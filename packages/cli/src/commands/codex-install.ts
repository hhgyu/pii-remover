/**
 * OpenAI Codex CLI `UserPromptSubmit` hook installer (ADR-0013, ADR-0014).
 *
 * Edits `~/.codex/config.toml` (or `<project>/.codex/config.toml`) to:
 *   1. Append a `[[hooks.UserPromptSubmit]]` block invoking `pii-remover hook`.
 *   2. (optional) Set `openai_base_url` to the local PII Remover proxy when
 *      `--proxy-url` is provided.
 *
 * TOML editing is intentionally surgical (no full TOML parser dependency,
 * ADR-0013 §Alternatives (d)). The function:
 *   - Preserves existing content verbatim.
 *   - Detects an already-registered identical `pii-remover hook` command and
 *     skips re-adding (idempotent).
 *   - Refuses to overwrite a pre-existing different `openai_base_url`
 *     (writes a comment-flagged "skipped" note in the result instead).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import {
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  DEFAULT_PROXY_PORT,
} from "../constants.js";
import {
  buildPiiRemoverJson,
  type InstallFs,
  type InstallScope,
  type InstallResult,
  type PiiRemoverConfigSlice,
} from "./install.js";

export const CODEX_HOOK_EVENT_NAME = "UserPromptSubmit";
export const CODEX_HOOK_TYPE = "command";

export interface CodexInstallOptions {
  target: "codex";
  scope?: InstallScope;
  commandPath: string;
  /**
   * Local proxy base URL to write into `openai_base_url`. Typical value:
   *   `http://localhost:8765/codex/v1`
   * If omitted, `openai_base_url` is left alone and the install only patches
   * the hook block (user must set the base URL manually).
   */
  proxyUrl?: string;
  homeDir?: string;
  projectDir?: string;
  dryRun?: boolean;
  fs?: InstallFs;
  piiConfig?: PiiRemoverConfigSlice;
}

const DEFAULT_FS: InstallFs = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFile(p, "utf8"),
  writeFile: async (p, data) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, "utf8");
  },
  mkdir: async (p) => {
    await mkdir(p, { recursive: true });
  },
};

export interface CodexPatchResult {
  patched: string;
  hookAlreadyPresent: boolean;
  baseUrlAlreadySet: boolean;
  baseUrlWritten: boolean;
}

/**
 * Pure TOML patcher. Exported for unit testing — `runCodexInstall` is the
 * filesystem-bound wrapper.
 */
export function patchCodexConfigToml(
  current: string,
  opts: {
    commandPath: string;
    timeoutSeconds: number;
    proxyUrl?: string;
  }
): CodexPatchResult {
  const normalizedCmd = quoteCommandPath(opts.commandPath);
  const hookAlreadyPresent = hasOurHook(current, normalizedCmd);

  let out = current;
  let baseUrlAlreadySet = false;
  let baseUrlWritten = false;

  if (opts.proxyUrl) {
    const existing = readScalarKey(out, "openai_base_url");
    if (existing === null) {
      out = appendScalarKey(out, "openai_base_url", opts.proxyUrl);
      baseUrlWritten = true;
    } else if (parseTomlBasicString(existing) === opts.proxyUrl) {
      // Desired value already present: end state is correct, so report it as applied.
      baseUrlWritten = true;
    } else {
      baseUrlAlreadySet = true;
    }
  }

  if (!hookAlreadyPresent) {
    out = appendHookBlock(out, normalizedCmd, opts.timeoutSeconds);
  }

  return {
    patched: out,
    hookAlreadyPresent,
    baseUrlAlreadySet,
    baseUrlWritten,
  };
}

