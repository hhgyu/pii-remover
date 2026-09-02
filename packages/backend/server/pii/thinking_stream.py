"""Per-block state for one streamed extended-thinking response — port of
``proxy/src/stream/anthropic-thinking.ts``.

A thinking block arrives as an arbitrary split of ``thinking_delta`` chunks
followed by a ``signature_delta`` and ``content_block_stop``. Two different
things have to happen to those chunks at once:

1. **Display** — the client must see restored PII, so the chunks go through a
   token-boundary :class:`~server.pii.stream_buffer.StreamBuffer`: a
   ``{{OPF:…}}`` token split across two deltas is held until it is whole, then
   restored.
2. **Replay** — the *unrestored* upstream bytes are what Anthropic signed, so
   they are accumulated verbatim in parallel and cached under the block's
   signature for the next request to substitute back in.

The two streams must not be conflated: restoring changes the byte length, and a
single restored byte breaks signature verification with a 400.

Both jobs hang off the cache. Without one there is nowhere to keep the signed
bytes, so restoring for display would hand the client text it can never replay —
thinking is then passed through masked, end to end.
"""

from __future__ import annotations

from dataclasses import dataclass

from .sse import StreamRestoreScope
from .stream_buffer import StreamBuffer, create_stream_buffer
from .thinking_cache import ThinkingCache


@dataclass(frozen=True, slots=True)
class ThinkingTail:
    """Restored thinking text still owed to the client for a block."""

    index: int
    text: str


class ThinkingStreamAccumulator:
    __slots__ = ("_buffer_window", "_buffers", "_cache", "_raw", "_scope", "_signatures")

    def __init__(
        self,
        *,
        scope: StreamRestoreScope,
        buffer_window: int,
        cache: ThinkingCache | None = None,
    ) -> None:
        self._scope = scope
        self._buffer_window = buffer_window
        self._cache = cache
        self._raw: dict[int, str] = {}
        self._buffers: dict[int, StreamBuffer] = {}
        self._signatures: dict[int, str] = {}

    def push_thinking(self, index: int, chunk: str) -> str:
        """Accumulate the raw chunk for replay and return the slice of restored
        thinking that is now safe to display — empty while a token is still
        straddling the delta boundary.

        With no cache the chunk is forwarded untouched instead: what the client
        is shown is what it replays next turn, and only unaltered bytes survive
        Anthropic's signature check.
        """
        if self._cache is None:
            return chunk
        self._raw[index] = self._raw.get(index, "") + chunk
        return self._scope.text(self._get_buffer(index).push(chunk))

    def push_signature(self, index: int, chunk: str) -> None:
        """Signature bytes are opaque: accumulated for the cache key, never altered."""
        self._signatures[index] = self._signatures.get(index, "") + chunk

    def stop(self, index: int) -> str:
        """Close block ``index``: cache the raw upstream thinking under its full
        signature and return whatever restored text the buffer still holds.

        A signature with no thinking behind it is the ``display: "omitted"``
        shape — Anthropic signs the block but streams no ``thinking_delta``. The
        bytes it signed are the empty string, so that is what gets cached;
        caching nothing would make the client's next replay unresolvable.
        """
        tail = ""
        buf = self._buffers.pop(index, None)
        if buf is not None:
            tail = self._scope.text(buf.flush())
        raw = self._raw.pop(index, "")
        signature = self._signatures.pop(index, "")
        if signature != "" and self._cache is not None:
            self._cache.set(signature, raw)
        return tail

    def drain(self) -> list[ThinkingTail]:
        """Restored tails for blocks the stream ended without closing.

        Deliberately does not cache: ``signature_delta`` may itself be chunked,
        so without ``content_block_stop`` there is no proof the accumulated
        signature is complete. Caching a truncated key would answer a later
        lookup with bytes Anthropic never signed; skipping it yields a miss, and
        a miss is refused outright next turn — a legible local error beats a
        silent upstream 400.
        """
        tails: list[ThinkingTail] = []
        for index, buf in self._buffers.items():
            remaining = buf.flush()
            if remaining != "":
                tails.append(ThinkingTail(index=index, text=self._scope.text(remaining)))
        return tails

    def clear(self) -> None:
        self._raw.clear()
        self._buffers.clear()
        self._signatures.clear()

    def _get_buffer(self, index: int) -> StreamBuffer:
        buf = self._buffers.get(index)
        if buf is None:
            buf = create_stream_buffer(self._buffer_window)
            self._buffers[index] = buf
        return buf
