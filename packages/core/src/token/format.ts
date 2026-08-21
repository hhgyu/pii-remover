/**
 * Token format per ADR-0022: `{{OPF:<CATEGORY>:<HASH>}}`
 *
 * - CATEGORY: uppercase ASCII + underscores (e.g. PERSON, BIZ_NUM)
 * - `:` separates the three fields
 * - HASH: lowercase base36 [a-z0-9], fixed TOKEN_HASH_LENGTH chars
 *
 * The predecessor `{{OPF:<CATEGORY>:<HASH>}}` embedded a complete Markdown
 * emphasis span in its own prefix — `{{OPF:PERSON:` is valid Markdown for bold
 * `OPF_PERSON` — so a model that rendered its own output deleted the delimiter
 * between category and hash. `{` and `}` are claimed by no CommonMark
 * construct, so `{{…}}` survives a Markdown round-trip untouched.
 *
 * The category charset excludes `:`, so the delimiter is unambiguous and the
 * category sub-pattern can be greedy; the old lazy `*?` existed only to stop
 * `BIZ_NUM` from swallowing an underscore delimiter.
 *
 * Single source of truth for the token grammar: every consumer that matches a
 * token builds its regex from the `*_PATTERN` sources below instead of
 * hardcoding the hash length. `tests/token-format-parity.test.ts` fails the
 * build if such a literal reappears.
 */

import { TOKEN_HASH_LENGTH } from "../redaction/token-hash.js";
import { CATEGORY_MAP } from "./category-map.js";

export const TOKEN_PREFIX = "{{OPF:";
export const TOKEN_SUFFIX = "}}";
export const TOKEN_DELIMITER = ":";

/** Category sub-pattern. Greedy is safe: `:` cannot occur in a category. */
export const TOKEN_CATEGORY_PATTERN = "[A-Z][A-Z0-9_]*";

/** Hash sub-pattern, derived from TOKEN_HASH_LENGTH. */
export const TOKEN_HASH_PATTERN = `[a-z0-9]{${TOKEN_HASH_LENGTH}}`;

export const MAX_CATEGORY_LABEL_LENGTH = Math.max(
  ...Object.values(CATEGORY_MAP).map((label) => label.length),
);

/**
 * Longest token `formatToken` can emit. A streaming consumer that looks back
 * fewer characters than this cannot see an in-progress token's `{{OPF:` start
 * and releases the tail raw.
 */
export const MAX_TOKEN_LENGTH =
  TOKEN_PREFIX.length +
  MAX_CATEGORY_LABEL_LENGTH +
  TOKEN_DELIMITER.length +
  TOKEN_HASH_LENGTH +
  TOKEN_SUFFIX.length;

function escapeRegex(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Regex-safe form of `TOKEN_PREFIX`. Exported because the prefix contains `{`,
 * so `new RegExp(TOKEN_PREFIX)` would build a quantifier, not a literal.
 */
export const TOKEN_PREFIX_PATTERN = escapeRegex(TOKEN_PREFIX);

const PREFIX_RE = TOKEN_PREFIX_PATTERN;
const SUFFIX_RE = escapeRegex(TOKEN_SUFFIX);
const DELIMITER_RE = escapeRegex(TOKEN_DELIMITER);

/**
 * Canonical token pattern source with two capture groups: category, hash.
 * Compile with whatever flags the call site needs — do not share a `g`-flagged
 * RegExp across call sites, `lastIndex` is stateful.
 */
export const TOKEN_STRICT_PATTERN = `${PREFIX_RE}(${TOKEN_CATEGORY_PATTERN})${DELIMITER_RE}(${TOKEN_HASH_PATTERN})${SUFFIX_RE}`;

/**
 * Lenient variant for LLM-mangled tokens: case-insensitive category and an
 * optional closing brace pair. Always compile with the `i` flag.
 *
 * The trailing look-ahead is load-bearing: without it a hash that grew a
 * character still matches on its first TOKEN_HASH_LENGTH characters, so a
 * length-corrupted token reads as a valid one naming a different entry.
 */
export const TOKEN_LENIENT_PATTERN = `${PREFIX_RE}([A-Za-z][A-Za-z0-9_]*)${DELIMITER_RE}(${TOKEN_HASH_PATTERN})(?:${SUFFIX_RE})?(?![A-Za-z0-9_])`;

/**
 * Deliberately looser than the two matchers above, and NOT a restoration
 * matcher: a hit here is only ever a *candidate*. It tolerates a hash one
 * character short or long and a dropped brace on either side, so that
 * length-corrupted and brace-damaged tokens become visible at all.
 *
 * Loosening the real matchers would widen the false-restoration surface, which
 * the quality plan forbids (§8). This pattern is safe because every candidate
 * must still clear the vault-bounded checks in `restorer/repair.ts` — matching
 * epoch, matching category, and exactly one live vault entry within one edit —
 * before a single character is substituted.
 */
export const TOKEN_REPAIR_PATTERN =
  `\\{\\{?OPF${DELIMITER_RE}([A-Za-z][A-Za-z0-9_]*)${DELIMITER_RE}` +
  `([a-z0-9]{${TOKEN_HASH_LENGTH - 1},${TOKEN_HASH_LENGTH + 1}})` +
  `(?:\\}\\}?)?`;

export const TOKEN_STRICT_REGEX = new RegExp(TOKEN_STRICT_PATTERN, "g");

export const TOKEN_LENIENT_REGEX = new RegExp(TOKEN_LENIENT_PATTERN, "gi");

const STRICT_FULL = new RegExp(`^${TOKEN_STRICT_PATTERN}$`);

const HASH_FULL = new RegExp(`^${TOKEN_HASH_PATTERN}$`);

export interface ParsedToken {
  category: string;
  hash: string;
}

export function formatToken(category: string, hash: string): string {
  if (typeof category !== "string" || !/^[A-Z][A-Z_]*$/.test(category)) {
    throw new TypeError(
      `Invalid token category: ${JSON.stringify(category)} (must be uppercase ASCII letters + underscores)`,
    );
  }
  if (typeof hash !== "string" || !HASH_FULL.test(hash)) {
    throw new TypeError(
      `Invalid token hash: ${JSON.stringify(hash)} (must be ${TOKEN_HASH_LENGTH} lowercase base36 chars)`,
    );
  }
  return `${TOKEN_PREFIX}${category}${TOKEN_DELIMITER}${hash}${TOKEN_SUFFIX}`;
}

export function parseToken(text: string): ParsedToken | null {
  const m = STRICT_FULL.exec(text);
  if (!m) return null;
  return { category: m[1]!, hash: m[2]! };
}

export function isToken(text: string): boolean {
  return STRICT_FULL.test(text);
}
