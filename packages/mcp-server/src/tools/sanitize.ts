/**
 * `sanitize` tool — mask PII in a single text. ADR-0016 §3.
 *
 * Returns `vault_id` that the caller MUST pass to `desanitize` later.
 * Same PII in the same vault dedups to the same token across calls.
 */

import { z } from "zod";
import type { VaultPool } from "../vault-pool.js";
import type { Logger } from "../logging.js";
import { withToolErrorMapping } from "../errors.js";
import { aggregateCategories } from "./shared.js";

export const SanitizeInputSchema = z.object({
  text: z.string().describe(
    "Text containing potential PII. Detected PII is replaced with {{OPF:<CATEGORY>:<INDEX>__ tokens.",
  ),
  vault_id: z
    .string()
    .optional()
    .describe(
      "Existing vault_id to append to. Omit to create a new vault. Reusing a vault_id across calls preserves token dedup (same PII → same token).",
    ),
});

export const SanitizeOutputSchema = z.object({
  text: z.string(),
  vault_id: z.string(),
  token_count: z.number().int().nonnegative(),
  categories: z.record(z.string(), z.number().int().nonnegative()),
  latency_ms: z.number().nonnegative(),
  backend_name: z.string(),
});

export type SanitizeInput = z.infer<typeof SanitizeInputSchema>;
export type SanitizeOutput = z.infer<typeof SanitizeOutputSchema>;

export const SANITIZE_TOOL_DEFINITION = {
  name: "sanitize",
  title: "Sanitize PII",
  description:
    "Detect PII (English NER via OpenAI Privacy Filter + Korean regex with checksums: RRN, business number, credit card LUHN + Korean name heuristic) and replace each entity with a reversible token. Returns a vault_id to use for desanitize. Idempotent within a vault: the same PII string yields the same token.",
  inputSchema: SanitizeInputSchema,
  outputSchema: SanitizeOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;

export interface SanitizeDeps {
  vaultPool: VaultPool;
  logger?: Logger;
}

export function createSanitizeHandler(deps: SanitizeDeps) {
  const { vaultPool, logger } = deps;
  return async (input: SanitizeInput) => {
    return withToolErrorMapping(async () => {
      const remover = await vaultPool.resolve(input.vault_id);
      const result = await remover.mask(input.text, { provider: "mcp" });
      const categories = aggregateCategories(result.tokens);
      const out: SanitizeOutput = {
        text: result.text,
        vault_id: remover.sessionId,
        token_count: result.tokens.length,
        categories,
        latency_ms: result.latency_ms,
        backend_name: result.backend_name,
      };
      logger?.log("debug", {
        event: "sanitize_ok",
        vault_id: out.vault_id,
        token_count: out.token_count,
        categories,
        backend_name: out.backend_name,
        latency_ms: out.latency_ms,
        pool_size: vaultPool.size(),
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              out.token_count === 0
                ? "No PII detected."
                : `Masked ${out.token_count} ${out.token_count === 1 ? "entity" : "entities"}. vault_id=${out.vault_id}`,
          },
        ],
        structuredContent: out,
      };
    });
  };
}
