import type { PIICategory } from "../types.js";
import { selectSyntheticName } from "./name-pool.js";
import {
  syntheticBizNum,
  syntheticCard,
  syntheticRrn,
} from "./checksum.js";

export function synthesize(
  category: PIICategory,
  index: number,
  originalText: string,
): string {
  switch (category) {
    case "private_person":
      return selectSyntheticName(originalText, index);
    case "private_email":
      return `synthetic.user${index}@example.invalid`;
    case "private_phone":
      return `010-0000-${String(((index - 1) % 9999) + 1).padStart(4, "0")}`;
    case "private_url":
      return `https://example-${index}.invalid/`;
    case "private_address":
      return `서울시 가상구 가상동 ${index}번지`;
    case "private_date":
      return `2000-01-${String(((index - 1) % 28) + 1).padStart(2, "0")}`;
    case "account_number":
      return `ACC-${String(index).padStart(8, "0")}`;
    case "secret":
      return `SYNTH_SECRET_${index}`;
    case "rrn":
      return syntheticRrn(index);
    case "biz_num":
      return syntheticBizNum(index);
    case "card":
      return syntheticCard(index);
    default:
      return `SYNTH_${String(category).toUpperCase()}_${index}`;
  }
}

export { selectSyntheticName, getNamePoolSize } from "./name-pool.js";
export { syntheticRrn, syntheticBizNum, syntheticCard } from "./checksum.js";
export {
  KOREAN_PARTICLE_SUFFIXES,
  endsWithHangul,
  isHangulText,
} from "./particles.js";
