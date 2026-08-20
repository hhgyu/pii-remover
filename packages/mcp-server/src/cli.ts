/**
 * CLI entry — parses `--transport`, `--port`, `--host`, `--config`,
 * `--max-vaults`, `--ttl-ms`, then delegates to the appropriate transport.
 */

import { createPiiRemoverMcpServer } from "./server.js";
import { runStdio } from "./transport/stdio.js";
import { runStreamableHttp } from "./transport/streamable-http.js";
import type { CliOptions, TransportKind } from "./types.js";

export function parseArgs(argv: readonly string[]): CliOptions {
  const out: CliOptions = { transport: "stdio" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--transport") {
      const v = argv[i + 1];
      if (v !== "stdio" && v !== "http") {
        throw new Error(`--transport must be 'stdio' or 'http' (got: ${v ?? "<missing>"})`);
      }
      out.transport = v as TransportKind;
      i += 1;
    } else if (arg === "--port") {
      const v = Number(argv[i + 1]);
      if (!Number.isFinite(v) || v <= 0 || v > 65535) {
        throw new Error(`--port must be a number in 1..65535 (got: ${argv[i + 1] ?? "<missing>"})`);
      }
      out.port = v;
      i += 1;
    } else if (arg === "--host") {
      const v = argv[i + 1];
      if (!v) throw new Error("--host requires a value");
      out.host = v;
      i += 1;
    } else if (arg === "--config") {
      const v = argv[i + 1];
      if (!v) throw new Error("--config requires a value");
      out.configPath = v;
      i += 1;
    } else if (arg === "--max-vaults") {
      const v = Number(argv[i + 1]);
      if (!Number.isInteger(v) || v <= 0) {
        throw new Error(`--max-vaults must be a positive integer (got: ${argv[i + 1] ?? "<missing>"})`);
      }
      out.vaultPoolOptions = { ...(out.vaultPoolOptions ?? {}), maxSize: v };
      i += 1;
    } else if (arg === "--ttl-ms") {
      const v = Number(argv[i + 1]);
      if (!Number.isInteger(v) || v <= 0) {
        throw new Error(`--ttl-ms must be a positive integer (got: ${argv[i + 1] ?? "<missing>"})`);
      }
      out.vaultPoolOptions = { ...(out.vaultPoolOptions ?? {}), ttlMs: v };
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stderr.write(usage());
      process.exit(0);
    } else if (arg === "--version" || arg === "-v") {
      process.stderr.write(`pii-remover-mcp 0.0.3\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

export function usage(): string {
  return [
    "pii-remover-mcp — MCP server for @pii-remover/core",
    "",
    "USAGE:",
    "  pii-remover-mcp [--transport stdio|http] [--port N] [--host HOST]",
    "                  [--config PATH] [--max-vaults N] [--ttl-ms N]",
    "",
    "OPTIONS:",
    "  --transport stdio|http   Transport binding. Default: stdio.",
    "  --port N                 Streamable HTTP port. Default: 8766. (http only)",
    "  --host HOST              Bind host. Default: 127.0.0.1. (http only)",
    "  --config PATH            Path to pii-remover.json config.",
    "  --max-vaults N           Max vaults in pool. Default: 100.",
    "  --ttl-ms N               Vault idle TTL in ms. Default: 3600000 (1h).",
    "  -h, --help               Show this help.",
    "  -v, --version            Show version.",
    "",
  ].join("\n");
}

export async function main(argv: readonly string[]): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${usage()}`);
    process.exit(2);
  }
  const serverOptions: Parameters<typeof createPiiRemoverMcpServer>[0] = {};
  const poolOptions = { ...(opts.vaultPoolOptions ?? {}) };
  if (opts.configPath !== undefined) poolOptions.configPath = opts.configPath;
  if (Object.keys(poolOptions).length > 0) serverOptions.vaultPoolOptions = poolOptions;
  const server = createPiiRemoverMcpServer(serverOptions);
  if (opts.transport === "stdio") {
    await runStdio(server);
  } else {
    const httpOpts: { port?: number; host?: string } = {};
    if (opts.port !== undefined) httpOpts.port = opts.port;
    if (opts.host !== undefined) httpOpts.host = opts.host;
    const handle = await runStreamableHttp(server, httpOpts);
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        void handle.close().finally(() => resolve());
      };
      process.once("SIGINT", cleanup);
      process.once("SIGTERM", cleanup);
    });
  }
}
