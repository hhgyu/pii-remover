import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  DEFAULT_PROXY_PORT,
  HOOK_EVENT_NAME,
  CLAUDE_HOOK_TYPE,
} from "../constants.js";
import type { PIICategory } from "@pii-remover/core";
import {
  ALL_CATEGORIES,
  CATEGORY_LABELS,
  DEFAULT_CONFIG,
  resolveTokenKey,
  defaultKeyPath,
} from "@pii-remover/core";
export { ALL_CATEGORIES, CATEGORY_LABELS };

export function ensureTokenKey(
  env: NodeJS.ProcessEnv = process.env,
): { key_path: string; source: string } {
  const resolution = resolveTokenKey({ env });
  return { key_path: defaultKeyPath(), source: resolution.source };
}

export type InstallTarget = "claude-code" | "opencode" | "codex";
export type InstallScope = "global" | "project";

export const OPENCODE_PLUGIN_PACKAGE = "@pii-remover/opencode-plugin";
export const OPENCODE_PLUGIN_MASK_SUBPATH = "@pii-remover/opencode-plugin/mask";
export const OPENCODE_PLUGIN_RESTORE_SUBPATH = "@pii-remover/opencode-plugin/restore";

export interface PiiRemoverConfigSlice {
  endpoint: string;
  categories: PIICategory[];
  auto_start?: boolean;
  compose_file?: "cpu" | "gpu" | string;
  start_timeout_ms?: number;
}

export interface InstallOptions {
  target: InstallTarget;
  scope?: InstallScope;
  commandPath: string;
  homeDir?: string;
  projectDir?: string;
  dryRun?: boolean;
  fs?: InstallFs;
  piiConfig?: PiiRemoverConfigSlice;
}

export interface InstallFs {
  exists: (p: string) => boolean;
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  mkdir: (p: string) => Promise<void>;
}

