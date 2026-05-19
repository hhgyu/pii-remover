import type { AssignedToken } from "@pii-remover/core";

export function aggregateCategories(
  tokens: readonly AssignedToken[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tokens) {
    out[t.category] = (out[t.category] ?? 0) + 1;
  }
  return out;
}
