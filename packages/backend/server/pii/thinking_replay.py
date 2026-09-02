"""The signed-thinking round trip — port of
``proxy/src/providers/thinking-replay.ts``.

Cache what Anthropic signed on the way out, put those exact bytes back on the
way in.

Anthropic verifies a replayed ``thinking`` block against its opaque signature
and requires the assistant turn to be echoed back whole — a request that quietly
omits one block is answered with a 400 the user cannot diagnose. The proxy,
meanwhile, shows the user *restored* thinking, so the bytes the client replays
are not the bytes that were signed and no masking pass can rebuild them (the
token hash is minted per vault entry).

Hence the two rules this module encodes:

- Restore for display **only** when the signed bytes were cached first.
- Resolve a replayed turn **all or nothing** — never drop a block.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Final, assert_never

from .thinking_cache import ThinkingCache

THINKING_REPLAY_ERROR: Final = "thinking_replay_unavailable"

THINKING_REPLAY_REJECTION: Final[dict[str, str]] = {
    "error": THINKING_REPLAY_ERROR,
    "message": (
        "An extended-thinking block in this request could not be matched to the "
        "signed bytes this proxy holds for it. Forwarding it would either fail "
        "Anthropic's signature check or send restored text upstream, so the "
        "request was refused locally. Retry the turn without the stale thinking "
        "blocks, or start a new conversation."
    ),
}
"""Body of the local refusal for a turn that cannot be replayed byte-identically.

Answered with ``400`` on purpose: the Anthropic SDKs retry ``408``/``409``/
``429``/``5xx``, and this condition never heals on its own — a retry loop would
just repeat it. The message names the condition and nothing else: no signature,
no thinking text, no restored PII.
"""


@dataclass(frozen=True, slots=True)
class ThinkingReplayed:
    """Every replayed thinking block resolved to the bytes upstream signed."""

    messages: list[Any]


@dataclass(frozen=True, slots=True)
class ThinkingUnresolvable:
    """At least one block could not be matched to signed bytes; refuse the turn."""


ThinkingReplay = ThinkingReplayed | ThinkingUnresolvable


@dataclass(frozen=True, slots=True)
class _ForwardBlock:
    block: Any


_BlockReplay = _ForwardBlock | ThinkingUnresolvable


def is_anthropic_thinking_block(block: Any) -> bool:
    return (
        isinstance(block, dict)
        and block.get("type") == "thinking"
        and isinstance(block.get("thinking"), str)
        and isinstance(block.get("signature"), str)
    )


def replay_thinking(messages: Any, cache: ThinkingCache | None) -> ThinkingReplay:
    """Swap every replayed thinking block back to the bytes Anthropic signed.

    With no cache nothing was ever restored, so there is nothing to undo and the
    messages pass through untouched. With a cache, a block that cannot be
    resolved fails the whole request: dropping it would draw an opaque 400 from
    upstream, and forwarding it would put the user's plaintext PII on the wire.
    """
    msgs: list[Any] = messages if isinstance(messages, list) else []
    if cache is None:
        return ThinkingReplayed(messages=msgs)

    out: list[Any] = []
    for message in msgs:
        if not _is_assistant_turn(message):
            out.append(message)
            continue
        blocks: list[Any] = []
        for block in message["content"]:
            replay = _resolve_thinking_block(block, cache)
            match replay:
                case ThinkingUnresolvable():
                    return ThinkingUnresolvable()
                case _ForwardBlock(block=resolved):
                    blocks.append(resolved)
                case unreachable:
                    assert_never(unreachable)
        out.append({**message, "content": blocks})
    return ThinkingReplayed(messages=out)


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


def _resolve_thinking_block(block: Any, cache: ThinkingCache) -> _BlockReplay:
    """``redacted_thinking`` and every non-thinking block are forwarded verbatim —
    they carry no plaintext and Anthropic expects them back unchanged."""
    if not isinstance(block, dict) or block.get("type") != "thinking":
        return _ForwardBlock(block=block)
    if not is_anthropic_thinking_block(block):
        return ThinkingUnresolvable()
    signed = cache.get(block["signature"])
    if signed is None:
        return ThinkingUnresolvable()
    return _ForwardBlock(block={**block, "thinking": signed})
