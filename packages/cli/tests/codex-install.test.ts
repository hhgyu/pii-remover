import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  patchCodexConfigToml,
  runCodexInstall,
} from "../src/commands/codex-install.js";
import type { InstallFs } from "../src/commands/install.js";

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

describe("patchCodexConfigToml", () => {
  test("creates a [[hooks.UserPromptSubmit]] block when file is empty", () => {
    const r = patchCodexConfigToml("", {
      commandPath: 'node "/abs/path/pii-remover" hook',
      timeoutSeconds: 30,
    });
    expect(r.hookAlreadyPresent).toBe(false);
    expect(r.patched).toContain("[[hooks.UserPromptSubmit]]");
    expect(r.patched).toContain("[[hooks.UserPromptSubmit.hooks]]");
    expect(r.patched).toContain('type = "command"');
    expect(r.patched).toContain(
      'command = "node \\"/abs/path/pii-remover\\" hook"'
    );
    expect(r.patched).toContain("timeout = 30");
  });

  test("is idempotent — does not re-add when same command already present", () => {
    const initial = patchCodexConfigToml("", {
      commandPath: 'node "/abs/path" hook',
      timeoutSeconds: 30,
    }).patched;
    const r = patchCodexConfigToml(initial, {
      commandPath: 'node "/abs/path" hook',
      timeoutSeconds: 30,
    });
    expect(r.hookAlreadyPresent).toBe(true);
    expect(r.patched).toBe(initial);
  });

  test("preserves existing user content", () => {
    const existing = [
      "model = \"o1\"",
      "",
      "[tools]",
      "fancy = true",
      "",
    ].join("\n");
    const r = patchCodexConfigToml(existing, {
      commandPath: "node bin hook",
      timeoutSeconds: 30,
    });
    expect(r.patched.startsWith(existing)).toBe(true);
    expect(r.patched).toContain("[[hooks.UserPromptSubmit]]");
  });

  test("appends openai_base_url at top when missing and proxyUrl provided", () => {
    const r = patchCodexConfigToml("", {
      commandPath: "node bin hook",
      timeoutSeconds: 30,
      proxyUrl: "http://localhost:8765/codex/v1",
    });
    expect(r.baseUrlAlreadySet).toBe(false);
    expect(r.baseUrlWritten).toBe(true);
    expect(r.patched).toContain(
      'openai_base_url = "http://localhost:8765/codex/v1"'
    );
  });

  test("inserts openai_base_url BEFORE first [section]", () => {
    const existing = "[tools]\nfancy = true\n";
    const r = patchCodexConfigToml(existing, {
      commandPath: "node bin hook",
      timeoutSeconds: 30,
      proxyUrl: "http://localhost:8765/codex/v1",
    });
    expect(r.baseUrlWritten).toBe(true);
    const baseUrlIdx = r.patched.indexOf("openai_base_url");
    const sectionIdx = r.patched.indexOf("[tools]");
    expect(baseUrlIdx).toBeGreaterThan(-1);
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(baseUrlIdx).toBeLessThan(sectionIdx);
  });

  test("does not overwrite existing openai_base_url", () => {
    const existing = 'openai_base_url = "https://api.openai.com/v1"\n';
    const r = patchCodexConfigToml(existing, {
      commandPath: "node bin hook",
      timeoutSeconds: 30,
      proxyUrl: "http://localhost:8765/codex/v1",
    });
    expect(r.baseUrlAlreadySet).toBe(true);
    expect(r.baseUrlWritten).toBe(false);
    expect(r.patched).toContain(
      'openai_base_url = "https://api.openai.com/v1"'
    );
    expect(r.patched).not.toContain("http://localhost:8765/codex/v1");
  });

  test("re-running with the identical proxy URL reports it as applied", () => {
    const url = "http://localhost:8765/codex/v1";
    const r = patchCodexConfigToml(`openai_base_url = "${url}"\n`, {
      commandPath: "node bin hook",
      timeoutSeconds: 30,
      proxyUrl: url,
    });
    expect(r.baseUrlWritten).toBe(true);
    expect(r.baseUrlAlreadySet).toBe(false);
    expect(r.patched.match(/openai_base_url/g)).toHaveLength(1);
  });

  test("escapes backslashes in Windows-style paths", () => {
    const r = patchCodexConfigToml("", {
      commandPath: 'node "D:\\Git\\bin\\pii-remover.js" hook',
      timeoutSeconds: 30,
    });
    expect(r.patched).toContain('"node \\"D:\\\\Git\\\\bin\\\\pii-remover.js\\" hook"');
  });

  test("strips inline comment when matching command", () => {
    const existingHook = [
      "[[hooks.UserPromptSubmit]]",
      "  [[hooks.UserPromptSubmit.hooks]]",
      '  type = "command"',
      '  command = "node bin hook" # was added by us',
      "  timeout = 30",
      "",
    ].join("\n");
    const r = patchCodexConfigToml(existingHook, {
      commandPath: "node bin hook",
      timeoutSeconds: 30,
    });
    expect(r.hookAlreadyPresent).toBe(true);
  });
});

