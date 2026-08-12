"""Non-streaming request/response transforms — port of ``proxy/src/providers/*.ts``.

Request side masks PII before it leaves the machine; response side restores it
before the client sees it. Streaming goes through
:mod:`server.pii.stream_transformers` instead.

Depends on a :class:`TokenCodec` rather than the whole detection stack so these
transforms stay unit-testable against a fixed vault, and so the wiring to the
in-process OPF pipeline lives in one place (the API layer) instead of here.

Two upstream defects are reproduced deliberately, because parity with the
TypeScript proxy is the contract. Both are pinned by tests:

- **Codex input ``arguments`` are not masked.** ``maskToolArguments`` in
  ``codex.ts`` calls ``walkAsyncSyncMask``, whose body is ``return value``. The
  JSON is parsed and re-serialised, never masked. PII inside a tool-call
  argument therefore reaches the upstream model in the clear.
- **Anthropic/OpenAI images pass through** unless an image redactor is supplied
  (Phase 6, ADR-0009).
"""

from __future__ import annotations

import json
from typing import Any, Protocol

from .sse import js_json_dumps
from .system_note import OPF_PLACEHOLDER_SYSTEM_NOTE, append_placeholder_note

_MASKABLE_CODEX_INPUT_TEXT_TYPES = frozenset({"input_text", "text"})
_RESTORABLE_CODEX_OUTPUT_TEXT_TYPES = frozenset({"output_text", "text"})


class TokenCodec(Protocol):
    """Masks PII into tokens and restores tokens back to PII."""

    def mask(self, text: str) -> str: ...

    def restore(self, text: str) -> str: ...


def _walk_restore(value: Any, codec: TokenCodec) -> Any:
    if isinstance(value, str):
        return codec.restore(value)
    if isinstance(value, list):
        return [_walk_restore(v, codec) for v in value]
    if isinstance(value, dict):
        return {k: _walk_restore(v, codec) for k, v in value.items()}
    return value


def _restore_json_arguments(raw: Any, codec: TokenCodec) -> Any:
    """Restore inside a JSON string argument, falling back to plain text.

    A tool-call argument that is not valid JSON is still worth restoring: the
    model may have emitted a bare string, and dropping the restore would show
    the user a token.
    """
    if not isinstance(raw, str) or raw == "":
        return raw
    try:
        parsed = json.loads(raw)
    except ValueError:
        return codec.restore(raw)
    return js_json_dumps(_walk_restore(parsed, codec))


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------


def _mask_anthropic_blocks(blocks: list[Any], codec: TokenCodec) -> list[Any]:
    out: list[Any] = []
    for block in blocks:
        if not isinstance(block, dict):
            out.append(block)
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            out.append({**block, "text": codec.mask(block["text"])})
            continue
        out.append(block)
    return out


def _mask_anthropic_system(system: Any, codec: TokenCodec) -> Any:
    if system is None:
        return None
    if isinstance(system, str):
        return codec.mask(system)
    if isinstance(system, list):
        out: list[Any] = []
        for entry in system:
            if isinstance(entry, dict) and isinstance(entry.get("text"), str):
                out.append({**entry, "text": codec.mask(entry["text"])})
            else:
                out.append(entry)
        return out
    return system


def _with_anthropic_note(system: Any) -> Any:
    if not isinstance(system, list):
        return append_placeholder_note(system if isinstance(system, str) else None)
    if any(isinstance(b, dict) and b.get("text") == OPF_PLACEHOLDER_SYSTEM_NOTE for b in system):
        return system
    return [*system, {"type": "text", "text": OPF_PLACEHOLDER_SYSTEM_NOTE}]


def transform_anthropic_request(raw: dict[str, Any], codec: TokenCodec) -> dict[str, Any]:
    messages: list[Any] = []
    for message in raw.get("messages") or []:
        if not isinstance(message, dict):
            messages.append(message)
            continue
        content = message.get("content")
        if isinstance(content, str):
            messages.append({**message, "content": codec.mask(content)})
        elif isinstance(content, list):
            messages.append({**message, "content": _mask_anthropic_blocks(content, codec)})
        else:
            messages.append(message)

    out = {**raw, "messages": messages}
    out["system"] = _with_anthropic_note(_mask_anthropic_system(raw.get("system"), codec))
    return out


def restore_anthropic_response(body: dict[str, Any], codec: TokenCodec) -> dict[str, Any]:
    content = body.get("content")
    if not isinstance(content, list):
        return body

    restored: list[Any] = []
    for block in content:
        if not isinstance(block, dict):
            restored.append(block)
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            restored.append({**block, "text": codec.restore(block["text"])})
            continue
        if block.get("type") == "tool_use" and block.get("input") is not None:
            restored.append({**block, "input": _walk_restore(block["input"], codec)})
            continue
        restored.append(block)
    return {**body, "content": restored}


# ---------------------------------------------------------------------------
# OpenAI (chat completions)
# ---------------------------------------------------------------------------


def _mask_openai_parts(parts: list[Any], codec: TokenCodec) -> list[Any]:
    out: list[Any] = []
    for part in parts:
        if not isinstance(part, dict):
            out.append(part)
            continue
        if part.get("type") == "text" and isinstance(part.get("text"), str):
            out.append({**part, "text": codec.mask(part["text"])})
            continue
        out.append(part)
    return out


