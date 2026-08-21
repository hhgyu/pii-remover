"""SSE token-boundary buffer — port of ``proxy/src/stream/buffer.ts``.

An LLM streams a token like ``{{OPF:PERSON:4ov9mhqtc1vepqf5}}`` across several
SSE deltas. Restoring each delta independently would emit ``{{OPF:PE`` to the
user verbatim and never match the vault. This buffer holds back any tail that
*could* still become a token and releases it once the rest arrives.

Two parity traps, both corrected below:

1. **``$`` means different things.** In JavaScript (no ``m`` flag) ``$`` anchors
   at the very end of the string. In Python ``$`` also matches *before a
   trailing newline*. SSE text deltas routinely end in ``\\n``, so a Python port
   using ``$`` computes a boundary one-or-more characters early and leaks a
   partial token. Both patterns here use ``\\Z``.
2. **The prefix bound is inclusive.** A buffer ending at exactly ``{{OPF:`` must
   also be held. The other alternative needs at least one category character
   after the prefix, so stopping one short left a gap where only the trailing
   ``_`` was held and ``__OPF`` was released, splitting the token across two
   restore calls and delivering it raw.
"""

from __future__ import annotations

import re
from typing import Final

from .token_format import (
    MAX_TOKEN_LENGTH,
    TOKEN_DELIMITER,
    TOKEN_PREFIX,
    TOKEN_SUFFIX,
)
from .token_hash import TOKEN_HASH_LENGTH

DEFAULT_BUFFER_WINDOW: Final = MAX_TOKEN_LENGTH * 2
"""Must stay >= MAX_TOKEN_LENGTH, else the lookback misses an in-progress
token's ``{{OPF:`` start and the tail is released raw. Doubled for headroom."""

_PREFIX_SOURCE: Final = re.escape(TOKEN_PREFIX)
_DELIMITER_SOURCE: Final = re.escape(TOKEN_DELIMITER)
_SUFFIX_SOURCE: Final = re.escape(TOKEN_SUFFIX)

_PARTIAL_SUFFIX_GROUP: Final = "|".join(
    re.escape(TOKEN_SUFFIX[: len(TOKEN_SUFFIX) - i]) for i in range(len(TOKEN_SUFFIX))
)
"""Every proper prefix of the closing suffix, longest first.

Alternation is order-sensitive: a shorter branch first would match ``}`` and
release the second brace raw.
"""


def _build_unsafe_prefix_group() -> str:
    return "|".join(re.escape(TOKEN_PREFIX[:i]) for i in range(1, len(TOKEN_PREFIX) + 1))


COMPLETE_TOKEN_AT_END_PATTERN: Final = (
    rf"{_PREFIX_SOURCE}[A-Z][A-Z0-9_]*{_DELIMITER_SOURCE}"
    rf"[a-z0-9]{{{TOKEN_HASH_LENGTH}}}{_SUFFIX_SOURCE}\Z"
)

UNSAFE_TOKEN_TAIL_PATTERN: Final = (
    rf"(?:{_build_unsafe_prefix_group()}|{_PREFIX_SOURCE}[A-Z][A-Z0-9_]*"
    rf"(?:{_DELIMITER_SOURCE}?[a-z0-9]{{0,{TOKEN_HASH_LENGTH}}}"
    rf"(?:{_PARTIAL_SUFFIX_GROUP})?)?)\Z"
)
"""Incomplete token tail held back until the rest of the stream arrives: the
prefix may be partial, or category/delimiter/hash may still be in progress."""

COMPLETE_TOKEN_AT_END_REGEX: Final = re.compile(COMPLETE_TOKEN_AT_END_PATTERN, re.IGNORECASE)
UNSAFE_TOKEN_TAIL_REGEX: Final = re.compile(UNSAFE_TOKEN_TAIL_PATTERN, re.IGNORECASE)


def find_unsafe_boundary(buffer: str, window_size: int = DEFAULT_BUFFER_WINDOW) -> int:
    """Index at which ``buffer`` stops being safe to release.

    Returns ``len(buffer)`` when everything can go out now, ``0`` when nothing
    can.
    """
    if buffer == "":
        return 0
    tail_start = max(0, len(buffer) - window_size)
    tail = buffer[tail_start:]

    # Sound because every alternative in both patterns below starts with the
    # first character of TOKEN_PREFIX: a tail without one cannot match either,
    # so skipping is free. Derived from the constant rather than written out —
    # this guard used to hardcode "_", and once the prefix stopped containing
    # one it silently released partial tokens raw.
    if TOKEN_PREFIX[0] not in tail:
        return len(buffer)

    if COMPLETE_TOKEN_AT_END_REGEX.search(tail):
        return len(buffer)

    match = UNSAFE_TOKEN_TAIL_REGEX.search(tail)
    if match is None:
        return len(buffer)
    return tail_start + match.start()


class StreamBuffer:
    """Accumulates deltas and releases only the prefix that cannot be a token."""

    __slots__ = ("_buf", "_window_size")

    def __init__(self, buffer_window: int | None = None) -> None:
        self._buf = ""
        self._window_size = buffer_window if buffer_window is not None else DEFAULT_BUFFER_WINDOW

    def push(self, chunk: str) -> str:
        if chunk == "":
            return ""
        self._buf += chunk
        unsafe_start = find_unsafe_boundary(self._buf, self._window_size)
        if unsafe_start == 0:
            return ""
        safe = self._buf[:unsafe_start]
        self._buf = self._buf[unsafe_start:]
        return safe

    def flush(self) -> str:
        remaining = self._buf
        self._buf = ""
        return remaining

    def size(self) -> int:
        return len(self._buf)


def create_stream_buffer(buffer_window: int | None = None) -> StreamBuffer:
    return StreamBuffer(buffer_window)
