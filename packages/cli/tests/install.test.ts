import { describe, expect, test } from "bun:test";

import {
  runInstall,
  runOpenCodeInstall,
  loadExistingConfig,
  buildPiiRemoverJson,
  defaultProxyUrl,
  defaultProxyRoot,
  normalizeProxyRoot,
  openCodeProxyUrls,
  proxyUrlForRoute,
  proxyUrlForTarget,
  patchClaudeSettingsEnv,
  patchOpenCodeProviderBaseUrl,
  ALL_CATEGORIES,
  OPENCODE_PLUGIN_PACKAGE,
  type InstallFs,
} from "../src/commands/install.js";

function memFs(initial: Record<string, string> = {}): InstallFs & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    exists: (p) => files.has(p),
    readFile: async (p) => files.get(p) ?? "",
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    mkdir: async () => {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfig(files: Map<string, string>, p: string): Record<string, unknown> {
  const raw = files.get(p);
  if (raw === undefined) throw new Error(`nothing was written to ${p}`);
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error(`${p} does not hold a JSON object`);
  return parsed;
}

describe("runInstall", () => {
  test("creates settings.json when none exists", async () => {
    const fs = memFs();
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/abs/path/pii-remover",
      homeDir: "/home/u",
      fs,
    });
    expect(r.created).toBe(true);
    expect(r.hook_already_present).toBe(false);
    expect(r.settings_path).toBe("/home/u/.claude/settings.json".replaceAll("/", require("node:path").sep));
    const written = fs.files.get(r.settings_path);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    const group = parsed.hooks.UserPromptSubmit[0];
    expect(group.hooks[0].type).toBe("command");
    expect(group.hooks[0].command).toBe('node "/abs/path/pii-remover" hook');
    expect(group.hooks[0].timeout).toBe(30);
  });

  test("patches existing settings.json preserving unrelated keys", async () => {
    const path = require("node:path");
    const settingsPath = path.join("/home/u", ".claude", "settings.json");
    const fs = memFs({
      [settingsPath]: JSON.stringify(
        {
          unrelated: { keep: true, value: 42 },
          hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
        },
        null,
        2
      ),
    });
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/usr/local/bin/pii-remover",
      homeDir: "/home/u",
      fs,
    });
    expect(r.created).toBe(false);
    const parsed = JSON.parse(fs.files.get(r.settings_path)!);
    expect(parsed.unrelated).toEqual({ keep: true, value: 42 });
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
  });

  test("idempotent: rerunning with the same command does not duplicate", async () => {
    const path = require("node:path");
    const settingsPath = path.join("/home/u", ".claude", "settings.json");
    const fs = memFs({
      [settingsPath]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'node "/usr/local/bin/pii-remover" hook',
                  timeout: 30,
                },
              ],
            },
          ],
        },
      }),
    });
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/usr/local/bin/pii-remover",
      homeDir: "/home/u",
      fs,
    });
    expect(r.hook_already_present).toBe(true);
    const parsed = JSON.parse(fs.files.get(r.settings_path)!);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
  });

  test("idempotent: bare command matches node-prefixed command", async () => {
    const path = require("node:path");
    const settingsPath = path.join("/home/u", ".claude", "settings.json");
    const fs = memFs({
      [settingsPath]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/usr/local/bin/pii-remover hook",
                  timeout: 30,
                },
              ],
            },
          ],
        },
      }),
    });
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/usr/local/bin/pii-remover",
      homeDir: "/home/u",
      fs,
    });
    expect(r.hook_already_present).toBe(true);
    const parsed = JSON.parse(fs.files.get(r.settings_path)!);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
  });

  test("idempotent: node-prefixed matches bare command", async () => {
    const path = require("node:path");
    const settingsPath = path.join("/home/u", ".claude", "settings.json");
    const fs = memFs({
      [settingsPath]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node /usr/local/bin/pii-remover hook",
                  timeout: 30,
                },
              ],
            },
          ],
        },
      }),
    });
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/usr/local/bin/pii-remover",
      homeDir: "/home/u",
      fs,
    });
    expect(r.hook_already_present).toBe(true);
  });

  test("project scope uses .claude/settings.json under projectDir", async () => {
    const path = require("node:path");
    const fs = memFs();
    const r = await runInstall({
      target: "claude-code",
      scope: "project",
      commandPath: "/abs/pii-remover",
      projectDir: "/repo/x",
      fs,
    });
    expect(r.settings_path).toBe(path.join("/repo/x", ".claude", "settings.json"));
    expect(fs.files.has(r.settings_path)).toBe(true);
  });

  test("dryRun does not write but returns patched JSON", async () => {
    const fs = memFs();
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/abs/pii-remover",
      homeDir: "/home/u",
      dryRun: true,
      fs,
    });
    expect(fs.files.size).toBe(0);
    expect(r.patched_json).toContain("UserPromptSubmit");
  });

  test("malformed existing JSON throws", async () => {
    const path = require("node:path");
    const settingsPath = path.join("/home/u", ".claude", "settings.json");
    const fs = memFs({ [settingsPath]: "{ not json" });
    await expect(
      runInstall({
        target: "claude-code",
        commandPath: "/abs/pii-remover",
        homeDir: "/home/u",
        fs,
      })
    ).rejects.toThrow(/Cannot parse/);
  });

  test("next_steps include proxy hand-off instructions", async () => {
    const fs = memFs();
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/abs/pii-remover",
      homeDir: "/home/u",
      fs,
    });
    const joined = r.next_steps.join("\n");
    expect(joined).toContain("docker compose");
    expect(joined).toContain("ANTHROPIC_BASE_URL=");
    expect(joined).toContain("8000");
  });

  test("piiConfig writes .pii-remover.json", async () => {
    const path = require("node:path");
    const fs = memFs();
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/abs/pii-remover",
      homeDir: "/home/u",
      fs,
      piiConfig: {
        endpoint: "http://localhost:9000/redact",
        categories: ["private_email", "private_phone"],
      },
    });
    expect(r.config_written).toBe(true);
    expect(r.config_path).toBe(
      path.join("/home/u", ".config", "pii-remover", "config.json")
    );
    const written = fs.files.get(r.config_path!);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.backend.endpoint).toBe("http://localhost:9000/redact");
    expect(parsed.detection.enabled_categories).toEqual(["private_email", "private_phone"]);
  });

  test("piiConfig writes claude-code global config to loader-readable path (~/.config/pii-remover/config.json)", async () => {
    const fs = memFs();
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/abs/pii-remover",
      homeDir: "/home/u",
      fs,
      piiConfig: {
        endpoint: "http://localhost:8000/redact",
        categories: [...ALL_CATEGORIES],
      },
    });
    expect(r.config_written).toBe(true);
    expect(r.config_path).toBe(
      require("node:path").join("/home/u", ".config", "pii-remover", "config.json")
    );
    expect(fs.files.has(r.config_path!)).toBe(true);
  });

  test("project scope writes <project>/.pii-remover.json (cwd-based loader candidate)", async () => {
    const path = require("node:path");
    const fs = memFs();
    const r = await runInstall({
      target: "claude-code",
      scope: "project",
      commandPath: "/abs/pii-remover",
      homeDir: "/home/u",
      projectDir: "/work/myproj",
      fs,
      piiConfig: {
        endpoint: "http://localhost:9000/redact",
        categories: ["private_email"],
      },
    });
    expect(r.config_path).toBe(path.join("/work/myproj", ".pii-remover.json"));
  });

  test("legacy ~/.pii-remover.json triggers migration warning in next_steps", async () => {
    const path = require("node:path");
    const legacy = path.join("/home/u", ".pii-remover.json");
    const fs = memFs({ [legacy]: "{}" });
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/abs/pii-remover",
      homeDir: "/home/u",
      fs,
      piiConfig: {
        endpoint: "http://localhost:9000/redact",
        categories: ["private_email"],
      },
    });
    const joined = r.next_steps.join("\n");
    expect(joined).toContain("WARNING: legacy config detected");
    expect(joined).toContain(legacy);
    expect(joined).toContain(".config");
  });

  test("dryRun skips config write", async () => {
    const fs = memFs();
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/abs/pii-remover",
      homeDir: "/home/u",
      dryRun: true,
      fs,
      piiConfig: {
        endpoint: "http://localhost:8000/redact",
        categories: ["private_email"],
      },
    });
    expect(fs.files.size).toBe(0);
    expect(r.config_written).toBe(true);
  });
});

