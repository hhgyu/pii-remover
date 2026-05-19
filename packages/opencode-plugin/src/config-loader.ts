import {
  DEFAULT_CONFIG,
  loadConfig as coreLoadConfig,
  type PiiRemoverConfig,
} from "@pii-remover/core";

export interface PluginConfigLoadOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

/**
 * Resolve the effective `PiiRemoverConfig` for the OpenCode plugin.
 *
 * Delegates to `@pii-remover/core`'s `loadConfig`, which honours (in order):
 *   1. `opts.configPath` if provided,
 *   2. `<cwd>/.opencode/pii-remover.json`         — project, OpenCode-scoped,
 *   3. `<cwd>/.pii-remover.json`                  — project root (legacy),
 *   4. `~/.config/opencode/pii-remover.json`      — user, OpenCode-scoped,
 *   5. `~/.config/pii-remover/config.json`        — user global (legacy),
 * falling back to `DEFAULT_CONFIG` when no file is found. Environment
 * variable substitution (`${VAR}` / `${VAR:-default}`) is performed inside
 * core's loader.
 *
 * The two OpenCode-scoped paths exist so PII Remover settings live next to
 * `opencode.json` and `.opencode/plugins/` — the standard layout OpenCode
 * users expect.
 */
export async function loadPluginConfig(
  opts: PluginConfigLoadOptions = {}
): Promise<PiiRemoverConfig> {
  return coreLoadConfig(opts);
}

export { DEFAULT_CONFIG };
export type { PiiRemoverConfig };
