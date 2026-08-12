/**
 * Token format per ADR-0020: `__OPF_<CATEGORY>__<HASH>__`
 *
 * - CATEGORY: uppercase ASCII + underscores (e.g. PERSON, BIZ_NUM)
 * - `__` delimiter separates CATEGORY from HASH (disambiguates BIZ_NUM)
 * - HASH: lowercase base36 [a-z0-9], fixed TOKEN_HASH_LENGTH chars
 *
 * The lazy `[A-Z0-9_]*?` stops at the first `__` delimiter; the fixed-length
 * hash makes the right boundary unambiguous.
 *
 * Single source of truth for the token grammar: every consumer that matches a
 * token builds its regex from the `*_PATTERN` sources below instead of
 * hardcoding the hash length. `tests/token-format-parity.test.ts` fails the
 * build if such a literal reappears.
 */

import { TOKEN_HASH_LENGTH } from "../redaction/token-hash.js";
import { CATEGORY_MAP } from "./category-map.js";

export const TOKEN_PREFIX = "__OPF_";
export const TOKEN_SUFFIX = "__";
export const TOKEN_DELIMITER = "__";

/**
 * Category sub-pattern. Lazy so it stops at the first `__` delimiter, which
 * is what keeps `BIZ_NUM` from swallowing the delimiter into the category.
 */
export const TOKEN_CATEGORY_PATTERN = "[A-Z][A-Z0-9_]*?";

/** Hash sub-pattern, derived from TOKEN_HASH_LENGTH. */
export const TOKEN_HASH_PATTERN = `[a-z0-9]{${TOKEN_HASH_LENGTH}}`;

export const MAX_CATEGORY_LABEL_LENGTH = Math.max(
  ...Object.values(CATEGORY_MAP).map((label) => label.length),
);

/**
 * Longest token `formatToken` can emit. A streaming consumer that looks back
 * fewer characters than this cannot see an in-progress token's `__OPF_` start
 * and releases the tail raw.
 */
export const MAX_TOKEN_LENGTH =
  TOKEN_PREFIX.length +
  MAX_CATEGORY_LABEL_LENGTH +
  TOKEN_DELIMITER.length +
  TOKEN_HASH_LENGTH +
  TOKEN_SUFFIX.length;

/**
 * Canonical token pattern source with two capture groups: category, hash.
 * Compile with whatever flags the call site needs — do not share a `g`-flagged
 * RegExp across call sites, `lastIndex` is stateful.
 */
export const TOKEN_STRICT_PATTERN = `${TOKEN_PREFIX}(${TOKEN_CATEGORY_PATTERN})${TOKEN_DELIMITER}(${TOKEN_HASH_PATTERN})${TOKEN_SUFFIX}`;

/**
 * Lenient variant for LLM-mangled tokens: case-insensitive category and an
 * optional trailing suffix. Always compile with the `i` flag.
 */
export const TOKEN_LENIENT_PATTERN = `\\b${TOKEN_PREFIX}([A-Za-z][A-Za-z0-9_]*?)${TOKEN_DELIMITER}(${TOKEN_HASH_PATTERN})(?:${TOKEN_SUFFIX})?\\b`;

/**
 * Renders a literal so that each underscore may carry a preceding backslash,
 * which is how Markdown renderers escape our tokens (`\_\_OPF\_...`).
 */
function escapableLiteral(literal: string): string {
  return [...literal]
    .map((c) =>
      c === "_" ? "\\\\?_" : c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
    )
    .join("");
}

/**
 * Deliberately looser than the two matchers above, and NOT a restoration
 * matcher: a hit here is only ever a *candidate*. It tolerates a hash one
 * character short or long and a backslash before any underscore, so that
 * length-corrupted and Markdown-escaped tokens become visible at all.
 *
 * Loosening the real matchers would widen the false-restoration surface, which
 * the quality plan forbids (§8). This pattern is safe because every candidate
 * must still clear the vault-bounded checks in `restorer/repair.ts` — matching
 * epoch, matching category, and exactly one live vault entry within one edit —
 * before a single character is substituted.
 */
export const TOKEN_REPAIR_PATTERN =
  `${escapableLiteral(TOKEN_PREFIX)}([A-Za-z][A-Za-z0-9_\\\\]*?)` +
  `${escapableLiteral(TOKEN_DELIMITER)}` +
  `([a-z0-9]{${TOKEN_HASH_LENGTH - 1},${TOKEN_HASH_LENGTH + 1}})` +
  `(?:${escapableLiteral(TOKEN_SUFFIX)})?`;

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
