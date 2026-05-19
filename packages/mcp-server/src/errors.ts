/**
 * Error semantics for `@pii-remover/mcp-server`.
 *
 * Two categories per ADR-0016 §7:
 *   - Semantic errors (vault missing, detection failed) → tool result
 *     `isError: true` with `structuredContent.error_code` set. The LLM can
 *     retry / explain to the user.
 *   - Protocol errors (schema violation, transport / server faults) → JSON-RPC
 *     error codes. The SDK handles these automatically when our handler throws
 *     a `McpError` or a thrown `Error` that isn't `VaultNotFoundError` etc.
 */

import { FailClosedError } from "@pii-remover/core";
import type { ErrorCode, StructuredErrorPayload } from "./types.js";

export class VaultNotFoundError extends Error {
  override readonly name = "VaultNotFoundError";
  constructor(public readonly vaultId: string, message?: string) {
    super(message ?? `vault not found: ${vaultId}`);
  }
}

export class VaultExpiredError extends Error {
  override readonly name = "VaultExpiredError";
  constructor(public readonly vaultId: string, message?: string) {
    super(message ?? `vault expired: ${vaultId}`);
  }
}

export interface ToolErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: StructuredErrorPayload;
}

/**
 * Convert a thrown error from a tool handler into a structured tool result.
 * Returns `null` if the error is not one this module owns — callers should
 * rethrow so the SDK can map it to a JSON-RPC error code.
 */
export function toToolErrorResult(err: unknown): ToolErrorResult | null {
  if (err instanceof VaultNotFoundError) {
    return buildToolError("vault_not_found", err.message, err.vaultId);
  }
  if (err instanceof VaultExpiredError) {
    return buildToolError("vault_expired", err.message, err.vaultId);
  }
  if (err instanceof FailClosedError) {
    return buildToolError(
      "fail_closed",
      err.message,
    );
  }
  if (err instanceof Error && err.name === "DetectionError") {
    return buildToolError("detection_failed", err.message);
  }
  return null;
}

export function buildToolError(
  code: ErrorCode,
  message: string,
  vaultId?: string,
): ToolErrorResult {
  const structured: StructuredErrorPayload = { error_code: code, message };
  if (vaultId !== undefined) structured.vault_id = vaultId;
  return {
    isError: true,
    content: [{ type: "text", text: `[${code}] ${message}` }],
    structuredContent: structured,
  };
}

/**
 * Sentinel used in tool handlers: try the operation, return tool error on
 * known semantic errors, rethrow on unknown so the SDK responds with a
 * JSON-RPC internal error.
 */
export async function withToolErrorMapping<T extends object>(
  fn: () => Promise<T>,
): Promise<T | ToolErrorResult> {
  try {
    return await fn();
  } catch (err) {
    const mapped = toToolErrorResult(err);
    if (mapped) return mapped;
    throw err;
  }
}
