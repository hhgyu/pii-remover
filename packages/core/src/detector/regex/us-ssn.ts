import type { Detection } from "../../types.js";

const SSN_REGEX = /\b(\d{3})-(\d{2})-(\d{4})\b/g;

export function findUsSsns(text: string): Detection[] {
  const out: Detection[] = [];
  for (const m of text.matchAll(SSN_REGEX)) {
    const area = m[1]!;
    const group = m[2]!;
    const serial = m[3]!;
    if (!isValidSsn(area, group, serial)) continue;
    const start = m.index ?? 0;
    out.push({
      start,
      end: start + m[0].length,
      category: "account_number",
      confidence: 0.9,
      text: m[0],
    });
  }
  return out;
}

export function isValidSsn(
  area: string,
  group: string,
  serial: string,
): boolean {
  const areaNum = Number(area);
  // Area: 000, 666, and 900-999 are never assigned.
  if (areaNum === 0 || areaNum === 666 || areaNum >= 900) return false;
  // Group "00" and serial "0000" are never assigned.
  if (group === "00") return false;
  if (serial === "0000") return false;
  return true;
}
