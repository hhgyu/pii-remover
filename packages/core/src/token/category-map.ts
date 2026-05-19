import type { PIICategory } from "../types.js";

export const CATEGORY_MAP: Readonly<Record<PIICategory, string>> = Object.freeze({
  private_person: "PERSON",
  private_email: "EMAIL",
  private_phone: "PHONE",
  private_address: "ADDRESS",
  account_number: "ACCOUNT",
  private_date: "DATE",
  private_url: "URL",
  secret: "SECRET",
  rrn: "RRN",
  biz_num: "BIZNUM",
  card: "CARD",
});

export const REVERSE_CATEGORY_MAP: Readonly<Record<string, PIICategory>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(CATEGORY_MAP).map(([k, v]) => [v, k as PIICategory])
    ) as Record<string, PIICategory>
  );

export function categoryToTokenLabel(category: PIICategory): string {
  return CATEGORY_MAP[category];
}

export function tokenLabelToCategory(label: string): PIICategory | null {
  return REVERSE_CATEGORY_MAP[label] ?? null;
}
