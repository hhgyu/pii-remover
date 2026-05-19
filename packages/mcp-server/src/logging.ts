/**
 * MCP logging adapter.
 *
 * ADR-0016 §6:
 *   - In stdio mode, stdout is the JSON-RPC channel → NEVER write logs to
 *     stdout. We use `server.sendLoggingMessage(...)` for runtime logs.
 *   - stderr is reserved for fatal boot errors only, never for runtime logs.
 *   - No PII plaintext is ever logged. Only category counts, vault IDs,
 *     backend names, latencies, error class names.
 *
 * The MCP capability `logging` is declared in `server.ts`. Clients can set
 * the active level via `logging/setLevel`. We respect that by deferring the
 * actual emit to `Server.sendLoggingMessage`, which the SDK gates per the
 * client-requested level.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export type LogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

export interface LogPayload {
  event: string;
  vault_id?: string;
  backend_name?: string;
  latency_ms?: number;
  categories?: Readonly<Record<string, number>>;
  token_count?: number;
  restored_count?: number;
  unknown_token_count?: number;
  partial_match_count?: number;
  error_class?: string;
  error_code?: string;
  pool_size?: number;
  reason?: string;
}

export interface Logger {
  log(level: LogLevel, payload: LogPayload): void;
  /** Warn helper that always emits. Routes through `notifications/message` */
  warn(message: string): void;
}

/**
 * Create a logger backed by `Server.sendLoggingMessage`.
 *
 * The provided server may not be connected yet at construction time — the
 * SDK queues messages until `connect()`. We tolerate either order.
 */
export function createMcpLogger(
  server: Pick<Server, "sendLoggingMessage">,
  source = "pii-remover",
): Logger {
  return {
    log(level, payload) {
      try {
        server.sendLoggingMessage({
          level,
          logger: source,
          data: payload as unknown as Record<string, unknown>,
        });
      } catch {
        // sendLoggingMessage throws if the client did not advertise the
        // logging capability. Swallow — we cannot route to stdout.
      }
    },
    warn(message) {
      try {
        server.sendLoggingMessage({
          level: "warning",
          logger: source,
          data: { event: "warn", message },
        });
      } catch {
        // Best effort; never escalate to stdout in stdio mode.
      }
    },
  };
}

/**
 * No-op logger used when running without an MCP server connection (e.g.
 * unit tests).
 */
export const NOOP_LOGGER: Logger = {
  log() {},
  warn() {},
};
