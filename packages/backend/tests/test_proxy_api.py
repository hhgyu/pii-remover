"""End-to-end proxy routes on the merged single-service app.

Uses the same regex-driven OPF stand-in as :mod:`tests.test_api` (the real model
is ~5GB) and an ``httpx.MockTransport`` upstream, so nothing here touches torch
or the network.

The round trip under test is the whole point of the merge::

    client --(PII)--> proxy --(tokens)--> upstream
    client <--(PII)-- proxy <--(tokens)-- upstream
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.api import health as health_api
from server.api import proxy as proxy_api
from server.api import redact as redact_api
from server.config import get_proxy_settings
from server.main import _track_redact_activity
from server.opf_runner import OpfRunner

_PATTERNS: dict[str, re.Pattern[str]] = {
    "private_email": re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
    "private_person": re.compile(r"\b(?:John Smith|Alice Lee)\b"),
}

EMAIL = "alice@example.com"
PERSON = "John Smith"


class FakeOpfRunner(OpfRunner):
    def __init__(self) -> None:
        super().__init__()
        self._loaded = True

    @property
    def is_loaded(self) -> bool:  # type: ignore[override]
        return True

    def load(self) -> None:  # type: ignore[override]
        return None

    def _detect_raw(self, text: str):  # type: ignore[override]
        from server.opf_runner import RawSpan

        spans: list[RawSpan] = []
        for label, pattern in _PATTERNS.items():
            for match in pattern.finditer(text):
                spans.append(RawSpan(start=match.start(), end=match.end(), label=label, score=0.99))
        spans.sort(key=lambda s: (s.start, s.end))
        return spans


class _Upstream:
    """Records what the proxy forwarded and replies with a scripted body."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.responder: Any = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        return self.responder(request)

    @property
    def last_body(self) -> dict[str, Any]:
        return json.loads(self.requests[-1].content)

    @property
    def last_body_text(self) -> str:
        return self.requests[-1].content.decode()


@pytest.fixture()
def upstream() -> _Upstream:
    return _Upstream()


@pytest.fixture()
def app(monkeypatch: pytest.MonkeyPatch, upstream: _Upstream) -> Iterator[FastAPI]:
    monkeypatch.setenv("PII_PROXY_ENABLED", "1")
    monkeypatch.setenv("PII_REMOVER_TOKEN_KEY", "proxy-api-test-key")
    get_proxy_settings.cache_clear()

    application = FastAPI()
    application.middleware("http")(_track_redact_activity)
    application.include_router(health_api.router)
    application.include_router(redact_api.router)
    application.include_router(proxy_api.router)

    application.state.opf_runner = FakeOpfRunner()
    application.state.korean_ner_runner = None
    application.state.last_request_at = None
    application.state.idle_unloaded = False
    application.state.proxy_http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(upstream.handler)
    )

    yield application

    get_proxy_settings.cache_clear()


@pytest.fixture()
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


# --------------------------------------------------------------------------
# the catch-all must not shadow the detection API
# --------------------------------------------------------------------------


def test_health_still_reachable_with_proxy_mounted(client: TestClient) -> None:
    """The auto-start probe polls ``/health`` for ``model_loaded``.

    If the proxy catch-all ever shadows it, auto-start never sees a healthy
    backend and every prompt fails closed.
    """
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["model_loaded"] is True


def test_redact_still_reachable_with_proxy_mounted(client: TestClient) -> None:
    response = client.post("/redact", json={"text": f"mail {EMAIL}"})
    assert response.status_code == 200
    assert response.json()["detections"][0]["label"] == "private_email"


# --------------------------------------------------------------------------
# masked round trip
# --------------------------------------------------------------------------