describe("loadExistingConfig", () => {
  test("reads endpoint and categories from project .pii-remover.json", async () => {
    const path = require("node:path");
    const configPath = path.join("/proj", ".pii-remover.json");
    const fs = memFs({
      [configPath]: JSON.stringify({
        backend: { endpoint: "http://ml-server/redact" },
        detection: { enabled_categories: ["private_email", "private_phone"] },
      }),
    });
    const result = await loadExistingConfig("/proj", "/home/u", fs);
    expect(result).not.toBeNull();
    expect(result!.endpoint).toBe("http://ml-server/redact");
    expect(result!.categories).toEqual(["private_email", "private_phone"]);
  });

  test("returns null when no config file exists", async () => {
    const fs = memFs();
    const result = await loadExistingConfig("/proj", "/home/u", fs);
    expect(result).toBeNull();
  });

  test("returns null on malformed JSON", async () => {
    const path = require("node:path");
    const configPath = path.join("/home/u", ".pii-remover.json");
    const fs = memFs({ [configPath]: "{ bad json" });
    const result = await loadExistingConfig("/proj", "/home/u", fs);
    expect(result).toBeNull();
  });
});

describe("buildPiiRemoverJson", () => {
  test("serialises endpoint and categories", () => {
    const json = buildPiiRemoverJson({
      endpoint: "http://localhost:8000/redact",
      categories: ["private_email", "secret"],
    });
    const parsed = JSON.parse(json);
    expect(parsed.backend.endpoint).toBe("http://localhost:8000/redact");
    expect(parsed.detection.enabled_categories).toEqual(["private_email", "secret"]);
  });

  test("does NOT include auto_start / compose_file by default (backwards-compat)", () => {
    const parsed = JSON.parse(
      buildPiiRemoverJson({
        endpoint: "http://localhost:8000/redact",
        categories: ["private_email"],
      })
    );
    expect(parsed.backend.auto_start).toBe(false);
    expect(parsed.backend.compose_file).toBe("cpu");
  });

  test("includes auto_start=true when explicitly set", () => {
    const parsed = JSON.parse(
      buildPiiRemoverJson({
        endpoint: "http://localhost:8000/redact",
        categories: ["private_email"],
        auto_start: true,
        compose_file: "gpu",
        start_timeout_ms: 120000,
      })
    );
    expect(parsed.backend.auto_start).toBe(true);
    expect(parsed.backend.compose_file).toBe("gpu");
    expect(parsed.backend.start_timeout_ms).toBe(120000);
  });

  test("auto_start=false is preserved (explicit opt-out)", () => {
    const parsed = JSON.parse(
      buildPiiRemoverJson({
        endpoint: "http://localhost:8000/redact",
        categories: ["private_email"],
        auto_start: false,
      })
    );
    expect(parsed.backend.auto_start).toBe(false);
  });
});

