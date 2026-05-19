/**
 * Token format per ADR-0002: `__OPF_<CATEGORY>_<INDEX>__`
 *
 * - CATEGORY: uppercase ASCII + underscores (e.g. PERSON, BIZ_NUM)
 * - INDEX: positive integer, 1-based per vault
 *
 * Regex pair (strict + lenient) is exported for the Restorer and the
 * proxy's SSE boundary detector to share a single source of truth.
 */

export const TOKEN_PREFIX = "__OPF_";
export const TOKEN_SUFFIX = "__";

export const TOKEN_STRICT_REGEX = /__OPF_([A-Z_]+)_(\d+)__/g;

export const TOKEN_LENIENT_REGEX = /\b__OPF_([A-Z_]+)_(\d+)(?:__)?\b/gi;

const STRICT_FULL = /^__OPF_([A-Z_]+)_(\d+)__$/;

export interface ParsedToken {
  category: string;
  index: number;
}

export function formatToken(category: string, index: number): string {
  if (typeof category !== "string" || !/^[A-Z][A-Z_]*$/.test(category)) {
    throw new TypeError(
      `Invalid token category: ${JSON.stringify(category)} (must be uppercase ASCII letters + underscores)`
    );
  }
  if (!Number.isInteger(index) || index < 1) {
    throw new RangeError(
      `Invalid token index: ${index} (must be a positive integer)`
    );
  }
  return `${TOKEN_PREFIX}${category}_${index}${TOKEN_SUFFIX}`;
}

export function parseToken(text: string): ParsedToken | null {
  const m = STRICT_FULL.exec(text);
  if (!m) return null;
  return { category: m[1]!, index: Number(m[2]) };
}

export function isToken(text: string): boolean {
  return STRICT_FULL.test(text);
}
