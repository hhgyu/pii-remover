import { CATEGORY_MAP, TOKEN_HASH_LENGTH } from "@pii-remover/core";

import type { Mutator, TokenInfo } from "../types.js";
import { buildToken, deterministicHash, rewriteTokens } from "./rewrite.js";

/**
 * Safety probes (plan §5 catalog 11, 12, 13, 14).
 *
 * Every class here re-points or invents a token so that it no longer names its
 * own vault entry. The correct outcome is that NOTHING is restored: resolving
 * one of these onto a live value would put person B's data where person A's
 * token stood, which invariant I1 (plan §8) calls categorically worse than
 * leaving `[UNRESTORABLE]` behind. They are scored by `false_restoration_rate`,
 * not by roundtrip rate.
 */

/** The single hallucinated hash class 14 injects. Held as a constant so a test
 *  can assert it is absent from the entire corpus keyset — a probe that
 *  accidentally collided with a live entry would prove nothing. */
export const HALLUCINATED_HASH = deterministicHash(
  "pii-remover/eval/hallucinated-token/v1",
  TOKEN_HASH_LENGTH,
);

/** Category labels the vault can actually mint (ADR-0010 → ADR-0020 labels). */
const MINTABLE_LABELS: readonly string[] = Object.values(CATEGORY_MAP);

/** Plausible renames an LLM produces when it "tidies up" a token label. */
const CATEGORY_ALIASES: Readonly<Record<string, string | undefined>> = {
  PERSON: "NAME",
  EMAIL: "MAIL",
  PHONE: "TEL",
  ADDRESS: "ADDR",
  ACCOUNT: "ACCT",
  DATE: "DOB",
  URL: "LINK",
  SECRET: "APIKEY",
  RRN: "SSN",
  BIZNUM: "COMPANY",
  CARD: "PAN",
};

/** 11 — the model renames the category to a synonym that was never minted. */
export const categoryRename: Mutator = (text) => ({
  text: rewriteTokens(text, (match) =>
    buildToken(CATEGORY_ALIASES[match.category] ?? "RENAMED", match.hash),
  ),
  expectedRecoverable: false,
  note: "renamed category names no vault entry; recovery must stay fail-closed (I1 requires a category match)",
});

/** 12 — the category is swapped for another live one, hash untouched. */
export const categorySwap: Mutator = (text, tokens) => {
  const liveLabels = tokens.map((token) => token.category);
  return {
    text: rewriteTokens(text, (match) =>
      buildToken(foreignLabel(match.category, liveLabels), match.hash),
    ),
    expectedRecoverable: false,
    note: "hash survives under a different category; the vault key is a miss and must stay one",
  };
};

/** 13 — the hashes of two live tokens change places. The false-restoration
 *  probe: when the pair spans two categories the result names no entry at all,
 *  and when it does not, each token still names exactly its own entry. Either
 *  way no value may surface for a token that was not in the input. */
export const hashSwap: Mutator = (text, tokens) => {
  const partner = new Map<string, string>();
  tokens.forEach((token, index) => {
    partner.set(token.hash, tokens[(index + 1) % tokens.length].hash);
  });
  return {
    text: rewriteTokens(text, (match) =>
      buildToken(match.category, partner.get(match.hash) ?? match.hash),
    ),
    expectedRecoverable: false,
    note: "hashes rotated between live tokens; no token may resolve to another entry's value (I1)",
  };
};

/** 14 — a wholly invented token is appended, as an LLM does when it copies a
 *  token shape from an earlier conversation. */
export const inventedToken: Mutator = (text, tokens) => ({
  text: `${text} ${buildToken(plausibleLabel(tokens), HALLUCINATED_HASH)}`,
  expectedRecoverable: false,
  note: "hallucinated token; must be counted as observed-and-unknown, never resolved",
});

function plausibleLabel(tokens: readonly TokenInfo[]): string {
  return tokens.at(0)?.category ?? "PERSON";
}

function foreignLabel(own: string, liveLabels: readonly string[]): string {
  const fromLive = liveLabels.find((label) => label !== own);
  if (fromLive !== undefined) return fromLive;
  return MINTABLE_LABELS.find((label) => label !== own) ?? "RENAMED";
}
