/**
 * 한국 주민등록번호 (RRN) detector.
 *
 * Reference: ADR-0007 §Decision §1, ADR-0010 §2.
 *
 * Pattern: 6 digits + optional "-" + 1 digit (1-4 for gender/century) + 6 digits.
 *
 * Checksum algorithm (ADR-0007 §Implementation Notes):
 *   weights = [2,3,4,5,6,7,8,9,2,3,4,5]
 *   sum = digits[0..11] · weights
 *   check = (11 - sum % 11) % 10
 *   valid iff check === digits[12]
 *
 * Some pre-2020 RRNs do not satisfy the checksum (legacy data). Callers may
 * pass `strict_checksum: false` to skip the checksum and accept any 13-digit
 * RRN-shaped value with a valid gender/century digit.
 */
import type { Detection } from "../../types.js";

const RRN_REGEX = /\b\d{6}-?[1-4]\d{6}\b/g;

const RRN_WEIGHTS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];

export interface FindRrnOptions {
  /** When false, skip the checksum and accept any RRN-shaped value. Default true. */
  strict_checksum?: boolean;
}

/**
 * Find Korean RRN occurrences in `text`.
 *
 * Confidence is 0.99 with checksum, 0.7 without (lenient mode).
 */
export function findKoreanRrns(
  text: string,
  opts: FindRrnOptions = {}
): Detection[] {
  const strict = opts.strict_checksum !== false;
  const out: Detection[] = [];
  for (const m of text.matchAll(RRN_REGEX)) {
    const raw = m[0];
    const digits = stripNonDigits(raw);
    if (digits.length !== 13) continue;
    const valid = isValidRrnChecksum(digits);
    if (strict && !valid) continue;
    const start = m.index ?? 0;
    out.push({
      start,
      end: start + raw.length,
      category: "rrn",
      confidence: valid ? 0.99 : 0.7,
      text: raw,
    });
  }
  return out;
}

/**
 * Validate RRN checksum. Returns false on any non-digit input or wrong length.
 */
export function isValidRrnChecksum(digitsOrRaw: string): boolean {
  const digits = stripNonDigits(digitsOrRaw);
  if (digits.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    sum += d * (RRN_WEIGHTS[i] ?? 0);
  }
  const expected = (11 - (sum % 11)) % 10;
  const actual = digits.charCodeAt(12) - 48;
  return expected === actual;
}

function stripNonDigits(s: string): string {
  return s.replace(/\D/g, "");
}
