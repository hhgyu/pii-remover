import {
  TOKEN_LENIENT_REGEX,
  TOKEN_STRICT_REGEX,
} from "../token/format.js";
import type { VaultManager } from "../vault/manager.js";

/**
 * A token that was detected in text by the Restorer. May correspond to the
 * canonical strict form (`__OPF_PERSON_1__`) or a lenient/LLM-mangled variant
 * (e.g. `__opf_person_1` — case-folded, suffix dropped). See ADR-0002.
 *
 * `normalizedToken` is the canonical form used for vault lookup. `token`
 * preserves the original surface form so callers can attribute LLM
 * transformations.
 */
export interface TokenMatch {
  /** Half-open span in the source text: text[start..end). */
  start: number;
  end: number;
  /** Original surface form that was matched (may differ from normalizedToken). */
  token: string;
  /** Canonical form used for vault lookup: `__OPF_<CATEGORY>_<INDEX>__`. */
  normalizedToken: string;
  /** Uppercase category label (e.g. "PERSON", "EMAIL", "BIZ_NUM"). */
  category: string;
  /** 1-based vault index. */
  index: number;
  /** Which regex matched: strict (canonical) or lenient (variant). */
  matchType: "strict" | "lenient";
}

/**
 * Outcome of a single `Restorer.restore()` call. Counters are computed
 * independently:
 *  - `restoredCount`: tokens whose vault lookup succeeded.
 *  - `partialMatchCount`: tokens matched by the lenient regex (regardless of
 *    whether the vault contained an entry). Signals "LLM mangled at least N
 *    tokens" to callers.
 *  - `unknownTokenCount`: tokens whose vault lookup failed (hallucinated or
 *    stale references — strict and lenient both count).
 */
export interface RestoreResult {
  text: string;
  matches: TokenMatch[];
  restoredCount: number;
  partialMatchCount: number;
  unknownTokenCount: number;
}

export interface RestoreOptions {
  /** Activate the lenient fallback regex for LLM-mangled tokens.
   *  Default: true. Set false to restrict to canonical-form tokens only. */
  lenient?: boolean;
  /** Emit a warning whenever a lenient (non-canonical) match is encountered.
   *  Default: true. */
  warnOnPartial?: boolean;
  /** Emit a warning when a strict-form token is not in the vault (suggests an
   *  LLM hallucination per ADR-0002). Default: true. */
  warnOnUnknownToken?: boolean;
  /** Called when a lenient match cannot be resolved against the vault. The
   *  return value is substituted into the output text. Default: keep the
   *  original surface form (no replacement). */
  partialMatchHandler?: (text: string, match: TokenMatch) => string;
  /** Called when a strict-form token is not in the vault. The return value
   *  is substituted into the output text. Default: keep the original token
   *  text (no replacement). */
  unknownTokenHandler?: (token: string) => string;
  /** Sink for warning messages. Falls back to defaultOpts.warn (set on the
   *  Restorer) and finally to a no-op. */
  warn?: (msg: string) => void;
}

/**
 * Token restorer (ADR-0002 §Implementation Notes, ADR-0003 §round-trip,
 * ADR-0004 §LLM variation scenarios).
 *
 *  1. Scan text with the strict regex.
 *  2. Scan text with the lenient regex; drop any matches that overlap a
 *     strict span (avoids double-counting the same canonical token).
 *  3. Walk matches right-to-left, looking each one up in the vault. Hits
 *     are substituted with the original surface form; misses go through
 *     the appropriate handler (default: keep original).
 *
 * Right-to-left replacement preserves earlier-match offsets after each
 * substitution.
 */
export class Restorer {
  private readonly vault: VaultManager;
  private readonly defaultOpts: RestoreOptions;

  constructor(vault: VaultManager, defaultOpts: RestoreOptions = {}) {
    this.vault = vault;
    this.defaultOpts = defaultOpts;
  }

  /**
   * Scan `text` for all OPF tokens (strict + lenient), returning the matches
   * sorted by start position. Does not consult the vault.
   */
  scan(text: string): TokenMatch[] {
    return scanTokens(text);
  }

  /**
   * Resolve every token in `text` using the vault for `sessionId`.
   *
   * Throws `TypeError` if `sessionId` is empty / non-string. Passing a
   * session that was never populated is allowed and yields all-unknown
   * counts (no entries means every token is a vault miss).
   */
  restore(
    text: string,
    sessionId: string,
    opts: RestoreOptions = {}
  ): RestoreResult {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError(
        `Restorer.restore: sessionId must be a non-empty string (got ${JSON.stringify(sessionId)})`
      );
    }
    if (text === "") {
      return {
        text: "",
        matches: [],
        restoredCount: 0,
        partialMatchCount: 0,
        unknownTokenCount: 0,
      };
    }