function quoteCommandPath(p: string): string {
  // TOML basic string — escape backslashes (Windows paths) and double quotes.
  const escaped = p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Returns true if the file already contains a `[[hooks.UserPromptSubmit.hooks]]`
 * entry whose `command` matches ours. Conservative scan: looks for the literal
 * `command = <quoted>` line within a window after `[[hooks.UserPromptSubmit`.
 */
function hasOurHook(content: string, quotedCmd: string): boolean {
  const lines = content.split(/\r?\n/);
  let inHookSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*\[\[hooks\.UserPromptSubmit(?:\.hooks)?\]\]\s*$/.test(line)) {
      inHookSection = true;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      inHookSection = false;
      continue;
    }
    if (!inHookSection) continue;
    const m = /^\s*command\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const value = stripInlineComment(m[1] ?? "").trim();
    if (value === quotedCmd) return true;
  }
  return false;
}

function stripInlineComment(s: string): string {
  // Best-effort: detach `# ...` after a string literal. TOML comments are `#`.
  // We only strip if the `#` is outside a basic string.
  let inStr = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (c === "#" && !inStr) return s.slice(0, i);
  }
  return s;
}

function parseTomlBasicString(raw: string): string | null {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(raw.trim());
  if (m === null) return null;
  return (m[1] ?? "").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function readScalarKey(content: string, key: string): string | null {
  const re = new RegExp(
    `^\\s*${escapeRegex(key)}\\s*=\\s*(.+?)\\s*$`,
    "m"
  );
  // We only honour top-of-file (root table) — Codex reads `openai_base_url`
  // at the top of config.toml, not nested under a section.
  const lines = content.split(/\r?\n/);
  let inRoot = true;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inRoot = false;
      continue;
    }
    if (!inRoot) continue;
    const m = re.exec(line);
    if (m) return (m[1] ?? "").trim();
  }
  return null;
}

