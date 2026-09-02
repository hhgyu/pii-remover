"""SSE parser and transformer equivalence with the TypeScript implementation.

Vectors are generated from the TypeScript source::

    bun run scripts/gen-sse-vectors.ts

Every stream is replayed at several chunk widths. Upstream chunk boundaries
never align with SSE event boundaries, so a transformer that only works when a
whole event arrives at once is broken in production and green in a naive test.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from server.pii.restorer import RestoreOptions, Restorer
from server.pii.sse import (
    SseEvent,
    SseLineParser,
    create_stream_restore_scope,
    js_json_dumps,
    serialize_sse_event,
)
from server.pii.stream_transformers import (
    AnthropicSseTransformer,
    CodexSseTransformer,
    OpenAISseTransformer,
)
from server.pii.token_hash import derive_token_key
from server.pii.types import Detection
from server.pii.vault import VaultManager

_FIXTURE = Path(__file__).parent / "fixtures" / "sse_vectors.json"

with _FIXTURE.open(encoding="utf-8") as _fh:
    VECTORS: dict[str, Any] = json.load(_fh)

SETUP: dict[str, Any] = VECTORS["setup"]

_TRANSFORMERS = {
    "anthropic": AnthropicSseTransformer,
    "openai": OpenAISseTransformer,
    "codex": CodexSseTransformer,
}


def _build_scope() -> Any:
    vault = VaultManager(token_key=derive_token_key(SETUP["secret"]))
    detections: list[Detection] = []
    cursor = 0
    for spec in SETUP["detections"]:
        text = spec["text"]
        detections.append(
            Detection(
                start=cursor,
                end=cursor + len(text),
                category=spec["category"],
                confidence=0.99,
                text=text,
            )
        )
        cursor += len(text) + 1
    vault.assign(SETUP["session_id"], detections)
    restorer = Restorer(vault, RestoreOptions(warn=lambda _m: None))
    return create_stream_restore_scope(
        restorer, SETUP["session_id"], RestoreOptions(warn=lambda _m: None)
    )


def test_setup_reproduces_the_same_tokens() -> None:
    scope = _build_scope()
    for token in SETUP["tokens"].values():
        assert scope.text(token) != token, f"{token} did not restore"


# --------------------------------------------------------------------------
# JSON encoding contract
# --------------------------------------------------------------------------


def test_js_json_dumps_matches_json_stringify() -> None:
    """``json.dumps`` defaults are wrong for us in two independent ways.

    Compact separators are cosmetic; ``ensure_ascii`` is not. Escaping a
    restored Korean name to ``\\uae40\\ucca0\\uc218`` hands the model a
    different string than the TypeScript proxy would, inside tool-call
    arguments the model then acts on.
    """
    value = {"name": "김철수", "n": 1, "nested": ["a", "b"]}
    assert js_json_dumps(value) == '{"name":"김철수","n":1,"nested":["a","b"]}'
    assert json.dumps(value) != js_json_dumps(value)


# --------------------------------------------------------------------------
# parser
# --------------------------------------------------------------------------


@pytest.mark.parametrize("case", VECTORS["parser"], ids=lambda c: c["name"])
def test_parser_matches_typescript(case: dict[str, Any]) -> None:
    parser = SseLineParser()
    pushes = [
        [{"event": e.event, "data": e.data} for e in parser.push(chunk)] for chunk in case["chunks"]
    ]
    flushed = [{"event": e.event, "data": e.data} for e in parser.flush()]

    assert pushes == case["expected"]["pushes"]
    assert flushed == case["expected"]["flush"]


@pytest.mark.parametrize("case", VECTORS["serialize"], ids=lambda c: c["input"]["data"][:20])
def test_serialize_matches_typescript(case: dict[str, Any]) -> None:
    ev = SseEvent(data=case["input"]["data"], event=case["input"]["event"])
    assert serialize_sse_event(ev) == case["output"]


def test_data_prefix_strips_exactly_one_space() -> None:
    """``data:  two`` carries a leading space in its payload; dropping both
    would silently rewrite content the upstream sent."""
    parser = SseLineParser()
    events = parser.push("data:  two\n\n")
    assert len(events) == 1
    assert events[0].data == " two"


# --------------------------------------------------------------------------
# transformers
# --------------------------------------------------------------------------


@pytest.mark.parametrize("case", VECTORS["transformers"], ids=lambda c: c["name"])
def test_transformer_matches_typescript(case: dict[str, Any]) -> None:
    transformer = _TRANSFORMERS[case["provider"]](_build_scope(), buffer_window=64)
    pushes = [transformer.push(chunk) for chunk in case["chunks"]]
    flushed = transformer.flush()

    assert pushes == case["expected"]["pushes"]
    assert flushed == case["expected"]["flush"]
    assert "".join(pushes) + flushed == case["expected"]["total"]


@pytest.mark.parametrize("case", VECTORS["transformers"], ids=lambda c: c["name"])
def test_transformer_output_carries_no_live_tokens(case: dict[str, Any]) -> None:
    """The point of the whole pipeline: the client never sees a vault token."""
    transformer = _TRANSFORMERS[case["provider"]](_build_scope(), buffer_window=64)
    out = "".join(transformer.push(chunk) for chunk in case["chunks"])
    out += transformer.flush()
    for token in SETUP["tokens"].values():
        assert token not in out, f"{token} leaked to the client"


def _is_openai_tool_call_case(case: dict[str, Any]) -> bool:
    return case["provider"] == "openai" and "tool-calls" in case["name"]


@pytest.mark.parametrize(
    "case",
    [c for c in VECTORS["transformers"] if _is_openai_tool_call_case(c)],
    ids=lambda c: c["name"],
)
def test_openai_streaming_tool_calls_restore_exactly_once(case: dict[str, Any]) -> None:
    """A streamed tool call reaches the client restored, at close, and once.

    ``tool_calls`` arguments arrive as fragmented JSON, so every delta is held
    and accumulated and one restored copy is emitted at stream close. Echoing
    the upstream event as well would hand the client a tool call whose
    arguments still carry the vault token, followed by a restored duplicate.
    """
    transformer = _TRANSFORMERS[case["provider"]](_build_scope(), buffer_window=64)
    pushes = [transformer.push(chunk) for chunk in case["chunks"]]
    flushed = transformer.flush()
    pre_flush = "".join(pushes)
    out = pre_flush + flushed

    assert SETUP["tokens"]["EMAIL"] not in out
    assert "alice@example.com" in flushed
    assert out.count("alice@example.com") == 1

    # Holding the arguments must not cost the client the fields it dispatches
    # on; those arrive once, on the first delta, and are never re-sent.
    assert '"id":"call_fixture_1"' in pre_flush
    assert '"type":"function"' in pre_flush
    assert '"name":"send_email"' in pre_flush
    assert '"arguments":""' in pre_flush


def test_openai_held_content_survives_a_passthrough_sibling_choice() -> None:
    """A held partial token must not ride out on a sibling choice's event.

    Choice 1 carries no string content, so the event is not "all held" and the
    early return does not fire. The sanitized copy of choice 0 is then the only
    thing keeping the partial token off the wire.
    """
    transformer = OpenAISseTransformer(_build_scope(), buffer_window=64)
    email_token = SETUP["tokens"]["EMAIL"]
    head = email_token[:20]

    first = transformer.push(
        serialize_sse_event(
            SseEvent(
                data=js_json_dumps(
                    {
                        "choices": [
                            {"index": 0, "delta": {"content": head}},
                            {"index": 1, "delta": {"role": "assistant"}},
                        ]
                    }
                )
            )
        )
    )
    rest = transformer.push(
        serialize_sse_event(
            SseEvent(
                data=js_json_dumps(
                    {"choices": [{"index": 0, "delta": {"content": email_token[20:]}}]}
                )
            )
        )
    )
    out = first + rest + transformer.flush()

    assert head not in first
    assert "assistant" in first
    assert email_token not in out
    assert out.count("alice@example.com") == 1


def test_transformer_is_inert_after_flush() -> None:
    """A closed transformer must not emit again — a late chunk after client
    abort would otherwise write into a response that is already finished."""
    transformer = AnthropicSseTransformer(_build_scope())
    assert transformer.flush() == ""
    assert transformer.push("event: x\ndata: {}\n\n") == ""
    assert transformer.flush() == ""
