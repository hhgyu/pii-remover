"""SSE parsing and restore scoping — port of ``proxy/src/stream/sse-parser.ts``
and ``proxy/src/stream/restore-scope.ts``.

The parser is deliberately incremental: upstream chunks do not align with event
boundaries, so :meth:`SseLineParser.push` returns only the events that are
complete and keeps the remainder for the next chunk.

:func:`js_json_dumps` is the load-bearing detail here. ``JSON.stringify`` and
:func:`json.dumps` disagree twice, and both defaults are wrong for us:

===============  ==========================  =============================
                 ``JSON.stringify``          ``json.dumps`` default
===============  ==========================  =============================
separators       ``{"a":1}``                 ``{"a": 1}``
non-ASCII        emitted raw (``김철수``)      escaped (``\\uae40...``)
===============  ==========================  =============================

The second one is not cosmetic: restoring a Korean name into a tool-call
argument would hand the model ``\\uae40\\ucca0\\uc218`` instead of ``김철수``,
which is a different string to every downstream consumer.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Final

from .restorer import RestoreOptions, Restorer
from .token_format import js_trim

_LINE_SPLIT: Final = re.compile(r"\r?\n")
_LEADING_BLANK_LINES: Final = re.compile(r"^(?:\r?\n)+")


def js_json_dumps(value: Any) -> str:
    """``JSON.stringify(value)`` — compact separators, raw non-ASCII."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


@dataclass(frozen=True, slots=True)
class SseEvent:
    data: str
    event: str | None = None
    raw: str = ""


def _next_event_end(buf: str) -> int:
    nn = buf.find("\n\n")
    rnn = buf.find("\r\n\r\n")
    if nn == -1 and rnn == -1:
        return -1
    if nn == -1:
        return rnn + 4
    if rnn == -1:
        return nn + 2
    return min(nn + 2, rnn + 4)


def _parse_event_block(block: str) -> SseEvent | None:
    event: str | None = None
    data_lines: list[str] = []
    for line in _LINE_SPLIT.split(block):
        if line == "" or line.startswith(":"):
            continue
        if line.startswith("event:"):
            event = js_trim(line[6:])
            continue
        if line.startswith("data:"):
            payload = line[5:]
            data_lines.append(payload[1:] if payload.startswith(" ") else payload)
    if not data_lines and event is None:
        return None
    return SseEvent(data="\n".join(data_lines), event=event, raw=block)


class SseLineParser:
    """Incremental SSE event reader."""

    __slots__ = ("_buf",)

    def __init__(self) -> None:
        self._buf = ""

    def push(self, chunk: str) -> list[SseEvent]:
        self._buf += chunk
        events: list[SseEvent] = []
        while True:
            idx = _next_event_end(self._buf)
            if idx == -1:
                break
            block = self._buf[:idx]
            self._buf = _LEADING_BLANK_LINES.sub("", self._buf[idx:])
            parsed = _parse_event_block(block)
            if parsed is not None:
                events.append(parsed)
        return events

    def flush(self) -> list[SseEvent]:
        if self._buf == "":
            return []
        parsed = _parse_event_block(self._buf)
        self._buf = ""
        return [parsed] if parsed is not None else []

    def size(self) -> int:
        return len(self._buf)


def serialize_sse_event(ev: SseEvent) -> str:
    parts: list[str] = []
    if ev.event:
        parts.append(f"event: {ev.event}")
    if ev.data:
        parts.extend(f"data: {line}" for line in ev.data.split("\n"))
    parts.append("")
    parts.append("")
    return "\n".join(parts)


class StreamRestoreScope:
    """Restores text and tool-call JSON for one streamed response.

    Bundles the restore call so the transformers do not thread session and
    options through every recursive walk.
    """

    __slots__ = ("_restore_text",)

    def __init__(self, restore_text: Callable[[str], str]) -> None:
        self._restore_text = restore_text

    def text(self, value: str) -> str:
        return value if value == "" else self._restore_text(value)

    def _walk(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self._walk(v) for v in value]
        if isinstance(value, dict):
            return {k: self._walk(v) for k, v in value.items()}
        return value

    def json(self, raw: str) -> str:
        """Restore inside a JSON document, tolerating a truncated one.

        A tool-call argument stream can be cut mid-object, so an unparseable
        fragment falls back to plain text restoration rather than being dropped.
        """
        if raw == "":
            return raw
        try:
            parsed = json.loads(raw)
        except ValueError:
            return self.text(raw)
        return js_json_dumps(self._walk(parsed))


def create_stream_restore_scope(
    restorer: Restorer,
    session_id: str,
    options: RestoreOptions | None = None,
) -> StreamRestoreScope:
    opts = options if options is not None else RestoreOptions()

    def restore_text(value: str) -> str:
        return restorer.restore(value, session_id, opts).text

    return StreamRestoreScope(restore_text)
