/**
 * `sanitize_batch` tool — mask PII in multiple texts within one vault.
 * ADR-0016 §3. Same vault → token dedup preserved across all inputs.
 */

import { z } from "zod";
import type { VaultPool } from "../vault-pool.js";
import type { Logger } from "../logging.js";
import { withToolErrorMapping } from "../errors.js";
import { aggregateCategories } from "./shared.js";
import { SanitizeOutputSchema, type SanitizeOutput } from "./sanitize.js";

export const SanitizeBatchInputSchema = z.object({
  texts: z
    .array(z.string())
    .min(1)
    .describe("Array of texts to sanitize. All share the same vault."),
  vault_id: z
    .string()
    .optional()
    .describe("Optional vault_id. If omitted, a single new vault is created and reused for every text."),
});

export const SanitizeBatchOutputSchema = z.object({
  results: z.array(SanitizeOutputSchema),
  vault_id: z.string(),
});

export type SanitizeBatchInput = z.infer<typeof SanitizeBatchInputSchema>;
export type SanitizeBatchOutput = z.infer<typeof SanitizeBatchOutputSchema>;

export const SANITIZE_BATCH_TOOL_DEFINITION = {
  name: "sanitize_batch",
  title: "Sanitize PII (Batch)",
  description:
    "Sanitize multiple texts using a single shared vault so that the same PII string across inputs maps to the same token. Returns one SanitizeOutput per input.",
  inputSchema: SanitizeBatchInputSchema,
  outputSchema: SanitizeBatchOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;

export interface SanitizeBatchDeps {
  vaultPool: VaultPool;
  logger?: Logger;
}

export function createSanitizeBatchHandler(deps: SanitizeBatchDeps) {
  const { vaultPool, logger } = deps;
  return async (input: SanitizeBatchInput) => {
    return withToolErrorMapping(async () => {
      const remover = await vaultPool.resolve(input.vault_id);
      const vaultId = remover.sessionId;
      const results: SanitizeOutput[] = [];
      for (const text of input.texts) {
        const result = await remover.mask(text, { provider: "mcp" });
        results.push({
          text: result.text,
          vault_id: vaultId,
          token_count: result.tokens.length,
          categories: aggregateCategories(result.tokens),
          latency_ms: result.latency_ms,
          backend_name: result.backend_name,
        });
      }
      const totalTokens = results.reduce((sum, r) => sum + r.token_count, 0);
      const out: SanitizeBatchOutput = { results, vault_id: vaultId };
      logger?.log("debug", {
        event: "sanitize_batch_ok",
        vault_id: vaultId,
        token_count: totalTokens,
        backend_name: results[0]?.backend_name ?? "unknown",
        pool_size: vaultPool.size(),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Masked ${totalTokens} ${totalTokens === 1 ? "entity" : "entities"} across ${results.length} texts. vault_id=${vaultId}`,
          },
        ],
        structuredContent: out,
      };
    });
  };
}
