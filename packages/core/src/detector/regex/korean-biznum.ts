/**
 * 한국 사업자등록번호 (Business Registration Number) detector.
 *
 * Reference: ADR-0007 §Decision §1, ADR-0010 §2.
 *
 * Pattern: 3 digits + optional "-" + 2 digits + optional "-" + 5 digits.
 *
 * Checksum algorithm (National Tax Service spec):
 *   weights = [1,3,7,1,3,7,1,3,5]
 *   sum_partial = digits[0..8] · weights
 *   sum = sum_partial + floor((digits[8] * 5) / 10)
 *   check = (10 - sum % 10) % 10
 *   valid iff check === digits[9]
 */
import type { Detection } from "../../types.js";

const BIZNUM_REGEX = /\b\d{3}-?\d{2}-?\d{5}\b/g;

const BIZNUM_WEIGHTS: readonly number[] = [1, 3, 7, 1, 3, 7, 1, 3, 5];

export function findKoreanBizNums(text: string): Detection[] {
  const out: Detection[] = [];
  for (const m of text.matchAll(BIZNUM_REGEX)) {
    const raw = m[0];
    const digits = stripNonDigits(raw);
    if (digits.length !== 10) continue;
    if (!isValidBizNumChecksum(digits)) continue;
    const start = m.index ?? 0;
    out.push({
      start,
      end: start + raw.length,
      category: "biz_num",
      confidence: 0.99,
      text: raw,
    });
  }
  return out;
}

export function isValidBizNumChecksum(digitsOrRaw: string): boolean {
  const digits = stripNonDigits(digitsOrRaw);
  if (digits.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    sum += d * (BIZNUM_WEIGHTS[i] ?? 0);
  }
  const d8 = digits.charCodeAt(8) - 48;
  sum += Math.floor((d8 * 5) / 10);
  const expected = (10 - (sum % 10)) % 10;
  const actual = digits.charCodeAt(9) - 48;
  return expected === actual;
}

function stripNonDigits(s: string): string {
  return s.replace(/\D/g, "");
}
