import { TOKEN_EPOCH_LENGTH } from "../redaction/token-hash.js";
import { parseToken } from "../token/format.js";

/**
 * Why a token that looked well-formed could not be resolved.
 *
 * The token key is persistent (`~/.config/pii-remover/key`), so the epoch is
 * stable across restarts. That makes the two causes cleanly separable:
 *  - `foreign`: the epoch does not match this key, so this key never minted
 *    the token — the model invented it (or the key was replaced).
 *  - `expired`: the epoch matches, so this key DID mint it, but the in-memory
 *    vault no longer holds it — a session was resumed or disposed.
 *  - `ambiguous`: repair found more than one live vault entry within one edit,
 *    so restoring would be a guess. Fails closed (invariant I1).
 */
export type MissCause = "foreign" | "expired" | "ambiguous";

export type MissResolution =
  | { kind: "repaired"; normalizedToken: string }
  | { kind: "unresolved"; cause: MissCause };

export interface RepairCandidate {
  category: string;
  hash: string;
  token: string;
}

export interface ObservedToken {
  category: string;
  hash: string;
}

/**
 * Flatten a session's vault keys once per restore call. Repair is bounded by
 * this set: a mutated token can only ever resolve to a token that was actually
 * minted, never to a value derived from the mutation itself.
 */
export function buildRepairIndex(
  vaultTokens: readonly string[]
): RepairCandidate[] {
  const out: RepairCandidate[] = [];
  for (const token of vaultTokens) {
    const parsed = parseToken(token);
    if (parsed) {
      out.push({ category: parsed.category, hash: parsed.hash, token });
    }
  }
  return out;
}

/**
 * Repair requires the category to match as well as the hash.
 *
 * Resolving on the hash alone looks tempting — the hash is
 * `HMAC(key, category ‖ text)`, so it denotes exactly one entry — but the eval
 * harness measured the consequence: when the model swaps or renames a
 * category, hash-only repair hands back a DIFFERENT entry's value, 54 times
 * across the tier-1 corpus. The vault key is `category + hash`, so "its own
 * entry" means both. Withholding a category-mutated token is the fail-closed
 * outcome invariant I1 demands.
 */
export function resolveMiss(
  observed: ObservedToken,
  currentEpoch: string,
  index: readonly RepairCandidate[]
): MissResolution {
  // Repair runs BEFORE the epoch comparison on purpose. The epoch occupies the
  // first TOKEN_EPOCH_LENGTH of 16 hash characters, so gating on it first threw
  // away every corruption that happened to land there — roughly a fifth of all
  // single-character damage — by calling it foreign. The epoch is a
  // classification aid, not a safety check: the safety comes from requiring a
  // category match and exactly one live vault entry within a single edit.
  let candidate: string | null = null;
  for (const entry of index) {
    if (entry.category !== observed.category) continue;
    if (!isWithinOneEdit(entry.hash, observed.hash)) continue;
    if (candidate !== null) return { kind: "unresolved", cause: "ambiguous" };
    candidate = entry.token;
  }
  if (candidate !== null) {
    return { kind: "repaired", normalizedToken: candidate };
  }

  return observed.hash.slice(0, TOKEN_EPOCH_LENGTH) === currentEpoch
    ? { kind: "unresolved", cause: "expired" }
    : { kind: "unresolved", cause: "foreign" };
}

/**
 * Levenshtein distance ≤ 1, computed in O(n) without a matrix. Equal lengths
 * reduce to "at most one differing position"; a length gap of one reduces to a
 * single skip in the longer string.
 */
export function isWithinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;

  if (a.length === b.length) {
    let differences = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      differences++;
      if (differences > 1) return false;
    }
    return true;
  }

  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}
