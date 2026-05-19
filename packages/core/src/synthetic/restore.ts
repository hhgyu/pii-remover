/**
 * Synthetic-mode restoration: scan text for vault entries' `synthetic_value`
 * and replace them with the original `text`. Supports a Korean particle
 * suffix lenient mode (ADR-0018 §7).
 */

import type { VaultEntry } from "../vault/schema.js";
import { KOREAN_PARTICLE_SUFFIXES, isHangulText } from "./particles.js";

interface Span {
  start: number;
  end: number;
  replacement: string;
}

const WORD_CHAR = /[A-Za-z0-9_]/;
const HANGUL = /[\uAC00-\uD7A3]/;

export function restoreSynthetic(
  text: string,
  entries: readonly VaultEntry[],
): { text: string; restoredCount: number } {
  if (text.length === 0 || entries.length === 0) {
    return { text, restoredCount: 0 };
  }
  const sorted = [...entries]
    .filter((e) => typeof e.synthetic_value === "string" && e.synthetic_value.length > 0)
    .sort(
      (a, b) => (b.synthetic_value!.length) - (a.synthetic_value!.length),
    );
  const occupied: Array<[number, number]> = [];
  const spans: Span[] = [];
  for (const entry of sorted) {
    const synthetic = entry.synthetic_value!;
    const hangul = isHangulText(synthetic);
    let from = 0;
    while (from <= text.length) {
      const idx = text.indexOf(synthetic, from);
      if (idx === -1) break;
      const end = idx + synthetic.length;
      const matchEnd = hangul
        ? expandKoreanParticle(text, end)
        : end;
      if (isMatchValid(text, idx, end, hangul) && !overlaps(occupied, idx, matchEnd)) {
        spans.push({ start: idx, end: matchEnd, replacement: entry.text });
        occupied.push([idx, matchEnd]);
        from = matchEnd;
        continue;
      }
      from = idx + 1;
    }
  }
  if (spans.length === 0) return { text, restoredCount: 0 };
  spans.sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of spans) {
    out = out.slice(0, s.start) + s.replacement + out.slice(s.end);
  }
  return { text: out, restoredCount: spans.length };
}

function isMatchValid(
  text: string,
  start: number,
  end: number,
  hangul: boolean,
): boolean {
  const left = start > 0 ? text[start - 1] : undefined;
  const right = end < text.length ? text[end] : undefined;
  if (hangul) {
    return !(left !== undefined && HANGUL.test(left))
        && !(right !== undefined && HANGUL.test(right) && !isKoreanParticleStart(text, end));
  }
  return !(left !== undefined && WORD_CHAR.test(left))
      && !(right !== undefined && WORD_CHAR.test(right));
}

function isKoreanParticleStart(text: string, pos: number): boolean {
  if (pos >= text.length) return false;
  const ch = text[pos]!;
  return KOREAN_PARTICLE_SUFFIXES.includes(ch);
}

function expandKoreanParticle(text: string, end: number): number {
  if (end >= text.length) return end;
  const ch = text[end]!;
  if (!KOREAN_PARTICLE_SUFFIXES.includes(ch)) return end;
  const after = end + 1 < text.length ? text[end + 1] : undefined;
  if (after !== undefined && HANGUL.test(after)) return end;
  return end + 1;
}

function overlaps(
  ranges: ReadonlyArray<[number, number]>,
  start: number,
  end: number,
): boolean {
  for (const [s, e] of ranges) {
    if (start < e && end > s) return true;
  }
  return false;
}
