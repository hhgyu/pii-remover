/**
 * Runtime verification of the split-mode ordering invariant.
 *
 * `trackMode` in hooks.ts only observes the order in which our own two entries
 * were imported, so it is blind to the invariant that actually protects PII:
 * mask must be FIRST in the plugin array and restore must be LAST. A plugin
 * registered ahead of mask sees raw PII in `tool.execute.before`; one
 * registered behind restore sees plaintext again in `tool.execute.after`. The
 * installer enforces the order once, at install time, and nothing re-checks it
 * after a hand edit or another tool appending to the array.
 *
 * The plugin API exposes no view of the array, so the check reads
 * `opencode.json` from disk. Advisory only — it warns, never blocks.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type PluginRole = "mask" | "restore" | "full" | "foreign";

export type PluginOrderIssueKind =
  | "plugins_before_mask"
  | "plugins_after_restore"
  | "restore_before_mask"
  | "double_registration";

export interface PluginOrderIssue {
  readonly kind: PluginOrderIssueKind;
  readonly message: string;
}

const PACKAGE_NAME = "@pii-remover/opencode-plugin";
const SPLIT_ENTRY = /(?:dist|src)\/(mask|restore)\.(?:js|ts)(?:$|[?#])/;
const FULL_FILE_ENTRY =
  /@pii-remover\/opencode-plugin\/(?:dist|src)\/index\.(?:js|ts)(?:$|[?#])/;

export function classifyPluginEntry(spec: string): PluginRole {
  const split = SPLIT_ENTRY.exec(spec);
  if (split !== null && spec.includes("pii-remover")) {
    return split[1] === "mask" ? "mask" : "restore";
  }
  if (spec === `${PACKAGE_NAME}/mask`) return "mask";
  if (spec === `${PACKAGE_NAME}/restore`) return "restore";
  if (
    spec === PACKAGE_NAME ||
    spec.startsWith(`${PACKAGE_NAME}@`) ||
    FULL_FILE_ENTRY.test(spec)
  ) {
    return "full";
  }
  return "foreign";
}

/**
 * Returns one issue per broken invariant. An array holding neither of our split
 * entries yields nothing: the plugin was registered some other way (a
 * `plugins/` glue file, a test harness) and this array says nothing about it.
 */
export function inspectPluginOrder(
  plugins: readonly string[]
): readonly PluginOrderIssue[] {
  const roles = plugins.map(classifyPluginEntry);
  const maskIndex = roles.indexOf("mask");
  const restoreIndex = roles.lastIndexOf("restore");
  if (maskIndex === -1 && restoreIndex === -1) return [];

  const issues: PluginOrderIssue[] = [];
  const fullEntries = plugins.filter((_, i) => roles[i] === "full");

  if (fullEntries.length > 0) {
    issues.push({
      kind: "double_registration",
      message:
        `pii-remover is registered twice: ${fullEntries.join(", ")} runs in ` +
        `"full" mode alongside the split mask/restore entries. Hooks fire ` +
        `twice and the ordering guarantee no longer holds. Keep only the ` +
        `split entries.`,
    });
  }

  if (maskIndex !== -1 && restoreIndex !== -1 && restoreIndex < maskIndex) {
    issues.push({
      kind: "restore_before_mask",
      message:
        `pii-remover restore is registered before mask. Masking will not run ` +
        `before the other plugins. Move the mask entry first.`,
    });
  }

  if (maskIndex > 0) {
    const before = plugins.slice(0, maskIndex);
    issues.push({
      kind: "plugins_before_mask",
      message:
        `${before.length} plugin(s) run before pii-remover mask and therefore ` +
        `see UNMASKED PII in tool.execute.before: ${before.join(", ")}. Move ` +
        `the mask entry to the front of the plugin array.`,
    });
  }

  if (restoreIndex !== -1 && restoreIndex !== plugins.length - 1) {
    const after = plugins.slice(restoreIndex + 1);
    issues.push({
      kind: "plugins_after_restore",
      message:
        `${after.length} plugin(s) run after pii-remover restore and therefore ` +
        `see RESTORED plaintext PII in tool.execute.after: ${after.join(", ")}. ` +
        `Move the restore entry to the end of the plugin array.`,
    });
  }

  return issues;
}

export function pluginArrayFrom(raw: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const plugin = (parsed as { plugin?: unknown }).plugin;
  if (!Array.isArray(plugin)) return null;
  return plugin.filter((p): p is string => typeof p === "string");
}

export function openCodeConfigPaths(args: {
  directory?: string | undefined;
  homeDir?: string | undefined;
}): readonly string[] {
  const home = args.homeDir ?? homedir();
  const paths = [join(home, ".config", "opencode", "opencode.json")];
  if (args.directory !== undefined && args.directory.length > 0) {
    paths.push(
      join(args.directory, ".opencode", "opencode.json"),
      join(args.directory, "opencode.json")
    );
  }
  return paths;
}

export async function warnOnPluginOrder(args: {
  directory?: string | undefined;
  homeDir?: string | undefined;
  warn: (message: string) => void;
  readFileImpl?: (path: string) => Promise<string>;
}): Promise<readonly PluginOrderIssue[]> {
  const read = args.readFileImpl ?? ((p: string) => readFile(p, "utf8"));
  const seen = new Set<string>();
  const reported: PluginOrderIssue[] = [];

  for (const path of openCodeConfigPaths(args)) {
    let plugins: readonly string[] | null;
    try {
      plugins = pluginArrayFrom(await read(path));
    } catch {
      continue;
    }
    if (plugins === null) continue;
    for (const issue of inspectPluginOrder(plugins)) {
      const key = `${issue.kind}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reported.push(issue);
      args.warn(`[pii-remover] WARNING: ${issue.message} (${path})`);
    }
  }
  return reported;
}
