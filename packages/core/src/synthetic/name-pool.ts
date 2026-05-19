import data from "../data/synthetic-names.json" with { type: "json" };

const KOREAN_POOL: readonly string[] = data.korean;
const ENGLISH_POOL: readonly string[] = data.english;

const HANGUL_TEST = /[\uAC00-\uD7A3]/;

export function selectSyntheticName(
  originalText: string,
  index: number,
): string {
  const pool = HANGUL_TEST.test(originalText) ? KOREAN_POOL : ENGLISH_POOL;
  const slot = ((index - 1) % pool.length + pool.length) % pool.length;
  return pool[slot]!;
}

export function getNamePoolSize(locale: "korean" | "english"): number {
  return locale === "korean" ? KOREAN_POOL.length : ENGLISH_POOL.length;
}
