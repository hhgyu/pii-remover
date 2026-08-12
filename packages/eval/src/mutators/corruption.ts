import type { Mutator } from "../types.js";
import { buildToken, midpoint, nextBase36Char, rewriteTokens } from "./rewrite.js";

/**
 * Hash-damage mutations (plan §5 catalog 3, 4).
 *
 * Both destroy the exact vault key while leaving a plausible token behind.
 * They are NOT probes: recovering them is the goal, as long as recovery stays
 * fail-closed on ambiguity (plan lever L4).
 */

/** 3 — one hash character is substituted. Length is preserved, so both the
 *  strict and lenient matchers still see a token and only the vault lookup
 *  fails, which puts the miss squarely inside L4's edit-distance-1 window. */
export const hashCharSubstitution: Mutator = (text) => ({
  text: rewriteTokens(text, (match) =>
    buildToken(match.category, substituteChar(match.hash)),
  ),
  expectedRecoverable: true,
  note: "recovered by the L4 single-candidate edit-distance repair; a drop here means repair regressed or turned ambiguous",
});

/** 4 — one hash character is inserted or deleted. The length changes, so the
 *  fixed-width hash sub-pattern misses; only the loose candidate scan sees it,
 *  and it may only resolve through the vault-bounded repair. */
export const hashLengthChange: Mutator = (text) => ({
  text: rewriteTokens(text, (match, index) =>
    buildToken(
      match.category,
      index % 2 === 0 ? insertChar(match.hash) : deleteChar(match.hash),
    ),
  ),
  expectedRecoverable: true,
  note: "length-changing hash damage; recovered only via the repair-only candidate scan plus the single-candidate edit-distance rule",
});

function substituteChar(hash: string): string {
  const at = midpoint(hash);
  return hash.slice(0, at) + nextBase36Char(hash.charAt(at)) + hash.slice(at + 1);
}

function insertChar(hash: string): string {
  const at = midpoint(hash);
  return hash.slice(0, at) + nextBase36Char(hash.charAt(at)) + hash.slice(at);
}

function deleteChar(hash: string): string {
  const at = midpoint(hash);
  return hash.slice(0, at) + hash.slice(at + 1);
}
