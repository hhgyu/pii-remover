"""Streamed thinking blocks — parity with the ``AnthropicSseTransformer`` half
of ``packages/proxy/tests/thinking-restore.test.ts``.

Every case here checks both halves at once: what the client was shown, and what
was kept for the next turn to replay.
"""

from __future__ import annotations

from server.pii.stream_transformers import AnthropicSseTransformer
from server.pii.thinking_cache import ThinkingCache
from tests.conftest import EMAIL, ThinkingPair
from tests.fixtures.anthropic_sse import (
    aggregate,
    block_stop,
    signature_delta,
    text_delta,
    thinking_delta,
)

SIGNATURE = "ErUBCkYIBRgCIkC9+z/Rp0Nq4w=="


def _drive(transformer: AnthropicSseTransformer, chunks: list[str]) -> str:
    return "".join(transformer.push(chunk) for chunk in chunks) + transformer.flush()


def test_caches_the_exact_raw_upstream_thinking_at_content_block_stop(
    thinking_pair: ThinkingPair,
) -> None:
    # Given: masked thinking whose OPF token is split across two deltas
    cache = ThinkingCache()
    raw = thinking_pair.raw
    split = len(raw) // 2
    transformer = AnthropicSseTransformer(
        thinking_pair.scope, buffer_window=64, thinking_cache=cache
    )

    # When: the block streams to completion
    out = _drive(
        transformer,
        [
            thinking_delta(0, raw[:split]),
            thinking_delta(0, raw[split:]),
            signature_delta(0, SIGNATURE),
            block_stop(0),
        ],
    )

    # Then: the client saw PII while the cache kept the signed bytes verbatim
    displayed, _signature = aggregate(out)
    assert EMAIL in displayed
    assert "{{OPF:" not in displayed
    assert cache.get(SIGNATURE) == raw


def test_the_cache_holds_the_masked_bytes_not_what_the_client_was_shown(
    thinking_pair: ThinkingPair,
) -> None:
    """Restoring into the cache would put the user's PII back on the wire and
    break the signature at the same time."""
    # Given: a completed thinking block
    cache = ThinkingCache()
    transformer = AnthropicSseTransformer(
        thinking_pair.scope, buffer_window=64, thinking_cache=cache
    )

    # When: it streams and closes
    out = _drive(
        transformer,
        [thinking_delta(0, thinking_pair.raw), signature_delta(0, SIGNATURE), block_stop(0)],
    )

    # Then: display and cache disagree in exactly the intended direction
    displayed, _signature = aggregate(out)
    signed = cache.get(SIGNATURE)
    assert signed is not None
    assert "{{OPF:" in signed
    assert EMAIL not in signed
    assert displayed != signed


def test_a_signature_split_across_deltas_is_keyed_by_its_concatenation(
    thinking_pair: ThinkingPair,
) -> None:
    # Given: an upstream that chunks signature_delta
    cache = ThinkingCache()
    transformer = AnthropicSseTransformer(
        thinking_pair.scope, buffer_window=64, thinking_cache=cache
    )

    # When: the signature arrives in two pieces
    out = _drive(
        transformer,
        [
            thinking_delta(0, thinking_pair.raw),
            signature_delta(0, SIGNATURE[:5]),
            signature_delta(0, SIGNATURE[5:]),
            block_stop(0),
        ],
    )

    # Then: both halves reach the client verbatim and key one cache entry
    _displayed, signature = aggregate(out)
    assert signature == SIGNATURE
    assert cache.get(SIGNATURE) == thinking_pair.raw


def test_a_stream_cut_before_content_block_stop_shows_the_tail_but_caches_nothing(
    thinking_pair: ThinkingPair,
) -> None:
    # Given: a thinking block that never closes
    cache = ThinkingCache()
    transformer = AnthropicSseTransformer(
        thinking_pair.scope, buffer_window=64, thinking_cache=cache
    )

    # When: the stream ends after the deltas, with no stop event
    out = _drive(
        transformer, [thinking_delta(0, thinking_pair.raw), signature_delta(0, SIGNATURE)]
    )

    # Then: the user still reads the thinking, but nothing unverified is cached
    displayed, _signature = aggregate(out)
    assert EMAIL in displayed
    assert cache.size() == 0


def test_a_signature_with_no_thinking_delta_caches_the_empty_string_it_signed(
    thinking_pair: ThinkingPair,
) -> None:
    """``display: "omitted"`` — Anthropic signs the block but streams no text."""
    # Given: a block that carries only a signature
    cache = ThinkingCache()
    transformer = AnthropicSseTransformer(
        thinking_pair.scope, buffer_window=64, thinking_cache=cache
    )

    # When: only the signature and the stop event arrive
    out = _drive(transformer, [signature_delta(0, SIGNATURE), block_stop(0)])

    # Then: the empty signed string is cached, so next turn's replay resolves
    _displayed, signature = aggregate(out)
    assert signature == SIGNATURE
    assert cache.get(SIGNATURE) == ""


def test_without_a_cache_thinking_passes_through_masked_end_to_end(
    thinking_pair: ThinkingPair,
) -> None:
    """Backward compatibility: showing text that can never be replayed would
    trade a visible token for an undiagnosable upstream 400."""
    # Given: a transformer with nowhere to keep the signed bytes
    transformer = AnthropicSseTransformer(thinking_pair.scope, buffer_window=64)

    # When: a thinking block streams to completion
    out = _drive(
        transformer,
        [
            thinking_delta(0, thinking_pair.raw[:9]),
            thinking_delta(0, thinking_pair.raw[9:]),
            signature_delta(0, SIGNATURE),
            block_stop(0),
        ],
    )

    # Then: what the client sees is exactly what upstream signed
    displayed, signature = aggregate(out)
    assert displayed == thinking_pair.raw
    assert signature == SIGNATURE
    assert EMAIL not in displayed


def test_text_delta_blocks_are_unaffected_by_the_thinking_path(
    thinking_pair: ThinkingPair,
) -> None:
    # Given: a plain text block streamed alongside the thinking machinery
    cache = ThinkingCache()
    transformer = AnthropicSseTransformer(
        thinking_pair.scope, buffer_window=64, thinking_cache=cache
    )

    # When: only text deltas arrive
    out = _drive(transformer, [text_delta(0, thinking_pair.raw), block_stop(0)])

    # Then: text is restored as before and never lands in the thinking cache
    assert "text_delta" in out
    assert EMAIL in out
    assert cache.size() == 0