describe("loadExistingConfig — backend lifecycle fields (ADR-0019)", () => {
  test("round-trips auto_start / compose_file / start_timeout_ms", async () => {
    const path = require("node:path");
    const configPath = path.join("/proj", ".pii-remover.json");
    const fs = memFs({
      [configPath]: JSON.stringify({
        backend: {
          endpoint: "http://ml-server/redact",
          auto_start: true,
          compose_file: "gpu",
          start_timeout_ms: 90000,
        },
        detection: { enabled_categories: ["private_email"] },
      }),
    });
    const result = await loadExistingConfig("/proj", "/home/u", fs);
    expect(result).not.toBeNull();
    expect(result!.auto_start).toBe(true);
    expect(result!.compose_file).toBe("gpu");
    expect(result!.start_timeout_ms).toBe(90000);
  });

  test("ignores invalid auto_start / compose_file types", async () => {
    const path = require("node:path");
    const configPath = path.join("/proj", ".pii-remover.json");
    const fs = memFs({
      [configPath]: JSON.stringify({
        backend: {
          endpoint: "http://ml-server/redact",
          auto_start: "yes",
          compose_file: 42,
          start_timeout_ms: -1,
        },
        detection: { enabled_categories: ["private_email"] },
      }),
    });
    const result = await loadExistingConfig("/proj", "/home/u", fs);
    expect(result).not.toBeNull();
    expect(result!.auto_start).toBeUndefined();
    expect(result!.compose_file).toBeUndefined();
    expect(result!.start_timeout_ms).toBeUndefined();
  });
});

