"""The signed-thinking round trip — port of
``proxy/src/providers/thinking-replay.ts``.

Cache what Anthropic signed on the way out, put those exact bytes back on the
way in.

Anthropic verifies a replayed ``thinking`` block against its opaque signature
and rejects the request unless the bytes are identical to what it emitted. The
proxy, meanwhile, shows the user *restored* thinking, so the bytes the client
replays are not the bytes that were signed. Re-masking is not a way back either:
detection is a model, and one span it fails to re-detect on the second pass
would put plaintext PII on the wire.

Hence the rules this module encodes:

- Restore for display **only** when the signed bytes were cached first.
- **Never forward** a block that cannot be resolved — drop it instead.
- An empty ``thinking`` was never restored, so it bypasses the cache.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .thinking_cache import ThinkingCache


@dataclass(frozen=True, slots=True)
class _ForwardBlock:
    block: Any


def is_anthropic_thinking_block(block: Any) -> bool:
    return (
        isinstance(block, dict)
        and block.get("type") == "thinking"
        and isinstance(block.get("thinking"), str)
        and isinstance(block.get("signature"), str)
    )


def replay_thinking(messages: Any, cache: ThinkingCache | None) -> list[Any]:
    """Swap every replayed thinking block back to the bytes Anthropic signed.

    With no cache nothing was ever restored, so there is nothing to undo and the
    messages pass through untouched.

    A block that cannot be resolved is dropped, never forwarded: forwarding it
    would put the user's plaintext PII on the wire. Dropping is verified against
    the live API across manual, adaptive and thinking-disabled requests, and for
    tool-use turns — upstream accepts an assistant turn with no thinking block.
    """
    msgs: list[Any] = messages if isinstance(messages, list) else []
    if cache is None:
        return msgs

    out: list[Any] = []
    for message in msgs:
        if not _is_assistant_turn(message):
            out.append(message)
            continue
        blocks = [
            replay.block
            for replay in (_resolve_thinking_block(b, cache) for b in message["content"])
            if replay is not None
        ]
        out.append({**message, "content": blocks})
    return out


def restore_thinking_block(
    block: dict[str, Any],
    cache: ThinkingCache | None,
    restore: Callable[[str], str],
) -> dict[str, Any]:
    """Restore a response thinking block for the user's eyes only after its
    signed bytes are safely cached — the cache is what lets the next request
    replay them byte-identically. With no cache there is no way back, so the
    block is left masked instead.

    A ``display: "omitted"`` block arrives signed with an empty ``thinking``;
    caching that empty string is what makes its replay resolvable next turn.
    """
    thinking = block.get("thinking")
    signature = block.get("signature")
    if (
        cache is None
        or not isinstance(thinking, str)
        or not isinstance(signature, str)
        or signature == ""
    ):
        return block
    cache.set(signature, thinking)
    return {**block, "thinking": restore(thinking)}


def _is_assistant_turn(message: Any) -> bool:
    """Only an assistant turn carries thinking; user turns are forwarded as-is."""
    return (
        isinstance(message, dict)
        and message.get("role") == "assistant"
        and isinstance(message.get("content"), list)
    )


def _resolve_thinking_block(block: Any, cache: ThinkingCache) -> _ForwardBlock | None:
    """``redacted_thinking`` and every non-thinking block are forwarded verbatim —
    they carry no plaintext and Anthropic expects them back unchanged. ``None``
    means the block cannot be resolved and must be dropped."""
    if not isinstance(block, dict) or block.get("type") != "thinking":
        return _ForwardBlock(block=block)
    if not is_anthropic_thinking_block(block):
        return None
    # Safe because ``restore`` only swaps a token for its original and never
    # empties a string: "" on the way in proves "" is what upstream signed, so
    # there is no plaintext to leak. Adaptive-thinking models return this shape
    # for *every* block, which would make a cache miss here fatal for nothing.
    if block["thinking"] == "":
        return _ForwardBlock(block=block)
    signed = cache.get(block["signature"])
    if signed is None:
        return None
    return _ForwardBlock(block={**block, "thinking": signed})
