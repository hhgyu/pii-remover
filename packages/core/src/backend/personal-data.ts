import type {
  Detection,
  DetectOpts,
  DetectionResult,
  PIICategory,
  TrustTier,
} from "../types.js";
import { ALL_CATEGORIES } from "../types.js";
import type { BackendClient, BackendHealth } from "./client.js";
import type { PersonalDataEntry } from "../config/schema.js";

interface NormalizedEntry {
  readonly value: string;
  readonly category: PIICategory;
  readonly caseSensitive: boolean;
  readonly wordBoundary: boolean;
  readonly isHangulValue: boolean;
}

const HANGUL_TEST = /[\uAC00-\uD7A3]/;
const WORD_CHAR = /[A-Za-z0-9_]/;

export class PersonalDataBackend implements BackendClient {
  readonly name = "personal-data";
  readonly trust_tier: TrustTier = "local";
  private readonly entries: readonly NormalizedEntry[];

  constructor(entries: readonly PersonalDataEntry[]) {
    this.entries = normalizeEntries(entries);
  }

  size(): number {
    return this.entries.length;
  }

  async detect(text: string, _opts: DetectOpts): Promise<DetectionResult> {
    const t0 = performance.now();
    const detections: Detection[] = [];
    if (text.length === 0 || this.entries.length === 0) {
      return {
        detections,
        backend_name: this.name,
        latency_ms: performance.now() - t0,
      };
    }
    for (const entry of this.entries) {
      collectMatches(text, entry, detections);
    }
    return {
      detections,
      backend_name: this.name,
      latency_ms: performance.now() - t0,
    };
  }

  async healthCheck(): Promise<BackendHealth> {
    return { ok: true, latency_ms: 0, version: "personal-data-v1" };
  }
}

function normalizeEntries(
  raw: readonly PersonalDataEntry[],
): readonly NormalizedEntry[] {
  const seen = new Set<string>();
  const out: NormalizedEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const e = raw[i]!;
    if (typeof e.value !== "string" || e.value.trim().length === 0) {
      throw new Error(
        `PersonalDataBackend: entries[${i}].value must be a non-empty string (fail-closed)`,
      );
    }
    if (!ALL_CATEGORIES.includes(e.category)) {
      throw new Error(
        `PersonalDataBackend: entries[${i}].category '${String(e.category)}' is not a known PIICategory (fail-closed)`,
      );
    }
    const value = e.value;
    const category = e.category;
    const caseSensitive = e.case_sensitive ?? false;
    const isHangulValue = HANGUL_TEST.test(value);
    const wordBoundary = e.word_boundary ?? !isHangulValue;
    const dedupKey = `${category}::${caseSensitive ? value : value.toLowerCase()}::${wordBoundary}::${caseSensitive}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({
      value,
      category,
      caseSensitive,
      wordBoundary,
      isHangulValue,
    });
  }
  return out;
}

function collectMatches(
  text: string,
  entry: NormalizedEntry,
  out: Detection[],
): void {
  const needle = entry.caseSensitive ? entry.value : entry.value.toLowerCase();
  const haystack = entry.caseSensitive ? text : text.toLowerCase();
  if (needle.length === 0) return;
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    const end = idx + needle.length;
    if (!entry.wordBoundary || isWordBoundary(text, idx, end, entry.isHangulValue)) {
      out.push({
        start: idx,
        end,
        category: entry.category,
        confidence: 0.95,
        text: text.slice(idx, end),
      });
    }
    from = idx + 1;
  }
}

function isWordBoundary(
  text: string,
  start: number,
  end: number,
  isHangulValue: boolean,
): boolean {
  const left = start > 0 ? text[start - 1] : undefined;
  const right = end < text.length ? text[end] : undefined;
  if (isHangulValue) {
    return (
      !(left !== undefined && HANGUL_TEST.test(left)) &&
      !(right !== undefined && HANGUL_TEST.test(right))
    );
  }
  return (
    !(left !== undefined && WORD_CHAR.test(left)) &&
    !(right !== undefined && WORD_CHAR.test(right))
  );
}
