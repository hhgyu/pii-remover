import { join } from "node:path";

import { PACKAGE_VERSION, DEFAULT_PROXY_PORT } from "./constants.js";
import { runHookCommand, readStdin, type HookCommandIo } from "./commands/hook.js";
import type { InstallTarget, InstallScope } from "./commands/install.js";
import {
  runInstallCommand,
  type InstallCommandIo,
} from "./commands/install-command.js";
import { runDetectCommand, type DetectCommandIo } from "./commands/detect.js";
import { runHealthCommand, type HealthCommandIo, type FetchLike } from "./commands/health.js";

export interface CliIo extends InstallCommandIo {
  stdin?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  fetchFn?: FetchLike;
  initPiiRemover?: HookCommandIo["initPiiRemover"];
  /**
   * Stubs for the two side-effecting steps of the hook path. Without them a
   * test run reads the caller's real `pii-remover.json` and, when it sets
   * `auto_start`, warms a real backend or spawns Docker.
   */
  loadConfigFn?: HookCommandIo["loadConfigFn"];
  autoStartFn?: HookCommandIo["autoStartFn"];
}

export interface ParsedFlags {
  target?: InstallTarget;
  scope?: InstallScope;
  text?: string;
  port?: number;
  url?: string;
  commandPath?: string;
  endpoint?: string;
  categories?: string[];
  proxyUrl?: string;
  proxy?: boolean;
  proxyOnly?: boolean;
  autoStart?: boolean;
  composeFile?: "cpu" | "gpu" | string;
  startTimeoutMs?: number;
  idleTimeoutSeconds?: number;
  dryRun: boolean;
  showHelp: boolean;
}

export function parseFlags(argv: readonly string[]): ParsedFlags {
  const out: ParsedFlags = { dryRun: false, showHelp: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target" || arg === "-t") {
      const v = argv[++i];
      if (v === "claude-code" || v === "opencode" || v === "codex") out.target = v;
    } else if (arg === "--proxy-url") {
      const v = argv[++i];
      if (typeof v === "string") out.proxyUrl = v;
    } else if (arg === "--proxy") {
      out.proxy = true;
    } else if (arg === "--proxy-only") {
      out.proxy = true;
      out.proxyOnly = true;
    } else if (arg === "--scope" || arg === "-s") {
      const v = argv[++i];
      if (v === "global" || v === "project") out.scope = v;
    } else if (arg === "--text") {
      const v = argv[++i];
      if (typeof v === "string") out.text = v;
    } else if (arg === "--port" || arg === "-p") {
      const v = argv[++i];
      if (typeof v === "string") out.port = Number.parseInt(v, 10);
    } else if (arg === "--url" || arg === "-u") {
      const v = argv[++i];
      if (typeof v === "string") out.url = v;
    } else if (arg === "--command-path") {
      const v = argv[++i];
      if (typeof v === "string") out.commandPath = v;
    } else if (arg === "--endpoint" || arg === "-e") {
      const v = argv[++i];
      if (typeof v === "string") out.endpoint = v;
    } else if (arg === "--categories" || arg === "-c") {
      const v = argv[++i];
      if (typeof v === "string") out.categories = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--auto-start") {
      out.autoStart = true;
    } else if (arg === "--no-auto-start") {
      out.autoStart = false;
    } else if (arg === "--compose-file") {
      const v = argv[++i];
      if (typeof v === "string") out.composeFile = v;
    } else if (arg === "--start-timeout-ms") {
      const v = argv[++i];
      if (typeof v === "string") {
        const n = Number.parseInt(v, 10);
        if (Number.isFinite(n) && n > 0) out.startTimeoutMs = n;
      }
    } else if (arg === "--idle-timeout") {
      const v = argv[++i];
      if (typeof v === "string") {
        const n = Number.parseInt(v, 10);
        if (Number.isFinite(n) && n >= 0) out.idleTimeoutSeconds = n;
      }
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      out.showHelp = true;
    }
  }
  return out;
}

