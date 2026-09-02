"""Bounded signature-keyed store of masked thinking — parity with
``packages/proxy/tests/thinking-cache.test.ts``.
"""

from __future__ import annotations

from server.pii.thinking_cache import (
    DEFAULT_THINKING_CACHE_MAX_BYTES,
    DEFAULT_THINKING_CACHE_MAX_ENTRIES,
    ThinkingCache,
)

SIG_A = "ErUBCkYIBRgCIkAAAAAAAA=="
SIG_B = "ErUBCkYIBRgCIkBBBBBBBB=="
SIG_C = "ErUBCkYIBRgCIkCCCCCCCC=="


def test_defaults_match_the_typescript_cache() -> None:
    assert DEFAULT_THINKING_CACHE_MAX_ENTRIES == 256
    assert DEFAULT_THINKING_CACHE_MAX_BYTES == 4 * 1024 * 1024


def test_returns_the_exact_bytes_stored_under_a_signature() -> None:
    # Given: masked upstream thinking with an OPF token and CRLF/unicode bytes
    cache = ThinkingCache()
    raw = "Reply to {{OPF:EMAIL:4pr244g2t4k32cuo}}\r\n김철수 님께"

    # When: it is cached under the signature and read back
    cache.set(SIG_A, raw)

    # Then: the retrieved value is byte-identical
    assert cache.get(SIG_A) == raw
    assert cache.size() == 1


def test_unknown_or_empty_signature_reads_as_a_miss() -> None:
    # Given: a cache holding one entry
    cache = ThinkingCache()
    cache.set(SIG_A, "thought")

    # When/Then: neither an unknown nor an empty signature resolves
    assert cache.get(SIG_B) is None
    assert cache.get("") is None


def test_an_empty_cached_value_is_a_hit_not_a_miss() -> None:
    """``display: "omitted"`` signs the empty string, and that has to replay.

    Reporting it as a miss would refuse a turn Anthropic is perfectly happy to
    verify, so the miss signal must be ``None`` and never a falsy value.
    """
    # Given: a block whose signed thinking was the empty string
    cache = ThinkingCache()

    # When: it is cached and read back
    cache.set(SIG_A, "")

    # Then: the read reports a hit carrying the empty string
    assert cache.get(SIG_A) == ""
    assert cache.get(SIG_A) is not None


def test_an_empty_signature_is_never_stored() -> None:
    # Given: an empty cache
    cache = ThinkingCache()

    # When: a write arrives with no signature to key it by
    cache.set("", "thought")

    # Then: nothing is retained — an unkeyed entry could never be replayed
    assert cache.size() == 0


def test_evicts_the_oldest_entry_once_max_entries_is_exceeded() -> None:
    # Given: a cache with room for two entries
    cache = ThinkingCache(max_entries=2)
    cache.set(SIG_A, "first")
    cache.set(SIG_B, "second")

    # When: a third entry arrives
    cache.set(SIG_C, "third")

    # Then: insertion order decides — the first entry is gone, the rest intact
    assert cache.size() == 2
    assert cache.get(SIG_A) is None
    assert cache.get(SIG_B) == "second"
    assert cache.get(SIG_C) == "third"


def test_a_read_refreshes_recency_so_the_read_entry_outlives_an_older_one() -> None:
    # Given: two entries where the older one was just read
    cache = ThinkingCache(max_entries=2)
    cache.set(SIG_A, "first")
    cache.set(SIG_B, "second")
    assert cache.get(SIG_A) == "first"

    # When: a third entry forces an eviction
    cache.set(SIG_C, "third")

    # Then: the refreshed entry survives and the untouched one is evicted
    assert cache.get(SIG_A) == "first"
    assert cache.get(SIG_B) is None


def test_evicts_oldest_entries_until_a_new_value_fits_the_byte_cap() -> None:
    # Given: a byte cap that holds exactly two 40-byte payloads
    cache = ThinkingCache(max_entries=16, max_bytes=80)
    cache.set(SIG_A, "a" * 40)
    cache.set(SIG_B, "b" * 40)

    # When: a third 40-byte payload arrives
    cache.set(SIG_C, "c" * 40)

    # Then: only the oldest is dropped — just enough to make room
    assert cache.size() == 2
    assert cache.get(SIG_A) is None
    assert cache.get(SIG_B) == "b" * 40
    assert cache.get(SIG_C) == "c" * 40


def test_byte_accounting_counts_utf8_bytes_not_characters() -> None:
    # Given: a cap of 8 bytes and a 4-character payload that is 12 UTF-8 bytes
    cache = ThinkingCache(max_entries=16, max_bytes=8)

    # When: the multibyte payload is offered
    cache.set(SIG_A, "김철수님")

    # Then: it is rejected — measuring len() (4) would have accepted it
    assert cache.size() == 0


def test_a_value_larger_than_the_byte_cap_is_rejected_without_evicting_anything() -> None:
    # Given: a cache already holding a live entry
    cache = ThinkingCache(max_entries=16, max_bytes=50)
    cache.set(SIG_A, "keep me")

    # When: an oversized value that can never fit arrives
    cache.set(SIG_B, "x" * 51)

    # Then: the existing entry is untouched — a doomed write must not purge the cache
    assert cache.size() == 1
    assert cache.get(SIG_A) == "keep me"
    assert cache.get(SIG_B) is None


def test_rewriting_a_signature_replaces_the_value_without_double_counting_bytes() -> None:
    # Given: a cap sized for two 30-byte payloads
    cache = ThinkingCache(max_entries=16, max_bytes=60)
    cache.set(SIG_A, "a" * 30)
    cache.set(SIG_B, "b" * 30)

    # When: an existing signature is rewritten with a same-size payload
    cache.set(SIG_B, "z" * 30)

    # Then: the rewrite is in place — stale bytes did not push the other entry out
    assert cache.size() == 2
    assert cache.get(SIG_A) == "a" * 30
    assert cache.get(SIG_B) == "z" * 30


def test_clear_drops_every_entry_and_frees_the_byte_budget() -> None:
    # Given: a cache at its byte cap
    cache = ThinkingCache(max_entries=16, max_bytes=40)
    cache.set(SIG_A, "a" * 40)

    # When: it is cleared and refilled
    cache.clear()
    cache.set(SIG_B, "b" * 40)

    # Then: the new entry fits, proving the byte counter was reset too
    assert cache.size() == 1
    assert cache.get(SIG_B) == "b" * 40
