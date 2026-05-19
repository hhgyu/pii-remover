import { describe, expect, test } from "bun:test";

import {
  runInstall,
  runOpenCodeInstall,
  loadExistingConfig,
  buildPiiRemoverJson,
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
    expect(joined).toContain("pii-remover-proxy start");
    expect(joined).toContain("ANTHROPIC_BASE_URL=");
    expect(joined).toContain("8765");
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
    expect(r.config_path).toBe(path.join("/home/u", ".pii-remover.json"));
    const written = fs.files.get(r.config_path!);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.backend.endpoint).toBe("http://localhost:9000/redact");
    expect(parsed.detection.enabled_categories).toEqual(["private_email", "private_phone"]);
  });

  test("piiConfig writes .pii-remover.json", async () => {
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
    expect(r.config_path).toBe(require("node:path").join("/home/u", ".pii-remover.json"));
    expect(fs.files.has(r.config_path!)).toBe(true);
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
});
