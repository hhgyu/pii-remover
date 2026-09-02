"""Extended-thinking round trip through the live proxy routes.

The two halves have to hold at once: the user reads their own PII inside
``thinking``, and the bytes Anthropic signed are what goes back upstream next
turn. Restoring without the replay half draws an opaque 400 from Anthropic;
replaying without the restore half shows the user a masking token.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.conftest import PERSON, ProxyUpstream
from tests.fixtures.anthropic_sse import (
    aggregate,
    block_stop,
    event,
    signature_delta,
    thinking_delta,
)

SIGNATURE = "ErUBCkYIBRgCIkC9+z/Rp0Nq4w=="
STALE_SIGNATURE = "ErUBCkYIBRgCIkDzzzzzzzz=="
MESSAGES_PATH = "/anthropic/v1/messages"


def _turn(**extra: Any) -> dict[str, Any]:
    return {
        "model": "m",
        "messages": [{"role": "user", "content": f"I am {PERSON}"}],
        **extra,
    }


def _replay_turn(thinking: str, signature: str) -> dict[str, Any]:
    return {
        "model": "m",
        "messages": [
            {"role": "user", "content": "continue"},
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": thinking, "signature": signature},
                    {"type": "text", "text": "Working on it."},
                ],
            },
        ],
    }


def _stream_thinking_turn(
    client: TestClient, upstream: ProxyUpstream, headers: dict[str, str] | None = None
) -> tuple[str, str]:
    """Run one streamed thinking turn; return the raw signed bytes and what the
    client was shown for them."""
    captured: list[str] = []

    def responder(request: httpx.Request) -> httpx.Response:
        token = json.loads(request.content)["messages"][0]["content"].split()[-1]
        raw = f"Reply to {token}"
        captured.append(raw)
        split = len(raw) // 2
        stream = (
            thinking_delta(0, raw[:split])
            + thinking_delta(0, raw[split:])
            + signature_delta(0, SIGNATURE)
            + block_stop(0)
            + event("message_stop", {"type": "message_stop"})
        )
        return httpx.Response(
            200, content=stream.encode(), headers={"content-type": "text/event-stream"}
        )

    upstream.responder = responder
    response = client.post(MESSAGES_PATH, json=_turn(stream=True), headers=headers or {})
    assert response.status_code == 200
    displayed, _signature = aggregate(response.text)
    return captured[0], displayed


def test_streaming_thinking_delta_reaches_the_client_restored(
    proxy_client: TestClient, proxy_upstream: ProxyUpstream
) -> None:
    """Given: upstream streams a signed thinking block carrying a masked token.

    When: the client streams that turn through the proxy.
    Then: the user reads their own PII and never a canonical OPF token.
    """
    raw, displayed = _stream_thinking_turn(proxy_client, proxy_upstream)

    assert "{{OPF:" not in displayed, "canonical token leaked inside thinking_delta"
    assert PERSON in displayed, "thinking was never restored for display"
    assert "{{OPF:" in raw, "the fixture never exercised a masked token"


def test_the_next_turn_replays_the_bytes_upstream_signed(
    proxy_client: TestClient, proxy_upstream: ProxyUpstream
) -> None:
    # Given: a streamed thinking block the client was shown restored
    raw, displayed = _stream_thinking_turn(proxy_client, proxy_upstream)
    proxy_upstream.responder = lambda _r: httpx.Response(200, json={"content": []})

    # When: the client replays exactly what it saw
    response = proxy_client.post(MESSAGES_PATH, json=_replay_turn(displayed, SIGNATURE))

    # Then: upstream gets the signed bytes back, and no PII rides along
    assert response.status_code == 200
    forwarded = proxy_upstream.last_body["messages"][1]["content"][0]
    assert displayed != raw
    assert forwarded["thinking"] == raw
    assert forwarded["signature"] == SIGNATURE
    assert PERSON not in proxy_upstream.last_body_text


def test_a_replay_the_proxy_cannot_match_is_refused_locally(
    proxy_client: TestClient, proxy_upstream: ProxyUpstream
) -> None:
    # Given: nothing cached under the signature the client is about to replay
    proxy_upstream.responder = lambda _r: httpx.Response(200, json={"content": []})

    # When: it replays a thinking block carrying its own restored PII
    response = proxy_client.post(
        MESSAGES_PATH, json=_replay_turn(f"Reply to {PERSON} about it.", STALE_SIGNATURE)
    )

    # Then: the proxy refuses locally, forwards nothing, and echoes nothing back
    assert response.status_code == 400
    assert response.json()["error"] == "thinking_replay_unavailable"
    assert proxy_upstream.requests == [], "an unresolvable turn must not reach upstream"
    assert PERSON not in response.text
    assert STALE_SIGNATURE not in response.text
    assert "Reply to" not in response.text


def test_the_thinking_cache_is_isolated_per_session(
    proxy_client: TestClient, proxy_upstream: ProxyUpstream
) -> None:
    """A signature minted for one vault must not resolve against another's, or a
    replay hands the wrong conversation's thinking to upstream."""
    # Given: alice streamed a thinking block on her own session
    raw, displayed = _stream_thinking_turn(
        proxy_client, proxy_upstream, headers={"X-PII-Session": "alice"}
    )
    proxy_upstream.responder = lambda _r: httpx.Response(200, json={"content": []})
    replay = _replay_turn(displayed, SIGNATURE)

    # When: bob replays her signature, then alice replays her own
    for_bob = proxy_client.post(MESSAGES_PATH, json=replay, headers={"X-PII-Session": "bob"})
    for_alice = proxy_client.post(MESSAGES_PATH, json=replay, headers={"X-PII-Session": "alice"})

    # Then: only alice's session can resolve it
    assert for_bob.status_code == 400
    assert for_alice.status_code == 200
    assert proxy_upstream.last_body["messages"][1]["content"][0]["thinking"] == raw


