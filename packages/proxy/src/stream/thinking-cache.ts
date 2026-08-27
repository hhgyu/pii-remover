import { Buffer } from "node:buffer";

/**
 * Session-scoped store of the **masked** thinking bytes Anthropic signed,
 * keyed by the opaque `signature` it returned with them.
 *
 * Anthropic verifies a replayed `thinking` block against its `signature` and
 * rejects the request with 400 unless the bytes are identical to what it
 * emitted. The proxy, however, hands the client *restored* thinking so the user
 * can read their own PII — so the bytes the client replays are not the bytes
 * that were signed, and no masking pass can reconstruct them (the token hash is
 * salted per vault entry, and the signature covers the exact original string).
 *
 * The only sound answer is to remember the original: cache the upstream bytes
 * under their signature on the way out, and substitute them back on the way in.
 *
 * Invariants:
 * - **Only masked/raw upstream thinking is ever stored.** Restored PII must not
 *   enter this cache — it exists precisely to keep PII off the wire.
 * - **Bounded.** Entry count and total payload bytes are both capped; the
 *   oldest entry is evicted first (Map insertion order), and a read moves its
 *   entry to the recent end so an actively replayed conversation stays warm.
 * - **In-memory, never persisted** — same lifetime as the session's vault.
 */
export interface ThinkingCache {
  /** Exact bytes cached for `signature`, or `undefined` on a miss. */
  get(signature: string): string | undefined;
  /** Remember `thinking` (masked upstream bytes) under `signature`. */
  set(signature: string, thinking: string): void;
  clear(): void;
  /** Number of live entries. */
  size(): number;
}

export interface ThinkingCacheOptions {
  maxEntries?: number;
  /** Cap on the summed UTF-8 size of the cached thinking payloads. */
  maxBytes?: number;
}

/** One entry per thinking block; a long session replays a handful per turn. */
export const DEFAULT_THINKING_CACHE_MAX_ENTRIES = 256;

/** 4 MiB — 256 entries of ~16 KB, the shape of a long extended-thinking block. */
export const DEFAULT_THINKING_CACHE_MAX_BYTES = 4 * 1024 * 1024;

class BoundedThinkingCache implements ThinkingCache {
  private readonly entries = new Map<string, string>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor(opts: ThinkingCacheOptions = {}) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_THINKING_CACHE_MAX_ENTRIES);
    this.maxBytes = Math.max(0, opts.maxBytes ?? DEFAULT_THINKING_CACHE_MAX_BYTES);
  }

  get(signature: string): string | undefined {
    if (signature.length === 0) return undefined;
    const hit = this.entries.get(signature);
    if (hit === undefined) return undefined;
    // Re-insert to move the entry to the recent end of the Map's insertion
    // order: a block replayed on every turn must not age out of a long chat.
    this.entries.delete(signature);
    this.entries.set(signature, hit);
    return hit;
  }

  set(signature: string, thinking: string): void {
    if (signature.length === 0) return;
    const incoming = Buffer.byteLength(thinking, "utf8");
    // A value that can never fit is dropped before any eviction runs: letting a
    // doomed write purge the cache would turn one oversized block into a cache
    // miss for every other block in the conversation.
    if (incoming > this.maxBytes) return;

    this.forget(signature);
    while (this.entries.size >= this.maxEntries || this.bytes + incoming > this.maxBytes) {
      if (!this.evictOldest()) break;
    }
    this.entries.set(signature, thinking);
    this.bytes += incoming;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  size(): number {
    return this.entries.size;
  }

  private evictOldest(): boolean {
    for (const oldest of this.entries.keys()) {
      this.forget(oldest);
      return true;
    }
    return false;
  }

  private forget(signature: string): void {
    const existing = this.entries.get(signature);
    if (existing === undefined) return;
    this.entries.delete(signature);
    this.bytes -= Buffer.byteLength(existing, "utf8");
  }
}

export function createThinkingCache(opts: ThinkingCacheOptions = {}): ThinkingCache {
  return new BoundedThinkingCache(opts);
}
