import type { PIICategory } from "../types.js";
import type { TypeRedactionOverride } from "../config/schema.js";
import { categoryToTokenLabel } from "../token/category-map.js";

const DEFAULT_VISIBLE_SUFFIX = 4;

interface NormalizedOverride {
  readonly mode: "token" | "mask" | "partial";
  readonly placeholder?: string;
  readonly visibleSuffix: number;
}

export class TypeRedactor {
  private readonly overrides: ReadonlyMap<PIICategory, NormalizedOverride>;

  constructor(overrides: readonly TypeRedactionOverride[]) {
    const map = new Map<PIICategory, NormalizedOverride>();
    for (const o of overrides) {
      const normalized: NormalizedOverride = {
        mode: o.mode,
        visibleSuffix: o.visible_suffix ?? DEFAULT_VISIBLE_SUFFIX,
      };
      if (o.placeholder !== undefined) {
        (normalized as { placeholder?: string }).placeholder = o.placeholder;
      }
      map.set(o.category, normalized);
    }
    this.overrides = map;
  }

  hasOverride(category: PIICategory): boolean {
    const o = this.overrides.get(category);
    return o !== undefined && o.mode !== "token";
  }

  /**
   * Returns the redacted replacement when an override applies, otherwise null
   * (caller falls back to the reversible vault token).
   */
  redact(category: PIICategory, text: string): string | null {
    const o = this.overrides.get(category);
    if (!o || o.mode === "token") return null;
    if (o.mode === "mask") {
      return o.placeholder ?? `[${categoryToTokenLabel(category)}]`;
    }
    return partialMask(text, o.visibleSuffix);
  }
}

function partialMask(text: string, visibleSuffix: number): string {
  const chars = [...text];
  if (visibleSuffix <= 0) {
    return maskDigitsAndAlnum(chars, chars.length);
  }
  const hiddenCount = Math.max(0, chars.length - visibleSuffix);
  return maskDigitsAndAlnum(chars, hiddenCount);
}

function maskDigitsAndAlnum(chars: string[], hiddenCount: number): string {
  let out = "";
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (i < hiddenCount && /[A-Za-z0-9]/.test(ch)) {
      out += "*";
    } else {
      out += ch;
    }
  }
  return out;
}
