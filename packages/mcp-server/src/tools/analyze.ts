/**
 * `analyze` tool — detect PII without storing in a vault. ADR-0016 §3.
 *
 * Security note: response intentionally OMITS the original PII text (only
 * spans + categories). Returning original PII would defeat the tool's
 * purpose. Callers who need the masked text should use `sanitize` instead.
 */

import { z } from "zod";
import { PIIRemover, type PIIRemoverInitOptions } from "@pii-remover/core";
import type { Logger } from "../logging.js";
import { withToolErrorMapping } from "../errors.js";

export const AnalyzeInputSchema = z.object({
  text: z.string().describe("Text to analyze for PII presence. No vault is created."),
});

const DetectionSpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  category: z.string(),
  confidence: z.number(),
});

export const AnalyzeOutputSchema = z.object({
  detections: z.array(DetectionSpanSchema),
  backend_name: z.string(),
  latency_ms: z.number().nonnegative(),
});

export type AnalyzeInput = z.infer<typeof AnalyzeInputSchema>;
export type AnalyzeOutput = z.infer<typeof AnalyzeOutputSchema>;

export const ANALYZE_TOOL_DEFINITION = {
  name: "analyze",
  title: "Analyze PII (no vault)",
  description:
    "Detect PII spans without creating a vault. Returns category + offset only — original PII text is intentionally omitted from the response to avoid leaking the data the tool is meant to protect. Use sanitize/desanitize for reversible round-trips.",
  inputSchema: AnalyzeInputSchema,
  outputSchema: AnalyzeOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

export interface AnalyzeDeps {
  logger?: Logger;
  /** Forwarded to a throwaway `PIIRemover.init`. Defaults to env-loaded config. */
  initOptions?: Pick<PIIRemoverInitOptions, "config" | "configPath" | "env" | "warn">;
}

export function createAnalyzeHandler(deps: AnalyzeDeps) {
  const { logger, initOptions } = deps;
  return async (input: AnalyzeInput) => {
    return withToolErrorMapping(async () => {
      const remover = await PIIRemover.init(initOptions ?? {});
      try {
        const result = await remover.mask(input.text, { provider: "mcp" });
        const detections = result.tokens.map((t) => ({
          start: t.start,
          end: t.end,
          category: t.category,
          confidence: t.confidence,
        }));
        const out: AnalyzeOutput = {
          detections,
          backend_name: result.backend_name,
          latency_ms: result.latency_ms,
        };
        logger?.log("debug", {
          event: "analyze_ok",
          backend_name: out.backend_name,
          latency_ms: out.latency_ms,
          token_count: detections.length,
        });
        return {
          content: [
            {
              type: "text" as const,
              text:
                detections.length === 0
                  ? "No PII detected."
                  : `Detected ${detections.length} PII span${detections.length === 1 ? "" : "s"}.`,
            },
          ],
          structuredContent: out,
        };
      } finally {
        remover.dispose();
      }
    });
  };
}