function appendScalarKey(content: string, key: string, value: string): string {
  const quoted = `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const line = `${key} = ${quoted}\n`;
  // Insert at top of file (before any [section]). If file is empty or starts
  // with a section header, prepend; otherwise append after the last existing
  // top-of-file key.
  if (content.length === 0) return line;
  const firstSectionIdx = content.search(/^\s*\[/m);
  if (firstSectionIdx === -1) {
    const sep = content.endsWith("\n") ? "" : "\n";
    return `${content}${sep}${line}`;
  }
  if (firstSectionIdx === 0) {
    return `${line}\n${content}`;
  }
  const head = content.slice(0, firstSectionIdx);
  const tail = content.slice(firstSectionIdx);
  const sep = head.endsWith("\n") ? "" : "\n";
  return `${head}${sep}${line}${tail}`;
}

function appendHookBlock(
  content: string,
  quotedCmd: string,
  timeoutSeconds: number
): string {
  const block = [
    "",
    "# Added by @pii-remover/cli (pii-remover install --target codex). See ADR-0013.",
    "[[hooks.UserPromptSubmit]]",
    "  [[hooks.UserPromptSubmit.hooks]]",
    `  type = "${CODEX_HOOK_TYPE}"`,
    `  command = ${quotedCmd}`,
    `  timeout = ${timeoutSeconds}`,
    "",
  ].join("\n");
  if (content.length === 0) return block.trimStart();
  const sep = content.endsWith("\n") ? "" : "\n";
  return `${content}${sep}${block}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Filesystem-bound install entry-point. Mirrors `runInstall` for Claude Code. */
export async function runCodexInstall(
  opts: CodexInstallOptions
): Promise<InstallResult & {
  base_url_already_set: boolean;
  base_url_written: boolean;
}> {
  const fs = opts.fs ?? DEFAULT_FS;
  const home = opts.homeDir ?? homedir();
  const project = opts.projectDir ?? process.cwd();
  const scope = opts.scope ?? "global";

  const settingsPath =
    scope === "global"
      ? join(home, ".codex", "config.toml")
      : join(project, ".codex", "config.toml");

  const existed = fs.exists(settingsPath);
  const current = existed ? await fs.readFile(settingsPath) : "";

  const patchOpts: {
    commandPath: string;
    timeoutSeconds: number;
    proxyUrl?: string;
  } = {
    commandPath: buildCommand(opts.commandPath),
    timeoutSeconds: DEFAULT_HOOK_TIMEOUT_SECONDS,
  };
  if (opts.proxyUrl !== undefined) patchOpts.proxyUrl = opts.proxyUrl;
  const result = patchCodexConfigToml(current, patchOpts);

  if (!opts.dryRun) {
    await fs.writeFile(settingsPath, result.patched);
  }

  let piiConfigPath: string | null = null;
  let piiConfigWritten = false;
  if (opts.piiConfig) {
    const configBase = scope === "global" ? home : project;
    piiConfigPath = join(configBase, ".codex", "pii-remover.json");
    if (!opts.dryRun) {
      await fs.writeFile(piiConfigPath, buildPiiRemoverJson(opts.piiConfig));
    }
    piiConfigWritten = true;
  }

  return {
    settings_path: settingsPath,
    created: !existed,
    hook_already_present: result.hookAlreadyPresent,
    patched_json: result.patched,
    config_path: piiConfigPath,
    config_written: piiConfigWritten,
    base_url_already_set: result.baseUrlAlreadySet,
    base_url_written: result.baseUrlWritten,
    next_steps: buildCodexNextSteps(
      opts.commandPath,
      opts.proxyUrl,
      result.baseUrlAlreadySet
    ),
  };
}

/**
 * Build the literal `command =` string. We invoke through `node` so the
 * compiled `dist/cli.js` runs uniformly across platforms (mirrors Claude
 * Code install — see `commands/install.ts#buildCommand`).
 */
function buildCommand(binPath: string): string {
  // Path goes verbatim into TOML, where it will be JSON-quoted at write time.
  // Wrap in literal quotes for the TOML command field, matching the Claude
  // Code installer's style: `node "/abs/path" hook`.
  const inner = `node "${binPath.replace(/\\/g, "\\\\")}" hook`;
  return inner;
}

function buildCodexNextSteps(
  commandPath: string,
  proxyUrl: string | undefined,
  baseUrlAlreadySet: boolean
): readonly string[] {
  const quoted = commandPath.includes(" ") ? `"${commandPath}"` : commandPath;
  const runCmd = `node ${quoted}`;
  const lines: string[] = [
    `1) Hook installed for Codex. Test it:`,
    `   echo '{"hook_event_name":"UserPromptSubmit","prompt":"test email user@example.com","session_id":"s","transcript_path":"","cwd":"","permission_mode":"default"}' | ${runCmd} hook`,
    "",
    `2) Start the local proxy (required for actual masking):`,
    `   pii-remover-proxy start`,
    `   # listens on http://127.0.0.1:${DEFAULT_PROXY_PORT}`,
    "",
  ];
  if (proxyUrl && !baseUrlAlreadySet) {
    lines.push(
      `3) openai_base_url is now set to ${proxyUrl} in ~/.codex/config.toml.`,
      `   Codex will route Responses API calls through the proxy automatically.`
    );
  } else if (proxyUrl && baseUrlAlreadySet) {
    lines.push(
      `3) openai_base_url was already present in config.toml — left untouched.`,
      `   To route through the proxy, set it manually:`,
      `     openai_base_url = "${proxyUrl}"`,
      `   (proxy default URL: http://localhost:${DEFAULT_PROXY_PORT}/codex/v1)`
    );
  } else {
    lines.push(
      `3) Set openai_base_url in ~/.codex/config.toml to route through the proxy:`,
      `     openai_base_url = "http://localhost:${DEFAULT_PROXY_PORT}/codex/v1"`,
      `   Or re-run install with --proxy-url to do it automatically.`
    );
  }
  lines.push(
    "",
    `4) Codex hook prompt-replacement is not supported (see ADR-0013).`,
    `   Set PII_REMOVER_PROXY_TRUST=1 if the proxy is configured but base URL`,
    `   detection cannot prove it (Codex has no base-URL env var override).`
  );
  return lines;
}
