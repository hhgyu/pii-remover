import { randomBytes, randomUUID } from "node:crypto";
import type { Detection, PIICategory, TokenizedSpan } from "../types.js";
import { formatToken } from "../token/format.js";
import { categoryToTokenLabel } from "../token/category-map.js";
import { tokenHash } from "../redaction/token-hash.js";
import { SCHEMA_VERSION, type Vault, type VaultEntry } from "./schema.js";

const MAX_ENTRIES_HARD = 100_000;
const MAX_ENTRIES_WARN = 10_000;

export type AssignedToken = TokenizedSpan & { syntheticValue?: string };

export type SyntheticGenerator = (
  category: PIICategory,
  index: number,
  text: string,
) => string;

export interface VaultManagerOptions {
  maxEntries?: number;
  onWarn?: (message: string) => void;
  syntheticGenerator?: SyntheticGenerator;
  /** HMAC key for deterministic token hashing (ADR-0020). When omitted, a
   *  process-local random key is used (tokens stay consistent within the
   *  process but not across restarts). */
  tokenKey?: Buffer;
}

export class VaultManager {
  private readonly sessions = new Map<string, Vault>();
  private readonly maxEntries: number;
  private readonly onWarn: (message: string) => void;
  private readonly syntheticGenerator: SyntheticGenerator | null;
  private readonly tokenKey: Buffer;

  constructor(opts: VaultManagerOptions = {}) {
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES_HARD;
    this.onWarn = opts.onWarn ?? (() => {});
    this.syntheticGenerator = opts.syntheticGenerator ?? null;
    this.tokenKey = opts.tokenKey ?? randomBytes(32);
  }

  entries(sessionId: string): VaultEntry[] {
    const v = this.sessions.get(sessionId);
    if (!v) return [];
    return Object.values(v.entries);
  }

  getOrCreate(sessionId: string): Vault {
    let v = this.sessions.get(sessionId);
    if (!v) {
      v = {
        schema_version: SCHEMA_VERSION,
        vault_id: randomUUID(),
        entries: {},
        created_at: Date.now(),
      };
      this.sessions.set(sessionId, v);
    }
    return v;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  size(sessionId: string): number {
    const v = this.sessions.get(sessionId);
    return v ? Object.keys(v.entries).length : 0;
  }

  dispose(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  disposeAll(): void {
    this.sessions.clear();
  }

  lookup(sessionId: string, token: string): VaultEntry | null {
    const v = this.sessions.get(sessionId);
    if (!v) return null;
    return v.entries[token] ?? null;
  }

  assign(sessionId: string, detections: readonly Detection[]): AssignedToken[] {
    if (detections.length === 0) return [];
    assertNoOverlap(detections);
    const vault = this.getOrCreate(sessionId);

    const dedupLookup = new Map<string, string>();
    for (const [token, entry] of Object.entries(vault.entries)) {
      dedupLookup.set(dedupKey(entry.label, entry.canonical_text), token);
    }

    const result: AssignedToken[] = detections.map((d) => {
      const label = d.category;
      const canonical = canonicalize(d.text);
      const key = dedupKey(label, canonical);
      let token = dedupLookup.get(key);
      if (!token) {
        const tokenLabel = categoryToTokenLabel(label as PIICategory);
        const hash = tokenHash(this.tokenKey, tokenLabel, canonical);
        token = formatToken(tokenLabel, hash);
        const collision = vault.entries[token];
        if (collision && collision.canonical_text !== canonical) {
          throw new Error(
            `Vault ${vault.vault_id}: token hash collision for ${token} ` +
              `(existing label=${collision.label}; new label=${label}) — fail-closed`,
          );
        }
        const entry: VaultEntry = {
          label,
          text: d.text,
          canonical_text: canonical,
          id: hash,
        };
        if (this.syntheticGenerator) {
          entry.synthetic_value = this.syntheticGenerator(
            label as PIICategory,
            hashToSeed(hash),
            d.text,
          );
        }
        vault.entries[token] = entry;
        dedupLookup.set(key, token);
      }
      const existing = vault.entries[token]!;
      const out: AssignedToken = { ...d, token };
      if (existing.synthetic_value !== undefined) {
        out.syntheticValue = existing.synthetic_value;
      }
      return out;
    });

    const size = Object.keys(vault.entries).length;
    if (size > this.maxEntries) {
      throw new Error(
        `Vault ${vault.vault_id}: entries (${size}) exceeded hard limit (${this.maxEntries})`
      );
    }
    if (size >= MAX_ENTRIES_WARN && size - detections.length < MAX_ENTRIES_WARN) {
      this.onWarn(
        `Vault ${vault.vault_id}: entries reached soft limit (${MAX_ENTRIES_WARN})`
      );
    }
    return result;
  }
}

function canonicalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Map a base36 token hash to a stable positive integer seed for synthetic
 * value generation (ADR-0018). Deterministic: same hash → same seed.
 */
function hashToSeed(hash: string): number {
  let acc = 0;
  for (let i = 0; i < hash.length; i += 1) {
    acc = (acc * 31 + hash.charCodeAt(i)) % 1_000_000_007;
  }
  return acc + 1;
}

function dedupKey(label: string, canonical: string): string {
  return `${label}\u0000${canonical}`;
}

function assertNoOverlap(detections: readonly Detection[]): void {
  if (detections.length < 2) return;
  const sorted = [...detections].sort(
    (a, b) => a.start - b.start || a.end - b.end
  );
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.start < prev.end) {
      throw new RangeError(
        `Overlapping spans: [${prev.start}, ${prev.end}) (${prev.category}) and [${cur.start}, ${cur.end}) (${cur.category})`
      );
    }
  }
}
