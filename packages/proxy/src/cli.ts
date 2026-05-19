import { loadConfig, type PiiRemoverConfig } from "@pii-remover/core";

import { DEFAULT_PROXY_PORT } from "./config.js";
import { startProxy, type FetchLike } from "./server.js";

const VERSION = "0.0.1";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ParsedFlags {
  port?: number;
  host?: string;
  configPath?: string;
  url?: string;
}

export function parseFlags(argv: readonly string[]): ParsedFlags {
  const out: ParsedFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      const v = argv[++i];
      if (typeof v === "string") out.port = Number.parseInt(v, 10);
    } else if (arg === "--host") {
      const v = argv[++i];
      if (typeof v === "string") out.host = v;
    } else if (arg === "--config" || arg === "-c") {
      const v = argv[++i];
      if (typeof v === "string") out.configPath = v;
    } else if (arg === "--url" || arg === "-u") {
      const v = argv[++i];
      if (typeof v === "string") out.url = v;
    }
  }
  return out;
}

export function helpText(): string {
  return [
    "pii-remover-proxy — local LLM proxy that masks PII before Anthropic/OpenAI calls",
    "",
    "Usage:",
    "  pii-remover-proxy <command> [flags]",
    "",
    "Commands:",
    `  start    Start the proxy (default port ${DEFAULT_PROXY_PORT}, foreground)`,
    "  health   GET /health on a running proxy and print the JSON body",
    "  version  Print the package version",
    "  help     Print this message",
    "",
    "Flags:",
    `  --port, -p <n>      Port to bind  (default ${DEFAULT_PROXY_PORT})`,
    "  --host <h>          Host to bind  (default 127.0.0.1)",
    "  --config, -c <f>    Path to a .pii-remover.json config",
    "  --url, -u <u>       Proxy URL for `health` command",
    "",
    "Environment variables to set in downstream clients:",
    "  export ANTHROPIC_BASE_URL=http://localhost:<port>/anthropic/v1",
    "  export OPENAI_API_BASE=http://localhost:<port>/openai/v1",
  ].join("\n");
}

export async function runCli(
  argv: readonly string[],
  io: {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    loadConfigFn?: (opts: {
      configPath?: string;
    }) => Promise<PiiRemoverConfig>;
    fetchFn?: FetchLike;
    startProxyFn?: typeof startProxy;
  }
): Promise<number> {
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  const loadFn = io.loadConfigFn ?? ((opts) => loadConfig(opts));
  const fetchFn = io.fetchFn ?? fetch;
  const startFn = io.startProxyFn ?? startProxy;

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  if (cmd === "help" || cmd === "--help" || cmd === "-h" || cmd === undefined) {
    io.stdout(`${helpText()}\n`);
    return 0;
  }

  if (cmd === "health") {
    const url = flags.url ?? `http://127.0.0.1:${flags.port ?? DEFAULT_PROXY_PORT}`;
    try {
      const res = await fetchFn(`${url.replace(/\/$/, "")}/health`);
      const body = await res.text();
      io.stdout(`${body}\n`);
      return res.ok ? 0 : 1;
    } catch (err) {
      io.stderr(`health check failed: ${(err as Error).message}\n`);
      return 2;
    }
  }

  if (cmd === "start") {
    const loadOpts: { configPath?: string } = {};
    if (flags.configPath) loadOpts.configPath = flags.configPath;
    const config = await loadFn(loadOpts);
    const startOpts: Parameters<typeof startProxy>[0] = { config };
    if (flags.port !== undefined) startOpts.port = flags.port;
    if (flags.host !== undefined) startOpts.host = flags.host;
    const proxy = await startFn(startOpts);
    io.stdout(`pii-remover-proxy listening on ${proxy.url}\n`);
    return 0;
  }

  io.stderr(`unknown command: ${cmd}\n`);
  io.stderr(`${helpText()}\n`);
  return 64;
}
