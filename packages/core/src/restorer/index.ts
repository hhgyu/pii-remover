import type { VaultManager } from "../vault/manager.js";
import { isInsidePath } from "./path.js";
import {
  buildRepairIndex,
  resolveMiss,
  type MissCause,
  type RepairCandidate,
} from "./repair.js";
import {
  scanTokens,
  scanTokensWithRepairCandidates,
  type TokenMatch,
} from "./scan.js";

export {
  scanTokens,
  scanTokensWithRepairCandidates,
  type TokenMatch,
} from "./scan.js";
export { isInsidePath } from "./path.js";
export { isWithinOneEdit, type MissCause } from "./repair.js";

/**
 * Outcome of a single `Restorer.restore()` call.
 *
 * Two partitions hold by construction and are worth relying on:
 *  - `unknownTokenCount === hallucinatedCount + deadTokenCount + ambiguousCount`
 *  - `repairedCount ⊆ restoredCount`
 *
 * `pathSkipCount` is a separate bucket of vault MISSES suppressed because they
 * sit inside a filesystem path; vault hits inside paths restore normally.
 * `residualTokenCount` counts tokens still matchable in the OUTPUT text — the
 * user-visible failure surface, which `unknownTokenCount` stops describing once
 * an unknown-token handler rewrites the span.
 */
export interface RestoreResult {
  text: string;
  matches: TokenMatch[];
  restoredCount: number;
  partialMatchCount: number;
  lenientRestoredCount: number;
  repairedCount: number;
  unknownTokenCount: number;
  /**
   * Misses whose epoch shows this key never minted the token. That is a fact
   * about the token, NOT blame: the model may have invented it, but a tool
   * result, a file the agent read, or the user's own message can equally carry
   * a token-shaped string. Deciding whose fault it was needs provenance, which
   * only the caller has — see `RestoreOptions.origin`.
   */
  foreignCount: number;
  deadTokenCount: number;
  ambiguousCount: number;
  pathSkipCount: number;
  residualTokenCount: number;
}

export type RestoreOrigin = "model" | "tool" | "user";

export interface UnknownTokenInfo {
  category: string;
  cause: MissCause;
}

export interface RestoreOptions {
  /** Activate the lenient fallback regex for LLM-mangled tokens. Default true. */
  lenient?: boolean;
  /** Warn on every lenient (non-canonical) match. Default true. */
  warnOnPartial?: boolean;
  /** Warn when a strict-form token is not in the vault. Default true. */
  warnOnUnknownToken?: boolean;
  /**
   * Attempt vault-bounded repair of a mutated hash (ADR-0021). Only accepts a
   * replacement when exactly ONE live vault entry lies within a single edit;
   * two or more candidates fail closed. Default true.
   */
  repair?: boolean;
  /**
   * Who wrote the text being restored. Only `"model"` text can hallucinate a
   * token; a `"tool"` result (a file the agent read, shell stdout, a web page)
   * or a `"user"` message carrying a token-shaped string is third-party data,
   * and counting it as a model failure poisons `hallucination_rate` — the very
   * number the prompt lever is chosen from. Defaults to `"model"`, so a caller
   * that forgets is attributed conservatively rather than silently exonerated.
   */
  origin?: RestoreOrigin;
  /** Called when a lenient match cannot be resolved. Return value replaces the
   *  span. Default: keep the original surface form. */
  partialMatchHandler?: (text: string, match: TokenMatch) => string;
  /** Called when a token cannot be resolved. Return value replaces the span.
   *  Default: keep the original token text. */
  unknownTokenHandler?: (token: string, info: UnknownTokenInfo) => string;
  warn?: (msg: string) => void;
  /** Skip tokens sitting inside a filesystem path span. Default true. */
  skipPathMatches?: boolean;
}

interface UnresolvedToken {
  match: TokenMatch;
  cause: MissCause;
}

/**
 * Typed as `Record<MissCause, ...>` so adding a fourth cause fails the build
 * instead of silently landing in no counter.
 */
const CAUSE_COUNTER = {
  foreign: "foreignCount",
  expired: "deadTokenCount",
  ambiguous: "ambiguousCount",
} as const satisfies Record<MissCause, keyof RestoreResult>;

const EMPTY_RESULT: Omit<RestoreResult, "text" | "matches"> = {
  restoredCount: 0,
  partialMatchCount: 0,
  lenientRestoredCount: 0,
  repairedCount: 0,
  unknownTokenCount: 0,
  foreignCount: 0,
  deadTokenCount: 0,
  ambiguousCount: 0,
  pathSkipCount: 0,
  residualTokenCount: 0,
};

/**
 * Token restorer (ADR-0020 round-trip, ADR-0021 miss classification).
 *
 *  1. Scan with the strict regex, then the lenient regex minus overlaps.
 *  2. Walk matches right-to-left so each substitution preserves the offsets of
 *     the matches still to come.
 *  3. Exact vault hit wins. Otherwise classify the miss and, when repair finds
 *     exactly one live vault entry within a single edit, restore that.
 */
export class Restorer {
  private readonly vault: VaultManager;
  private readonly defaultOpts: RestoreOptions;

  constructor(vault: VaultManager, defaultOpts: RestoreOptions = {}) {
    this.vault = vault;
    this.defaultOpts = defaultOpts;
  }

  scan(text: string): TokenMatch[] {
    return scanTokens(text);
  }