describe("runCodexInstall", () => {
  test("creates config.toml when none exists (global scope)", async () => {
    const fs = memFs();
    const r = await runCodexInstall({
      target: "codex",
      scope: "global",
      commandPath: "/abs/path/pii-remover",
      homeDir: "/home/u",
      fs,
    });
    expect(r.created).toBe(true);
    expect(r.hook_already_present).toBe(false);
    const expected = join("/home/u", ".codex", "config.toml");
    expect(r.settings_path).toBe(expected);
    const written = fs.files.get(r.settings_path);
    expect(written).toBeDefined();
    expect(written!).toContain("[[hooks.UserPromptSubmit]]");
  });

  test("project scope writes to <project>/.codex/config.toml", async () => {
    const fs = memFs();
    await runCodexInstall({
      target: "codex",
      scope: "project",
      commandPath: "/abs/path/pii-remover",
      homeDir: "/home/u",
      projectDir: "/proj",
      fs,
    });
    expect(fs.files.has(join("/proj", ".codex", "config.toml"))).toBe(true);
  });

  test("writes pii-remover.json under .codex/ directory", async () => {
    const fs = memFs();
    const r = await runCodexInstall({
      target: "codex",
      scope: "global",
      commandPath: "/abs/path/pii-remover",
      homeDir: "/home/u",
      fs,
      piiConfig: {
        endpoint: "http://localhost:8000/redact",
        categories: ["private_email", "secret"],
      },
    });
    expect(r.config_written).toBe(true);
    expect(r.config_path).toBe(
      join("/home/u", ".codex", "pii-remover.json")
    );
    const piiJson = fs.files.get(r.config_path!);
    expect(piiJson).toBeDefined();
    const parsed = JSON.parse(piiJson!);
    expect(parsed.backend.endpoint).toBe("http://localhost:8000/redact");
    expect(parsed.detection.enabled_categories).toEqual([
      "private_email",
      "secret",
    ]);
  });

  test("idempotent install on second run", async () => {
    const fs = memFs();
    const opts = {
      target: "codex" as const,
      scope: "global" as const,
      commandPath: "/abs/path/pii-remover",
      homeDir: "/home/u",
      fs,
    };
    await runCodexInstall(opts);
    const r2 = await runCodexInstall(opts);
    expect(r2.hook_already_present).toBe(true);
  });

  test("dry-run does not touch the filesystem", async () => {
    const fs = memFs();
    const r = await runCodexInstall({
      target: "codex",
      scope: "global",
      commandPath: "/abs/path/pii-remover",
      homeDir: "/home/u",
      dryRun: true,
      fs,
    });
    expect(fs.files.size).toBe(0);
    expect(r.patched_json).toContain("[[hooks.UserPromptSubmit]]");
  });

  test("--proxy-url sets openai_base_url in fresh config", async () => {
    const fs = memFs();
    await runCodexInstall({
      target: "codex",
      scope: "global",
      commandPath: "/abs/path/pii-remover",
      homeDir: "/home/u",
      proxyUrl: "http://localhost:8765/codex/v1",
      fs,
    });
    const written = fs.files.get(join("/home/u", ".codex", "config.toml"));
    expect(written!).toContain(
      'openai_base_url = "http://localhost:8765/codex/v1"'
    );
  });
});
