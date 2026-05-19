/**
 * 한국 휴대전화 번호 (Mobile Phone Number) detector.
 *
 * Reference: ADR-0007 §Decision §1, ADR-0010 §3 (reuses `private_phone`).
 *
 * Pattern: 01[016-9] prefix + optional "-" + 3-4 digit middle + optional "-" + 4 digit suffix.
 * Total digit length: 10 (3-3-4) or 11 (3-4-4). Older SKT/KT/LGU+ prefixes
 * (011/016/017/018/019) are supported per ADR-0007.
 */
import type { Detection } from "../../types.js";

const KR_PHONE_REGEX = /\b01[016-9]-?\d{3,4}-?\d{4}\b/g;

export function findKoreanPhones(text: string): Detection[] {
  const out: Detection[] = [];
  for (const m of text.matchAll(KR_PHONE_REGEX)) {
    const raw = m[0];
    const digits = raw.replace(/\D/g, "");
    if (digits.length !== 10 && digits.length !== 11) continue;
    const start = m.index ?? 0;
    out.push({
      start,
      end: start + raw.length,
      category: "private_phone",
      confidence: 0.95,
      text: raw,
    });
  }
  return out;
}