describe("runOpenCodeInstall split-mode", () => {
  const path = require("node:path") as typeof import("node:path");
  const { pathToFileURL } = require("node:url") as typeof import("node:url");

  const stubResolver = (subpath: string): string | null => {
    if (subpath.endsWith("/mask")) return "/fake/node_modules/@pii-remover/opencode-plugin/dist/mask.js";
    if (subpath.endsWith("/restore")) return "/fake/node_modules/@pii-remover/opencode-plugin/dist/restore.js";
    return null;
  };

  test("creates opencode.json with mask first and restore last", async () => {
    const fs = memFs();
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
    });
    const written = fs.files.get(r.settings_path);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    const plugins = parsed.plugin as string[];
    expect(plugins).toHaveLength(2);
    expect(plugins[0]).toBe(pathToFileURL("/fake/node_modules/@pii-remover/opencode-plugin/dist/mask.js").href);
    expect(plugins[1]).toBe(pathToFileURL("/fake/node_modules/@pii-remover/opencode-plugin/dist/restore.js").href);
  });

  test("preserves other plugins between mask and restore", async () => {
    const configPath = path.join("/home/u", ".config", "opencode", "opencode.json");
    const fs = memFs({
      [configPath]: JSON.stringify({
        plugin: ["other-plugin-a", "other-plugin-b"],
      }),
    });
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
    });
    const parsed = JSON.parse(fs.files.get(r.settings_path)!);
    const plugins = parsed.plugin as string[];
    expect(plugins).toHaveLength(4);
    expect(plugins[0]).toMatch(/mask\.js$/);
    expect(plugins[1]).toBe("other-plugin-a");
    expect(plugins[2]).toBe("other-plugin-b");
    expect(plugins[3]).toMatch(/restore\.js$/);
  });

  test("re-running upgrades legacy bare entry to split mode", async () => {
    const configPath = path.join("/home/u", ".config", "opencode", "opencode.json");
    const fs = memFs({
      [configPath]: JSON.stringify({
        plugin: [OPENCODE_PLUGIN_PACKAGE, "third-party"],
      }),
    });
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
    });
    const parsed = JSON.parse(fs.files.get(r.settings_path)!);
    const plugins = parsed.plugin as string[];
    expect(plugins).toHaveLength(3);
    expect(plugins[0]).toMatch(/mask\.js$/);
    expect(plugins[1]).toBe("third-party");
    expect(plugins[2]).toMatch(/restore\.js$/);
    expect(plugins.filter((p) => p === OPENCODE_PLUGIN_PACKAGE)).toHaveLength(0);
  });

  test("re-running is idempotent (same array on second run)", async () => {
    const fs = memFs();
    const r1 = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
    });
    const after1 = fs.files.get(r1.settings_path);
    const r2 = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
    });
    expect(r2.hook_already_present).toBe(true);
    expect(fs.files.get(r2.settings_path)).toBe(after1);
  });

  test("falls back to bare package when resolver returns null", async () => {
    const fs = memFs();
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: () => null,
    });
    const parsed = JSON.parse(fs.files.get(r.settings_path)!);
    expect(parsed.plugin).toEqual([OPENCODE_PLUGIN_PACKAGE]);
    expect(r.next_steps.join("\n")).toContain("WARNING");
  });

  test("dryRun does not write file", async () => {
    const fs = memFs();
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      dryRun: true,
      resolvePluginFile: stubResolver,
    });
    expect(fs.files.size).toBe(0);
    expect(r.patched_json).toContain("mask.js");
    expect(r.patched_json).toContain("restore.js");
  });

  test("proxyUrl writes provider.anthropic.options.baseURL alongside the plugins", async () => {
    const fs = memFs();
    const url = "http://localhost:8765/anthropic/v1";
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
      proxyUrl: url,
    });
    expect(r.base_url_written).toBe(true);
    expect(r.base_url_already_set).toBe(false);
    const parsed = JSON.parse(fs.files.get(r.settings_path)!);
    expect(parsed.provider.anthropic.options.baseURL).toBe(url);
    expect((parsed.plugin as string[])[0]).toMatch(/mask\.js$/);
  });

  test("proxyOnly registers no plugin but still writes the baseURL", async () => {
    const fs = memFs();
    const url = "http://localhost:8000/anthropic/v1";
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
      proxyUrl: url,
      proxyOnly: true,
    });

    const parsed = JSON.parse(fs.files.get(r.settings_path)!);
    expect(parsed.provider.anthropic.options.baseURL).toBe(url);
    expect(parsed.plugin).toBeUndefined();
    expect(r.patched_json).not.toContain("mask.js");
    expect(r.patched_json).not.toContain("restore.js");
  });

  test("proxyOnly strips plugin entries a previous install added, keeping foreign ones", async () => {
    const configPath = path.join("/home/u", ".config", "opencode", "opencode.json");
    const fs = memFs({
      [configPath]: JSON.stringify({
        plugin: [
          "file:///abs/@pii-remover/opencode-plugin/dist/mask.js",
          "someone-elses-plugin@1.2.3",
          "file:///abs/@pii-remover/opencode-plugin/dist/restore.js",
        ],
      }),
    });
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
      proxyUrl: "http://localhost:8000/anthropic/v1",
      proxyOnly: true,
    });

    const parsed = JSON.parse(fs.files.get(r.settings_path)!);
    expect(parsed.plugin).toEqual(["someone-elses-plugin@1.2.3"]);
    expect(r.next_steps.join("\n")).toContain("Removed 2");
  });

  test("proxyOnly reports nothing removed when no plugin was installed", async () => {
    const fs = memFs();
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
      proxyUrl: "http://localhost:8000/anthropic/v1",
      proxyOnly: true,
    });
    expect(r.hook_already_present).toBe(true);
    expect(r.next_steps.join("\n")).toContain("No pii-remover plugin entries were present");
  });

  test("proxyUrl does not clobber a different existing baseURL and warns", async () => {
    const configPath = path.join("/home/u", ".config", "opencode", "opencode.json");
    const fs = memFs({
      [configPath]: JSON.stringify({
        provider: { anthropic: { options: { baseURL: "https://gateway.corp/v1" } } },
      }),
    });
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
      proxyUrl: "http://localhost:8765/anthropic/v1",
    });
    expect(r.base_url_written).toBe(false);
    expect(r.base_url_already_set).toBe(true);
    const parsed = JSON.parse(fs.files.get(r.settings_path)!);
    expect(parsed.provider.anthropic.options.baseURL).toBe("https://gateway.corp/v1");
    expect(r.next_steps.join("\n")).toContain("BYPASS");
  });

  test("proxyUrl points both OpenCode LLM providers at their own proxy route", async () => {
    const fs = memFs();
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
      proxyUrl: "http://localhost:8765/anthropic/v1",
    });

    expect(readConfig(fs.files, r.settings_path).provider).toEqual({
      anthropic: { options: { baseURL: "http://localhost:8765/anthropic/v1" } },
      openai: { options: { baseURL: "http://localhost:8765/openai/v1" } },
    });
    expect(r.provider_base_urls).toEqual([
      {
        provider: "anthropic",
        url: "http://localhost:8765/anthropic/v1",
        outcome: { already_set: false, written: true, existing: null },
      },
      {
        provider: "openai",
        url: "http://localhost:8765/openai/v1",
        outcome: { already_set: false, written: true, existing: null },
      },
    ]);
  });

  test("a suffix-free proxyUrl still lands both providers on a masking route", async () => {
    const fs = memFs();
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
      proxyUrl: "http://localhost:8000",
    });

    expect(readConfig(fs.files, r.settings_path).provider).toEqual({
      anthropic: { options: { baseURL: "http://localhost:8000/anthropic/v1" } },
      openai: { options: { baseURL: "http://localhost:8000/openai/v1" } },
    });
  });

  test("an anthropic gateway conflict does not block the openai write", async () => {
    const configPath = path.join("/home/u", ".config", "opencode", "opencode.json");
    const fs = memFs({
      [configPath]: JSON.stringify({
        provider: { anthropic: { options: { baseURL: "https://gateway.corp/v1" } } },
      }),
    });
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
      proxyUrl: "http://localhost:8765/anthropic/v1",
    });

    expect(readConfig(fs.files, r.settings_path).provider).toEqual({
      anthropic: { options: { baseURL: "https://gateway.corp/v1" } },
      openai: { options: { baseURL: "http://localhost:8765/openai/v1" } },
    });
    expect(r.provider_base_urls).toEqual([
      {
        provider: "anthropic",
        url: "http://localhost:8765/anthropic/v1",
        outcome: { already_set: true, written: false, existing: "https://gateway.corp/v1" },
      },
      {
        provider: "openai",
        url: "http://localhost:8765/openai/v1",
        outcome: { already_set: false, written: true, existing: null },
      },
    ]);
    expect(r.base_url_written).toBe(false);
    expect(r.base_url_already_set).toBe(true);
    expect(r.base_url_existing).toBe("https://gateway.corp/v1");
  });

  test("an openai gateway conflict does not block the anthropic write", async () => {
    const configPath = path.join("/home/u", ".config", "opencode", "opencode.json");
    const fs = memFs({
      [configPath]: JSON.stringify({
        provider: { openai: { options: { baseURL: "https://openai-gw/v1" } } },
      }),
    });
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
      proxyUrl: "http://localhost:8765/anthropic/v1",
    });

    expect(readConfig(fs.files, r.settings_path).provider).toEqual({
      anthropic: { options: { baseURL: "http://localhost:8765/anthropic/v1" } },
      openai: { options: { baseURL: "https://openai-gw/v1" } },
    });
    expect(r.base_url_written).toBe(true);
    expect(r.base_url_already_set).toBe(false);
    const joined = r.next_steps.join("\n");
    expect(joined).toContain("provider.openai.options.baseURL");
    expect(joined).toContain("BYPASS");
  });

  test("proxyOnly patches both providers", async () => {
    const fs = memFs();
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
      proxyUrl: "http://localhost:8000/anthropic/v1",
      proxyOnly: true,
    });

    const written = readConfig(fs.files, r.settings_path);
    expect(written.provider).toEqual({
      anthropic: { options: { baseURL: "http://localhost:8000/anthropic/v1" } },
      openai: { options: { baseURL: "http://localhost:8000/openai/v1" } },
    });
    expect(written.plugin).toBeUndefined();
  });

  test("without proxyUrl no provider is touched", async () => {
    const fs = memFs();
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
    });

    expect(readConfig(fs.files, r.settings_path).provider).toBeUndefined();
    expect(r.provider_base_urls).toEqual([]);
    expect(r.base_url_written).toBe(false);
    expect(r.base_url_already_set).toBe(false);
  });

  test("--proxy mode registers plugin first/last and both provider URLs together", async () => {
    const fs = memFs();
    const r = await runOpenCodeInstall({
      target: "opencode",
      scope: "global",
      homeDir: "/home/u",
      fs,
      resolvePluginFile: stubResolver,
      proxyUrl: "http://localhost:8000",
    });

    // Plugin ordering: mask first, restore last
    const config = readConfig(fs.files, r.settings_path);
    const plugins = config.plugin as string[];
    expect(plugins).toHaveLength(2);
    expect(plugins[0]).toMatch(/mask\.js$/);
    expect(plugins[1]).toMatch(/restore\.js$/);

    // Both provider URLs derived from the bare root
    expect(config.provider).toEqual({
      anthropic: { options: { baseURL: "http://localhost:8000/anthropic/v1" } },
      openai: { options: { baseURL: "http://localhost:8000/openai/v1" } },
    });

    // Both provider patches recorded as written
    expect(r.provider_base_urls).toEqual([
      {
        provider: "anthropic",
        url: "http://localhost:8000/anthropic/v1",
        outcome: { already_set: false, written: true, existing: null },
      },
      {
        provider: "openai",
        url: "http://localhost:8000/openai/v1",
        outcome: { already_set: false, written: true, existing: null },
      },
    ]);
  });
});