def test_a_fresh_session_pool_refuses_a_stale_replay(
    proxy_app: FastAPI, proxy_client: TestClient, proxy_upstream: ProxyUpstream
) -> None:
    """The cache is in-memory and never persisted, so a restart makes every
    outstanding thinking block unreplayable — which has to surface as this
    proxy's own 400 and not as restored PII on the wire."""
    # Given: a thinking block cached by the pool that served the first turn
    _raw, displayed = _stream_thinking_turn(proxy_client, proxy_upstream)
    proxy_upstream.responder = lambda _r: httpx.Response(200, json={"content": []})
    forwarded_before = len(proxy_upstream.requests)

    # When: the process restarts, i.e. a new pool with an empty cache takes over
    proxy_app.state.proxy_session_pool = None
    response = proxy_client.post(MESSAGES_PATH, json=_replay_turn(displayed, SIGNATURE))

    # Then: the turn is refused rather than forwarded with restored text
    assert response.status_code == 400
    assert response.json()["error"] == "thinking_replay_unavailable"
    assert len(proxy_upstream.requests) == forwarded_before


def test_non_streaming_thinking_is_restored_then_replayed(
    proxy_client: TestClient, proxy_upstream: ProxyUpstream
) -> None:
    # Given: a non-streaming response carrying a signed, masked thinking block
    captured: list[str] = []

    def responder(request: httpx.Request) -> httpx.Response:
        token = json.loads(request.content)["messages"][0]["content"].split()[-1]
        raw = f"Reply to {token}"
        captured.append(raw)
        return httpx.Response(
            200,
            json={
                "content": [
                    {"type": "thinking", "thinking": raw, "signature": SIGNATURE},
                    {"type": "text", "text": "done"},
                ]
            },
        )

    proxy_upstream.responder = responder

    # When: the client reads that turn and replays the thinking it was shown
    first = proxy_client.post(MESSAGES_PATH, json=_turn())
    displayed = first.json()["content"][0]["thinking"]
    proxy_upstream.responder = lambda _r: httpx.Response(200, json={"content": []})
    second = proxy_client.post(MESSAGES_PATH, json=_replay_turn(displayed, SIGNATURE))

    # Then: the client read PII, upstream gets its own bytes back unchanged
    assert PERSON in displayed
    assert "{{OPF:" not in first.text
    assert first.json()["content"][0]["signature"] == SIGNATURE
    assert second.status_code == 200
    assert proxy_upstream.last_body["messages"][1]["content"][0]["thinking"] == captured[0]
    assert PERSON not in proxy_upstream.last_body_text