def _with_openai_note(messages: list[Any]) -> list[Any]:
    """Append the note to the last system message, or insert one right after it.

    Keeping it adjacent to the existing system run means the cacheable prefix
    only shifts once, when the feature is first enabled.
    """
    last_system = -1
    for i, message in enumerate(messages):
        if isinstance(message, dict) and message.get("role") == "system":
            last_system = i

    existing = messages[last_system] if last_system >= 0 else None
    if isinstance(existing, dict) and isinstance(existing.get("content"), str):
        if OPF_PLACEHOLDER_SYSTEM_NOTE in existing["content"]:
            return messages
        nxt = list(messages)
        nxt[last_system] = {
            **existing,
            "content": append_placeholder_note(existing["content"]),
        }
        return nxt

    note = {"role": "system", "content": OPF_PLACEHOLDER_SYSTEM_NOTE}
    at = last_system + 1
    return [*messages[:at], note, *messages[at:]]


def transform_openai_request(raw: dict[str, Any], codec: TokenCodec) -> dict[str, Any]:
    messages: list[Any] = []
    for message in raw.get("messages") or []:
        if not isinstance(message, dict):
            messages.append(message)
            continue
        content = message.get("content")
        if isinstance(content, str):
            messages.append({**message, "content": codec.mask(content)})
        elif isinstance(content, list):
            messages.append({**message, "content": _mask_openai_parts(content, codec)})
        else:
            messages.append(message)
    return {**raw, "messages": _with_openai_note(messages)}


def restore_openai_response(body: dict[str, Any], codec: TokenCodec) -> dict[str, Any]:
    choices = body.get("choices")
    if not isinstance(choices, list):
        return body

    out_choices: list[Any] = []
    for choice in choices:
        if not isinstance(choice, dict) or not isinstance(choice.get("message"), dict):
            out_choices.append(choice)
            continue
        message = choice["message"]
        restored = dict(message)

        content = message.get("content")
        if isinstance(content, str):
            restored["content"] = codec.restore(content)
        elif isinstance(content, list):
            restored["content"] = [
                {**p, "text": codec.restore(p["text"])}
                if isinstance(p, dict)
                and p.get("type") == "text"
                and isinstance(p.get("text"), str)
                else p
                for p in content
            ]

        if isinstance(message.get("tool_calls"), list):
            restored["tool_calls"] = [
                {
                    **tc,
                    "function": {
                        **tc["function"],
                        "arguments": _restore_json_arguments(
                            tc["function"].get("arguments"), codec
                        ),
                    },
                }
                if isinstance(tc, dict) and isinstance(tc.get("function"), dict)
                else tc
                for tc in message["tool_calls"]
            ]

        out_choices.append({**choice, "message": restored})
    return {**body, "choices": out_choices}


# ---------------------------------------------------------------------------
# Codex (Responses API)
# ---------------------------------------------------------------------------


def _mask_codex_tool_arguments(raw: Any) -> Any:
    """Reproduces ``codex.ts`` exactly, no-op walk included.

    The TypeScript helper this mirrors delegates to ``walkAsyncSyncMask``, whose
    entire body is ``return value``. The JSON round-trips through parse and
    re-serialise without a single field being masked, so PII inside a tool-call
    argument reaches the upstream model in the clear. Reproduced rather than
    fixed because a Python side that masked here would produce a body the
    TypeScript proxy never produces.
    """
    if not isinstance(raw, str) or raw == "":
        return raw
    try:
        parsed = json.loads(raw)
    except ValueError:
        return raw
    return js_json_dumps(parsed)


def transform_codex_request(raw: dict[str, Any], codec: TokenCodec) -> dict[str, Any]:
    out = dict(raw)
    instructions = raw.get("instructions")
    masked_instructions = codec.mask(instructions) if isinstance(instructions, str) else None
    out["instructions"] = append_placeholder_note(masked_instructions)

    raw_input = raw.get("input")
    if isinstance(raw_input, str):
        out["input"] = codec.mask(raw_input)
    elif isinstance(raw_input, list):
        items: list[Any] = []
        for item in raw_input:
            if not isinstance(item, dict):
                items.append(item)
                continue
            if isinstance(item.get("content"), list):
                items.append({**item, "content": _mask_codex_content(item["content"], codec)})
                continue
            if isinstance(item.get("arguments"), str):
                items.append({**item, "arguments": _mask_codex_tool_arguments(item["arguments"])})
                continue
            items.append(item)
        out["input"] = items
    return out


def _mask_codex_content(parts: list[Any], codec: TokenCodec) -> list[Any]:
    out: list[Any] = []
    for part in parts:
        if not isinstance(part, dict):
            out.append(part)
            continue
        if (
            isinstance(part.get("text"), str)
            and part.get("type") in _MASKABLE_CODEX_INPUT_TEXT_TYPES
        ):
            out.append({**part, "text": codec.mask(part["text"])})
            continue
        out.append(part)
    return out


def restore_codex_response(body: dict[str, Any], codec: TokenCodec) -> dict[str, Any]:
    out = dict(body)
    if isinstance(body.get("output"), list):
        out["output"] = [_restore_codex_item(item, codec) for item in body["output"]]
    if isinstance(body.get("output_text"), str):
        out["output_text"] = codec.restore(body["output_text"])
    return out


def _restore_codex_item(item: Any, codec: TokenCodec) -> Any:
    if not isinstance(item, dict):
        return item
    nxt = item
    if isinstance(item.get("content"), list):
        nxt = {
            **nxt,
            "content": [_restore_codex_content(p, codec) for p in item["content"]],
        }
    if isinstance(item.get("arguments"), str):
        nxt = {**nxt, "arguments": _restore_json_arguments(item["arguments"], codec)}
    return nxt


def _restore_codex_content(part: Any, codec: TokenCodec) -> Any:
    if not isinstance(part, dict):
        return part
    if (
        isinstance(part.get("text"), str)
        and part.get("type") in _RESTORABLE_CODEX_OUTPUT_TEXT_TYPES
    ):
        return {**part, "text": codec.restore(part["text"])}
    return part
