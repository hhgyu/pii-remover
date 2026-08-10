import type {
  Detection,
  DetectOpts,
  DetectionResult,
  PIICategory,
  TrustTier,
} from "../types.js";
import { ALL_CATEGORIES } from "../types.js";
import type { BackendClient, BackendHealth } from "./client.js";
import type { CustomPatternConfig } from "../config/schema.js";

interface CompiledPattern {
  readonly name: string;
  readonly regex: RegExp;
  readonly category: PIICategory;
  readonly confidence: number;
}

export class CustomPatternBackend implements BackendClient {
  readonly name = "custom-pattern";
  readonly trust_tier: TrustTier = "local";
  private readonly patterns: readonly CompiledPattern[];

  constructor(patterns: readonly CustomPatternConfig[]) {
    this.patterns = compilePatterns(patterns);
  }

  size(): number {
    return this.patterns.length;
  }

  async detect(text: string, _opts: DetectOpts): Promise<DetectionResult> {
    const t0 = performance.now();
    const detections: Detection[] = [];
    if (text.length > 0) {
      for (const p of this.patterns) {
        collectMatches(text, p, detections);
      }
    }
    return {
      detections,
      backend_name: this.name,
      latency_ms: performance.now() - t0,
    };
  }

  async healthCheck(): Promise<BackendHealth> {
    return { ok: true, latency_ms: 0, version: "custom-pattern-v1" };
  }
}

function compilePatterns(
  raw: readonly CustomPatternConfig[],
): readonly CompiledPattern[] {
  const out: CompiledPattern[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const p = raw[i]!;
    if (p.enabled === false) continue;
    if (typeof p.pattern !== "string" || p.pattern.length === 0) {
      throw new Error(
        `CustomPatternBackend: patterns[${i}].pattern must be a non-empty string (fail-closed)`,
      );
    }
    if (!ALL_CATEGORIES.includes(p.category)) {
      throw new Error(
        `CustomPatternBackend: patterns[${i}].category '${String(p.category)}' is not a known PIICategory (fail-closed)`,
      );
    }
    const confidence = p.confidence ?? 0.9;
    if (confidence < 0 || confidence > 1 || !Number.isFinite(confidence)) {
      throw new Error(
        `CustomPatternBackend: patterns[${i}].confidence must be within [0, 1] (fail-closed)`,
      );
    }
    let regex: RegExp;
    try {
      regex = new RegExp(p.pattern, normalizeFlags(p.flags));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `CustomPatternBackend: patterns[${i}] ('${p.name}') has an invalid regex: ${reason} (fail-closed)`,
      );
    }
    out.push({ name: p.name, regex, category: p.category, confidence });
  }
  return out;
}

function normalizeFlags(flags: string | undefined): string {
  const set = new Set((flags ?? "").split(""));
  set.add("g");
  return [...set].join("");
}

function collectMatches(
  text: string,
  pattern: CompiledPattern,
  out: Detection[],
): void {
  pattern.regex.lastIndex = 0;
  for (const m of text.matchAll(pattern.regex)) {
    const full = m[0];
    if (full.length === 0) continue;
    const start = m.index ?? 0;
    out.push({
      start,
      end: start + full.length,
      category: pattern.category,
      confidence: pattern.confidence,
      text: full,
    });
  }
}