describe("defaultProxyUrl", () => {
  test("routes anthropic hosts to /anthropic/v1 and codex to /codex/v1", () => {
    expect(defaultProxyUrl("claude-code")).toBe("http://localhost:8000/anthropic/v1");
    expect(defaultProxyUrl("opencode")).toBe("http://localhost:8000/anthropic/v1");
    expect(defaultProxyUrl("codex")).toBe("http://localhost:8000/codex/v1");
  });

  test("honours a custom port", () => {
    expect(defaultProxyUrl("claude-code", 9999)).toBe("http://localhost:9999/anthropic/v1");
  });
});

describe("proxy root normalization", () => {
  const rootOf = (input: string): string => normalizeProxyRoot(input).value;

  test("strips every known terminal route suffix back to the same root", () => {
    expect(rootOf("http://localhost:8000/anthropic/v1")).toBe("http://localhost:8000");
    expect(rootOf("http://localhost:8000/openai/v1")).toBe("http://localhost:8000");
    expect(rootOf("http://localhost:8000/codex/v1")).toBe("http://localhost:8000");
  });

  test("treats a suffix-free URL as the root itself", () => {
    expect(rootOf("http://localhost:8000")).toBe("http://localhost:8000");
    expect(rootOf("http://localhost:8000/")).toBe("http://localhost:8000");
    expect(rootOf("  http://localhost:8000/  ")).toBe("http://localhost:8000");
  });

  test("keeps an unrecognized mount path as part of the root", () => {
    expect(rootOf("https://gw.corp/pii")).toBe("https://gw.corp/pii");
    expect(rootOf("https://gw.corp/pii/anthropic/v1")).toBe("https://gw.corp/pii");
    expect(rootOf("https://gw.corp/anthropic")).toBe("https://gw.corp/anthropic");
    expect(rootOf("https://gw.corp/v1")).toBe("https://gw.corp/v1");
  });

  test("strips at most one suffix so a doubled path stays visible", () => {
    expect(rootOf("http://h:1/anthropic/v1/anthropic/v1")).toBe("http://h:1/anthropic/v1");
  });

  test("defaultProxyRoot carries no route suffix and honours the port", () => {
    expect(defaultProxyRoot().value).toBe("http://localhost:8000");
    expect(defaultProxyRoot(9999).value).toBe("http://localhost:9999");
  });
});

