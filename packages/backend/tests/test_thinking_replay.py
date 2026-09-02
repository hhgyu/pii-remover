"""Request-side replay and non-streaming restore — parity with the
``transformAnthropicRequest`` / ``restoreAnthropicResponse`` halves of
``packages/proxy/tests/thinking-restore.test.ts``.
"""

from __future__ import annotations

import json
from typing import Any

from server.pii.pipeline import ReplayedRequest, replay_request
from server.pii.providers_anthropic import restore_anthropic_response
from server.pii.session_pool import ProxySession
from server.pii.stream_transformers import AnthropicSseTransformer
from server.pii.thinking_cache import ThinkingCache
from server.pii.thinking_replay import (
    ThinkingReplayed,
    ThinkingUnresolvable,
    replay_thinking,
)
from tests.conftest import EMAIL, ThinkingPair
from tests.fixtures.anthropic_sse import aggregate, block_stop, signature_delta, thinking_delta

SIGNATURE = "ErUBCkYIBRgCIkC9+z/Rp0Nq4w=="
OTHER_SIGNATURE = "ErUBCkYIBRgCIkDzzzzzzzz=="
REDACTED = {"type": "redacted_thinking", "data": "EroBCkYIBRgCKkBc=="}


def _assistant_turn(blocks: list[Any]) -> dict[str, Any]:
    return {"role": "assistant", "content": blocks}


def _replayed_blocks(replay: object) -> list[Any]:
    assert isinstance(replay, ThinkingReplayed)
    content = replay.messages[-1]["content"]
    assert isinstance(content, list)
    return content


# --------------------------------------------------------------------------
# request: swap the displayed text back to the bytes upstream signed
# --------------------------------------------------------------------------


def test_a_cache_hit_replays_the_exact_signed_bytes_and_leaves_the_signature_alone(
    thinking_pair: ThinkingPair,
) -> None:
    # Given: a cache holding the masked bytes Anthropic signed, and a client
    # replaying the restored thinking it was shown
    cache = ThinkingCache()
    cache.set(SIGNATURE, thinking_pair.raw)
    messages = [
        {"role": "user", "content": "continue"},
        _assistant_turn(
            [
                {"type": "thinking", "thinking": thinking_pair.restored, "signature": SIGNATURE},
                {"type": "text", "text": "Working on it."},
            ]
        ),
    ]

    # When: the replayed turn is resolved
    replay = replay_thinking(messages, cache)

    # Then: upstream receives the signed bytes verbatim under the same signature
    blocks = _replayed_blocks(replay)
    assert blocks[0]["thinking"] == thinking_pair.raw
    assert blocks[0]["signature"] == SIGNATURE
    assert blocks[1] == {"type": "text", "text": "Working on it."}
    assert isinstance(replay, ThinkingReplayed)
    assert EMAIL not in json.dumps(replay.messages, ensure_ascii=False)


def test_a_cache_miss_refuses_the_turn_instead_of_dropping_the_block(
    thinking_pair: ThinkingPair,
) -> None:
    # Given: an empty cache and a replayed turn whose thinking carries live PII
    cache = ThinkingCache()

    # When: the turn is resolved against a signature nobody cached
    replay = replay_thinking(
        [
            _assistant_turn(
                [
                    {
                        "type": "thinking",
                        "thinking": thinking_pair.restored,
                        "signature": OTHER_SIGNATURE,
                    }
                ]
            )
        ],
        cache,
    )

    # Then: the whole turn is unresolvable — never forwarded, never trimmed
    assert isinstance(replay, ThinkingUnresolvable)


def test_thinking_without_a_usable_signature_is_refused_not_dropped(
    thinking_pair: ThinkingPair,
) -> None:
    # Given: a cache that could resolve a real signature
    cache = ThinkingCache()
    cache.set(SIGNATURE, thinking_pair.raw)

    # When: a block arrives with an empty signature, which nothing can have signed
    replay = replay_thinking(
        [_assistant_turn([{"type": "thinking", "thinking": thinking_pair.restored, "signature": ""}])],
        cache,
    )

    # Then: unsigned thinking is unreplayable, so the turn is refused whole
    assert isinstance(replay, ThinkingUnresolvable)


def test_one_unresolvable_block_refuses_the_turn_that_also_holds_a_resolvable_one(
    thinking_pair: ThinkingPair,
) -> None:
    """All-or-nothing: a turn Anthropic verifies partially is a turn it rejects."""
    # Given: a cache holding only the first of two replayed signatures
    cache = ThinkingCache()
    cache.set(SIGNATURE, thinking_pair.raw)

    # When: the turn replays both blocks
    replay = replay_thinking(
        [
            _assistant_turn(
                [
                    {
                        "type": "thinking",
                        "thinking": thinking_pair.restored,
                        "signature": SIGNATURE,
                    },
                    {
                        "type": "thinking",
                        "thinking": thinking_pair.restored,
                        "signature": OTHER_SIGNATURE,
                    },
                ]
            )
        ],
        cache,
    )

    # Then: the resolvable block does not rescue the turn
    assert isinstance(replay, ThinkingUnresolvable)


