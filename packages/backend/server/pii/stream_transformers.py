"""OpenAI and Codex SSE transformers — port of
``proxy/src/stream/{openai,codex}-sse.ts``.

The shared plumbing lives in :mod:`server.pii.stream_base`; Anthropic has a
module of its own (:mod:`server.pii.stream_anthropic`) because signed thinking
blocks force it to keep two copies of the same text. ``AnthropicSseTransformer``
is re-exported here so the three providers stay importable from one place.
"""

from __future__ import annotations

from typing import Any, Final

from .sse import SseEvent, StreamRestoreScope, js_json_dumps, serialize_sse_event
from .stream_anthropic import AnthropicSseTransformer
from .stream_base import BaseSseTransformer, loads_or_none
from .stream_buffer import StreamBuffer

__all__ = [
    "CODEX_TEXT_DELTA_EVENT",
    "CODEX_TEXT_DONE_EVENT",
    "AnthropicSseTransformer",
    "CodexSseTransformer",
    "OpenAISseTransformer",
]

CODEX_TEXT_DELTA_EVENT: Final = "response.output_text.delta"
CODEX_TEXT_DONE_EVENT: Final = "response.output_text.done"
_CODEX_FUNC_ARGS_DELTA_EVENT: Final = "response.function_call_arguments.delta"
_CODEX_FUNC_ARGS_DONE_EVENT: Final = "response.function_call_arguments.done"


class OpenAISseTransformer(BaseSseTransformer):
    __slots__ = ("_content_buffers", "_tool_args")

    def __init__(self, scope: StreamRestoreScope, **kwargs: Any) -> None:
        super().__init__(scope, **kwargs)
        self._content_buffers: dict[int, StreamBuffer] = {}
        self._tool_args: dict[str, str] = {}

    def _handle_event(self, ev: SseEvent) -> str:
        if ev.data == "[DONE]":
            return serialize_sse_event(ev)
        obj = loads_or_none(ev.data)
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
                mutated = True
                # Only the arguments fragment is withheld. ``id``, ``type``,
                # ``index`` and ``function.name`` arrive once, on the first
                # delta, and are what the client dispatches on — dropping them
                # strands the tool call.
                held_tool_calls: list[Any] = []
                for tc in delta_dict["tool_calls"]:
                    fn = tc.get("function") if isinstance(tc, dict) else None
                    if not isinstance(fn, dict):
                        held_tool_calls.append(tc)
                        continue
                    chunk = fn.get("arguments")
                    if not isinstance(chunk, str):
                        held_tool_calls.append(tc)
                        continue
                    tc_idx = tc["index"] if isinstance(tc.get("index"), int) else 0
                    key = f"{choice_idx}:{tc_idx}"
                    self._tool_args[key] = self._tool_args.get(key, "") + chunk
                    held_tool_calls.append({**tc, "function": {**fn, "arguments": ""}})
                next_choices.append(
                    {**choice, "delta": {**delta_dict, "tool_calls": held_tool_calls}}
                )
                continue

            content = delta_dict.get("content")
            if not isinstance(content, str):
                all_held = False
                next_choices.append(choice)
                continue

            buf = self._get_buffer(self._content_buffers, choice_idx, self._buffer_window)
            safe = buf.push(content)
            if safe == "":
                mutated = True
                next_choices.append({**choice, "delta": {**delta_dict, "content": ""}})
                continue
            all_held = False
            mutated = True
            next_choices.append(
                {**choice, "delta": {**delta_dict, "content": self._scope.text(safe)}}
            )

        if all_held and len(obj["choices"]) > 0:
            return ""
        # Every branch above that rewrites a choice must have set ``mutated``, or
        # this line re-emits the upstream event and the sanitized copy is dropped
        # — putting the live token back on the wire.
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


class CodexSseTransformer(BaseSseTransformer):
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

        payload = loads_or_none(ev.data)
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
        payload = loads_or_none(ev.data)
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