describe("proxy URL derivation", () => {
  test("derives all three routes from one root", () => {
    const root = normalizeProxyRoot("http://localhost:8765/anthropic/v1");
    expect(proxyUrlForRoute(root, "anthropic")).toBe("http://localhost:8765/anthropic/v1");
    expect(proxyUrlForRoute(root, "openai")).toBe("http://localhost:8765/openai/v1");
    expect(proxyUrlForRoute(root, "codex")).toBe("http://localhost:8765/codex/v1");
  });

  test("maps each install target to its own route", () => {
    const root = defaultProxyRoot(9999);
    expect(proxyUrlForTarget(root, "claude-code")).toBe("http://localhost:9999/anthropic/v1");
    expect(proxyUrlForTarget(root, "opencode")).toBe("http://localhost:9999/anthropic/v1");
    expect(proxyUrlForTarget(root, "codex")).toBe("http://localhost:9999/codex/v1");
  });

  test("openCodeProxyUrls yields one URL per OpenCode LLM provider", () => {
    expect(openCodeProxyUrls(normalizeProxyRoot("http://localhost:8000/openai/v1"))).toEqual({
      anthropic: "http://localhost:8000/anthropic/v1",
      openai: "http://localhost:8000/openai/v1",
    });
  });
});

describe("patchClaudeSettingsEnv", () => {
  const url = "http://localhost:8765/anthropic/v1";

  test("creates the env block when absent", () => {
    const { patched, outcome } = patchClaudeSettingsEnv({ hooks: {} }, url);
    expect(outcome.written).toBe(true);
    expect(outcome.already_set).toBe(false);
    expect((patched.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe(url);
    expect(patched.hooks).toEqual({});
  });

  test("preserves unrelated env keys", () => {
    const { patched } = patchClaudeSettingsEnv({ env: { FOO: "bar" } }, url);
    const env = patched.env as Record<string, string>;
    expect(env.FOO).toBe("bar");
    expect(env.ANTHROPIC_BASE_URL).toBe(url);
  });

  test("identical existing value is reported as applied without mutation", () => {
    const input = { env: { ANTHROPIC_BASE_URL: url } };
    const { patched, outcome } = patchClaudeSettingsEnv(input, url);
    expect(outcome.written).toBe(true);
    expect(outcome.already_set).toBe(false);
    expect(patched).toBe(input);
  });

  test("refuses to clobber a different existing value", () => {
    const input = { env: { ANTHROPIC_BASE_URL: "https://gateway.corp/v1" } };
    const { patched, outcome } = patchClaudeSettingsEnv(input, url);
    expect(outcome.written).toBe(false);
    expect(outcome.already_set).toBe(true);
    expect(outcome.existing).toBe("https://gateway.corp/v1");
    expect(patched).toBe(input);
  });

  test("leaves a malformed env value untouched", () => {
    const input = { env: ["not", "an", "object"] };
    const { patched, outcome } = patchClaudeSettingsEnv(input, url);
    expect(outcome.written).toBe(false);
    expect(outcome.already_set).toBe(true);
    expect(patched).toBe(input);
  });
});

describe("patchOpenCodeProviderBaseUrl", () => {
  const url = "http://localhost:8765/anthropic/v1";

  test("creates the full nested path from an empty config", () => {
    const { patched, outcome } = patchOpenCodeProviderBaseUrl({}, url);
    expect(outcome.written).toBe(true);
    const provider = patched.provider as Record<string, Record<string, Record<string, string>>>;
    expect(provider.anthropic!.options!.baseURL).toBe(url);
  });

  test("preserves sibling keys and other providers", () => {
    const { patched } = patchOpenCodeProviderBaseUrl(
      {
        plugin: ["a"],
        provider: {
          openai: { options: { baseURL: "https://api.openai.com/v1" } },
          anthropic: { options: { apiKey: "k" } },
        },
      },
      url
    );
    expect(patched.plugin).toEqual(["a"]);
    const provider = patched.provider as Record<string, Record<string, Record<string, string>>>;
    expect(provider.openai!.options!.baseURL).toBe("https://api.openai.com/v1");
    expect(provider.anthropic!.options!.apiKey).toBe("k");
    expect(provider.anthropic!.options!.baseURL).toBe(url);
  });

  test("identical existing value is reported as applied without mutation", () => {
    const input = { provider: { anthropic: { options: { baseURL: url } } } };
    const { patched, outcome } = patchOpenCodeProviderBaseUrl(input, url);
    expect(outcome.written).toBe(true);
    expect(patched).toBe(input);
  });

  test("refuses to clobber a different existing value", () => {
    const input = { provider: { anthropic: { options: { baseURL: "https://gw/v1" } } } };
    const { outcome } = patchOpenCodeProviderBaseUrl(input, url);
    expect(outcome.written).toBe(false);
    expect(outcome.already_set).toBe(true);
    expect(outcome.existing).toBe("https://gw/v1");
  });

  test("leaves a malformed intermediate node untouched", () => {
    const input = { provider: ["nope"] };
    const { patched, outcome } = patchOpenCodeProviderBaseUrl(input, url);
    expect(outcome.written).toBe(false);
    expect(outcome.already_set).toBe(true);
    expect(patched).toBe(input);
  });

  test("patches the named provider instead of anthropic", () => {
    const openaiUrl = "http://localhost:8765/openai/v1";
    const { patched, outcome } = patchOpenCodeProviderBaseUrl({}, openaiUrl, "openai");
    expect(outcome.written).toBe(true);
    expect(patched.provider).toEqual({ openai: { options: { baseURL: openaiUrl } } });
  });

  test("patching openai preserves an anthropic gateway and openai siblings", () => {
    const openaiUrl = "http://localhost:8765/openai/v1";
    const { patched } = patchOpenCodeProviderBaseUrl(
      {
        provider: {
          anthropic: { options: { baseURL: "https://gateway.corp/v1" } },
          openai: { options: { apiKey: "k" }, models: { "gpt-5": {} } },
        },
      },
      openaiUrl,
      "openai"
    );
    expect(patched.provider).toEqual({
      anthropic: { options: { baseURL: "https://gateway.corp/v1" } },
      openai: { options: { apiKey: "k", baseURL: openaiUrl }, models: { "gpt-5": {} } },
    });
  });

  test("refuses to clobber a different openai gateway", () => {
    const input = { provider: { openai: { options: { baseURL: "https://openai-gw/v1" } } } };
    const { patched, outcome } = patchOpenCodeProviderBaseUrl(
      input,
      "http://localhost:8765/openai/v1",
      "openai"
    );
    expect(outcome.written).toBe(false);
    expect(outcome.already_set).toBe(true);
    expect(outcome.existing).toBe("https://openai-gw/v1");
    expect(patched).toBe(input);
  });
});

describe("runInstall proxy mode", () => {
  const url = "http://localhost:8765/anthropic/v1";

  test("writes env.ANTHROPIC_BASE_URL and keeps the hook", async () => {
    const fs = memFs();
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/abs/pii-remover",
      homeDir: "/home/u",
      fs,
      proxyUrl: url,
    });
    expect(r.base_url_written).toBe(true);
    const parsed = JSON.parse(fs.files.get(r.settings_path)!);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe(url);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    const joined = r.next_steps.join("\n");
    expect(joined).toContain("Proxy mode:");
    expect(joined).not.toContain("export ANTHROPIC_BASE_URL=");
  });

  test("warns and leaves a conflicting base URL untouched", async () => {
    const path = require("node:path");
    const settingsPath = path.join("/home/u", ".claude", "settings.json");
    const fs = memFs({
      [settingsPath]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gw/v1" } }),
    });
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/abs/pii-remover",
      homeDir: "/home/u",
      fs,
      proxyUrl: url,
    });
    expect(r.base_url_written).toBe(false);
    expect(r.base_url_already_set).toBe(true);
    const parsed = JSON.parse(fs.files.get(r.settings_path)!);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("https://gw/v1");
    expect(r.next_steps.join("\n")).toContain("BYPASS");
  });

  test("without proxyUrl the manual export instruction is still emitted", async () => {
    const fs = memFs();
    const r = await runInstall({
      target: "claude-code",
      commandPath: "/abs/pii-remover",
      homeDir: "/home/u",
      fs,
    });
    expect(r.base_url_written).toBe(false);
    expect(r.next_steps.join("\n")).toContain("export ANTHROPIC_BASE_URL=");
    expect(JSON.parse(fs.files.get(r.settings_path)!).env).toBeUndefined();
  });
});
