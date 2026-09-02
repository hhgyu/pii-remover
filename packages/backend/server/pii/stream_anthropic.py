"""Anthropic SSE transformer — port of ``proxy/src/stream/anthropic-sse.ts``.

Text and tool-call arguments behave the way they do for every other provider.
``thinking`` is the exception, and the reason this transformer has a module of
its own: its bytes are signed, so the copy shown to the user and the copy
replayed upstream can never be the same string. See
:mod:`server.pii.thinking_stream` for the split, and
:mod:`server.pii.thinking_cache` for why the signed bytes have to be kept.
"""

from __future__ import annotations

from typing import Any

from .sse import SseEvent, StreamRestoreScope, js_json_dumps, serialize_sse_event
from .stream_base import BaseSseTransformer, loads_or_none
from .stream_buffer import StreamBuffer
from .thinking_cache import ThinkingCache
from .thinking_stream import ThinkingStreamAccumulator


class AnthropicSseTransformer(BaseSseTransformer):
    __slots__ = ("_buffers", "_thinking", "_tool_inputs")

    def __init__(
        self,
        scope: StreamRestoreScope,
        *,
        thinking_cache: ThinkingCache | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(scope, **kwargs)
        self._buffers: dict[int, StreamBuffer] = {}
        self._tool_inputs: dict[int, str] = {}
        self._thinking = ThinkingStreamAccumulator(
            scope=scope, buffer_window=self._buffer_window, cache=thinking_cache
        )

    def _handle_event(self, ev: SseEvent) -> str:
        if ev.event == "content_block_delta":
            return self._handle_delta(ev)
        if ev.event == "content_block_stop":
            return self._handle_stop(ev)
        return serialize_sse_event(ev)

    def _handle_delta(self, ev: SseEvent) -> str:
        obj = loads_or_none(ev.data)
        if not isinstance(obj, dict):
            return serialize_sse_event(ev)
        block_index = obj["index"] if isinstance(obj.get("index"), int) else 0
        delta = obj.get("delta")
        delta_dict: dict[str, Any] = delta if isinstance(delta, dict) else {}
        delta_type = delta_dict.get("type")

        if delta_type == "input_json_delta":
            chunk = delta_dict.get("partial_json")
            self._tool_inputs[block_index] = self._tool_inputs.get(block_index, "") + (
                chunk if isinstance(chunk, str) else ""
            )
            return ""

        if delta_type == "thinking_delta":
            return self._handle_thinking_delta(ev, obj, delta_dict, block_index)

        if delta_type == "signature_delta":
            # Opaque bytes: accumulated for the cache key and relayed verbatim,
            # because the client has to echo them back byte-identically.
            signature = delta_dict.get("signature")
            self._thinking.push_signature(
                block_index, signature if isinstance(signature, str) else ""
            )
            return serialize_sse_event(ev)

        if delta_type != "text_delta":
            return serialize_sse_event(ev)

        buf = self._get_buffer(self._buffers, block_index, self._buffer_window)
        incoming = delta_dict.get("text")
        safe = buf.push(incoming if isinstance(incoming, str) else "")
        if safe == "":
            return ""
        out = {**obj, "delta": {**delta_dict, "text": self._scope.text(safe)}}
        return serialize_sse_event(SseEvent(data=js_json_dumps(out), event=ev.event))

    def _handle_thinking_delta(
        self,
        ev: SseEvent,
        obj: dict[str, Any],
        delta_dict: dict[str, Any],
        block_index: int,
    ) -> str:
        chunk = delta_dict.get("thinking")
        restored = self._thinking.push_thinking(
            block_index, chunk if isinstance(chunk, str) else ""
        )
        if restored == "":
            return ""
        out = {**obj, "delta": {**delta_dict, "thinking": restored}}
        return serialize_sse_event(SseEvent(data=js_json_dumps(out), event=ev.event))

    def _handle_stop(self, ev: SseEvent) -> str:
        obj = loads_or_none(ev.data)
        block_index = (
            obj["index"] if isinstance(obj, dict) and isinstance(obj.get("index"), int) else 0
        )
        out = ""

        if block_index in self._tool_inputs:
            accum = self._tool_inputs.pop(block_index)
            restored = self._scope.json(accum)
            if restored != accum:
                out += self._tool_delta_event(block_index, restored)
            elif accum != "":
                out += self._tool_delta_event(block_index, accum)

        buf = self._buffers.pop(block_index, None)
        if buf is not None:
            remaining = buf.flush()
            if remaining != "":
                out += self._text_delta_event(block_index, self._scope.text(remaining))

        thinking_tail = self._thinking.stop(block_index)
        if thinking_tail != "":
            out += self._thinking_delta_event(block_index, thinking_tail)

        return out + serialize_sse_event(ev)

    def _drain(self) -> str:
        out = ""
        for idx, accum in self._tool_inputs.items():
            if accum != "":
                out += self._tool_delta_event(idx, self._scope.json(accum))
        for idx, buf in self._buffers.items():
            remaining = buf.flush()
            if remaining != "":
                out += self._text_delta_event(idx, self._scope.text(remaining))
        for tail in self._thinking.drain():
            out += self._thinking_delta_event(tail.index, tail.text)
        return out

    def _clear(self) -> None:
        self._tool_inputs.clear()
        self._buffers.clear()
        self._thinking.clear()

    @staticmethod
    def _delta_event(index: int, delta: dict[str, str]) -> str:
        return serialize_sse_event(
            SseEvent(
                event="content_block_delta",
                data=js_json_dumps(
                    {"type": "content_block_delta", "index": index, "delta": delta}
                ),
            )
        )

    @classmethod
    def _tool_delta_event(cls, index: int, partial_json: str) -> str:
        return cls._delta_event(index, {"type": "input_json_delta", "partial_json": partial_json})

    @classmethod
    def _text_delta_event(cls, index: int, text: str) -> str:
        return cls._delta_event(index, {"type": "text_delta", "text": text})

    @classmethod
    def _thinking_delta_event(cls, index: int, thinking: str) -> str:
        return cls._delta_event(index, {"type": "thinking_delta", "thinking": thinking})
