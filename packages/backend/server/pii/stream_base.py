"""Shared SSE transformer plumbing — the common half of
``proxy/src/stream/{anthropic,openai,codex}-sse.ts``.

Each transformer sits between the upstream LLM and the client, restoring tokens
inside streamed deltas. Two things are held back and released late:

**Text** goes through a :class:`~server.pii.stream_buffer.StreamBuffer` per
block/choice/output index, so a token split across deltas is restored whole.

**Tool-call arguments** are accumulated rather than buffered: they are JSON
fragments, so a partial one cannot be parsed and a token can straddle any
boundary. They are restored in one piece when the provider signals the call is
complete, or at stream close.

``flush_on_close`` exists because a stream can end without that signal (client
abort, upstream truncation); dropping the accumulator would silently swallow
the tail of a tool call.
"""

from __future__ import annotations

import json
from typing import Any, Final

from .sse import SseEvent, SseLineParser, StreamRestoreScope
from .stream_buffer import StreamBuffer, create_stream_buffer

DEFAULT_SSE_BUFFER_WINDOW: Final = 64


def loads_or_none(data: str) -> Any | None:
    try:
        return json.loads(data)
    except ValueError:
        return None


class BaseSseTransformer:
    """Shared plumbing: incremental parsing, per-index buffers, closed latch."""

    __slots__ = ("_buffer_window", "_closed", "_flush_on_close", "_parser", "_scope")

    def __init__(
        self,
        scope: StreamRestoreScope,
        *,
        buffer_window: int | None = None,
        flush_on_close: bool = True,
    ) -> None:
        self._parser = SseLineParser()
        self._scope = scope
        self._buffer_window = (
            buffer_window if buffer_window is not None else DEFAULT_SSE_BUFFER_WINDOW
        )
        self._flush_on_close = flush_on_close
        self._closed = False

    def push(self, chunk: str) -> str:
        if self._closed:
            return ""
        return "".join(self._handle_event(ev) for ev in self._parser.push(chunk))

    def flush(self) -> str:
        if self._closed:
            return ""
        self._closed = True
        out = "".join(self._handle_event(ev) for ev in self._parser.flush())
        if self._flush_on_close:
            out += self._drain()
        self._clear()
        return out

    def _handle_event(self, ev: SseEvent) -> str:
        raise NotImplementedError

    def _drain(self) -> str:
        raise NotImplementedError

    def _clear(self) -> None:
        raise NotImplementedError

    @staticmethod
    def _get_buffer(buffers: dict[int, StreamBuffer], index: int, window: int) -> StreamBuffer:
        buf = buffers.get(index)
        if buf is None:
            buf = create_stream_buffer(window)
            buffers[index] = buf
        return buf
