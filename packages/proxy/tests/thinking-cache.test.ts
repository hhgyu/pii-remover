import { describe, expect, test } from "bun:test";

import { createThinkingCache } from "../src/stream/thinking-cache.js";

const SIG_A = "ErUBCkYIBRgCIkAAAAAAAA==";
const SIG_B = "ErUBCkYIBRgCIkBBBBBBBB==";
const SIG_C = "ErUBCkYIBRgCIkCCCCCCCC==";

describe("ThinkingCache — bounded signature-keyed store of masked thinking", () => {
  test("returns the exact bytes stored under a signature", () => {
    // Given: masked upstream thinking with an OPF token and CRLF/unicode bytes
    const cache = createThinkingCache();
    const raw = "Reply to {{OPF:EMAIL:4pr244g2t4k32cuo}}\r\n김철수 님께";

    // When: it is cached under the signature and read back
    cache.set(SIG_A, raw);

    // Then: the retrieved value is byte-identical
    expect(cache.get(SIG_A)).toBe(raw);
    expect(cache.size()).toBe(1);
  });

  test("unknown or empty signature reads as a miss", () => {
    // Given: a cache holding one entry
    const cache = createThinkingCache();
    cache.set(SIG_A, "thought");

    // When/Then: neither an unknown nor an empty signature resolves
    expect(cache.get(SIG_B)).toBeUndefined();
    expect(cache.get("")).toBeUndefined();
  });

  test("an empty signature is never stored", () => {
    // Given: an empty cache
    const cache = createThinkingCache();

    // When: a write arrives with no signature to key it by
    cache.set("", "thought");

    // Then: nothing is retained — an unkeyed entry could never be replayed
    expect(cache.size()).toBe(0);
  });

  test("evicts the oldest entry once maxEntries is exceeded", () => {
    // Given: a cache with room for two entries
    const cache = createThinkingCache({ maxEntries: 2 });
    cache.set(SIG_A, "first");
    cache.set(SIG_B, "second");

    // When: a third entry arrives
    cache.set(SIG_C, "third");

    // Then: insertion order decides — the first entry is gone, the rest intact
    expect(cache.size()).toBe(2);
    expect(cache.get(SIG_A)).toBeUndefined();
    expect(cache.get(SIG_B)).toBe("second");
    expect(cache.get(SIG_C)).toBe("third");
  });

  test("a read refreshes recency so the read entry outlives an older one", () => {
    // Given: two entries where the older one was just read
    const cache = createThinkingCache({ maxEntries: 2 });
    cache.set(SIG_A, "first");
    cache.set(SIG_B, "second");
    expect(cache.get(SIG_A)).toBe("first");

    // When: a third entry forces an eviction
    cache.set(SIG_C, "third");

    // Then: the refreshed entry survives and the untouched one is evicted
    expect(cache.get(SIG_A)).toBe("first");
    expect(cache.get(SIG_B)).toBeUndefined();
  });

  test("evicts oldest entries until a new value fits the byte cap", () => {
    // Given: a byte cap that holds exactly two 40-byte payloads
    const cache = createThinkingCache({ maxEntries: 16, maxBytes: 80 });
    cache.set(SIG_A, "a".repeat(40));
    cache.set(SIG_B, "b".repeat(40));

    // When: a third 40-byte payload arrives
    cache.set(SIG_C, "c".repeat(40));

    // Then: only the oldest is dropped — just enough to make room
    expect(cache.size()).toBe(2);
    expect(cache.get(SIG_A)).toBeUndefined();
    expect(cache.get(SIG_B)).toBe("b".repeat(40));
    expect(cache.get(SIG_C)).toBe("c".repeat(40));
  });

  test("byte accounting counts UTF-8 bytes, not UTF-16 code units", () => {
    // Given: a cap of 8 bytes and a 4-character payload that is 12 UTF-8 bytes
    const cache = createThinkingCache({ maxEntries: 16, maxBytes: 8 });

    // When: the multibyte payload is offered
    cache.set(SIG_A, "김철수님");

    // Then: it is rejected — measuring `.length` (4) would have accepted it
    expect(cache.size()).toBe(0);
  });

  test("a value larger than the byte cap is rejected without evicting anything", () => {
    // Given: a cache already holding a live entry
    const cache = createThinkingCache({ maxEntries: 16, maxBytes: 50 });
    cache.set(SIG_A, "keep me");

    // When: an oversized value that can never fit arrives
    cache.set(SIG_B, "x".repeat(51));

    // Then: the existing entry is untouched — a doomed write must not purge the cache
    expect(cache.size()).toBe(1);
    expect(cache.get(SIG_A)).toBe("keep me");
    expect(cache.get(SIG_B)).toBeUndefined();
  });

  test("rewriting a signature replaces the value without double-counting its bytes", () => {
    // Given: a cap sized for two 30-byte payloads
    const cache = createThinkingCache({ maxEntries: 16, maxBytes: 60 });
    cache.set(SIG_A, "a".repeat(30));
    cache.set(SIG_B, "b".repeat(30));

    // When: an existing signature is rewritten with a same-size payload
    cache.set(SIG_B, "z".repeat(30));

    // Then: the rewrite is in place — stale bytes did not push the other entry out
    expect(cache.size()).toBe(2);
    expect(cache.get(SIG_A)).toBe("a".repeat(30));
    expect(cache.get(SIG_B)).toBe("z".repeat(30));
  });

  test("clear drops every entry and frees the byte budget", () => {
    // Given: a cache at its byte cap
    const cache = createThinkingCache({ maxEntries: 16, maxBytes: 40 });
    cache.set(SIG_A, "a".repeat(40));

    // When: it is cleared and refilled
    cache.clear();
    cache.set(SIG_B, "b".repeat(40));

    // Then: the new entry fits, proving the byte counter was reset too
    expect(cache.size()).toBe(1);
    expect(cache.get(SIG_B)).toBe("b".repeat(40));
  });
});
