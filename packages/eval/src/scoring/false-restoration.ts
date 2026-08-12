import { scanTokens } from "@pii-remover/core";

import type { TokenInfo } from "../types.js";

/**
 * Token-identity scoring — the hard invariant (plan §3.2, §8 I1).
 *
 * I1: a token must never resolve to a value other than its own vault entry,
 * and recovery must require exactly one candidate AND a category match.
 *
 * Identity is judged per token, not per sentence: the owner is the token the
 * vault actually minted, `observedSurface` is what the model emitted for it,
 * and the verdict is which entry's value came back. A sentence-level value
 * count cannot answer that question, because mutation 13 swaps two tokens
 * *inside one sentence* — both values are present either way, and only the
 * position tells you that one person's data landed in another's slot.
 */
export type ResolutionOutcome =
  | "rightful-value"
  | "withheld"
  | "foreign-value";

export interface TokenResolutionProbe {
  /** The token the vault minted — ground truth for "its own vault entry". */
  readonly owner: TokenInfo;
  /** The surface form the mutation produced for that token. */
  readonly observedSurface: string;
  /** What the restorer returned for `observedSurface`. */
  readonly restoredText: string;
  /** Every (token, value) pair live in the session vault. */
  readonly vaultValues: readonly TokenInfo[];
}

export interface TokenVerdict {
  readonly outcome: ResolutionOutcome;
  /** Category label the restorer actually saw on the wire. */
  readonly observedCategory: string;
  /** Resolved even though the emitted category differs from the resolved
   *  entry's. Lever L4 accepts a candidate only on "exactly 1 candidate AND
   *  category match", so a true here deviates from that stated condition. */
  readonly categoryBlindRepair: boolean;
}

export function classifyTokenResolution(probe: TokenResolutionProbe): TokenVerdict {
  const observed = scanTokens(probe.observedSurface);
  const rightful = rightfulEntry(probe, observed.map((m) => m.normalizedToken));
  const resolved = resolveEntry(probe, rightful);
  const observedCategory = observed.at(0)?.category ?? probe.owner.category;
  return {
    outcome: outcomeOf(resolved, rightful),
    observedCategory,
    categoryBlindRepair: resolved !== null && resolved.category !== observedCategory,
  };
}

/**
 * The entry the emitted token is entitled to resolve to.
 *
 * Normally that is the token the vault minted for this slot. But mutation 13
 * can emit a surface form that IS another live vault key — when both swapped
 * tokens share a category, `PERSON/<hash of the other PERSON>` is a genuine,
 * exactly-matching key. Resolving a live key to its own entry is the restorer's
 * contract, not a false restoration: the model asked for that entry.
 */
function rightfulEntry(
  probe: TokenResolutionProbe,
  observedTokens: readonly string[],
): TokenInfo {
  const liveKey = probe.vaultValues.find((candidate) =>
    observedTokens.includes(candidate.token),
  );
  return liveKey ?? probe.owner;
}

function outcomeOf(
  resolved: TokenInfo | null,
  rightful: TokenInfo,
): ResolutionOutcome {
  if (resolved === null) return "withheld";
  return resolved.token === rightful.token ? "rightful-value" : "foreign-value";
}

function resolveEntry(
  probe: TokenResolutionProbe,
  rightful: TokenInfo,
): TokenInfo | null {
  const foreign = probe.vaultValues.find((candidate) =>
    isForeignResolution(probe, rightful, candidate),
  );
  if (foreign !== undefined) return foreign;
  return probe.restoredText.includes(rightful.value) ? rightful : null;
}

function isForeignResolution(
  probe: TokenResolutionProbe,
  rightful: TokenInfo,
  candidate: TokenInfo,
): boolean {
  if (candidate.token === rightful.token) return false;
  const appearedInOutput = probe.restoredText.includes(candidate.value);
  const wasAlreadyEmitted = probe.observedSurface.includes(candidate.value);
  const nestedInRightfulValue =
    probe.restoredText.includes(rightful.value) &&
    rightful.value.includes(candidate.value);
  return appearedInOutput && !wasAlreadyEmitted && !nestedInRightfulValue;
}

export interface IdentityTotals {
  readonly probes: number;
  readonly foreignValues: number;
}

/** `false_restoration_rate` — the plan's hard invariant. Must be exactly 0. */
export function falseRestorationRate(totals: IdentityTotals): number {
  if (totals.probes === 0) return 0;
  return totals.foreignValues / totals.probes;
}
