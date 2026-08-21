import {
  TOKEN_DELIMITER,
  TOKEN_LENIENT_REGEX,
  TOKEN_PREFIX,
  TOKEN_REPAIR_PATTERN,
  TOKEN_STRICT_REGEX,
  TOKEN_SUFFIX,
} from "../token/format.js";

/**
 * A token detected in text. May be the canonical strict form
 * (`{{OPF:PERSON:<hash>}}`) or a lenient/LLM-mangled variant (case-folded,
 * closing braces dropped). See ADR-0022.
 *
 * `normalizedToken` is the canonical form used for vault lookup; `token`
 * preserves the original surface form so callers can attribute the
 * transformation back to the model.
 */
export interface TokenMatch {
  /** Half-open span in the source text: text[start..end). */
  start: number;
  end: number;
  token: string;
  normalizedToken: string;
  /** Uppercase category label (e.g. "PERSON", "EMAIL", "BIZ_NUM"). */
  category: string;
  /** Deterministic base36 hash identifier (ADR-0020). */
  hash: string;
  /**
   * `repair` marks a span only the loose candidate pattern saw — a corrupted
   * or Markdown-escaped token. It is never restored on the strength of the
   * match alone; it must clear the vault-bounded checks first.
   */
  matchType: "strict" | "lenient" | "repair";
}

type Range = readonly [number, number];

export function buildNormalized(category: string, hash: string): string {
  return `${TOKEN_PREFIX}${category}${TOKEN_DELIMITER}${hash}${TOKEN_SUFFIX}`;
}

/**
 * Scan `text` for all OPF tokens, sorted by start position. Lenient matches
 * overlapping a strict match are suppressed so the same canonical token is
 * never counted twice.
 *
 * Exposed as a free function (not just `Restorer.scan`) so the proxy stream
 * boundary detector shares one source of truth without instantiating a
 * Restorer.
 */
export function scanTokens(text: string): TokenMatch[] {
  return scanInternal(text, false);
}

/**
 * As `scanTokens`, plus spans that only the loose candidate pattern matches:
 * a hash one character short or long, or underscores Markdown-escaped. Those
 * carry `matchType: "repair"` and mean nothing without the vault-bounded
 * resolution in `repair.ts`, so this is for the Restorer — never for callers
 * that treat a match as proof of a token.
 */
export function scanTokensWithRepairCandidates(text: string): TokenMatch[] {
  return scanInternal(text, true);
}

function scanInternal(text: string, includeRepair: boolean): TokenMatch[] {
  if (text === "") return [];

  const matches: TokenMatch[] = [];
  const occupied: Range[] = [];

  for (const m of text.matchAll(new RegExp(TOKEN_STRICT_REGEX.source, "g"))) {
    collect(matches, occupied, m, "strict");
  }
  for (const m of text.matchAll(new RegExp(TOKEN_LENIENT_REGEX.source, "gi"))) {
    collect(matches, occupied, m, "lenient");
  }
  if (includeRepair) {
    for (const m of text.matchAll(new RegExp(TOKEN_REPAIR_PATTERN, "gi"))) {
      collect(matches, occupied, m, "repair");
    }
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}

function collect(
  matches: TokenMatch[],
  occupied: Range[],
  m: RegExpMatchArray,
  matchType: TokenMatch["matchType"]
): void {
  const start = m.index ?? 0;
  const end = start + m[0].length;
  if (overlapsAny(occupied, start, end)) return;
  const category = stripEscapes(m[1] ?? "").toUpperCase();
  const hash = (m[2] ?? "").toLowerCase();
  occupied.push([start, end]);
  matches.push({
    start,
    end,
    token: m[0],
    normalizedToken: buildNormalized(category, hash),
    category,
    hash,
    matchType,
  });
}

function stripEscapes(value: string): string {
  return value.replace(/\\/g, "");
}

function overlapsAny(ranges: readonly Range[], start: number, end: number): boolean {
  for (const [s, e] of ranges) {
    // Half-open intersection: [start, end) ∩ [s, e) ≠ ∅
    if (start < e && end > s) return true;
  }
  return false;
}
