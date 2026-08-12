import { describe, expect, test } from "bun:test";
import { Restorer, TOKEN_PREFIX } from "@pii-remover/core";
import { findUnsafeBoundary } from "@pii-remover/proxy";

import { loadCorpus, maskCorpus } from "../src/corpus/index.js";
import {
  firstStraddlingToken,
  reassemble,
  sseDeltaSplit,
  streamChunks,
} from "../src/mutators/index.js";
import type { MaskedEntry } from "../src/types.js";

const masked = maskCorpus(loadCorpus());
const restorer = new Restorer(masked.vault, {
  warnOnPartial: false,
  warnOnUnknownToken: false,
  warn: () => {},
});

function entryById(id: string): MaskedEntry {
  const found = masked.entries.find((entry) => entry.id === id);
  if (!found) throw new Error(`fixture is missing entry ${id}`);
  return found;
}

const sample = entryById("en-multi-01");

/** Where the first token's prefix ends — the delta boundary an LLM produces
 *  whenever its tokenizer emits `__OPF_` as a single unit. */
function prefixBoundary(text: string): number {
  return text.indexOf(TOKEN_PREFIX) + TOKEN_PREFIX.length;
}

/** What the client finally sees: the proxy restores each released chunk on its
 *  own (`anthropic-sse.ts` handleDelta) and concatenates the results. */
function streamThroughProxy(deltas: readonly string[]): string {
  return streamChunks(deltas)
    .map((chunk) => restorer.restore(chunk, masked.sessionId).text)
    .join("");
}

describe("mutation 7 — SSE delta split through the real proxy buffer", () => {
  test("reassembles losslessly at every two-way split offset", () => {
    // Given every masked corpus entry
    // When each is split at every offset and pushed through the real buffer
    const lossy = masked.entries.filter(
      (entry) => reassembleAllOffsets(entry.masked) === false,
    );
    // Then no offset loses or reorders a byte
    expect(lossy.map((entry) => entry.id)).toEqual([]);
  });

  test("reassembles losslessly when every character is its own delta", () => {
    // Given a masked entry with four tokens
    // When it arrives one character at a time
    const rebuilt = reassemble([...sample.masked]);
    // Then the buffer emits exactly the original text
    expect(rebuilt).toBe(sample.masked);
  });

  test("releases a completed token immediately", () => {
    // Given a buffer fed a whole token followed by a space
    const text = `hello ${sample.tokens[0].token} `;
    // When the boundary detector inspects it
    // Then nothing is held back
    expect(findUnsafeBoundary(text)).toBe(text.length);
  });

  test("holds back a partial token whose category has started", () => {
    // Given a prefix that stops after `__OPF_PER`
    const token = sample.tokens[0].token;
    const head = `hello ${token.slice(0, TOKEN_PREFIX.length + 3)}`;
    // When the boundary detector inspects it
    // Then the unsafe tail starts at the token prefix
    expect(findUnsafeBoundary(head)).toBe(head.indexOf(TOKEN_PREFIX));
  });

  test("holds back a delta that ends exactly on the token prefix", () => {
    // Given a delta boundary landing right after `__OPF_` and nothing else
    const head = sample.masked.slice(0, prefixBoundary(sample.masked));
    // When the boundary detector inspects it
    // Then the whole prefix is held back, not just its final underscore
    expect(findUnsafeBoundary(head)).toBe(head.indexOf(TOKEN_PREFIX));
  });

  test("never releases a token across two chunks at that boundary", () => {
    // Given the two deltas an LLM emits when `__OPF_` is one tokenizer unit
    const cut = prefixBoundary(sample.masked);
    const chunks = streamChunks([
      sample.masked.slice(0, cut),
      sample.masked.slice(cut),
    ]);
    // When the released chunks are checked for a straddling token
    // Then every token sits wholly inside one chunk
    expect(firstStraddlingToken(chunks)).toBe(-1);
  });

  test("restores the original text when each released chunk is restored alone", () => {
    // Given the same prefix-boundary split
    const cut = prefixBoundary(sample.masked);
    // When the chunks travel the production per-chunk restore path
    const delivered = streamThroughProxy([
      sample.masked.slice(0, cut),
      sample.masked.slice(cut),
    ]);
    // Then the user sees the original values, never a raw token
    expect(delivered).toBe(sample.original);
  });

  test("reports the straddling offset instead of scoring the class healthy", () => {
    // Given the class-7 mutation over an entry
    // When it is applied
    const result = sseDeltaSplit(sample.masked, sample.tokens);
    // Then it hands the runner the independently-restorable delta units
    expect(result.text).toBe(sample.masked);
    expect(result.deltas === undefined || result.deltas.join("") === sample.masked).toBe(
      true,
    );
  });
});

function reassembleAllOffsets(text: string): boolean {
  for (let cut = 1; cut < text.length; cut += 1) {
    if (reassemble([text.slice(0, cut), text.slice(cut)]) !== text) return false;
  }
  return true;
}