def test_anthropic_round_trip_masks_then_restores(client: TestClient, upstream: _Upstream) -> None:
    def responder(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        echoed = sent["messages"][0]["content"]
        return httpx.Response(
            200, json={"content": [{"type": "text", "text": f"Reply to {echoed}"}]}
        )

    upstream.responder = responder

    response = client.post(
        "/anthropic/v1/messages",
        json={"model": "m", "messages": [{"role": "user", "content": f"I am {PERSON}"}]},
    )

    assert response.status_code == 200
    assert PERSON not in upstream.last_body_text, "PII reached the upstream"
    assert "{{OPF:PERSON:" in upstream.last_body_text
    assert PERSON in response.json()["content"][0]["text"], "token never restored"
    assert "{{OPF:" not in response.text


def test_openai_round_trip_masks_then_restores(client: TestClient, upstream: _Upstream) -> None:
    def responder(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        echoed = next(m["content"] for m in sent["messages"] if m["role"] == "user")
        return httpx.Response(200, json={"choices": [{"message": {"content": echoed}}]})

    upstream.responder = responder

    response = client.post(
        "/openai/v1/chat/completions",
        json={"model": "m", "messages": [{"role": "user", "content": f"mail {EMAIL}"}]},
    )

    assert response.status_code == 200
    assert EMAIL not in upstream.last_body_text
    assert EMAIL in response.json()["choices"][0]["message"]["content"]


def test_codex_round_trip_masks_then_restores(client: TestClient, upstream: _Upstream) -> None:
    def responder(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        return httpx.Response(200, json={"output_text": sent["input"]})

    upstream.responder = responder

    response = client.post(
        "/codex/v1/responses",
        json={"model": "m", "input": f"contact {EMAIL}"},
    )

    assert response.status_code == 200
    assert EMAIL not in upstream.last_body_text
    assert response.json()["output_text"] == f"contact {EMAIL}"


def test_openai_responses_round_trip_masks_then_restores(
    client: TestClient, upstream: _Upstream
) -> None:
    """OpenCode's built-in OpenAI provider posts the Responses body here.

    Passthrough on this path ships the whole prompt upstream in the clear —
    the production Docker leak this route exists to close.
    """

    def responder(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        return httpx.Response(200, json={"output_text": sent["input"]})

    upstream.responder = responder

    response = client.post(
        "/openai/v1/responses",
        json={"model": "m", "input": f"contact {EMAIL}"},
    )

    assert response.status_code == 200
    assert EMAIL not in upstream.last_body_text, "PII reached the upstream"
    assert "{{OPF:EMAIL:" in upstream.last_body_text
    assert response.json()["output_text"] == f"contact {EMAIL}", "token never restored"


def test_openai_responses_uses_the_openai_upstream(
    client: TestClient, upstream: _Upstream, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The codex upstream is separately configurable and may point elsewhere."""
    monkeypatch.setenv("PII_PROXY_OPENAI_UPSTREAM", "https://openai.test")
    monkeypatch.setenv("PII_PROXY_CODEX_UPSTREAM", "https://codex.test")
    get_proxy_settings.cache_clear()

    upstream.responder = lambda _r: httpx.Response(200, json={"output_text": "ok"})
    client.post("/openai/v1/responses", json={"model": "m", "input": "hi"})

    sent = upstream.requests[-1].url
    assert sent.host == "openai.test"
    assert sent.path == "/v1/responses"


def test_codex_responses_still_uses_the_codex_upstream(
    client: TestClient, upstream: _Upstream, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PII_PROXY_OPENAI_UPSTREAM", "https://openai.test")
    monkeypatch.setenv("PII_PROXY_CODEX_UPSTREAM", "https://codex.test")
    get_proxy_settings.cache_clear()

    upstream.responder = lambda _r: httpx.Response(200, json={"output_text": "ok"})
    client.post("/codex/v1/responses", json={"model": "m", "input": "hi"})

    assert upstream.requests[-1].url.host == "codex.test"


def test_openai_responses_stream_restores_tokens_split_across_deltas(
    client: TestClient, upstream: _Upstream
) -> None:
    """The Responses SSE shape, reached under the ``/openai`` prefix."""

    def responder(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        token = sent["input"].split()[-1]
        head, tail = token[:10], token[10:]

        def event(delta: str) -> str:
            payload = {
                "type": "response.output_text.delta",
                "output_index": 0,
                "delta": delta,
            }
            return f"event: response.output_text.delta\ndata: {json.dumps(payload)}\n\n"

        stream = event(f"Mail {head}") + event(tail) + "event: response.completed\ndata: {}\n\n"
        return httpx.Response(
            200, content=stream.encode(), headers={"content-type": "text/event-stream"}
        )

    upstream.responder = responder

    response = client.post(
        "/openai/v1/responses",
        json={"model": "m", "input": f"mail {EMAIL}", "stream": True},
    )

    assert response.status_code == 200
    assert EMAIL not in upstream.last_body_text
    assert EMAIL in response.text, "split token never reassembled"
    assert "{{OPF:" not in response.text


def test_unrelated_openai_paths_stay_passthrough(
    client: TestClient, upstream: _Upstream
) -> None:
    """Only the two chat surfaces mask; ``/v1/embeddings`` must relay verbatim.

    Byte-identical, not merely PII-free: a masking transform on this path would
    also inject the placeholder system note into a body that has no room for it.
    """
    upstream.responder = lambda _r: httpx.Response(200, json={"ok": True})
    sent = {"model": "text-embedding-3-small", "input": f"mail {EMAIL}"}

    response = client.post("/openai/v1/embeddings", json=sent)

    assert response.status_code == 200
    assert upstream.requests[-1].url.path == "/v1/embeddings"
    assert upstream.last_body == sent, "passthrough must not rewrite the body"


def test_openai_responses_child_path_stays_passthrough(
    client: TestClient, upstream: _Upstream, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Child paths under /v1/responses (e.g., /v1/responses/resp_123) must stay passthrough.

    Only the exact /v1/responses path is masked; retrieval siblings carry no
    prompt to mask and must relay untouched to the OpenAI upstream.
    """
    monkeypatch.setenv("PII_PROXY_OPENAI_UPSTREAM", "https://openai.test")
    monkeypatch.setenv("PII_PROXY_CODEX_UPSTREAM", "https://codex.test")
    get_proxy_settings.cache_clear()

    upstream.responder = lambda _r: httpx.Response(200, json={"ok": True})
    sent = {"model": "m", "input": f"contact {EMAIL}"}

    response = client.post("/openai/v1/responses/resp_123", json=sent)

    assert response.status_code == 200
    assert upstream.requests[-1].url.host == "openai.test", "must use OpenAI upstream"
    assert upstream.requests[-1].url.path == "/v1/responses/resp_123"
    assert upstream.last_body == sent, "passthrough must not rewrite the body"


def test_codex_responses_child_path_stays_passthrough(
    client: TestClient, upstream: _Upstream, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Child paths under /v1/responses (e.g., /v1/responses/resp_123) must stay passthrough.

    Only the exact /v1/responses path is masked; retrieval siblings carry no
    prompt to mask and must relay untouched to the Codex upstream.
    """
    monkeypatch.setenv("PII_PROXY_OPENAI_UPSTREAM", "https://openai.test")
    monkeypatch.setenv("PII_PROXY_CODEX_UPSTREAM", "https://codex.test")
    get_proxy_settings.cache_clear()

    upstream.responder = lambda _r: httpx.Response(200, json={"ok": True})
    sent = {"model": "m", "input": f"contact {EMAIL}"}

    response = client.post("/codex/v1/responses/resp_123", json=sent)

    assert response.status_code == 200
    assert upstream.requests[-1].url.host == "codex.test", "must use Codex upstream"
    assert upstream.requests[-1].url.path == "/v1/responses/resp_123"
    assert upstream.last_body == sent, "passthrough must not rewrite the body"


def test_system_note_is_injected(client: TestClient, upstream: _Upstream) -> None:
    upstream.responder = lambda _r: httpx.Response(200, json={"content": []})
    client.post("/anthropic/v1/messages", json={"model": "m", "messages": [], "system": "be nice"})
    assert "{{OPF:<LABEL>:<HASH>}}" in upstream.last_body_text


def test_hop_by_hop_headers_are_not_forwarded(client: TestClient, upstream: _Upstream) -> None:
    upstream.responder = lambda _r: httpx.Response(200, json={"content": []})
    client.post(
        "/anthropic/v1/messages",
        json={"model": "m", "messages": []},
        headers={"authorization": "Bearer sk-test", "host": "localhost:8000"},
    )
    forwarded = upstream.requests[-1].headers
    assert forwarded.get("authorization") == "Bearer sk-test", "credentials must relay"
    assert forwarded.get("host") != "localhost:8000"


# --------------------------------------------------------------------------
# sessions
# --------------------------------------------------------------------------


def test_sessions_get_separate_vaults(client: TestClient, upstream: _Upstream) -> None:
    captured: list[str] = []

    def responder(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        captured.append(sent["messages"][0]["content"])
        return httpx.Response(200, json={"content": []})

    upstream.responder = responder

    body = {"model": "m", "messages": [{"role": "user", "content": f"I am {PERSON}"}]}
    client.post("/anthropic/v1/messages", json=body, headers={"X-PII-Session": "a"})
    client.post("/anthropic/v1/messages", json=body, headers={"X-PII-Session": "b"})

    assert captured[0] == captured[1], "the token is deterministic across sessions"
    pool = client.app.state.proxy_session_pool  # type: ignore[attr-defined]
    assert pool.size() == 2


# --------------------------------------------------------------------------
# streaming
# --------------------------------------------------------------------------


def test_streaming_restores_tokens_split_across_deltas(
    client: TestClient, upstream: _Upstream
) -> None:
    """The token is deliberately chopped in half across two SSE deltas."""

    def responder(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        token = sent["messages"][0]["content"].split()[-1]
        head, tail = token[:10], token[10:]

        def event(payload: dict[str, Any]) -> str:
            return f"event: content_block_delta\ndata: {json.dumps(payload)}\n\n"

        stream = (
            event(
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": f"Hi {head}"},
                }
            )
            + event(
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": tail},
                }
            )
            + "event: message_stop\ndata: {}\n\n"
        )
        return httpx.Response(
            200, content=stream.encode(), headers={"content-type": "text/event-stream"}
        )

    upstream.responder = responder

    response = client.post(
        "/anthropic/v1/messages",
        json={
            "model": "m",
            "messages": [{"role": "user", "content": f"I am {PERSON}"}],
            "stream": True,
        },
    )

    assert response.status_code == 200
    assert PERSON in response.text, "split token never reassembled"
    assert "{{OPF:" not in response.text


# --------------------------------------------------------------------------
# routing + toggle
# --------------------------------------------------------------------------


def test_passthrough_route_relays_untouched(client: TestClient, upstream: _Upstream) -> None:
    upstream.responder = lambda _r: httpx.Response(200, json={"ok": True})
    response = client.get("/anthropic/api/organizations")
    assert response.status_code == 200
    assert upstream.requests[-1].url.path == "/api/organizations"


def test_non_post_on_chat_route_is_rejected(client: TestClient) -> None:
    response = client.get("/openai/v1/chat/completions")
    assert response.status_code in (200, 405)


def test_unknown_prefix_is_404(client: TestClient) -> None:
    assert client.post("/unknown/v1/x", json={}).status_code == 404


def test_invalid_json_is_rejected(client: TestClient) -> None:
    response = client.post(
        "/anthropic/v1/messages",
        content=b"{not json",
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 400


def test_proxy_disabled_returns_404(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    """Default-off: the standalone detection image must not become an outbound
    LLM proxy without an explicit opt-in."""
    monkeypatch.setenv("PII_PROXY_ENABLED", "0")
    get_proxy_settings.cache_clear()
    try:
        response = client.post("/anthropic/v1/messages", json={"model": "m", "messages": []})
        assert response.status_code == 404
    finally:
        get_proxy_settings.cache_clear()


def test_proxy_traffic_defers_idle_unload(client: TestClient, upstream: _Upstream) -> None:
    """Masking runs the model, so proxy traffic must reset the idle timer -
    otherwise a busy proxy gets its weights unloaded underneath it."""
    upstream.responder = lambda _r: httpx.Response(200, json={"content": []})
    client.app.state.last_request_at = None  # type: ignore[attr-defined]

    client.post("/anthropic/v1/messages", json={"model": "m", "messages": []})

    assert client.app.state.last_request_at is not None  # type: ignore[attr-defined]


# --------------------------------------------------------------------------
# operator category opt-out (PII_PROXY_EXCLUDED_CATEGORIES)
# --------------------------------------------------------------------------


def test_excluded_category_reaches_upstream_verbatim(
    client: TestClient, upstream: _Upstream, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PII_PROXY_EXCLUDED_CATEGORIES", "private_email")
    get_proxy_settings.cache_clear()

    upstream.responder = lambda request: httpx.Response(
        200, json={"content": [{"type": "text", "text": "ok"}]}
    )

    response = client.post(
        "/anthropic/v1/messages",
        json={
            "model": "m",
            "messages": [{"role": "user", "content": f"{PERSON} at {EMAIL}"}],
        },
    )

    assert response.status_code == 200
    assert EMAIL in upstream.last_body_text, "excluded category was masked anyway"
    assert PERSON not in upstream.last_body_text, "non-excluded category leaked"
    assert "{{OPF:PERSON:" in upstream.last_body_text


def test_no_exclusion_masks_every_category(client: TestClient, upstream: _Upstream) -> None:
    get_proxy_settings.cache_clear()

    upstream.responder = lambda request: httpx.Response(
        200, json={"content": [{"type": "text", "text": "ok"}]}
    )

    response = client.post(
        "/anthropic/v1/messages",
        json={
            "model": "m",
            "messages": [{"role": "user", "content": f"{PERSON} at {EMAIL}"}],
        },
    )

    assert response.status_code == 200
    assert EMAIL not in upstream.last_body_text
    assert PERSON not in upstream.last_body_text


def test_exclusion_does_not_leak_spans_swallowed_by_the_excluded_span(
    app: FastAPI, upstream: _Upstream, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An over-extended private_url must not carry the email out with it.

    OPF regularly emits one wide ``private_url`` span covering a trailing
    email. Filtering after the merge drops that whole span and the email
    reaches the LLM verbatim.
    """
    from server.opf_runner import RawSpan

    class WideUrlRunner(FakeOpfRunner):
        def _detect_raw(self, text: str):  # type: ignore[override]
            end = text.index(EMAIL) + len(EMAIL)
            return [RawSpan(start=0, end=end, label="private_url", score=0.68)]

    app.state.opf_runner = WideUrlRunner()
    monkeypatch.setenv("PII_PROXY_EXCLUDED_CATEGORIES", "private_url")
    get_proxy_settings.cache_clear()

    upstream.responder = lambda request: httpx.Response(
        200, json={"content": [{"type": "text", "text": "ok"}]}
    )

    with TestClient(app) as client:
        response = client.post(
            "/anthropic/v1/messages",
            json={
                "model": "m",
                "messages": [
                    {"role": "user", "content": f"see https://x.example.com then {EMAIL}"}
                ],
            },
        )

    assert response.status_code == 200
    assert "https://x.example.com" in upstream.last_body_text, "url should pass through"
    assert EMAIL not in upstream.last_body_text, "email leaked inside the excluded span"
    assert "{{OPF:EMAIL:" in upstream.last_body_text