export function helpText(): string {
  return [
    "pii-remover — Claude Code UserPromptSubmit hook + helper CLI",
    "",
    "Usage:",
    "  pii-remover <command> [flags]",
    "",
    "Commands:",
    "  hook                       Run as a UserPromptSubmit hook (reads stdin JSON, writes",
    "                             stdout JSON per ADR-0012). exit 0 always; decisions in JSON.",
    "  install [--target <t>]     Register the hook/plugin. Prompts for OPF endpoint + categories.",
    "          [--scope <s>]      Without --target, pick any subset of the three hosts from a",
    "                             checkbox; they install in order claude-code -> opencode -> codex,",
    "                             one shared config, and a failing host does not stop the rest.",
    "                             <t> = 'claude-code'  UserPromptSubmit hook in Claude Code settings.json",
    "                             <t> = 'opencode'     Plugin entry in OpenCode opencode.json",
    "                             <t> = 'codex'        UserPromptSubmit hook in Codex config.toml (ADR-0013)",
    "                             <s> = 'global'  (default) user-level config",
    "                             <s> = 'project'          project-level config",
    "  detect --text <s>          Mask a string and print the result + tokens (for debugging).",
    "  health                     GET /health on the local proxy and print the JSON body.",
    "  version                    Print the package version.",
    "  help                       Print this message.",
    "",
    "Common flags:",
    "  --command-path <path>      Absolute path to this binary (default: argv[0]).",
    "  --scope, -s <s>            install only: 'global' (default) or 'project'.",
    "  --endpoint, -e <url>       install only: OPF backend endpoint (skips prompt).",
    "  --categories, -c <list>    install only: comma-separated PII categories (skips prompt).",
    "  --proxy                    install only: proxy mode — write the local proxy base URL into the",
    "                             host config so no manual export is needed. Per target:",
    "                               claude-code  env.ANTHROPIC_BASE_URL in settings.json",
    "                               opencode     provider.anthropic + provider.openai options.baseURL",
    "                                            in opencode.json",
    "                               codex        openai_base_url in config.toml",
    "                             An existing different base URL is never overwritten (warns instead).",
    "  --proxy-url <url>          install only: same as --proxy but with an explicit URL",
    "                             (remote/self-hosted proxy). Overrides --proxy. Any route suffix is",
    "                             stripped and each host's own route re-derived from the root.",
    "  --proxy-only               install, opencode only: mask entirely at the proxy, skipping (and",
    "                             removing) the plugin entries. Normal plugin+proxy install is",
    "                             supported and needs no special handling; use this only for a",
    "                             minimal proxy-only setup. Exits 64 when opencode isn't selected.",
    "  --auto-start               install only: write backend.auto_start=true (opt-in Docker spawn).",
    "                             Default: backend must be started manually. See ADR-0019.",
    "  --no-auto-start            install only: write backend.auto_start=false (explicit opt-out).",
    "  --compose-file <s>         install only: backend.compose_file value. 'cpu' (default) | 'gpu'",
    "                             | <absolute path>. Effective only with --auto-start.",
    "  --start-timeout-ms <n>     install only: backend.start_timeout_ms (default 60000).",
    "                             Health-poll deadline after 'docker compose up -d'.",
    "  --idle-timeout <seconds>   install only: surface a 'set OPF_IDLE_TIMEOUT_SECONDS=<n>' hint",
    "                             in the next-steps output. 0 = disable idle unload. Default: 1800.",
    "  --dry-run                  install only: do not write the file, just print the patched JSON.",
    "  --port, -p <n>             health only: override the local proxy port.",
    "  --url, -u <u>              health only: override the full proxy base URL.",
    "  --help, -h                 Print this message.",
    "",
    "Environment variables read:",
    "  ANTHROPIC_BASE_URL         Inspected to decide if the proxy is configured (ADR-0012).",
    "  PII_REMOVER_PROXY_TRUST=1  Opt-in: trust that a proxy is running regardless of base URL.",
    "  PII_REMOVER_BYPASS=1       Disable masking entirely (NOT recommended, see ADR-0006).",
    "",
    `Default proxy port: ${DEFAULT_PROXY_PORT}.`,
  ].join("\n");
}

export async function runCli(
  argv: readonly string[],
  io: CliIo
): Promise<number> {
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));

  if (flags.showHelp || cmd === "help" || cmd === "--help" || cmd === "-h") {
    io.stdout(`${helpText()}\n`);
    return 0;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    io.stdout(`${PACKAGE_VERSION}\n`);
    return 0;
  }
  if (cmd === undefined) {
    io.stdout(`${helpText()}\n`);
    return 0;
  }

  if (cmd === "hook") {
    const stdinFn = io.stdin ?? readStdin;
    const hookIo: HookCommandIo = {
      stdin: stdinFn,
      stdout: io.stdout,
      stderr: io.stderr,
      ...(io.env !== undefined ? { env: io.env } : {}),
      ...(io.initPiiRemover !== undefined
        ? { initPiiRemover: io.initPiiRemover }
        : {}),
      ...(io.loadConfigFn !== undefined ? { loadConfigFn: io.loadConfigFn } : {}),
      ...(io.autoStartFn !== undefined ? { autoStartFn: io.autoStartFn } : {}),
    };
    const r = await runHookCommand(hookIo);
    return r.exitCode;
  }

  if (cmd === "install") {
    return runInstallCommand(flags, io);
  }

  if (cmd === "detect") {
    const text = flags.text;
    if (typeof text !== "string") {
      io.stderr("detect: --text <string> is required\n");
      return 64;
    }
    const detectIo: DetectCommandIo = {
      text,
      stdout: io.stdout,
      stderr: io.stderr,
      ...(io.env !== undefined ? { env: io.env } : {}),
      ...(io.initPiiRemover !== undefined
        ? { initPiiRemover: io.initPiiRemover }
        : {}),
    };
    const r = await runDetectCommand(detectIo);
    return r.exitCode;
  }

  if (cmd === "health") {
    const healthIo: HealthCommandIo = {
      stdout: io.stdout,
      stderr: io.stderr,
      ...(io.env !== undefined ? { env: io.env } : {}),
      ...(io.fetchFn !== undefined ? { fetchFn: io.fetchFn } : {}),
      ...(flags.url !== undefined ? { url: flags.url } : {}),
      ...(flags.port !== undefined ? { port: flags.port } : {}),
    };
    const r = await runHealthCommand(healthIo);
    return r.exitCode;
  }

  io.stderr(`unknown command: ${cmd}\n`);
  io.stderr(`${helpText()}\n`);
  return 64;
}

export { join };