    const merged = mergeOptions(this.defaultOpts, opts);
    const useLenient = merged.lenient ?? true;
    const warnOnPartial = merged.warnOnPartial ?? true;
    const warnOnUnknownToken = merged.warnOnUnknownToken ?? true;
    const warn = merged.warn ?? noopWarn;

    const allMatches = scanTokens(text);
    const matches = useLenient
      ? allMatches
      : allMatches.filter((m) => m.matchType === "strict");

    // Pre-tally lenient matches as a "LLM mangled this many tokens" signal.
    // Independent from vault-hit status — see RestoreResult JSDoc.
    let partialMatchCount = 0;
    for (const m of matches) {
      if (m.matchType === "lenient") partialMatchCount++;
    }

    let restoredCount = 0;
    let unknownTokenCount = 0;

    // Walk right-to-left so earlier offsets stay valid after substitution.
    const reverseMatches = [...matches].sort((a, b) => b.start - a.start);

    let out = text;
    for (const m of reverseMatches) {
      const entry = this.vault.lookup(sessionId, m.normalizedToken);

      if (entry) {
        out = out.slice(0, m.start) + entry.text + out.slice(m.end);
        restoredCount++;
        if (m.matchType === "lenient" && warnOnPartial) {
          warn(
            `[WARN] PII restore: lenient match '${m.token}' resolved as '${m.normalizedToken}' (LLM transformation suspected)`
          );
        }
        continue;
      }

      unknownTokenCount++;
      if (m.matchType === "strict") {
        if (warnOnUnknownToken) {
          warn(
            `[WARN] PII restore: unknown token '${m.token}' not in vault (possibly hallucinated, ADR-0002)`
          );
        }
        const handler = merged.unknownTokenHandler;
        if (handler) {
          const replacement = handler(m.token);
          out = out.slice(0, m.start) + replacement + out.slice(m.end);
        }
      } else {
        if (warnOnPartial) {
          warn(
            `[WARN] PII restore: lenient match '${m.token}' (normalized '${m.normalizedToken}') not in vault`
          );
        }
        const handler = merged.partialMatchHandler;
        if (handler) {
          const replacement = handler(m.token, m);
          out = out.slice(0, m.start) + replacement + out.slice(m.end);
        }
      }
    }

    return {
      text: out,
      matches,
      restoredCount,
      partialMatchCount,
      unknownTokenCount,
    };
  }
}

/**
 * Scan `text` for all OPF tokens (strict + lenient), returning matches sorted
 * by start position. Lenient matches that overlap a strict match are
 * suppressed to avoid double-counting the same canonical token.
 *
 * Exposed as a free function (not just `Restorer.scan`) so the proxy stream
 * boundary detector can share the same source of truth without instantiating
 * a Restorer.
 */
export function scanTokens(text: string): TokenMatch[] {
  if (text === "") return [];

  const matches: TokenMatch[] = [];
  const strictRanges: Array<readonly [number, number]> = [];

  const strictRe = new RegExp(TOKEN_STRICT_REGEX.source, "g");
  for (const m of text.matchAll(strictRe)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const category = m[1]!;
    const index = Number(m[2]);
    strictRanges.push([start, end]);
    matches.push({
      start,
      end,
      token: m[0],
      normalizedToken: buildNormalized(category, index),
      category,
      index,
      matchType: "strict",
    });
  }

  const lenientRe = new RegExp(TOKEN_LENIENT_REGEX.source, "gi");
  for (const m of text.matchAll(lenientRe)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlapsAny(strictRanges, start, end)) continue;
    const category = m[1]!.toUpperCase();
    const index = Number(m[2]);
    matches.push({
      start,
      end,
      token: m[0],
      normalizedToken: buildNormalized(category, index),
      category,
      index,
      matchType: "lenient",
    });
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}

function buildNormalized(category: string, index: number): string {
  return `__OPF_${category}_${index}__`;
}

function overlapsAny(
  ranges: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number
): boolean {
  for (const [s, e] of ranges) {
    // Half-open intersection: [start, end) ∩ [s, e) ≠ ∅
    if (start < e && end > s) return true;
  }
  return false;
}

function mergeOptions(
  defaults: RestoreOptions,
  overrides: RestoreOptions
): RestoreOptions {
  return {
    lenient: overrides.lenient ?? defaults.lenient,
    warnOnPartial: overrides.warnOnPartial ?? defaults.warnOnPartial,
    warnOnUnknownToken:
      overrides.warnOnUnknownToken ?? defaults.warnOnUnknownToken,
    partialMatchHandler:
      overrides.partialMatchHandler ?? defaults.partialMatchHandler,
    unknownTokenHandler:
      overrides.unknownTokenHandler ?? defaults.unknownTokenHandler,
    warn: overrides.warn ?? defaults.warn,
  };
}

function noopWarn(_msg: string): void {}
