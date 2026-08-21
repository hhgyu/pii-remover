"""SSE boundary-buffer equivalence with the TypeScript implementation.

Vectors are generated from the TypeScript source::

    bun run scripts/gen-stream-vectors.ts

This is the per-delta hot path. The buffer decides, on every SSE chunk, how much
is safe to hand to the user. One character of drift either leaks a half-token
onto the screen or stalls the stream forever.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from server.pii.stream_buffer import (
    DEFAULT_BUFFER_WINDOW,
    create_stream_buffer,
    find_unsafe_boundary,
)
from server.pii.token_format import MAX_TOKEN_LENGTH, TOKEN_PREFIX

_FIXTURE = Path(__file__).parent / "fixtures" / "stream_vectors.json"

with _FIXTURE.open(encoding="utf-8") as _fh:
    VECTORS: dict[str, Any] = json.load(_fh)


def test_constants_match_typescript() -> None:
    assert VECTORS["constants"]["DEFAULT_BUFFER_WINDOW"] == DEFAULT_BUFFER_WINDOW
    assert VECTORS["constants"]["MAX_TOKEN_LENGTH"] == MAX_TOKEN_LENGTH
    assert DEFAULT_BUFFER_WINDOW >= MAX_TOKEN_LENGTH


@pytest.mark.parametrize(
    "case",
    VECTORS["boundaries"],
    ids=lambda c: f"{c['buffer']!r}-w{c['window_size']}"[:60],
)
def test_find_unsafe_boundary_matches(case: dict[str, Any]) -> None:
    assert find_unsafe_boundary(case["buffer"], case["window_size"]) == case["boundary"]


def test_trailing_newline_does_not_anchor_the_unsafe_tail() -> None:
    """JavaScript ``$`` anchors at end-of-string; Python's also matches before a
    trailing newline.

    ``"{{OPF:PERS\\n"`` carries a partial token that is *not* at the end, so
    JavaScript releases the whole buffer. A Python port using ``$`` instead of
    ``\\Z`` matches the partial token before the ``\\n``, returns 0, and holds the
    buffer forever - the stream stops advancing and the user sees nothing.
    """
    for buffer in ("{{OPF:PERS\n", "{{OPF:\n", "text\n"):
        assert find_unsafe_boundary(buffer) == len(buffer), buffer

    assert find_unsafe_boundary("{{OPF:PERS") == 0
    assert find_unsafe_boundary("{{OPF:") == 0


def test_partial_prefixes_are_held_back() -> None:
    """Every proper prefix of ``{{OPF:`` must be withheld, inclusive of the
    complete prefix - otherwise ``__OPF`` goes out raw and the token is split
    across two restore calls."""
    for partial in (TOKEN_PREFIX[:i] for i in range(1, len(TOKEN_PREFIX) + 1)):
        assert find_unsafe_boundary(partial) == 0, partial


@pytest.mark.parametrize("case", VECTORS["sequences"], ids=lambda c: c["name"])
def test_push_release_schedule_matches(case: dict[str, Any]) -> None:
    """Per-push equality, not just the concatenated total.

    A buffer that releases early and catches up later sums to the same string
    while having already shown the user a half-token.
    """
    buf = create_stream_buffer(case["buffer_window"])
    pushes = [buf.push(chunk) for chunk in case["chunks"]]
    flushed = buf.flush()

    expected = case["expected"]
    assert pushes == expected["pushes"]
    assert flushed == expected["flush"]
    assert "".join(pushes) + flushed == expected["total"]


@pytest.mark.parametrize("case", VECTORS["sequences"], ids=lambda c: c["name"])
def test_buffering_is_lossless(case: dict[str, Any]) -> None:
    """Whatever went in comes out, in order, across every split width."""
    buf = create_stream_buffer(case["buffer_window"])
    out = "".join(buf.push(chunk) for chunk in case["chunks"]) + buf.flush()
    assert out == "".join(case["chunks"])


def test_token_is_never_released_in_pieces() -> None:
    """The property the whole buffer exists for: a token reaches the restorer
    whole, no matter how the upstream chopped it."""
    person = VECTORS["tokens"]["PERSON"]
    text = f"Contact {person} today."
    for width in range(1, 9):
        buf = create_stream_buffer(None)
        released: list[str] = []
        for i in range(0, len(text), width):
            out = buf.push(text[i : i + width])
            if out:
                released.append(out)
        tail = buf.flush()
        if tail:
            released.append(tail)

        assert "".join(released) == text
        carrier = [r for r in released if person in r]
        assert len(carrier) == 1, f"token split across releases at width {width}"


def test_flush_drains_and_resets() -> None:
    buf = create_stream_buffer(None)
    assert buf.push("{{OPF:PERS") == ""
    assert buf.size() == len("{{OPF:PERS")
    assert buf.flush() == "{{OPF:PERS"
    assert buf.size() == 0
    assert buf.flush() == ""


def test_empty_chunk_is_a_noop() -> None:
    buf = create_stream_buffer(None)
    assert buf.push("") == ""
    assert buf.push("hello") == "hello"
    assert buf.push("") == ""
