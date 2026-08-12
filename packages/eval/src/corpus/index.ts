import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyTokens,
  parseToken,
  VaultManager,
  type Detection,
} from "@pii-remover/core";

import type {
  CorpusEntry,
  CorpusSpan,
  MaskedEntry,
  MutationCorpus,
  TokenInfo,
} from "../types.js";

export const PACKAGE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const CORPUS_PATH = join(PACKAGE_ROOT, "fixtures", "mutation-corpus.json");

export const FIXTURES_DIR = join(PACKAGE_ROOT, "fixtures");

export const EVAL_SESSION_ID = "eval:tier1";

/**
 * Fixed HMAC key. `VaultManager` falls back to `randomBytes(32)` when none is
 * supplied, which would re-mint different hashes on every run and make
 * baseline.md churn. A constant key keeps the whole harness reproducible.
 */
const EVAL_TOKEN_KEY = createHash("sha256")
  .update("pii-remover/eval/tier1/v1")
  .digest();

export function loadCorpus(path: string = CORPUS_PATH): MutationCorpus {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return assertCorpus(parsed, path);
}

/** A masked corpus plus the vault that backs it. */
export interface MaskedCorpus {
  readonly sessionId: string;
  readonly vault: VaultManager;
  readonly entries: readonly MaskedEntry[];
}

/**
 * Mask every corpus entry through the real `VaultManager` using the declared
 * spans as ground truth. No detection backend is involved, so Tier 1 needs no
 * network and no Docker, and the token set is exactly what the fixture says.
 *
 * All entries share one session — that is what a real process does, and it
 * widens the false-restoration surface: a fuzzy restorer could mis-resolve a
 * corrupted token onto ANY live entry, not just the one in the same sentence.
 */
export function maskCorpus(corpus: MutationCorpus): MaskedCorpus {
  const vault = new VaultManager({ tokenKey: EVAL_TOKEN_KEY });
  const entries = corpus.entries.map((entry) => maskEntry(vault, entry));
  return { sessionId: EVAL_SESSION_ID, vault, entries };
}

function maskEntry(vault: VaultManager, entry: CorpusEntry): MaskedEntry {
  const detections = locateSpans(entry);
  const assigned = vault.assign(EVAL_SESSION_ID, detections);
  const masked = applyTokens(entry.text, assigned);
  const seen = new Map<string, TokenInfo>();
  for (const a of assigned) {
    if (seen.has(a.token)) continue;
    const parsed = parseToken(a.token);
    if (!parsed) {
      throw new Error(`corpus ${entry.id}: minted token is not canonical`);
    }
    seen.set(a.token, {
      token: a.token,
      category: parsed.category,
      hash: parsed.hash,
      value: a.text,
      piiCategory: a.category,
    });
  }
  return {
    id: entry.id,
    lang: entry.lang,
    surface: entry.surface,
    original: entry.text,
    masked,
    tokens: [...seen.values()],
  };
}

/**
 * Resolve declared spans to offsets. Spans must appear in the entry text in
 * declaration order; the cursor advance is what lets one entry declare the
 * same value twice (`en-repeat-01`) without the two spans colliding.
 */
export function locateSpans(entry: CorpusEntry): Detection[] {
  const out: Detection[] = [];
  let cursor = 0;
  for (const span of entry.spans) {
    const start = entry.text.indexOf(span.text, cursor);
    if (start < 0) {
      throw new Error(
        `corpus ${entry.id}: span ${JSON.stringify(span.text)} not found at or after offset ${cursor}`,
      );
    }
    out.push({
      start,
      end: start + span.text.length,
      category: span.category,
      confidence: 1,
      text: span.text,
    });
    cursor = start + span.text.length;
  }
  return out;
}

/** Every (token, value) pair minted for the corpus — the false-restoration
 *  scorer's universe of "values that must never surface unbidden". */
export function vaultValues(masked: MaskedCorpus): readonly TokenInfo[] {
  const seen = new Map<string, TokenInfo>();
  for (const entry of masked.entries) {
    for (const token of entry.tokens) seen.set(token.token, token);
  }
  return [...seen.values()];
}

function assertCorpus(value: unknown, path: string): MutationCorpus {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`corpus ${path}: root must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw["entries"]) || raw["entries"].length === 0) {
    throw new TypeError(`corpus ${path}: 'entries' must be a non-empty array`);
  }
  if (!Array.isArray(raw["synthetic_values"])) {
    throw new TypeError(`corpus ${path}: 'synthetic_values' must be an array`);
  }
  if (!Array.isArray(raw["derived_from"])) {
    throw new TypeError(`corpus ${path}: 'derived_from' must be an array`);
  }
  const ids = new Set<string>();
  for (const entry of raw["entries"] as readonly CorpusEntry[]) {
    if (ids.has(entry.id)) {
      throw new TypeError(`corpus ${path}: duplicate entry id ${entry.id}`);
    }
    ids.add(entry.id);
    assertSpans(entry, path);
  }
  return raw as unknown as MutationCorpus;
}

function assertSpans(entry: CorpusEntry, path: string): void {
  if (!Array.isArray(entry.spans) || entry.spans.length === 0) {
    throw new TypeError(`corpus ${path}: entry ${entry.id} declares no spans`);
  }
  for (const span of entry.spans as readonly CorpusSpan[]) {
    if (typeof span.text !== "string" || span.text.length === 0) {
      throw new TypeError(`corpus ${path}: entry ${entry.id} has an empty span`);
    }
  }
}
