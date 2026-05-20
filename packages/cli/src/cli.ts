import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import checkbox from "@inquirer/checkbox";

import { PACKAGE_VERSION, DEFAULT_PROXY_PORT } from "./constants.js";
import { runHookCommand, readStdin, type HookCommandIo } from "./commands/hook.js";
import {
  runInstall,
  runOpenCodeInstall,
  loadExistingConfig,
  ALL_CATEGORIES,
  CATEGORY_LABELS,
  OPENCODE_PLUGIN_PACKAGE,
  type InstallTarget,
  type InstallScope,
  type InstallFs,
  type PiiRemoverConfigSlice,
} from "./commands/install.js";
import { runCodexInstall } from "./commands/codex-install.js";
import { runDetectCommand, type DetectCommandIo } from "./commands/detect.js";
import { runHealthCommand, type HealthCommandIo, type FetchLike } from "./commands/health.js";
import { DEFAULT_CONFIG, type PIICategory } from "@pii-remover/core";

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stdin?: () => Promise<string>;
  prompt?: (question: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  fetchFn?: FetchLike;
  installFs?: InstallFs;
  initPiiRemover?: HookCommandIo["initPiiRemover"];
  argv0?: string;
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
    "  install --target <t>       Register the hook/plugin. Prompts for OPF endpoint + categories.",
    "          [--scope <s>]      <t> = 'claude-code'  UserPromptSubmit hook in Claude Code settings.json",
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
    "  --proxy-url <url>          install only (--target codex): set openai_base_url to this proxy URL.",
    "                             Typical: http://localhost:8765/codex/v1",
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
    };
    const r = await runHookCommand(hookIo);
    return r.exitCode;
  }

  if (cmd === "install") {
    const target = flags.target;
    if (!target) {
      io.stderr(
        "install: --target is required (claude-code | claude-code-project | opencode | opencode-project)\n"
      );
      return 64;
    }

    const home = homedir();
    const project = process.cwd();
    const installFs = io.installFs;

    let piiConfig: PiiRemoverConfigSlice;

    const hasNonInteractive =
      flags.endpoint ||
      flags.categories ||
      flags.autoStart !== undefined ||
      flags.composeFile !== undefined ||
      flags.startTimeoutMs !== undefined;

    if (hasNonInteractive) {
      piiConfig = {
        endpoint: flags.endpoint ?? DEFAULT_CONFIG.backend.endpoint,
        categories: (flags.categories?.filter((c): c is PIICategory =>
          ALL_CATEGORIES.includes(c as PIICategory)
        )) ?? [...DEFAULT_CONFIG.detection.enabled_categories],
      };
    } else {
      const promptFn = io.prompt ?? makeReadlinePrompt();
      const fsForLoad = installFs ?? {
        exists: (p: string) => { const { existsSync } = require("node:fs"); return existsSync(p); },
        readFile: async (p: string) => { const { readFile } = require("node:fs/promises"); return readFile(p, "utf8"); },
        writeFile: async () => {},
        mkdir: async () => {},
      };
      const existing = await loadExistingConfig(project, home, fsForLoad);

      if (existing) {
        io.stdout(`\nFound existing config — endpoint: ${existing.endpoint}, ${existing.categories.length} categories enabled.\n`);
        const use = await promptFn("Use existing config? [Y/n] ");
        piiConfig = use.trim().toLowerCase() === "n"
          ? await promptForConfig(promptFn, io.stdout)
          : existing;
      } else {
        io.stdout("\nNo pii-remover.json found. Let's configure it.\n");
        piiConfig = await promptForConfig(promptFn, io.stdout);
      }
    }

    if (flags.autoStart !== undefined) piiConfig.auto_start = flags.autoStart;
    if (flags.composeFile !== undefined) piiConfig.compose_file = flags.composeFile;
    if (flags.startTimeoutMs !== undefined) piiConfig.start_timeout_ms = flags.startTimeoutMs;

    try {
      let r;
      if (target === "opencode") {
        const opts: Parameters<typeof runOpenCodeInstall>[0] = {
          target,
          scope: flags.scope ?? "global",
          pluginRef: flags.commandPath ?? OPENCODE_PLUGIN_PACKAGE,
          dryRun: flags.dryRun,
          piiConfig,
        };
        if (installFs) opts.fs = installFs;
        r = await runOpenCodeInstall(opts);
      } else if (target === "codex") {
        const commandPath =
          flags.commandPath ?? resolve(io.argv0 ?? process.argv[1] ?? "pii-remover");
        const opts: Parameters<typeof runCodexInstall>[0] = {
          target,
          scope: flags.scope ?? "global",
          commandPath,
          dryRun: flags.dryRun,
          piiConfig,
        };
        if (flags.proxyUrl !== undefined) opts.proxyUrl = flags.proxyUrl;
        if (installFs) opts.fs = installFs;
        r = await runCodexInstall(opts);
      } else {
        const commandPath =
          flags.commandPath ?? resolve(io.argv0 ?? process.argv[1] ?? "pii-remover");
        const opts: Parameters<typeof runInstall>[0] = {
          target,
          scope: flags.scope ?? "global",
          commandPath,
          dryRun: flags.dryRun,
          piiConfig,
        };
        if (installFs) opts.fs = installFs;
        r = await runInstall(opts);
      }

      const lines = [
        `${flags.dryRun ? "[dry-run] " : ""}${r.settings_path}`,
        `${flags.dryRun ? "would " : ""}${r.created ? "create" : "patch"}; plugin/hook ${
          r.hook_already_present ? "already present" : "registered"
        }.`,
      ];
      if (r.config_written && r.config_path) {
        lines.push(`Config written: ${r.config_path}`);
      }
      if (piiConfig.auto_start === true) {
        lines.push(
          `Backend auto-start: ENABLED (compose_file=${piiConfig.compose_file ?? "cpu"})`
        );
      } else if (piiConfig.auto_start === false) {
        lines.push("Backend auto-start: DISABLED (explicit opt-out)");
      }
      lines.push("", "Next steps:", ...r.next_steps);
      if (flags.idleTimeoutSeconds !== undefined) {
        lines.push(
          "",
          `Idle-unload timeout requested: ${flags.idleTimeoutSeconds}s`,
          `  (config files do NOT carry OPF_IDLE_TIMEOUT_SECONDS — it is a backend-side env var)`,
          `  Set on the backend container, e.g.:`,
          `    OPF_IDLE_TIMEOUT_SECONDS=${flags.idleTimeoutSeconds} docker compose up -d`,
          `  Or persist via packages/backend/docker-compose.yml or a .env file.`,
          flags.idleTimeoutSeconds === 0
            ? `  (0 = disabled; model stays loaded until container stops)`
            : `  Next /redact after ${flags.idleTimeoutSeconds}s idle lazy-reloads the model.`,
        );
      }
      lines.push("");
      io.stdout(lines.join("\n"));
      return 0;
    } catch (err) {
      io.stderr(`install failed: ${(err as Error).message}\n`);
      return 2;
    }
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

function makeReadlinePrompt(): (q: string) => Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return (q: string) =>
    new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a); }));
}

async function promptForConfig(
  prompt: (q: string) => Promise<string>,
  stdout: (s: string) => void
): Promise<PiiRemoverConfigSlice> {
  const defaultEndpoint = DEFAULT_CONFIG.backend.endpoint;
  const endpointInput = await prompt(`OPF backend endpoint [${defaultEndpoint}]: `);
  const endpoint = endpointInput.trim() || defaultEndpoint;

  const categories = await checkbox({
    message: "Select PII categories to detect:",
    choices: ALL_CATEGORIES.map((c) => ({
      name: `${CATEGORY_LABELS[c]} (${c})`,
      value: c,
      checked: true,
    })),
  });

  stdout(`\nConfig: endpoint=${endpoint}, ${categories.length}/${ALL_CATEGORIES.length} categories enabled.\n`);
  return { endpoint, categories: categories as PIICategory[] };
}