def test_redacted_thinking_and_user_turns_survive_unchanged(
    thinking_pair: ThinkingPair,
) -> None:
    # Given: a turn mixing a resolvable block with content that has no plaintext
    cache = ThinkingCache()
    cache.set(SIGNATURE, thinking_pair.raw)
    user_turn = {"role": "user", "content": [{"type": "thinking", "text": "not a block"}]}

    # When: the messages are resolved
    replay = replay_thinking(
        [
            user_turn,
            _assistant_turn(
                [
                    {
                        "type": "thinking",
                        "thinking": thinking_pair.restored,
                        "signature": SIGNATURE,
                    },
                    REDACTED,
                ]
            ),
        ],
        cache,
    )

    # Then: only the assistant's signed block was rewritten
    assert isinstance(replay, ThinkingReplayed)
    assert replay.messages[0] == user_turn
    blocks = _replayed_blocks(replay)
    assert blocks[1] == REDACTED
    assert cache.size() == 1


def test_without_a_cache_the_thinking_block_is_left_exactly_as_it_arrived(
    thinking_pair: ThinkingPair,
) -> None:
    # Given: no cache configured — nothing was ever restored, so nothing to undo
    messages = [
        _assistant_turn(
            [{"type": "thinking", "thinking": thinking_pair.raw, "signature": SIGNATURE}]
        )
    ]

    # When: the turn is resolved
    replay = replay_thinking(messages, None)

    # Then: passthrough is preserved for callers that never restore
    assert isinstance(replay, ThinkingReplayed)
    assert replay.messages == messages


def test_non_anthropic_bodies_are_forwarded_untouched(thinking_pair: ThinkingPair) -> None:
    """Only Anthropic mints signed thinking; the other transforms must not be
    handed an ``messages`` key they never had."""
    # Given: an OpenAI Responses body routed through the same pipeline
    session = ProxySession(codec=thinking_pair.codec, thinking_cache=ThinkingCache())
    body = {"model": "m", "input": "hello"}

    # When: the replay stage runs for the Responses transform
    replay = replay_request("responses", body, session)

    # Then: the body is the same object's content, unmodified
    assert isinstance(replay, ReplayedRequest)
    assert replay.body == body


# --------------------------------------------------------------------------
# response: cache the signed bytes, then restore for display
# --------------------------------------------------------------------------


def test_non_streaming_restore_caches_the_signed_bytes_then_shows_pii(
    thinking_pair: ThinkingPair,
) -> None:
    # Given: a non-streaming response carrying masked, signed thinking
    cache = ThinkingCache()

    # When: the response is restored for the client
    out = restore_anthropic_response(
        {
            "content": [
                {"type": "thinking", "thinking": thinking_pair.raw, "signature": SIGNATURE},
                {"type": "text", "text": thinking_pair.raw},
            ]
        },
        thinking_pair.codec,
        thinking_cache=cache,
    )

    # Then: the client sees PII, the signature is intact, replay bytes are kept
    assert EMAIL in out["content"][0]["thinking"]
    assert out["content"][0]["signature"] == SIGNATURE
    assert cache.get(SIGNATURE) == thinking_pair.raw


def test_non_streaming_restore_without_a_cache_leaves_thinking_masked(
    thinking_pair: ThinkingPair,
) -> None:
    # Given: no cache — restoring display text we could never replay is a 400
    # waiting to happen
    # When: the response is restored with default options
    out = restore_anthropic_response(
        {"content": [{"type": "thinking", "thinking": thinking_pair.raw, "signature": SIGNATURE}]},
        thinking_pair.codec,
    )

    # Then: the block is untouched
    assert out["content"][0]["thinking"] == thinking_pair.raw


def test_redacted_thinking_is_neither_restored_nor_cached(thinking_pair: ThinkingPair) -> None:
    # Given: a redacted block in the response
    cache = ThinkingCache()

    # When: the response is restored
    out = restore_anthropic_response(
        {"content": [REDACTED]}, thinking_pair.codec, thinking_cache=cache
    )

    # Then: it is untouched and nothing was cached
    assert out["content"][0] == REDACTED
    assert cache.size() == 0


# --------------------------------------------------------------------------
# the round trip both halves exist for
# --------------------------------------------------------------------------


def test_what_anthropic_signed_is_exactly_what_it_gets_back(
    thinking_pair: ThinkingPair,
) -> None:
    # Given: a thinking block streamed to the client through the transformer
    cache = ThinkingCache()
    transformer = AnthropicSseTransformer(
        thinking_pair.scope, buffer_window=64, thinking_cache=cache
    )
    raw = thinking_pair.raw
    sse = "".join(
        transformer.push(chunk)
        for chunk in [
            thinking_delta(0, raw[:9]),
            thinking_delta(0, raw[9:]),
            signature_delta(0, SIGNATURE),
            block_stop(0),
        ]
    )
    sse += transformer.flush()
    displayed, _signature = aggregate(sse)

    # When: the client replays exactly what it was shown
    replay = replay_thinking(
        [_assistant_turn([{"type": "thinking", "thinking": displayed, "signature": SIGNATURE}])],
        cache,
    )

    # Then: the bytes upstream verifies are byte-identical to what it emitted
    assert displayed != raw
    blocks = _replayed_blocks(replay)
    assert blocks[0]["thinking"] == raw
    assert blocks[0]["signature"] == SIGNATURE
