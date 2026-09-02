"""Routing and header-hygiene equivalence with the TypeScript proxy.

Vectors are generated from the TypeScript source::

    bun run scripts/gen-router-vectors.ts

A route that flips from a masking target to a passthrough target ships the
conversation upstream in the clear, so these are security assertions rather
than routing nits.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from server.pii.headers import (
    forwardable_request_headers,
    forwardable_response_headers,
    is_sensitive_header_name,
    safe_header_log,
)
from server.pii.router import ROUTE_PATHS, resolve_route

_FIXTURE = Path(__file__).parent / "fixtures" / "router_vectors.json"

with _FIXTURE.open(encoding="utf-8") as _fh:
    VECTORS: dict[str, Any] = json.load(_fh)

HEADERS: dict[str, Any] = VECTORS["headers"]


def test_route_paths_match_typescript() -> None:
    assert VECTORS["route_paths"] == ROUTE_PATHS


@pytest.mark.parametrize("case", VECTORS["routes"], ids=lambda c: c["pathname"] or "empty")
def test_resolve_route_matches_typescript(case: dict[str, Any]) -> None:
    resolution = resolve_route(case["pathname"])
    assert resolution.kind == case["kind"]
    if case["provider"] is None:
        assert resolution.match is None
    else:
        assert resolution.match is not None
        assert resolution.match.transform == case["transform"]
        assert resolution.match.provider == case["provider"]
        assert resolution.match.upstream == case["upstream"]
        assert resolution.match.upstream_path == case["upstream_path"]


def test_openai_responses_masks_and_keeps_the_openai_upstream() -> None:
    """OpenCode's built-in OpenAI provider posts the Responses body here.

    Passthrough would ship the prompt upstream in the clear; borrowing the
    ``codex`` upstream would send it to whatever base Codex is pointed at.
    """
    resolution = resolve_route("/openai/v1/responses")
    assert resolution.match is not None
    assert resolution.match.transform == "responses"
    assert resolution.match.provider == "openai"
    assert resolution.match.upstream == "openai"
    assert resolution.match.upstream_path == "/v1/responses"


def test_codex_responses_keeps_its_own_upstream_and_audit_identity() -> None:
    resolution = resolve_route("/codex/v1/responses")
    assert resolution.match is not None
    assert resolution.match.transform == "responses"
    assert resolution.match.provider == "codex"
    assert resolution.match.upstream == "codex"


def test_transform_is_independent_of_audit_provider() -> None:
    """Both Responses routes share one transform and differ in everything else.

    Deriving the transform from ``provider`` is what dropped
    ``/openai/v1/responses`` onto the passthrough branch.
    """
    openai_responses = resolve_route("/openai/v1/responses").match
    codex_responses = resolve_route("/codex/v1/responses").match
    assert openai_responses is not None
    assert codex_responses is not None
    assert openai_responses.transform == codex_responses.transform
    assert openai_responses.provider != codex_responses.provider
    assert openai_responses.upstream != codex_responses.upstream


def test_unrecognised_anthropic_paths_stay_on_the_masking_branch() -> None:
    """``/v1/messages/count_tokens`` posts the entire conversation.

    Defaulting unknown ``/anthropic`` paths to passthrough would relay that
    transcript verbatim. Only the account namespace ``/anthropic/api/`` is
    explicitly passthrough; everything else masks.
    """
    for pathname in (
        "/anthropic/v1/messages/count_tokens",
        "/anthropic/v1/complete",
        "/anthropic/v1/anything-new-anthropic-ships",
    ):
        resolution = resolve_route(pathname)
        assert resolution.match is not None
        assert resolution.match.transform == "anthropic_messages", pathname
        assert resolution.match.provider == "anthropic", pathname

    account = resolve_route("/anthropic/api/organizations")
    assert account.match is not None
    assert account.match.transform == "passthrough"
    assert account.match.provider == "passthrough_anthropic"


def test_prefix_match_requires_a_boundary() -> None:
    assert resolve_route("/anthropicx/v1/messages").kind == "not_found"
    assert resolve_route("/CODEX/v1/responses").kind == "not_found"


# --------------------------------------------------------------------------
# headers
# --------------------------------------------------------------------------


def test_forwardable_request_headers_match_typescript() -> None:
    got = forwardable_request_headers(HEADERS["request_input"])
    assert got == HEADERS["request_forwardable"]


def test_forwardable_response_headers_match_typescript() -> None:
    got = forwardable_response_headers(HEADERS["response_input"])
    assert got == HEADERS["response_forwardable"]


def test_hop_by_hop_headers_are_dropped() -> None:
    """A relayed ``content-length`` disagrees with the re-serialised masked
    body, and a relayed ``transfer-encoding`` makes the client de-chunk an
    already-decoded stream."""
    forwarded = forwardable_request_headers(HEADERS["request_input"])
    for dropped in (
        "content-length",
        "host",
        "connection",
        "transfer-encoding",
        "te",
        "upgrade",
        "proxy-authorization",
    ):
        assert dropped not in forwarded


def test_content_encoding_is_dropped_from_responses_only() -> None:
    """The upstream body is decompressed before the transformers see it, so
    announcing ``gzip`` downstream would make the client decompress plaintext."""
    assert "content-encoding" not in forwardable_response_headers(HEADERS["response_input"])
    assert "content-encoding" in forwardable_request_headers(
        [("content-encoding", "gzip"), ("content-type", "application/json")]
    )


def test_credentials_are_forwarded_but_never_logged() -> None:
    """The proxy holds no API key of its own; it relays the client's. That makes
    redaction-on-log the only thing standing between a debug dump and a leaked
    key."""
    forwarded = forwardable_request_headers(HEADERS["request_input"])
    assert forwarded["authorization"] == "Bearer sk-secret-value"
    assert forwarded["x-api-key"] == "anthropic-secret"

    logged = safe_header_log(HEADERS["request_input"])
    assert logged == HEADERS["safe_log"]
    assert logged["authorization"] == "<redacted>"
    assert logged["x-api-key"] == "<redacted>"
    assert "sk-secret-value" not in json.dumps(logged)
    assert logged["content-type"] == "application/json"


@pytest.mark.parametrize(("name", "expected"), sorted(HEADERS["sensitive"].items()), ids=str)
def test_sensitive_header_detection_is_case_insensitive(name: str, expected: bool) -> None:
    assert is_sensitive_header_name(name) is expected