export interface InstallResult {
  settings_path: string;
  created: boolean;
  hook_already_present: boolean;
  patched_json: string;
  config_path: string | null;
  config_written: boolean;
  next_steps: readonly string[];
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

export async function loadExistingConfig(
  projectDir: string,
  homeDir: string,
  fs: InstallFs
): Promise<PiiRemoverConfigSlice | null> {
  const candidates = [
    join(projectDir, ".opencode", "pii-remover.json"),
    join(projectDir, ".codex", "pii-remover.json"),
    join(projectDir, ".pii-remover.json"),
    join(homeDir, ".config", "opencode", "pii-remover.json"),
    join(homeDir, ".codex", "pii-remover.json"),
    join(homeDir, ".config", "pii-remover", "config.json"),
  ];
  for (const p of candidates) {
    if (fs.exists(p)) {
      try {
        const raw = await fs.readFile(p);
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const backendRaw = (parsed.backend as Record<string, unknown> | undefined) ?? {};
        const endpoint =
          typeof backendRaw.endpoint === "string"
            ? (backendRaw.endpoint as string)
            : DEFAULT_CONFIG.backend.endpoint;
        const cats = Array.isArray(
          (parsed.detection as Record<string, unknown>)?.enabled_categories
        )
          ? ((parsed.detection as Record<string, unknown>).enabled_categories as string[]).filter(
              (c): c is PIICategory => ALL_CATEGORIES.includes(c as PIICategory)
            )
          : [...DEFAULT_CONFIG.detection.enabled_categories];
        const slice: PiiRemoverConfigSlice = { endpoint, categories: cats };
        if (typeof backendRaw.auto_start === "boolean") {
          slice.auto_start = backendRaw.auto_start;
        }
        if (
          backendRaw.compose_file === "cpu" ||
          backendRaw.compose_file === "gpu" ||
          (typeof backendRaw.compose_file === "string" && backendRaw.compose_file.length > 0)
        ) {
          slice.compose_file = backendRaw.compose_file as string;
        }
        if (
          typeof backendRaw.start_timeout_ms === "number" &&
          backendRaw.start_timeout_ms > 0
        ) {
          slice.start_timeout_ms = backendRaw.start_timeout_ms;
        }
        return slice;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function buildPiiRemoverJson(slice: PiiRemoverConfigSlice): string {
  const backend = {
    ...DEFAULT_CONFIG.backend,
    endpoint: slice.endpoint,
    ...(slice.auto_start !== undefined ? { auto_start: slice.auto_start } : {}),
    ...(slice.compose_file !== undefined ? { compose_file: slice.compose_file } : {}),
    ...(slice.start_timeout_ms !== undefined
      ? { start_timeout_ms: slice.start_timeout_ms }
      : {}),
  };
  const cfg = {
    $schema: DEFAULT_CONFIG.$schema,
    backend,
    detection: {
      ...DEFAULT_CONFIG.detection,
      enabled_categories: slice.categories,
    },
  };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

export interface OpenCodeInstallOptions {
  target: "opencode";
  scope?: InstallScope;
  pluginRef?: string;
  homeDir?: string;
  projectDir?: string;
  dryRun?: boolean;
  fs?: InstallFs;
  piiConfig?: PiiRemoverConfigSlice;
  resolvePluginFile?: (subpath: string) => string | null;
}

function defaultResolvePluginFile(subpath: string, projectDir?: string): string | null {
  const anchors = [
    import.meta.url,
    `file://${join(projectDir ?? process.cwd(), "package.json")}`,
    `file://${join(homedir(), "package.json")}`,
  ];
  for (const anchor of anchors) {
    try {
      return createRequire(anchor).resolve(subpath);
    } catch {
      continue;
    }
  }
  return null;
}

function fileUrlFor(absPath: string): string {
  return pathToFileURL(absPath).href;
}

function isPiiRemoverEntry(spec: string): boolean {
  return (
    spec === OPENCODE_PLUGIN_PACKAGE ||
    spec.startsWith(`${OPENCODE_PLUGIN_PACKAGE}@`) ||
    spec.startsWith(`${OPENCODE_PLUGIN_PACKAGE}/`) ||
    /\/(?:dist|src)\/(?:mask|restore)\.(?:js|ts)(?:$|\?)/.test(spec)
  );
}

export async function runOpenCodeInstall(opts: OpenCodeInstallOptions): Promise<InstallResult> {
  const fs = opts.fs ?? DEFAULT_FS;
  const home = opts.homeDir ?? homedir();
  const project = opts.projectDir ?? process.cwd();
  const resolver =
    opts.resolvePluginFile ?? ((subpath: string) => defaultResolvePluginFile(subpath, project));

  const scope = opts.scope ?? "global";
  const configPath =
    scope === "global"
      ? join(home, ".config", "opencode", "opencode.json")
      : join(project, ".opencode", "opencode.json");

  const existed = fs.exists(configPath);
  const raw = existed ? await fs.readFile(configPath) : "{}";

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Cannot parse ${configPath}: ${(err as Error).message}`);
  }

  const existingPlugins: string[] = Array.isArray(parsed.plugin)
    ? [...(parsed.plugin as string[])]
    : [];

  const otherPlugins = existingPlugins.filter((p) => !isPiiRemoverEntry(p));

  let maskEntry: string;
  let restoreEntry: string | null = null;
  let resolved = true;

  const maskPath = resolver(OPENCODE_PLUGIN_MASK_SUBPATH);
  const restorePath = resolver(OPENCODE_PLUGIN_RESTORE_SUBPATH);
  if (maskPath && restorePath) {
    maskEntry = fileUrlFor(maskPath);
    restoreEntry = fileUrlFor(restorePath);
  } else {
    resolved = false;
    maskEntry = opts.pluginRef ?? OPENCODE_PLUGIN_PACKAGE;
  }

  const alreadyPresent =
    existingPlugins.includes(maskEntry) &&
    (restoreEntry === null || existingPlugins.includes(restoreEntry));

  // ordering invariant: mask FIRST, other plugins MIDDLE, restore LAST
  const plugins: string[] = [maskEntry, ...otherPlugins];
  if (restoreEntry) plugins.push(restoreEntry);
  parsed.plugin = plugins;

  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  if (!opts.dryRun) {
    await fs.writeFile(configPath, serialized);
  }

  let piiConfigPath: string | null = null;
  let piiConfigWritten = false;
  if (opts.piiConfig) {
    piiConfigPath =
      scope === "global"
        ? join(home, ".config", "opencode", "pii-remover.json")
        : join(project, ".opencode", "pii-remover.json");
    if (!opts.dryRun) {
      await fs.writeFile(piiConfigPath, buildPiiRemoverJson(opts.piiConfig));
    }
    piiConfigWritten = true;
  }

  const nextSteps: string[] = [];
  if (!opts.dryRun) {
    const { key_path, source } = ensureTokenKey();
    if (source === "generated") {
      nextSteps.push(
        `Deterministic token key written to ${key_path} (ADR-0020).`,
        `Set PII_REMOVER_TOKEN_KEY to override, or copy this file to share tokens across machines.`,
        ``
      );
    }
  }
  const legacyHomePath = join(home, ".pii-remover.json");
  if (fs.exists(legacyHomePath)) {
    nextSteps.push(
      `WARNING: legacy config detected at ${legacyHomePath}.`,
      `This path is NOT in the loader candidate list and is silently ignored.`,
      `Migrate any custom values to ${piiConfigPath ?? "~/.config/opencode/pii-remover.json"}.`,
      ``
    );
  }
  if (resolved) {
    nextSteps.push(
      `1) Split-mode plugin registered in ${configPath}:`,
      `   - mask  (first): ${maskEntry}`,
      `   - restore (last): ${restoreEntry}`,
      `   Any other OpenCode plugins run between them, so PII is masked before they see input`,
      `   and restored after they finish.`,
      ``,
      `2) Restart OpenCode to load the plugins.`,
    );
  } else {
    nextSteps.push(
      `WARNING: could not resolve ${OPENCODE_PLUGIN_MASK_SUBPATH} from this CLI install.`,
      `Installed as single-entry fallback (${maskEntry}).`,
      `For correct ordering relative to other OpenCode plugins, install the package next to your project:`,
      `   bun add -d ${OPENCODE_PLUGIN_PACKAGE}`,
      `then re-run this installer.`,
      ``,
      `1) Plugin registered in ${configPath}: ${maskEntry}`,
      `2) Restart OpenCode to load the plugin.`,
    );
  }

  return {
    settings_path: configPath,
    created: !existed,
    hook_already_present: alreadyPresent,
    patched_json: serialized,
    config_path: piiConfigPath,
    config_written: piiConfigWritten,
    next_steps: nextSteps,
  };
}

export async function runInstall(opts: InstallOptions): Promise<InstallResult> {
  const fs = opts.fs ?? DEFAULT_FS;
  const home = opts.homeDir ?? homedir();
  const project = opts.projectDir ?? process.cwd();
  const scope = opts.scope ?? "global";

  const settingsPath =
    scope === "global"
      ? join(home, ".claude", "settings.json")
      : join(project, ".claude", "settings.json");

  const existed = fs.exists(settingsPath);
  const current = existed ? await fs.readFile(settingsPath) : "{}";
  const parsed = parseSettings(current, settingsPath);

  const desiredCommand = buildCommand(opts.commandPath);
  const { patched, alreadyPresent } = ensureHook(parsed, desiredCommand);

  const serialized = `${JSON.stringify(patched, null, 2)}\n`;
  if (!opts.dryRun) {
    await fs.writeFile(settingsPath, serialized);
  }

  let configPath: string | null = null;
  let configWritten = false;

  if (opts.piiConfig) {
    configPath =
      scope === "global"
        ? join(home, ".config", "pii-remover", "config.json")
        : join(project, ".pii-remover.json");
    const configJson = buildPiiRemoverJson(opts.piiConfig);
    if (!opts.dryRun) {
      await fs.writeFile(configPath, configJson);
    }
    configWritten = true;
  }

  let tokenKeyNote: string[] = [];
  if (!opts.dryRun) {
    const { key_path, source } = ensureTokenKey();
    if (source === "generated") {
      tokenKeyNote = [
        `Deterministic token key written to ${key_path} (ADR-0020).`,
        `Set PII_REMOVER_TOKEN_KEY to override, or copy this file to share tokens across machines.`,
        ``,
      ];
    }
  }

  const legacyHomePath = join(home, ".pii-remover.json");
  const nextSteps =
    fs.exists(legacyHomePath) && scope === "global"
      ? [
          `WARNING: legacy config detected at ${legacyHomePath}.`,
          `This path is NOT in the loader candidate list and is silently ignored.`,
          `Migrate any custom values to ${configPath ?? "~/.config/pii-remover/config.json"}.`,
          ``,
          ...tokenKeyNote,
          ...buildNextSteps(opts.commandPath),
        ]
      : [...tokenKeyNote, ...buildNextSteps(opts.commandPath)];

  return {
    settings_path: settingsPath,
    created: !existed,
    hook_already_present: alreadyPresent,
    patched_json: serialized,
    config_path: configPath,
    config_written: configWritten,
    next_steps: nextSteps,
  };
}

function parseSettings(raw: string, path: string): SettingsJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Cannot parse existing settings at ${path}: ${(err as Error).message}`
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    return {};
  }
  return parsed as SettingsJson;
}

function ensureHook(
  settings: SettingsJson,
  command: string
): { patched: SettingsJson; alreadyPresent: boolean } {
  const out: SettingsJson = { ...settings };
  const hooks: HooksMap = isHooksMap(out.hooks) ? { ...out.hooks } : {};
  const eventGroups: HookGroup[] = Array.isArray(hooks[HOOK_EVENT_NAME])
    ? [...(hooks[HOOK_EVENT_NAME] as HookGroup[])]
    : [];

  for (const group of eventGroups) {
    const entries = Array.isArray(group.hooks) ? group.hooks : [];
    for (const entry of entries) {
      if (
        entry.type === CLAUDE_HOOK_TYPE &&
        typeof entry.command === "string" &&
        normalizeCommand(entry.command) === normalizeCommand(command)
      ) {
        out.hooks = { ...hooks, [HOOK_EVENT_NAME]: eventGroups };
        return { patched: out, alreadyPresent: true };
      }
    }
  }

  const newGroup: HookGroup = {
    hooks: [
      {
        type: CLAUDE_HOOK_TYPE,
        command,
        timeout: DEFAULT_HOOK_TIMEOUT_SECONDS,
      },
    ],
  };
  eventGroups.push(newGroup);
  hooks[HOOK_EVENT_NAME] = eventGroups;
  out.hooks = hooks;
  return { patched: out, alreadyPresent: false };
}

function normalizeCommand(c: string): string {
  let s = c.trim().replace(/\s+/g, " ");
  // Strip optional leading "node " so "node path.js hook" matches "path.js hook"
  if (s.toLowerCase().startsWith("node ")) {
    s = s.slice(5).trimStart();
  }
  // Strip surrounding quotes from the path portion: node "/path" hook → /path hook
  s = s.replace(/^"([^"]+)"\s/, "$1 ");
  return s;
}

