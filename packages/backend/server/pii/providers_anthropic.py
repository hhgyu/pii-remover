"""Anthropic non-streaming transforms — port of ``proxy/src/providers/anthropic.ts``.

Split out of :mod:`server.pii.providers` because extended thinking gives this
one provider a second, signature-bound copy of the assistant's own text: the
copy the user reads is restored, and the copy Anthropic will verify next turn is
the masked original. :mod:`server.pii.thinking_replay` owns that split; this
module only decides where in the body it applies.

Images pass through unless an image redactor is supplied (Phase 6, ADR-0009).
"""

from __future__ import annotations

from typing import Any

from .providers import TokenCodec, walk_restore
from .system_note import OPF_PLACEHOLDER_SYSTEM_NOTE, append_placeholder_note
from .thinking_cache import ThinkingCache
from .thinking_replay import restore_thinking_block


def _mask_blocks(blocks: list[Any], codec: TokenCodec) -> list[Any]:
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


def _mask_system(system: Any, codec: TokenCodec) -> Any:
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


def _with_note(system: Any) -> Any:
    if not isinstance(system, list):
        return append_placeholder_note(system if isinstance(system, str) else None)
    if any(isinstance(b, dict) and b.get("text") == OPF_PLACEHOLDER_SYSTEM_NOTE for b in system):
        return system
    return [*system, {"type": "text", "text": OPF_PLACEHOLDER_SYSTEM_NOTE}]


def transform_anthropic_request(raw: dict[str, Any], codec: TokenCodec) -> dict[str, Any]:
    """Mask the outbound body.

    Thinking blocks are deliberately not touched here: their bytes are signed,
    so :func:`server.pii.thinking_replay.replay_thinking` has already restored
    them to exactly what Anthropic emitted before this runs.
    """
    messages: list[Any] = []
    for message in raw.get("messages") or []:
        if not isinstance(message, dict):
            messages.append(message)
            continue
        content = message.get("content")
        if isinstance(content, str):
            messages.append({**message, "content": codec.mask(content)})
        elif isinstance(content, list):
            messages.append({**message, "content": _mask_blocks(content, codec)})
        else:
            messages.append(message)

    out = {**raw, "messages": messages}
    out["system"] = _with_note(_mask_system(raw.get("system"), codec))
    return out


def restore_anthropic_response(
    body: dict[str, Any],
    codec: TokenCodec,
    *,
    thinking_cache: ThinkingCache | None = None,
) -> dict[str, Any]:
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
            restored.append({**block, "input": walk_restore(block["input"], codec)})
            continue
        if block.get("type") == "thinking":
            # Caches the signed bytes *before* restoring, which is the only
            # order that leaves the next turn replayable.
            restored.append(restore_thinking_block(block, thinking_cache, codec.restore))
            continue
        restored.append(block)
    return {**body, "content": restored}
