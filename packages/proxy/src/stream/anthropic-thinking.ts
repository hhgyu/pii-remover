import { createStreamBuffer, type StreamBuffer } from "./buffer.js";
import type { StreamRestoreScope } from "./restore-scope.js";
import type { ThinkingCache } from "./thinking-cache.js";

/**
 * Per-block state for one streamed extended-thinking response.
 *
 * A thinking block arrives as an arbitrary split of `thinking_delta` chunks
 * followed by a `signature_delta` and `content_block_stop`. Two different
 * things have to happen to those chunks at once:
 *
 * 1. **Display** — the client must see restored PII, so the chunks go through a
 *    token-boundary {@link StreamBuffer}: a `{{OPF:…}}` token split across two
 *    deltas is held until it is whole, then restored.
 * 2. **Replay** — the *unrestored* upstream bytes are what Anthropic signed, so
 *    they are accumulated verbatim in parallel and cached under the block's
 *    signature for the next request to substitute back in.
 *
 * The two streams must not be conflated: restoring changes the byte length, and
 * a single restored byte breaks signature verification with a 400.
 *
 * Both jobs hang off the cache. Without one there is nowhere to keep the signed
 * bytes, so restoring for display would hand the client text it can never
 * replay — thinking is then passed through masked, end to end.
 */
export interface ThinkingStreamOptions {
  scope: StreamRestoreScope;
  bufferWindow: number;
  cache?: ThinkingCache;
}

/** Restored thinking text still owed to the client for a block. */
export interface ThinkingTail {
  index: number;
  text: string;
}

export class ThinkingStreamAccumulator {
  private readonly raw = new Map<number, string>();
  private readonly buffers = new Map<number, StreamBuffer>();
  private readonly signatures = new Map<number, string>();
  private readonly scope: StreamRestoreScope;
  private readonly bufferWindow: number;
  private readonly cache: ThinkingCache | undefined;

  constructor(opts: ThinkingStreamOptions) {
    this.scope = opts.scope;
    this.bufferWindow = opts.bufferWindow;
    this.cache = opts.cache;
  }

  /**
   * Accumulate the raw chunk for replay and return the slice of restored
   * thinking that is now safe to display — empty while a token is still
   * straddling the delta boundary.
   *
   * With no cache the chunk is forwarded untouched instead: what the client is
   * shown is what it replays next turn, and only unaltered bytes survive
   * Anthropic's signature check.
   */
  pushThinking(index: number, chunk: string): string {
    if (this.cache === undefined) return chunk;
    this.raw.set(index, (this.raw.get(index) ?? "") + chunk);
    return this.scope.text(this.getBuffer(index).push(chunk));
  }

  /** Signature bytes are opaque: accumulated for the cache key, never altered. */
  pushSignature(index: number, chunk: string): void {
    this.signatures.set(index, (this.signatures.get(index) ?? "") + chunk);
  }

  /**
   * Close block `index`: cache the raw upstream thinking under its full
   * signature and return whatever restored text the buffer still holds.
   *
   * A signature with no thinking behind it is the `display: "omitted"` shape —
   * Anthropic signs the block but streams no `thinking_delta`. The bytes it
   * signed are the empty string, so that is what gets cached; caching nothing
   * would make the client's next replay of this block unresolvable.
   */
  stop(index: number): string {
    let tail = "";
    const buf = this.buffers.get(index);
    if (buf !== undefined) {
      this.buffers.delete(index);
      tail = this.scope.text(buf.flush());
    }
    const raw = this.raw.get(index);
    const signature = this.signatures.get(index);
    this.raw.delete(index);
    this.signatures.delete(index);
    if (signature !== undefined && signature.length > 0) {
      this.cache?.set(signature, raw ?? "");
    }
    return tail;
  }

  /**
   * Restored tails for blocks the stream ended without closing.
   *
   * Deliberately does not cache: `signature_delta` may itself be chunked, so
   * without `content_block_stop` there is no proof the accumulated signature is
   * complete. Caching a truncated key would answer a later lookup with bytes
   * Anthropic never signed; skipping it yields a miss, and a miss is refused
   * outright next turn — a legible local error beats a silent upstream 400.
   */
  drain(): ThinkingTail[] {
    const tails: ThinkingTail[] = [];
    for (const [index, buf] of this.buffers.entries()) {
      const remaining = buf.flush();
      if (remaining.length > 0) {
        tails.push({ index, text: this.scope.text(remaining) });
      }
    }
    return tails;
  }

  clear(): void {
    this.raw.clear();
    this.buffers.clear();
    this.signatures.clear();
  }

  private getBuffer(index: number): StreamBuffer {
    let buf = this.buffers.get(index);
    if (!buf) {
      buf = createStreamBuffer({ bufferWindow: this.bufferWindow });
      this.buffers.set(index, buf);
    }
    return buf;
  }
}
