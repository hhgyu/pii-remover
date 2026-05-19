/**
 * `desanitize_batch` tool — restore PII tokens in multiple texts from one vault.
 * ADR-0016 §3.
 */

import { z } from "zod";
import type { VaultPool } from "../vault-pool.js";
import type { Logger } from "../logging.js";
import { withToolErrorMapping } from "../errors.js";
import { DesanitizeOutputSchema, type DesanitizeOutput } from "./desanitize.js";

export const DesanitizeBatchInputSchema = z.object({
  texts: z.array(z.string()).min(1).describe("Array of texts each potentially containing __OPF_*__ tokens."),
  vault_id: z.string().min(1).describe("vault_id returned by a prior sanitize call."),
});

export const DesanitizeBatchOutputSchema = z.object({
  results: z.array(DesanitizeOutputSchema),
  vault_id: z.string(),
});

export type DesanitizeBatchInput = z.infer<typeof DesanitizeBatchInputSchema>;
export type DesanitizeBatchOutput = z.infer<typeof DesanitizeBatchOutputSchema>;

export const DESANITIZE_BATCH_TOOL_DEFINITION = {
  name: "desanitize_batch",
  title: "Desanitize PII tokens (Batch)",
  description:
    "Restore __OPF_*__ tokens across multiple texts using a single vault_id. Returns one DesanitizeOutput per input.",
  inputSchema: DesanitizeBatchInputSchema,
  outputSchema: DesanitizeBatchOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

export interface DesanitizeBatchDeps {
  vaultPool: VaultPool;
  logger?: Logger;
}

export function createDesanitizeBatchHandler(deps: DesanitizeBatchDeps) {
  const { vaultPool, logger } = deps;
  return async (input: DesanitizeBatchInput) => {
    return withToolErrorMapping(async () => {
      const remover = await vaultPool.resolve(input.vault_id);
      const results: DesanitizeOutput[] = [];
      let totalRestored = 0;
      let totalUnknown = 0;
      for (const text of input.texts) {
        const result = remover.restore(text, { provider: "mcp" });
        results.push({
          text: result.text,
          restored_count: result.restoredCount,
          unknown_token_count: result.unknownTokenCount,
          partial_match_count: result.partialMatchCount,
          vault_id: input.vault_id,
        });
        totalRestored += result.restoredCount;
        totalUnknown += result.unknownTokenCount;
      }
      const out: DesanitizeBatchOutput = { results, vault_id: input.vault_id };
      logger?.log("debug", {
        event: "desanitize_batch_ok",
        vault_id: input.vault_id,
        restored_count: totalRestored,
        unknown_token_count: totalUnknown,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Restored ${totalRestored} token${totalRestored === 1 ? "" : "s"} across ${results.length} texts${
              totalUnknown > 0 ? ` (${totalUnknown} unknown left in place)` : ""
            }.`,
          },
        ],
        structuredContent: out,
      };
    });
  };
}
