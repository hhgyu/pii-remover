"""Per-provider SSE transformers — port of ``proxy/src/stream/{anthropic,openai,codex}-sse.ts``.

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

from .sse import SseEvent, SseLineParser, StreamRestoreScope, js_json_dumps, serialize_sse_event
from .stream_buffer import StreamBuffer, create_stream_buffer

_DEFAULT_BUFFER_WINDOW: Final = 64

CODEX_TEXT_DELTA_EVENT: Final = "response.output_text.delta"
CODEX_TEXT_DONE_EVENT: Final = "response.output_text.done"
_CODEX_FUNC_ARGS_DELTA_EVENT: Final = "response.function_call_arguments.delta"
_CODEX_FUNC_ARGS_DONE_EVENT: Final = "response.function_call_arguments.done"


def _loads_or_none(data: str) -> Any | None:
    try:
        return json.loads(data)
    except ValueError:
        return None


class _BaseTransformer:
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
        self._buffer_window = buffer_window if buffer_window is not None else _DEFAULT_BUFFER_WINDOW
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


class AnthropicSseTransformer(_BaseTransformer):
    __slots__ = ("_buffers", "_tool_inputs")

    def __init__(self, scope: StreamRestoreScope, **kwargs: Any) -> None:
        super().__init__(scope, **kwargs)
        self._buffers: dict[int, StreamBuffer] = {}
        self._tool_inputs: dict[int, str] = {}

    def _handle_event(self, ev: SseEvent) -> str:
        if ev.event == "content_block_delta":
            return self._handle_delta(ev)
        if ev.event == "content_block_stop":
            return self._handle_stop(ev)
        return serialize_sse_event(ev)

    def _handle_delta(self, ev: SseEvent) -> str:
        obj = _loads_or_none(ev.data)
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

        if delta_type != "text_delta":
            return serialize_sse_event(ev)

        buf = self._get_buffer(self._buffers, block_index, self._buffer_window)
        incoming = delta_dict.get("text")
        safe = buf.push(incoming if isinstance(incoming, str) else "")
        if safe == "":
            return ""
        out = {**obj, "delta": {**delta_dict, "text": self._scope.text(safe)}}
        return serialize_sse_event(SseEvent(data=js_json_dumps(out), event=ev.event))

    def _handle_stop(self, ev: SseEvent) -> str:
        obj = _loads_or_none(ev.data)
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
        return out

    def _clear(self) -> None:
        self._tool_inputs.clear()
        self._buffers.clear()

    @staticmethod
    def _tool_delta_event(index: int, partial_json: str) -> str:
        return serialize_sse_event(
            SseEvent(
                event="content_block_delta",
                data=js_json_dumps(
                    {
                        "type": "content_block_delta",
                        "index": index,
                        "delta": {"type": "input_json_delta", "partial_json": partial_json},
                    }
                ),
            )
        )

    @staticmethod
    def _text_delta_event(index: int, text: str) -> str:
        return serialize_sse_event(
            SseEvent(
                event="content_block_delta",
                data=js_json_dumps(
                    {
                        "type": "content_block_delta",
                        "index": index,
                        "delta": {"type": "text_delta", "text": text},
                    }
                ),
            )
        )


class OpenAISseTransformer(_BaseTransformer):
    __slots__ = ("_content_buffers", "_tool_args")

    def __init__(self, scope: StreamRestoreScope, **kwargs: Any) -> None:
        super().__init__(scope, **kwargs)
        self._content_buffers: dict[int, StreamBuffer] = {}
        self._tool_args: dict[str, str] = {}

    def _handle_event(self, ev: SseEvent) -> str:
        if ev.data == "[DONE]":
            return serialize_sse_event(ev)
        obj = _loads_or_none(ev.data)
        if not isinstance(obj, dict) or not isinstance(obj.get("choices"), list):
            return serialize_sse_event(ev)

        mutated = False
        all_held = True
        next_choices: list[Any] = []

        for choice in obj["choices"]:
            if not isinstance(choice, dict):
                all_held = False
                next_choices.append(choice)
                continue
            choice_idx = choice["index"] if isinstance(choice.get("index"), int) else 0
            delta = choice.get("delta")
            delta_dict = delta if isinstance(delta, dict) else {}

            if isinstance(delta_dict.get("tool_calls"), list):
                all_held = False
                for tc in delta_dict["tool_calls"]:
                    if not isinstance(tc, dict):
                        continue
                    tc_idx = tc["index"] if isinstance(tc.get("index"), int) else 0
                    fn = tc.get("function")
                    chunk = fn.get("arguments") if isinstance(fn, dict) else None
                    if isinstance(chunk, str):
                        key = f"{choice_idx}:{tc_idx}"
                        self._tool_args[key] = self._tool_args.get(key, "") + chunk
                next_choices.append({**choice, "delta": {**delta_dict, "tool_calls": []}})
                continue

            content = delta_dict.get("content")
            if not isinstance(content, str):
                all_held = False
                next_choices.append(choice)
                continue

            buf = self._get_buffer(self._content_buffers, choice_idx, self._buffer_window)
            safe = buf.push(content)
            if safe == "":
                next_choices.append({**choice, "delta": {**delta_dict, "content": ""}})
                continue
            all_held = False
            mutated = True
            next_choices.append(
                {**choice, "delta": {**delta_dict, "content": self._scope.text(safe)}}
            )

        if all_held and len(obj["choices"]) > 0:
            return ""
        if not mutated:
            return serialize_sse_event(ev)
        return serialize_sse_event(
            SseEvent(data=js_json_dumps({**obj, "choices": next_choices}), event=ev.event)
        )

    def _drain(self) -> str:
        out = ""
        for choice_idx, buf in self._content_buffers.items():
            remaining = buf.flush()
            if remaining != "":
                out += serialize_sse_event(
                    SseEvent(
                        data=js_json_dumps(
                            {
                                "choices": [
                                    {
                                        "index": choice_idx,
                                        "delta": {"content": self._scope.text(remaining)},
                                    }
                                ]
                            }
                        )
                    )
                )

        pending: dict[int, list[dict[str, Any]]] = {}
        for key, accum in self._tool_args.items():
            choice_str, tc_str = key.split(":")
            pending.setdefault(int(choice_str), []).append(
                {"index": int(tc_str), "function": {"arguments": self._scope.json(accum)}}
            )
        for choice_idx, tool_calls in pending.items():
            out += serialize_sse_event(
                SseEvent(
                    data=js_json_dumps(
                        {"choices": [{"index": choice_idx, "delta": {"tool_calls": tool_calls}}]}
                    )
                )
            )
        return out

    def _clear(self) -> None:
        self._content_buffers.clear()
        self._tool_args.clear()


class CodexSseTransformer(_BaseTransformer):
    __slots__ = ("_func_args", "_text_buffers")

    def __init__(self, scope: StreamRestoreScope, **kwargs: Any) -> None:
        super().__init__(scope, **kwargs)
        self._text_buffers: dict[int, StreamBuffer] = {}
        self._func_args: dict[int, str] = {}

    def _handle_event(self, ev: SseEvent) -> str:
        if ev.event in (_CODEX_FUNC_ARGS_DELTA_EVENT, _CODEX_FUNC_ARGS_DONE_EVENT):
            return self._handle_func_args(ev)
        if ev.event != CODEX_TEXT_DELTA_EVENT:
            return serialize_sse_event(ev)

        payload = _loads_or_none(ev.data)
        if not isinstance(payload, dict) or not isinstance(payload.get("delta"), str):
            return serialize_sse_event(ev)

        output_idx = payload["output_index"] if isinstance(payload.get("output_index"), int) else 0
        buf = self._get_buffer(self._text_buffers, output_idx, self._buffer_window)
        safe = buf.push(payload["delta"])
        if safe == "":
            return ""
        return serialize_sse_event(
            SseEvent(
                data=js_json_dumps({**payload, "delta": self._scope.text(safe)}),
                event=ev.event,
            )
        )

    def _handle_func_args(self, ev: SseEvent) -> str:
        payload = _loads_or_none(ev.data)
        if not isinstance(payload, dict):
            return serialize_sse_event(ev)
        output_idx = payload["output_index"] if isinstance(payload.get("output_index"), int) else 0

        if ev.event == _CODEX_FUNC_ARGS_DONE_EVENT:
            accum = self._func_args.pop(output_idx, "")
            return serialize_sse_event(
                SseEvent(
                    data=js_json_dumps({**payload, "delta": self._scope.json(accum)}),
                    event=ev.event,
                )
            )

        chunk = payload.get("delta")
        self._func_args[output_idx] = self._func_args.get(output_idx, "") + (
            chunk if isinstance(chunk, str) else ""
        )
        return ""

    def _drain(self) -> str:
        out = ""
        for output_idx, buf in self._text_buffers.items():
            remaining = buf.flush()
            if remaining != "":
                out += serialize_sse_event(
                    SseEvent(
                        event=CODEX_TEXT_DELTA_EVENT,
                        data=js_json_dumps(
                            {
                                "type": CODEX_TEXT_DELTA_EVENT,
                                "output_index": output_idx,
                                "delta": self._scope.text(remaining),
                            }
                        ),
                    )
                )
        for output_idx, accum in self._func_args.items():
            if accum != "":
                out += serialize_sse_event(
                    SseEvent(
                        event=_CODEX_FUNC_ARGS_DELTA_EVENT,
                        data=js_json_dumps(
                            {
                                "type": _CODEX_FUNC_ARGS_DELTA_EVENT,
                                "output_index": output_idx,
                                "delta": self._scope.json(accum),
                            }
                        ),
                    )
                )
        return out

    def _clear(self) -> None:
        self._text_buffers.clear()
        self._func_args.clear()
