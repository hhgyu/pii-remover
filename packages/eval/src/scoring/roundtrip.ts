import { scanTokens } from "@pii-remover/core";

/**
 * Roundtrip scoring for one mutated case (plan §3.2
 * `roundtrip_after_mutation_rate`).
 *
 * The metric is value presence, not text equality: several mutation classes
 * legitimately decorate the surrounding text (a code fence, a path, a Korean
 * particle), so `restore(mutate(mask(x))) === x` would score decoration as a
 * restoration failure. What must hold is that every synthetic value the entry
 * started with is back in the output.
 */
export interface RoundtripInput {
  readonly restoredText: string;
  /** Distinct values a correct restorer must return for this case. Empty for
   *  probe classes, whose contract is that nothing comes back. */
  readonly expectedValues: readonly string[];
}

export interface RoundtripScore {
  readonly expected: number;
  readonly restored: number;
  /** Tokens still matchable in the output — the user-visible failure surface. */
  readonly residualTokens: number;
}

export function scoreRoundtrip(input: RoundtripInput): RoundtripScore {
  const unique = [...new Set(input.expectedValues)];
  let restored = 0;
  for (const value of unique) {
    if (input.restoredText.includes(value)) restored += 1;
  }
  return {
    expected: unique.length,
    restored,
    residualTokens: scanTokens(input.restoredText).length,
  };
}

/** `restored / expected`, or `null` when the class expects no restoration at
 *  all. A rate of "0 out of 0" is not 0% — printing it as 0% would slander a
 *  probe class that behaved perfectly. */
export function roundtripRate(score: {
  readonly expected: number;
  readonly restored: number;
}): number | null {
  if (score.expected === 0) return null;
  return score.restored / score.expected;
}