function buildCommand(binPath: string): string {
  const quoted = `"${binPath}"`;
  return `node ${quoted} hook`;
}

function isHooksMap(v: unknown): v is HooksMap {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function buildNextSteps(commandPath: string): readonly string[] {
  const quoted = commandPath.includes(" ") ? `"${commandPath}"` : commandPath;
  const runCmd = `node ${quoted}`;
  return [
    `1) Hook installed. Test it:`,
    `   echo '{"hook_event_name":"UserPromptSubmit","prompt":"test email user@example.com","session_id":"s","transcript_path":"","cwd":"","permission_mode":"default"}' | ${runCmd} hook`,
    "",
    `2) Start the local proxy (required for actual masking):`,
    `   pii-remover-proxy start`,
    `   # listens on http://127.0.0.1:${DEFAULT_PROXY_PORT}`,
    "",
    `3) Point Claude Code at the proxy:`,
    `   export ANTHROPIC_BASE_URL=http://localhost:${DEFAULT_PROXY_PORT}/anthropic/v1`,
    "",
    `4) Verify the hook can see the proxy:`,
    `   ${runCmd} health`,
  ];
}

type HookEntry = {
  type: string;
  command?: string;
  timeout?: number;
};

type HookGroup = {
  matcher?: string;
  hooks?: HookEntry[];
};

type HooksMap = Record<string, HookGroup[]>;

type SettingsJson = {
  hooks?: HooksMap;
  [k: string]: unknown;
};
