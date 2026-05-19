/**
 * Shared types for @pii-remover/mcp-server.
 *
 * Tool input/output schemas live with the tools themselves (`./tools/*.ts`).
 * This module holds cross-cutting types: vault pool options, server options,
 * structured error payload shape.
 */

import type { PiiRemoverConfig } from "@pii-remover/core";

export type ErrorCode =
  | "vault_not_found"
  | "vault_expired"
  | "detection_failed"
  | "fail_closed"
  | "invalid_input"
  | "internal_error";

export interface StructuredErrorPayload {
  error_code: ErrorCode;
  message: string;
  vault_id?: string;
}

export interface VaultPoolOptions {
  /** Maximum number of concurrent vaults retained in memory. Default: 100. */
  maxSize?: number;
  /** Idle TTL after which a vault is evicted. Default: 1 hour. */
  ttlMs?: number;
  /** Background sweep interval. Default: ttlMs/4 (15 min for default TTL). */
  sweepIntervalMs?: number;
  /** Optional config override forwarded to every `PIIRemover.init`. */
  config?: PiiRemoverConfig;
  /** Optional config path forwarded to every `PIIRemover.init`. */
  configPath?: string;
  /** Optional env override forwarded to every `PIIRemover.init`. */
  env?: NodeJS.ProcessEnv;
  /** Optional warning sink (MCP logging or stderr-fallback). */
  warn?: (message: string) => void;
  /** Hook for cleanup notifications (testing / metrics). */
  onDispose?: (vaultId: string, reason: "lru" | "ttl" | "explicit" | "shutdown") => void;
  /** Clock injection for tests. Default: `Date.now`. */
  now?: () => number;
}

export type TransportKind = "stdio" | "http";

export interface ServerOptions {
  vaultPoolOptions?: VaultPoolOptions;
  /** Server name reported in MCP `initialize`. */
  name?: string;
  /** Server version reported in MCP `initialize`. */
  version?: string;
}

export interface CliOptions {
  transport: TransportKind;
  /** Streamable HTTP port. Default: 8766. */
  port?: number;
  /** Streamable HTTP host bind. Default: 127.0.0.1. */
  host?: string;
  /** Forward to PIIRemover config loader. */
  configPath?: string;
  vaultPoolOptions?: VaultPoolOptions;
}
