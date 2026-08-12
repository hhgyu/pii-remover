import type { PIICategory } from "@pii-remover/core";

/**
 * Shared vocabulary for the Tier-1 mutation harness
 * (docs/QUALITY-MEASUREMENT-PLAN.md §5).
 */

/** Surface form a corpus entry imitates. Mirrors the plan's stratification. */
export type SurfaceForm =
  | "prose"
  | "code"
  | "path"
  | "json"
  | "markdown"
  | "adversarial";

export type CorpusLang = "en" | "ko";

/** One declared PII span inside a corpus entry. Offsets are located at load
 *  time by scanning `text`, so the fixture stays readable. */
export interface CorpusSpan {
  readonly text: string;
  readonly category: PIICategory;
}

export interface CorpusEntry {
  readonly id: string;
  readonly lang: CorpusLang;
  readonly surface: SurfaceForm;
  readonly text: string;
  readonly spans: readonly CorpusSpan[];
}

export interface MutationCorpus {
  readonly derived_from: readonly string[];
  /** Every value any entry declares as PII. Enforced by the synthetic guard. */
  readonly synthetic_values: readonly string[];
  readonly entries: readonly CorpusEntry[];
}

/** A masking token minted for a corpus entry, paired with the synthetic value
 *  it hides. `token` is the canonical form used as the vault key. */
export interface TokenInfo {
  readonly token: string;
  /** Uppercase token label, e.g. `PERSON`, `BIZNUM`. */
  readonly category: string;
  readonly hash: string;
  readonly value: string;
  readonly piiCategory: PIICategory;
}

/** A corpus entry after deterministic masking. */
export interface MaskedEntry {
  readonly id: string;
  readonly lang: CorpusLang;
  readonly surface: SurfaceForm;
  readonly original: string;
  readonly masked: string;
  /** Distinct tokens present in `masked`, in first-appearance order. */
  readonly tokens: readonly TokenInfo[];
}

/**
 * What a mutation class does to token identity.
 *
 * - `surface` — re-cases or decorates the token; identity is intact, so a
 *   correct restorer must return the original value.
 * - `corruption` — damages the hash; exact vault lookup can no longer resolve
 *   it. Plan lever L4 targets these; today they are a recorded baseline gap.
 * - `probe` — deliberately re-points or invents a token. The original value
 *   MUST NOT come back. Restoring it anyway is a privacy incident (plan §8 I1),
 *   so these classes are scored by `false_restoration_rate`, not roundtrip.
 */
export type MutationKind = "surface" | "corruption" | "probe";

export interface MutationResult {
  readonly text: string;
  /** True when today's restorer is expected to return the original values.
   *  False marks a known-lossy class recorded as a baseline gap rather than a
   *  test failure (plan §9 Phase B). */
  readonly expectedRecoverable: boolean;
  /**
   * Units the transport restores INDEPENDENTLY, concatenating to `text`.
   *
   * Only SSE splitting needs this: the proxy calls `restore()` once per safe
   * chunk the stream buffer releases (`anthropic-sse.ts` handleDelta), so a
   * token broken across two chunks is never restored even though the bytes all
   * arrive. Scoring the whole message at once would declare that case healthy.
   * Absent for every other class, which restores the message in one call.
   */
  readonly deltas?: readonly string[];
  /** Diagnostic carried into baseline.md. Never contains PII or token hashes. */
  readonly note?: string;
}

export type Mutator = (
  maskedText: string,
  tokens: readonly TokenInfo[],
) => MutationResult;

export interface MutationClass {
  readonly id: number;
  readonly name: string;
  readonly kind: MutationKind;
  /** Minimum distinct tokens an entry needs for this class to be meaningful. */
  readonly minTokens: number;
  readonly description: string;
  readonly mutate: Mutator;
}
