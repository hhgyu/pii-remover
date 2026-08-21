import { scanTokens } from "@pii-remover/core";
import { createStreamBuffer, findUnsafeBoundary } from "@pii-remover/proxy";

import type { Mutator } from "../types.js";

/**
 * SSE delta splitting (plan §5 catalog 7).
 *
 * This class deliberately drives the REAL proxy stream buffer rather than a
 * re-implementation: the property under test is that
 * `createStreamBuffer` / `findUnsafeBoundary` hold back an incomplete token
 * tail until the rest of the stream arrives (ADR-0004 §12.3.3). A private copy
 * of that logic here would pass forever while the shipping one rotted.
 *
 * Two distinct properties are checked at every split offset:
 *  1. byte fidelity — the released chunks concatenate back to the input;
 *  2. restorability — no token straddles two released chunks. The proxy calls
 *     `restore()` once per released chunk, so a straddling token reaches the
 *     user as a raw `{{OPF:…` string even though no byte was lost.
 */

/** Safe chunks the buffer releases for `deltas`, in order, flush included. */
export function streamChunks(deltas: readonly string[]): readonly string[] {
  const buffer = createStreamBuffer();
  const out: string[] = [];
  for (const delta of deltas) {
    const safe = buffer.push(delta);
    if (safe.length > 0) out.push(safe);
  }
  const tail = buffer.flush();
  if (tail.length > 0) out.push(tail);
  return out;
}

export function reassemble(deltas: readonly string[]): string {
  return streamChunks(deltas).join("");
}

/** The suffix of `head` the boundary detector refuses to release yet. */
export function heldBackTail(head: string): string {
  return head.slice(findUnsafeBoundary(head));
}

/** Index of the first token broken across two released chunks, or -1. */
export function firstStraddlingToken(chunks: readonly string[]): number {
  const joined = chunks.join("");
  const matches = scanTokens(joined);
  if (matches.length === 0) return -1;
  const ends: number[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    cursor += chunk.length;
    ends.push(cursor);
  }
  return matches.findIndex(
    (match) => chunkAt(ends, match.start) !== chunkAt(ends, match.end - 1),
  );
}

function chunkAt(ends: readonly number[], offset: number): number {
  let low = 0;
  let high = ends.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offset < ends[mid]) high = mid;
    else low = mid + 1;
  }
  return low;
}

const LOSSLESS_NOTE =
  "every split offset reassembled losslessly and released whole tokens through the real proxy stream buffer";

/** 7 — split the masked text into two SSE deltas at every offset and rebuild
 *  it through the proxy buffer. */
export const sseDeltaSplit: Mutator = (text) => {
  for (let cut = 1; cut < text.length; cut += 1) {
    const head = text.slice(0, cut);
    const chunks = streamChunks([head, text.slice(cut)]);
    const rebuilt = chunks.join("");
    if (rebuilt !== text) {
      return {
        text: rebuilt,
        expectedRecoverable: true,
        note: `stream buffer did not reassemble losslessly at split offset ${cut}`,
      };
    }
    if (firstStraddlingToken(chunks) !== -1) {
      return {
        text,
        deltas: chunks,
        expectedRecoverable: true,
        note: `token released across two chunks at split offset ${cut}: the buffer held back only ${heldBackTail(head).length} of ${cut} chars, and the proxy restores each chunk on its own, so that token reaches the user raw`,
      };
    }
  }
  return { text, expectedRecoverable: true, note: LOSSLESS_NOTE };
};