  /**
   * Resolve every token in `text` using the vault for `sessionId`.
   *
   * Throws `TypeError` if `sessionId` is empty. A session that was never
   * populated is allowed and yields all-unknown counts.
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
    if (text === "") return { text: "", matches: [], ...EMPTY_RESULT };

    const merged = mergeOptions(this.defaultOpts, opts);
    const warn = merged.warn ?? noopWarn;
    const warnOnPartial = merged.warnOnPartial ?? true;
    const skipPaths = merged.skipPathMatches ?? true;
    const repairEnabled = merged.repair ?? true;

    const scan = repairEnabled ? scanTokensWithRepairCandidates : scanTokens;
    const allMatches = scan(text);
    const matches =
      merged.lenient === false
        ? allMatches.filter((m) => m.matchType === "strict")
        : allMatches;

    const counts = { ...EMPTY_RESULT };
    for (const m of matches) {
      if (m.matchType === "lenient") counts.partialMatchCount++;
    }

    const epoch = this.vault.epoch();
    let repairIndex: RepairCandidate[] | null = null;

    let out = text;
    for (const m of [...matches].sort((a, b) => b.start - a.start)) {
      const entry = this.vault.lookup(sessionId, m.normalizedToken);
      if (entry) {
        out = splice(out, m, entry.text);
        counts.restoredCount++;
        if (m.matchType === "lenient") {
          counts.lenientRestoredCount++;
          if (warnOnPartial) warn(lenientResolvedMessage(m));
        }
        continue;
      }

      if (repairEnabled && repairIndex === null) {
        repairIndex = buildRepairIndex(this.vault.tokens(sessionId));
      }
      const resolution = repairEnabled
        ? resolveMiss(
            { category: m.category, hash: m.hash },
            epoch,
            repairIndex ?? []
          )
        : ({ kind: "unresolved", cause: "expired" } as const);

      if (resolution.kind === "repaired") {
        const repaired = this.vault.lookup(sessionId, resolution.normalizedToken);
        if (repaired) {
          out = splice(out, m, repaired.text);
          counts.restoredCount++;
          counts.repairedCount++;
          warn(repairedMessage(m, resolution.normalizedToken));
          continue;
        }
      }

      if (skipPaths && isInsidePath(out, m.start, m.end)) {
        counts.pathSkipCount++;
        continue;
      }

      const cause =
        resolution.kind === "unresolved" ? resolution.cause : "expired";
      counts.unknownTokenCount++;
      counts[CAUSE_COUNTER[cause]]++;

      out = this.handleUnresolved(out, { match: m, cause }, merged);
    }

    return {
      text: out,
      matches,
      ...counts,
      residualTokenCount: matches.length === 0 ? 0 : scan(out).length,
    };
  }

  private handleUnresolved(
    text: string,
    unresolved: UnresolvedToken,
    opts: RestoreOptions
  ): string {
    const { match, cause } = unresolved;
    const warn = opts.warn ?? noopWarn;
    // A repair candidate is a guess about what the span even is, so an
    // unresolved one is left byte-for-byte alone: rewriting it could destroy
    // ordinary text that merely resembles a token.
    if (match.matchType === "repair") {
      if (opts.warnOnUnknownToken ?? true) warn(unresolvedMessage(match, cause));
      return text;
    }
    if (match.matchType === "strict") {
      if (opts.warnOnUnknownToken ?? true) warn(unresolvedMessage(match, cause));
      const handler = opts.unknownTokenHandler;
      if (handler) {
        return splice(text, match, handler(match.token, { category: match.category, cause }));
      }
      return text;
    }
    if (opts.warnOnPartial ?? true) warn(unresolvedMessage(match, cause));
    const handler = opts.partialMatchHandler;
    return handler ? splice(text, match, handler(match.token, match)) : text;
  }
}

function splice(text: string, match: TokenMatch, replacement: string): string {
  return text.slice(0, match.start) + replacement + text.slice(match.end);
}

function lenientResolvedMessage(m: TokenMatch): string {
  return `[WARN] PII restore: lenient match '${m.token}' resolved as '${m.normalizedToken}' (LLM transformation suspected)`;
}

function repairedMessage(m: TokenMatch, resolved: string): string {
  return `[WARN] PII restore: repaired mutated token '${m.token}' to '${resolved}' (single vault candidate within one edit)`;
}

const CAUSE_EXPLANATION: Record<MissCause, string> = {
  foreign:
    "not minted by this token key — possibly hallucinated by the model, or the key was replaced",
  expired:
    "minted by this token key but absent from the vault — dead token, likely from a previous process",
  ambiguous:
    "repair found more than one vault entry within a single edit — failing closed rather than guessing",
};

function unresolvedMessage(m: TokenMatch, cause: MissCause): string {
  return `[WARN] PII restore: token '${m.token}' unresolved (${cause}): ${CAUSE_EXPLANATION[cause]}`;
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
    repair: overrides.repair ?? defaults.repair,
    origin: overrides.origin ?? defaults.origin,
    partialMatchHandler:
      overrides.partialMatchHandler ?? defaults.partialMatchHandler,
    unknownTokenHandler:
      overrides.unknownTokenHandler ?? defaults.unknownTokenHandler,
    warn: overrides.warn ?? defaults.warn,
    skipPathMatches: overrides.skipPathMatches ?? defaults.skipPathMatches,
  };
}

function noopWarn(_msg: string): void {}
