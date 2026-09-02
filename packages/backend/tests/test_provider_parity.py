"""Provider transform equivalence with the TypeScript implementation.

Vectors are generated from the TypeScript source::

    bun run scripts/gen-provider-vectors.ts

The codec here mirrors the generator's: masking is literal replacement from a
fixed PII table, restoring is the real :class:`~server.pii.restorer.Restorer`
against a pre-populated vault. That isolates what is under test - which body
fields are walked, which pass through, and where the system note lands - from
the detection pipeline.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from server.pii.providers import (
    restore_codex_response,
    restore_openai_response,
    transform_codex_request,
    transform_openai_request,
)
from server.pii.providers_anthropic import (
    restore_anthropic_response,
    transform_anthropic_request,
)
from server.pii.restorer import RestoreOptions, Restorer
from server.pii.system_note import OPF_PLACEHOLDER_SYSTEM_NOTE
from server.pii.token_hash import derive_token_key
from server.pii.types import Detection
from server.pii.vault import VaultManager

_FIXTURE = Path(__file__).parent / "fixtures" / "provider_vectors.json"

with _FIXTURE.open(encoding="utf-8") as _fh:
    VECTORS: dict[str, Any] = json.load(_fh)

SETUP: dict[str, Any] = VECTORS["setup"]


class _FixtureCodec:
    """Literal-replacement mask, real vault-backed restore."""

    def __init__(self) -> None:
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

        self._restorer = Restorer(vault, RestoreOptions(warn=lambda _m: None))
        self._table: list[tuple[str, str]] = [(plain, token) for plain, token in SETUP["pii_table"]]

    def mask(self, text: str) -> str:
        out = text
        for plain, token in self._table:
            out = out.replace(plain, token)
        return out

    def restore(self, text: str) -> str:
        return self._restorer.restore(text, SETUP["session_id"]).text


def test_placeholder_note_matches_typescript() -> None:
    """A wording drift here makes host-to-host hallucination rates
    incomparable, which is the number the prompt lever is chosen from."""
    assert SETUP["placeholder_note"] == OPF_PLACEHOLDER_SYSTEM_NOTE


_TRANSFORMS = {
    ("anthropic", "requests"): transform_anthropic_request,
    ("anthropic", "responses"): restore_anthropic_response,
    ("openai", "requests"): transform_openai_request,
    ("openai", "responses"): restore_openai_response,
    ("codex", "requests"): transform_codex_request,
    ("codex", "responses"): restore_codex_response,
}


def _cases(provider: str, kind: str) -> list[Any]:
    return VECTORS[provider][kind]


@pytest.mark.parametrize(
    ("provider", "kind", "case"),
    [
        (provider, kind, case)
        for provider in ("anthropic", "openai", "codex")
        for kind in ("requests", "responses")
        for case in _cases(provider, kind)
    ],
    ids=lambda v: v["name"] if isinstance(v, dict) else str(v),
)
def test_transform_matches_typescript(provider: str, kind: str, case: dict[str, Any]) -> None:
    transform = _TRANSFORMS[(provider, kind)]
    got = transform(case["input"], _FixtureCodec())
    assert got == case["expected"]


def test_anthropic_note_appended_once_to_array_system() -> None:
    codec = _FixtureCodec()
    body = {"model": "m", "system": [{"type": "text", "text": "hi"}], "messages": []}
    once = transform_anthropic_request(body, codec)
    twice = transform_anthropic_request(once, codec)
    notes = [b for b in twice["system"] if b.get("text") == OPF_PLACEHOLDER_SYSTEM_NOTE]
    assert len(notes) == 1


def test_openai_note_lands_on_last_system_message() -> None:
    codec = _FixtureCodec()
    body = {
        "model": "m",
        "messages": [
            {"role": "system", "content": "first"},
            {"role": "user", "content": "hi"},
            {"role": "system", "content": "second"},
        ],
    }
    out = transform_openai_request(body, codec)
    assert OPF_PLACEHOLDER_SYSTEM_NOTE in out["messages"][2]["content"]
    assert OPF_PLACEHOLDER_SYSTEM_NOTE not in out["messages"][0]["content"]


def test_openai_note_inserted_when_no_system_message() -> None:
    codec = _FixtureCodec()
    out = transform_openai_request(
        {"model": "m", "messages": [{"role": "user", "content": "hi"}]}, codec
    )
    assert out["messages"][0] == {
        "role": "system",
        "content": OPF_PLACEHOLDER_SYSTEM_NOTE,
    }


def test_codex_input_tool_arguments_are_not_masked() -> None:
    """Pins a TypeScript defect this port reproduces on purpose.

    ``codex.ts`` routes input ``arguments`` through ``maskToolArguments``, which
    delegates to ``walkAsyncSyncMask`` - a function whose entire body is
    ``return value``. The JSON is parsed and re-serialised without a single
    field being masked.

    Unlike the OpenAI streaming ``tool_calls`` issue, this one is on the REQUEST
    side: PII inside a tool-call argument leaves the machine in the clear. It is
    reproduced rather than fixed because a Python side that masked here would
    emit a body the TypeScript proxy never emits, and the two must agree.

    Fixing it belongs upstream in ``codex.ts``; when that lands, regenerate the
    vectors and this test fails loudly.
    """
    codec = _FixtureCodec()
    email = "alice@example.com"
    out = transform_codex_request(
        {
            "model": "m",
            "input": [{"type": "function_call", "arguments": json.dumps({"to": email})}],
        },
        codec,
    )
    assert out["input"][0]["arguments"] == '{"to":"alice@example.com"}'
    assert email in out["input"][0]["arguments"], "documented leak, not a regression"


def test_codex_text_input_is_masked() -> None:
    """Contrast with the defect above: ordinary text input masks correctly."""
    codec = _FixtureCodec()
    out = transform_codex_request(
        {
            "model": "m",
            "input": [{"type": "message", "content": [{"type": "input_text", "text": "김철수"}]}],
        },
        codec,
    )
    masked = out["input"][0]["content"][0]["text"]
    assert "김철수" not in masked
    assert masked.startswith("{{OPF:PERSON:")


CASES_HITTING_UNMASKED_TOOL_ARGUMENTS = {
    "input-item-arguments-NOT-masked",
    "input-item-arguments-invalid-json",
}
CASES_HITTING_CONTENT_TYPE_ALLOWLIST = {"input-items-content"}
CASES_PINNED_AS_FAIL_OPEN_ELSEWHERE = (
    CASES_HITTING_UNMASKED_TOOL_ARGUMENTS | CASES_HITTING_CONTENT_TYPE_ALLOWLIST
)


@pytest.mark.parametrize("provider", ["anthropic", "openai", "codex"])
def test_request_bodies_carry_no_plaintext_pii(provider: str) -> None:
    codec = _FixtureCodec()
    transform = _TRANSFORMS[(provider, "requests")]
    checked = 0
    for case in _cases(provider, "requests"):
        if case["name"] in CASES_PINNED_AS_FAIL_OPEN_ELSEWHERE:
            continue
        serialized = json.dumps(transform(case["input"], codec), ensure_ascii=False)
        for plain, _token in SETUP["pii_table"]:
            assert plain not in serialized, f"{provider}/{case['name']} leaked {plain}"
        checked += 1
    assert checked > 0, "every case was excluded - the sweep proves nothing"


@pytest.mark.parametrize(
    ("transform", "body", "unmasked_path"),
    [
        (
            transform_anthropic_request,
            {
                "model": "m",
                "messages": [{"role": "user", "content": [{"type": "thinking", "text": "김철수"}]}],
            },
            "messages[0].content[0].text",
        ),
        (
            transform_openai_request,
            {
                "model": "m",
                "messages": [
                    {"role": "user", "content": [{"type": "input_audio", "text": "김철수"}]}
                ],
            },
            "messages[0].content[0].text",
        ),
        (
            transform_codex_request,
            {
                "model": "m",
                "input": [
                    {"type": "message", "content": [{"type": "summary_text", "text": "김철수"}]}
                ],
            },
            "input[0].content[0].text",
        ),
    ],
    ids=["anthropic", "openai", "codex"],
)
def test_content_part_masking_is_an_allowlist_and_fails_open(
    transform: Any, body: dict[str, Any], unmasked_path: str
) -> None:
    """Masking is an allowlist, so an unrecognised part type leaks its text.

    Latent rather than live: no current API shape produces a text-bearing part
    outside the allowlist. It is still fail-OPEN, against the project's
    fail-closed posture - the day a provider adds such a type, PII leaves the
    machine with no error. Reproduced from TypeScript, not fixed, because both
    implementations must emit the same body.
    """
    out = transform(body, _FixtureCodec())
    assert "김철수" in json.dumps(out, ensure_ascii=False), unmasked_path
