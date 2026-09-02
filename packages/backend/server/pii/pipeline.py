"""Per-transform stages of one proxied request.

Keyed by transform, never by route provider: ``/openai/v1/responses`` and
``/codex/v1/responses`` carry the same Responses body under two providers.

The stages run in a fixed order, and the order is the whole point. Replay first,
because a thinking block that cannot be matched to the bytes Anthropic signed
must abort the turn *before* anything is masked or sent. Mask second. Restore
last, on the way back, where the response side caches the newly signed bytes for
the next turn to replay.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, assert_never

from .providers import (
    TokenCodec,
    restore_codex_response,
    restore_openai_response,
    transform_codex_request,
    transform_openai_request,
)
from .providers_anthropic import restore_anthropic_response, transform_anthropic_request
from .router import MaskedTransform
from .session_pool import ProxySession
from .sse import StreamRestoreScope
from .stream_transformers import (
    AnthropicSseTransformer,
    CodexSseTransformer,
    OpenAISseTransformer,
)
from .thinking_replay import (
    ThinkingReplayed,
    ThinkingUnresolvable,
    replay_thinking,
)


class SseTransformer(Protocol):
    def push(self, chunk: str) -> str: ...

    def flush(self) -> str: ...


@dataclass(frozen=True, slots=True)
class StreamContext:
    """Everything one streamed response needs, minus the bytes."""

    scope: StreamRestoreScope
    session: ProxySession
    buffer_window: int
    flush_on_close: bool


@dataclass(frozen=True, slots=True)
class ReplayedRequest:
    body: dict[str, Any]


RequestReplay = ReplayedRequest | ThinkingUnresolvable


def replay_request(
    transform: MaskedTransform, body: dict[str, Any], session: ProxySession
) -> RequestReplay:
    """Resolve replayed thinking back to the bytes upstream signed, or refuse."""
    match transform:
        case "anthropic_messages":
            replay = replay_thinking(body.get("messages"), session.thinking_cache)
            match replay:
                case ThinkingUnresolvable():
                    return ThinkingUnresolvable()
                case ThinkingReplayed(messages=messages):
                    return ReplayedRequest(body={**body, "messages": messages})
                case unreachable:
                    assert_never(unreachable)
        case "openai_chat" | "responses":
            # Only Anthropic mints signed thinking; these bodies carry none.
            return ReplayedRequest(body=body)
        case unreachable:
            assert_never(unreachable)


def mask_request(
    transform: MaskedTransform, body: dict[str, Any], codec: TokenCodec
) -> dict[str, Any]:
    match transform:
        case "anthropic_messages":
            return transform_anthropic_request(body, codec)
        case "openai_chat":
            return transform_openai_request(body, codec)
        case "responses":
            return transform_codex_request(body, codec)
        case unreachable:
            assert_never(unreachable)


def restore_response(
    transform: MaskedTransform, body: dict[str, Any], session: ProxySession
) -> dict[str, Any]:
    match transform:
        case "anthropic_messages":
            return restore_anthropic_response(
                body, session.codec, thinking_cache=session.thinking_cache
            )
        case "openai_chat":
            return restore_openai_response(body, session.codec)
        case "responses":
            return restore_codex_response(body, session.codec)
        case unreachable:
            assert_never(unreachable)


def create_stream_transformer(
    transform: MaskedTransform, ctx: StreamContext
) -> SseTransformer:
    match transform:
        case "anthropic_messages":
            return AnthropicSseTransformer(
                ctx.scope,
                buffer_window=ctx.buffer_window,
                flush_on_close=ctx.flush_on_close,
                thinking_cache=ctx.session.thinking_cache,
            )
        case "openai_chat":
            return OpenAISseTransformer(
                ctx.scope, buffer_window=ctx.buffer_window, flush_on_close=ctx.flush_on_close
            )
        case "responses":
            return CodexSseTransformer(
                ctx.scope, buffer_window=ctx.buffer_window, flush_on_close=ctx.flush_on_close
            )
        case unreachable:
            assert_never(unreachable)
