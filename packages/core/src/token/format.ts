/**
 * Token format per ADR-0020: `__OPF_<CATEGORY>__<HASH>__`
 *
 * - CATEGORY: uppercase ASCII + underscores (e.g. PERSON, BIZ_NUM)
 * - `__` delimiter separates CATEGORY from HASH (disambiguates BIZ_NUM)
 * - HASH: lowercase base36 [a-z0-9], fixed 16 chars (TOKEN_HASH_LENGTH)
 *
 * The lazy `[A-Z0-9_]*?` stops at the first `__` delimiter; the fixed-length
 * hash makes the right boundary unambiguous. Regex pair (strict + lenient) is
 * exported for the Restorer and the proxy's SSE boundary detector to share.
 */

import { TOKEN_HASH_LENGTH } from "../redaction/token-hash.js";

export const TOKEN_PREFIX = "__OPF_";
export const TOKEN_SUFFIX = "__";
export const TOKEN_DELIMITER = "__";

const HASH = `[a-z0-9]{${TOKEN_HASH_LENGTH}}`;

export const TOKEN_STRICT_REGEX = new RegExp(
  `__OPF_([A-Z][A-Z0-9_]*?)__(${HASH})__`,
  "g",
);

export const TOKEN_LENIENT_REGEX = new RegExp(
  `\\b__OPF_([A-Za-z][A-Za-z0-9_]*?)__(${HASH})(?:__)?\\b`,
  "gi",
);

const STRICT_FULL = new RegExp(`^__OPF_([A-Z][A-Z0-9_]*?)__(${HASH})__$`);

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
  if (
    typeof hash !== "string" ||
    !new RegExp(`^${HASH}$`).test(hash)
  ) {
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
