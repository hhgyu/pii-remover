/**
 * `desanitize` tool — restore PII tokens in a single text. ADR-0016 §3.
 *
 * `vault_id` is REQUIRED — fail-closed (`isError: true`, `error_code:
 * "vault_not_found"`) when the vault is missing or expired.
 */

import { z } from "zod";
import type { VaultPool } from "../vault-pool.js";
import type { Logger } from "../logging.js";
import { withToolErrorMapping } from "../errors.js";

export const DesanitizeInputSchema = z.object({
  text: z.string().describe("Text containing __OPF_*__ tokens to restore to original PII."),
  vault_id: z.string().min(1).describe("vault_id returned by a prior sanitize call."),
});

export const DesanitizeOutputSchema = z.object({
  text: z.string(),
  restored_count: z.number().int().nonnegative(),
  unknown_token_count: z.number().int().nonnegative(),
  partial_match_count: z.number().int().nonnegative(),
  vault_id: z.string(),
});

export type DesanitizeInput = z.infer<typeof DesanitizeInputSchema>;
export type DesanitizeOutput = z.infer<typeof DesanitizeOutputSchema>;

export const DESANITIZE_TOOL_DEFINITION = {
  name: "desanitize",
  title: "Desanitize PII tokens",
  description:
    "Restore __OPF_*__ tokens in text to their original PII values using the given vault_id. Tokens not found in the vault are left in place and counted in unknown_token_count.",
  inputSchema: DesanitizeInputSchema,
  outputSchema: DesanitizeOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

export interface DesanitizeDeps {
  vaultPool: VaultPool;
  logger?: Logger;
}

export function createDesanitizeHandler(deps: DesanitizeDeps) {
  const { vaultPool, logger } = deps;
  return async (input: DesanitizeInput) => {
    return withToolErrorMapping(async () => {
      const remover = await vaultPool.resolve(input.vault_id);
      // The text belongs to whatever MCP client called us, not to a model this
      // process drove, so an unminted token here is not our model's mistake.
      const result = remover.restore(input.text, {
        provider: "mcp",
        origin: "tool",
      });
      const out: DesanitizeOutput = {
        text: result.text,
        restored_count: result.restoredCount,
        unknown_token_count: result.unknownTokenCount,
        partial_match_count: result.partialMatchCount,
        vault_id: input.vault_id,
      };
      logger?.log("debug", {
        event: "desanitize_ok",
        vault_id: out.vault_id,
        restored_count: out.restored_count,
        unknown_token_count: out.unknown_token_count,
        partial_match_count: out.partial_match_count,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Restored ${out.restored_count} token${out.restored_count === 1 ? "" : "s"}${
              out.unknown_token_count > 0
                ? ` (${out.unknown_token_count} unknown left in place)`
                : ""
            }.`,
          },
        ],
        structuredContent: out,
      };
    });
  };
}
