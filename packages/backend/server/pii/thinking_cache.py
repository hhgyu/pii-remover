"""Signature-keyed store of signed thinking bytes — port of
``proxy/src/stream/thinking-cache.ts``.

Anthropic verifies a replayed ``thinking`` block against its opaque
``signature`` and rejects the request with 400 unless the bytes are identical to
what it emitted. The proxy, however, hands the client *restored* thinking so the
user can read their own PII — so the bytes the client replays are not the bytes
that were signed, and no masking pass can reconstruct them (the token hash is
minted per vault entry, and the signature covers the exact original string).

The only sound answer is to remember the original: cache the upstream bytes
under their signature on the way out, and substitute them back on the way in.

Invariants:

- **Only masked/raw upstream thinking is ever stored.** Restored PII must not
  enter this cache — it exists precisely to keep PII off the wire.
- **Bounded.** Entry count and total payload bytes are both capped; the oldest
  entry is evicted first (``dict`` insertion order), and a read moves its entry
  to the recent end so an actively replayed conversation stays warm.
- **In-memory, never persisted** — same lifetime as the session's vault.
"""

from __future__ import annotations

from typing import Final

DEFAULT_THINKING_CACHE_MAX_ENTRIES: Final = 256
"""One entry per thinking block; a long session replays a handful per turn."""

DEFAULT_THINKING_CACHE_MAX_BYTES: Final = 4 * 1024 * 1024
"""4 MiB — 256 entries of ~16 KB, the shape of a long extended-thinking block."""


class ThinkingCache:
    """Bounded, session-scoped map of ``signature -> masked thinking bytes``."""

    __slots__ = ("_bytes", "_entries", "_max_bytes", "_max_entries")

    def __init__(self, *, max_entries: int | None = None, max_bytes: int | None = None) -> None:
        self._entries: dict[str, str] = {}
        self._max_entries = max(
            1, max_entries if max_entries is not None else DEFAULT_THINKING_CACHE_MAX_ENTRIES
        )
        self._max_bytes = max(
            0, max_bytes if max_bytes is not None else DEFAULT_THINKING_CACHE_MAX_BYTES
        )
        self._bytes = 0

    def get(self, signature: str) -> str | None:
        """Exact bytes cached for ``signature``, or ``None`` on a miss.

        ``""`` is a legitimate cached value (the ``display: "omitted"`` shape),
        so a miss must be reported as ``None`` and never as a falsy string.
        """
        if signature == "":
            return None
        hit = self._entries.get(signature)
        if hit is None:
            return None
        # Re-insert to move the entry to the recent end of the dict's insertion
        # order: a block replayed on every turn must not age out of a long chat.
        del self._entries[signature]
        self._entries[signature] = hit
        return hit

    def set(self, signature: str, thinking: str) -> None:
        """Remember ``thinking`` (masked upstream bytes) under ``signature``."""
        if signature == "":
            return
        incoming = len(thinking.encode("utf-8"))
        # A value that can never fit is dropped before any eviction runs: letting
        # a doomed write purge the cache would turn one oversized block into a
        # cache miss for every other block in the conversation.
        if incoming > self._max_bytes:
            return

        self._forget(signature)
        while len(self._entries) >= self._max_entries or self._bytes + incoming > self._max_bytes:
            if not self._evict_oldest():
                break
        self._entries[signature] = thinking
        self._bytes += incoming

    def clear(self) -> None:
        self._entries.clear()
        self._bytes = 0

    def size(self) -> int:
        return len(self._entries)

    def _evict_oldest(self) -> bool:
        oldest = next(iter(self._entries), None)
        if oldest is None:
            return False
        self._forget(oldest)
        return True

    def _forget(self, signature: str) -> None:
        existing = self._entries.pop(signature, None)
        if existing is None:
            return
        self._bytes -= len(existing.encode("utf-8"))
