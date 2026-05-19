/**
 * Korean name heuristic matcher (ADR-0007 §Decision §1).
 *
 * Matches Hangul runs of 2-4 characters where:
 *   - first 2 chars are a compound surname (e.g., 남궁, 황보) + 1-2 given chars, OR
 *   - first 1 char is a single surname + 1-3 given chars.
 *
 * Stopword filter removes common Korean words sharing surname prefixes
 * (박스, 정말, 김치, 이거, ...). False-positive precision tuned via the
 * stopwords list; recall is bounded by the surname list completeness.
 */
import type { Detection } from "../../types.js";
import { SURNAMES } from "./surnames.js";
import { KOREAN_STOPWORDS } from "./stopwords.js";

const HANGUL_RUN_REGEX = /[\uAC00-\uD7A3]{2,4}/g;

/**
 * Trailing Korean particles/honorifics commonly attached to names.
 * Stripped before name validation to recover the "exact name" span.
 *
 *   - Markers  : 이/가 (subj), 을/를 (obj), 은/는 (topic), 의 (poss),
 *                와/과 (and), 도 (also), 만 (only), 에 (loc)
 *   - Honorif. : 씨, 님, 군, 양
 *
 * Stripping is bounded by `isNameStructure` re-validation so "박물관에"
 * (location particle on a stopword noun) is recovered as "박물관" and
 * the stopword filter then suppresses the false positive.
 */
const TRAILING_PARTICLES: ReadonlySet<string> = new Set([
  "이", "가", "을", "를", "은", "는", "의", "와", "과", "도", "만",
  "에",
  "씨", "님", "군", "양",
]);

export interface FindKoreanNamesOptions {
  surnames?: ReadonlySet<string>;
  stopwords?: ReadonlySet<string>;
}

export function findKoreanNames(
  text: string,
  opts: FindKoreanNamesOptions = {}
): Detection[] {
  const surnames = opts.surnames ?? SURNAMES;
  const stopwords = opts.stopwords ?? KOREAN_STOPWORDS;
  const out: Detection[] = [];
  for (const m of text.matchAll(HANGUL_RUN_REGEX)) {
    const rawMatch = m[0];
    const matchStart = m.index ?? 0;

    const raw = stripTrailingParticle(rawMatch, surnames);

    if (stopwords.has(raw)) continue;
    if (!isNameStructure(raw, surnames)) continue;

    out.push({
      start: matchStart,
      end: matchStart + raw.length,
      category: "private_person",
      confidence: 0.6,
      text: raw,
    });
  }
  return out;
}

function stripTrailingParticle(
  raw: string,
  surnames: ReadonlySet<string>
): string {
  if (raw.length < 3) return raw;
  const last = raw[raw.length - 1] ?? "";
  if (!TRAILING_PARTICLES.has(last)) return raw;
  const shorter = raw.slice(0, -1);
  return isNameStructure(shorter, surnames) ? shorter : raw;
}

function isNameStructure(
  raw: string,
  surnames: ReadonlySet<string>
): boolean {
  if (raw.length < 2) return false;
  const compound = raw.slice(0, 2);
  if (surnames.has(compound)) {
    const givenLen = raw.length - 2;
    return givenLen >= 1 && givenLen <= 2;
  }
  const single = raw[0] ?? "";
  const givenLen = raw.length - 1;
  return givenLen >= 1 && givenLen <= 3 && surnames.has(single);
}
