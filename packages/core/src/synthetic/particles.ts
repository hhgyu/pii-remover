export const KOREAN_PARTICLE_SUFFIXES: readonly string[] = [
  "이", "가", "은", "는", "을", "를", "의", "와", "과", "도", "만",
  "씨", "님", "군", "양",
];

const HANGUL_TEST = /[\uAC00-\uD7A3]/;

export function endsWithHangul(value: string): boolean {
  return value.length > 0 && HANGUL_TEST.test(value[value.length - 1]!);
}

export function isHangulText(value: string): boolean {
  return HANGUL_TEST.test(value);
}
