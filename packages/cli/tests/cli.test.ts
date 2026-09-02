import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  PIIRemover,
  type PIICategory,
  type PiiRemoverConfig,
} from "@pii-remover/core";

function localOnlyConfig(): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
  };
}

/**
 * The hook path calls the real `loadConfig` and `maybeAutoStartBackend` unless
 * both are injected. Left un-stubbed it reads the developer's own
 * `pii-remover.json` and, when that sets `auto_start`, blocks on a real backend
 * warmup — which is what made this suite intermittently exceed the 5s per-test
 * timeout.
 */
function hookStubs() {
  return {
    loadConfigFn: async () => localOnlyConfig(),
    autoStartFn: async () => {},
  };
}

import { helpText, parseFlags, runCli } from "../src/cli.js";
import type { InstallFs, InstallTarget } from "../src/commands/install.js";
import type {
  CheckboxChoice,
  SelectCategoriesFn,
  SelectTargetsFn,
} from "../src/commands/install-command.js";

function makeIo(promptAnswers: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  let promptIdx = 0;
  return {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    prompt: async (q: string) => {
      prompts.push(q);
      return promptAnswers[promptIdx++] ?? "";
    },
    out,
    err,
    prompts,
  };
}

type MemFs = InstallFs & { files: Map<string, string> };

function memFs(seed: Record<string, string> = {}): MemFs {
  const files = new Map<string, string>(Object.entries(seed));
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

function writtenFile(fs: MemFs, matches: (path: string) => boolean): string {
  for (const [path, content] of fs.files) {
    if (matches(path)) return content;
  }
  throw new Error(
    `no written file matched; wrote: ${[...fs.files.keys()].join(", ")}`
  );
}

function writtenJson<T>(fs: MemFs, matches: (path: string) => boolean): T {
  return JSON.parse(writtenFile(fs, matches));
}

interface ClaudeSettings {
  env?: { ANTHROPIC_BASE_URL?: string };
  hooks?: unknown;
}

interface OpenCodeConfig {
  plugin?: string[];
  provider?: Record<string, { options?: { baseURL?: string } }>;
}

function targetSelector(answer: readonly InstallTarget[]) {
  const offered: CheckboxChoice<InstallTarget>[][] = [];
  const fn: SelectTargetsFn = async (choices) => {
    offered.push([...choices]);
    return answer;
  };
  return { fn, offered };
}

function categorySelector(answer: readonly PIICategory[] = ["private_email"]) {
  const offered: CheckboxChoice<PIICategory>[][] = [];
  const fn: SelectCategoriesFn = async (choices) => {
    offered.push([...choices]);
    return answer;
  };
  return { fn, offered };
}

const OPENCODE_GLOBAL_CONFIG = join(
  homedir(),
  ".config",
  "opencode",
  "opencode.json"
);

describe("parseFlags", () => {
  test("--proxy-only implies --proxy", () => {
    const f = parseFlags(["--target", "opencode", "--proxy-only"]);
    expect(f.proxyOnly).toBe(true);
    expect(f.proxy).toBe(true);
  });

  test("--proxy alone does not imply --proxy-only", () => {
    const f = parseFlags(["--target", "opencode", "--proxy"]);
    expect(f.proxy).toBe(true);
    expect(f.proxyOnly).toBeUndefined();
  });

  test("target + command-path", () => {
    const f = parseFlags(["--target", "claude-code", "--command-path", "/x/pii"]);
    expect(f.target).toBe("claude-code");
    expect(f.commandPath).toBe("/x/pii");
  });

  test("short flags + dry-run + scope", () => {
    const f = parseFlags(["-t", "claude-code", "-s", "project", "--dry-run"]);
    expect(f.target).toBe("claude-code");
    expect(f.scope).toBe("project");
    expect(f.dryRun).toBe(true);
  });

  test("unknown target value rejected silently", () => {
    const f = parseFlags(["--target", "vscode"]);
    expect(f.target).toBeUndefined();
  });

  test("--auto-start / --no-auto-start / --compose-file / --start-timeout-ms / --idle-timeout", () => {
    const a = parseFlags(["--auto-start", "--compose-file", "gpu", "--start-timeout-ms", "90000"]);
    expect(a.autoStart).toBe(true);
    expect(a.composeFile).toBe("gpu");
    expect(a.startTimeoutMs).toBe(90000);

    const b = parseFlags(["--no-auto-start", "--idle-timeout", "3600"]);
    expect(b.autoStart).toBe(false);
    expect(b.idleTimeoutSeconds).toBe(3600);

    const c = parseFlags(["--idle-timeout", "0"]);
    expect(c.idleTimeoutSeconds).toBe(0);

    const d = parseFlags(["--start-timeout-ms", "-5", "--idle-timeout", "-1"]);
    expect(d.startTimeoutMs).toBeUndefined();
    expect(d.idleTimeoutSeconds).toBeUndefined();
  });
});

describe("runCli", () => {
  test("version prints semver", async () => {
    const io = makeIo();
    const code = await runCli(["version"], io);
    expect(code).toBe(0);
    expect(io.out.join("")).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("help mentions hook + install + detect + health", async () => {
    const io = makeIo();
    const code = await runCli(["help"], io);
    expect(code).toBe(0);
    const txt = io.out.join("");
    expect(txt).toContain("hook");
    expect(txt).toContain("install");
    expect(txt).toContain("detect");
    expect(txt).toContain("health");
    expect(txt).toContain("ANTHROPIC_BASE_URL");
  });

  test("unknown command -> 64", async () => {
    const io = makeIo();
    const code = await runCli(["fubar"], io);
    expect(code).toBe(64);
    expect(io.err.join("")).toContain("unknown command");
  });

  test("no command -> help, exit 0", async () => {
    const io = makeIo();
    const code = await runCli([], io);
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("Usage:");
  });

  test("install with an empty target selection -> 64, nothing written", async () => {
    const io = makeIo();
    const fs = memFs();
    const targets = targetSelector([]);
    const categories = categorySelector();
    const code = await runCli(["install"], {
      ...io,
      installFs: fs,
      selectTargets: targets.fn,
      selectCategories: categories.fn,
    });
    expect(code).toBe(64);
    expect(fs.files.size).toBe(0);
    expect(categories.offered).toHaveLength(0);
    expect(io.err.join("")).toContain("at least one");
  });

  test("install --target claude-code --dry-run writes nothing", async () => {
    const io = makeIo(["", ""]);
    const fs = memFs();
    const code = await runCli(
      [
        "install",
        "--target", "claude-code",
        "--command-path", "/abs/pii-remover",
        "--endpoint", "http://localhost:8000/redact",
        "--categories", "private_email,private_phone",
        "--dry-run",
      ],
      { ...io, installFs: fs, argv0: "/abs/pii-remover" }
    );
    expect(code).toBe(0);
    expect(fs.files.size).toBe(0);
    expect(io.out.join("")).toContain("UserPromptSubmit");
    expect(io.out.join("")).toContain("[dry-run]");
  });

  test("install --target claude-code writes settings + config", async () => {
    const io = makeIo(["", ""]);
    const fs = memFs();
    const code = await runCli(
      [
        "install",
        "--target", "claude-code",
        "--command-path", "/abs/pii-remover",
        "--endpoint", "http://localhost:8000/redact",
        "--categories", "private_email,private_phone,secret",
      ],
      { ...io, installFs: fs }
    );
    expect(code).toBe(0);
    expect(fs.files.size).toBeGreaterThanOrEqual(2);
    const out = io.out.join("");
    expect(out).toContain("hook");
  });

  test("install --auto-start writes backend.auto_start=true to claude-code loader-readable config", async () => {
    const io = makeIo();
    const fs = memFs();
    const code = await runCli(
      [
        "install",
        "--target", "claude-code",
        "--command-path", "/abs/pii-remover",
        "--endpoint", "http://localhost:8000/redact",
        "--categories", "private_email",
        "--auto-start",
        "--compose-file", "gpu",
        "--start-timeout-ms", "90000",
      ],
      { ...io, installFs: fs }
    );
    expect(code).toBe(0);
    const piiConfigEntry = Array.from(fs.files.entries()).find(([p]) =>
      p.includes("pii-remover") && (p.endsWith("config.json") || p.endsWith(".pii-remover.json"))
    );
    expect(piiConfigEntry).toBeDefined();
    expect(piiConfigEntry![0]).toMatch(/\.config[\\/]pii-remover[\\/]config\.json$/);
    const cfg = JSON.parse(piiConfigEntry![1]);
    expect(cfg.backend.auto_start).toBe(true);
    expect(cfg.backend.compose_file).toBe("gpu");
    expect(cfg.backend.start_timeout_ms).toBe(90000);
    expect(io.out.join("")).toContain("Backend auto-start: ENABLED");
  });

  test("install --idle-timeout 0 emits OPF_IDLE_TIMEOUT_SECONDS guidance (disabled)", async () => {
    const io = makeIo();
    const fs = memFs();
    const code = await runCli(
      [
        "install",
        "--target", "claude-code",
        "--command-path", "/abs/pii-remover",
        "--endpoint", "http://localhost:8000/redact",
        "--categories", "private_email",
        "--idle-timeout", "0",
      ],
      { ...io, installFs: fs }
    );
    expect(code).toBe(0);
    const out = io.out.join("");
    expect(out).toContain("OPF_IDLE_TIMEOUT_SECONDS=0");
    expect(out).toContain("0 = disabled");
  });

  test("install --target claude-code --idle-timeout 0 with forced failure emits guidance and exits 2", async () => {
    const io = makeIo();
    const fs = memFs();
    // Force install to fail by providing an invalid settings path that cannot be written
    const code = await runCli(
      [
        "install",
        "--target", "claude-code",
        "--command-path", "/abs/pii-remover",
        "--endpoint", "http://localhost:8000/redact",
        "--categories", "private_email",
        "--idle-timeout", "0",
      ],
      {
        ...io,
        installFs: {
          exists: () => false,
          readFile: async () => "{}",
          writeFile: async () => {
            throw new Error("write failed");
          },
          mkdir: async () => {
            throw new Error("mkdir failed");
          },
        },
      }
    );
    expect(code).toBe(2);
    const out = io.out.join("");
    // Failure is on stderr, but idle guidance should be on stdout
    expect(out).toContain("OPF_IDLE_TIMEOUT_SECONDS=0");
    expect(out).toContain("0 = disabled");
  });

  test("install --no-auto-start explicitly disables (writes auto_start:false)", async () => {
    const io = makeIo();
    const fs = memFs();
    const code = await runCli(
      [
        "install",
        "--target", "claude-code",
        "--command-path", "/abs/pii-remover",
        "--endpoint", "http://localhost:8000/redact",
        "--categories", "private_email",
        "--no-auto-start",
      ],
      { ...io, installFs: fs }
    );
    expect(code).toBe(0);
    const cfgEntry = Array.from(fs.files.entries()).find(([p]) =>
      p.endsWith("config.json") && p.includes("pii-remover")
    )!;
    expect(cfgEntry).toBeDefined();
    const cfg = JSON.parse(cfgEntry[1]);
    expect(cfg.backend.auto_start).toBe(false);
    expect(io.out.join("")).toContain("DISABLED");
  });

  test("install --auto-start --target opencode writes to ~/.config/opencode/pii-remover.json (loader-readable)", async () => {
    const io = makeIo();
    const fs = memFs();
    const code = await runCli(
      [
        "install",
        "--target", "opencode",
        "--auto-start",
      ],
      { ...io, installFs: fs }
    );
    expect(code).toBe(0);
    const cfgEntry = Array.from(fs.files.entries()).find(([p]) =>
      p.endsWith("pii-remover.json") && p.includes("opencode")
    );
    expect(cfgEntry).toBeDefined();
    expect(cfgEntry![0]).toMatch(/\.config[\\/]opencode[\\/]pii-remover\.json$/);
    const cfg = JSON.parse(cfgEntry![1]);
    expect(cfg.backend.auto_start).toBe(true);
  });
});

describe("runCli install — target checkbox flow", () => {
  test("no --target offers exactly the three targets in canonical order", async () => {
    const io = makeIo([""]);
    const targets = targetSelector(["opencode"]);
    const categories = categorySelector();
    const code = await runCli(["install", "--dry-run"], {
      ...io,
      installFs: memFs(),
      selectTargets: targets.fn,
      selectCategories: categories.fn,
    });
    expect(code).toBe(0);
    const [firstOffer] = targets.offered;
    expect(targets.offered).toHaveLength(1);
    expect(firstOffer?.map((c) => c.value)).toEqual([
      "claude-code",
      "opencode",
      "codex",
    ]);
  });

  test("explicit --target skips the target checkbox entirely", async () => {
    const io = makeIo();
    const targets = targetSelector(["codex"]);
    const code = await runCli(
      [
        "install",
        "--target", "claude-code",
        "--command-path", "/abs/pii-remover",
        "--endpoint", "http://localhost:8000/redact",
        "--categories", "private_email",
        "--dry-run",
      ],
      { ...io, installFs: memFs(), selectTargets: targets.fn }
    );
    expect(code).toBe(0);
    expect(targets.offered).toHaveLength(0);
    const out = io.out.join("");
    expect(out).not.toContain("=== ");
    expect(out).not.toContain("Summary:");
  });

  test("a scrambled selection installs in canonical claude-code -> opencode -> codex order", async () => {
    const io = makeIo([""]);
    const targets = targetSelector(["codex", "claude-code", "opencode"]);
    const categories = categorySelector();
    const code = await runCli(
      ["install", "--command-path", "/abs/pii-remover", "--dry-run"],
      {
        ...io,
        installFs: memFs(),
        argv0: "/abs/pii-remover",
        selectTargets: targets.fn,
        selectCategories: categories.fn,
      }
    );
    expect(code).toBe(0);
    const out = io.out.join("");
    expect(out.indexOf("=== claude-code ===")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("=== claude-code ===")).toBeLessThan(
      out.indexOf("=== opencode ===")
    );
    expect(out.indexOf("=== opencode ===")).toBeLessThan(
      out.indexOf("=== codex ===")
    );
    expect(out).toContain("Summary:");
  });

  test("PII config is resolved once for the whole selection", async () => {
    const io = makeIo(["http://backend:9000/redact"]);
    const targets = targetSelector(["claude-code", "opencode", "codex"]);
    const categories = categorySelector(["private_email", "secret"]);
    const code = await runCli(
      ["install", "--command-path", "/abs/pii-remover", "--dry-run"],
      {
        ...io,
        installFs: memFs(),
        selectTargets: targets.fn,
        selectCategories: categories.fn,
      }
    );
    expect(code).toBe(0);
    expect(categories.offered).toHaveLength(1);
    expect(io.prompts.filter((q) => q.includes("endpoint"))).toHaveLength(1);
  });

  test("--proxy-url derives the per-target route from one normalized root", async () => {
    const io = makeIo();
    const fs = memFs();
    const code = await runCli(
      [
        "install",
        "--command-path", "/abs/pii-remover",
        "--endpoint", "http://localhost:8000/redact",
        "--categories", "private_email",
        "--proxy-url", "https://gw.corp/pii/anthropic/v1",
      ],
      {
        ...io,
        installFs: fs,
        argv0: "/abs/pii-remover",
        selectTargets: targetSelector(["claude-code", "opencode", "codex"]).fn,
      }
    );
    expect(code).toBe(0);

    const claude = writtenJson<ClaudeSettings>(fs, (p) =>
      p.endsWith("settings.json")
    );
    expect(claude.env?.ANTHROPIC_BASE_URL).toBe("https://gw.corp/pii/anthropic/v1");

    const opencode = writtenJson<OpenCodeConfig>(
      fs,
      (p) => p === OPENCODE_GLOBAL_CONFIG
    );
    expect(opencode.provider?.anthropic?.options?.baseURL).toBe(
      "https://gw.corp/pii/anthropic/v1"
    );
    expect(opencode.provider?.openai?.options?.baseURL).toBe(
      "https://gw.corp/pii/openai/v1"
    );

    const codexToml = writtenFile(fs, (p) => p.endsWith("config.toml"));
    expect(codexToml).toContain('openai_base_url = "https://gw.corp/pii/codex/v1"');
  });

  test("--proxy derives every route from the default local root", async () => {
    const io = makeIo();
    const fs = memFs();
    const code = await runCli(
      [
        "install",
        "--command-path", "/abs/pii-remover",
        "--endpoint", "http://localhost:8000/redact",
        "--categories", "private_email",
        "--proxy",
      ],
      {
        ...io,
        installFs: fs,
        argv0: "/abs/pii-remover",
        selectTargets: targetSelector(["claude-code", "opencode", "codex"]).fn,
      }
    );
    expect(code).toBe(0);
    const opencode = writtenJson<OpenCodeConfig>(
      fs,
      (p) => p === OPENCODE_GLOBAL_CONFIG
    );
    expect(opencode.provider?.anthropic?.options?.baseURL).toBe(
      "http://localhost:8000/anthropic/v1"
    );
    expect(opencode.provider?.openai?.options?.baseURL).toBe(
      "http://localhost:8000/openai/v1"
    );
    const claude = writtenJson<ClaudeSettings>(fs, (p) =>
      p.endsWith("settings.json")
    );
    expect(claude.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:8000/anthropic/v1");
  });

  test("one failing target does not stop the rest; exit 2 with a per-target report", async () => {
    const io = makeIo();
    const fs = memFs({ [OPENCODE_GLOBAL_CONFIG]: "{ this is not json" });
    const code = await runCli(
      [
        "install",
        "--command-path", "/abs/pii-remover",
        "--endpoint", "http://localhost:8000/redact",
        "--categories", "private_email",
        "--dry-run",
      ],
      {
        ...io,
        installFs: fs,
        argv0: "/abs/pii-remover",
        selectTargets: targetSelector(["claude-code", "opencode", "codex"]).fn,
      }
    );
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("[opencode]");
    const out = io.out.join("");
    expect(out).toContain("=== claude-code ===");
    expect(out).toContain("=== codex ===");
    expect(out).toMatch(/Summary:[\s\S]*opencode\s+FAILED/);
  });

  test("--proxy-only without opencode -> 64 before config prompts or writes", async () => {
    const io = makeIo();
    const fs = memFs();
    const categories = categorySelector();
    const code = await runCli(["install", "--proxy-only"], {
      ...io,
      installFs: fs,
      selectTargets: targetSelector(["claude-code", "codex"]).fn,
      selectCategories: categories.fn,
    });
    expect(code).toBe(64);
    expect(fs.files.size).toBe(0);
    expect(categories.offered).toHaveLength(0);
    expect(io.prompts).toHaveLength(0);
    expect(io.err.join("")).toContain("--proxy-only");
  });

  test("--proxy-only with explicit non-opencode --target -> 64", async () => {
    const io = makeIo();
    const fs = memFs();
    const code = await runCli(
      ["install", "--target", "claude-code", "--proxy-only"],
      { ...io, installFs: fs }
    );
    expect(code).toBe(64);
    expect(fs.files.size).toBe(0);
  });

  test("a lone target reports its failure on stderr only, unprefixed", async () => {
    const io = makeIo();
    const fs = memFs({ [OPENCODE_GLOBAL_CONFIG]: "{ this is not json" });
    const code = await runCli(
      [
        "install",
        "--target", "opencode",
        "--endpoint", "http://localhost:8000/redact",
        "--categories", "private_email",
        "--dry-run",
      ],
      { ...io, installFs: fs }
    );
    expect(code).toBe(2);
    expect(io.out.join("")).toBe("");
    expect(io.err.join("")).toContain("install failed: Cannot parse");
    expect(io.err.join("")).not.toContain("[opencode]");
  });

  test("opencode reports each provider's proxy outcome independently", async () => {
    const io = makeIo();
    const fs = memFs({
      [OPENCODE_GLOBAL_CONFIG]: JSON.stringify({
        provider: { openai: { options: { baseURL: "https://corp.gateway/v1" } } },
      }),
    });
    const code = await runCli(
      [
        "install",
        "--target", "opencode",
        "--endpoint", "http://localhost:8000/redact",
        "--categories", "private_email",
        "--proxy",
        "--dry-run",
      ],
      { ...io, installFs: fs }
    );
    expect(code).toBe(0);
    const out = io.out.join("");
    expect(out).toContain(
      "Proxy mode (anthropic): ENABLED -> http://localhost:8000/anthropic/v1"
    );
    expect(out).toContain("Proxy mode (openai): NOT APPLIED");
  });

  test("--proxy-only applies to opencode only, leaving co-selected targets installed", async () => {
    const io = makeIo();
    const fs = memFs();
    const code = await runCli(
      [
        "install",
        "--command-path", "/abs/pii-remover",
        "--endpoint", "http://localhost:8000/redact",
        "--categories", "private_email",
        "--proxy-only",
      ],
      {
        ...io,
        installFs: fs,
        argv0: "/abs/pii-remover",
        selectTargets: targetSelector(["opencode", "claude-code"]).fn,
      }
    );
    expect(code).toBe(0);
    const opencode = writtenJson<OpenCodeConfig>(
      fs,
      (p) => p === OPENCODE_GLOBAL_CONFIG
    );
    expect(opencode.plugin ?? []).toEqual([]);
    const claude = writtenJson<ClaudeSettings>(fs, (p) =>
      p.endsWith("settings.json")
    );
    expect(JSON.stringify(claude.hooks)).toContain("UserPromptSubmit");
    expect(claude.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:8000/anthropic/v1");
  });
});

describe("runCli — help text mentions new lifecycle flags", () => {
  test("--auto-start / --compose-file / --idle-timeout documented", async () => {
    const io = makeIo();
    await runCli(["help"], io);
    const txt = io.out.join("");
    expect(txt).toContain("--auto-start");
    expect(txt).toContain("--compose-file");
    expect(txt).toContain("--idle-timeout");
  });

  test("detect --text masks", async () => {
    const io = makeIo();
    const code = await runCli(
      ["detect", "--text", "Hello user@example.com"],
      {
        ...io,
        initPiiRemover: (opts) => PIIRemover.init({ ...(opts ?? {}), config: localOnlyConfig() }),
      }
    );
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("{{OPF:EMAIL:");
  });

  test("detect missing --text -> 64", async () => {
    const io = makeIo();
    const code = await runCli(["detect"], io);
    expect(code).toBe(64);
    expect(io.err.join("")).toContain("--text");
  });

  test("hook routes to runHookCommand (no PII -> exit 0)", async () => {
    const io = makeIo();
    const stdinJson = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "s",
      transcript_path: "",
      cwd: "",
      permission_mode: "default",
      prompt: "no pii at all",
    });
    const code = await runCli(["hook"], {
      ...io,
      stdin: () => Promise.resolve(stdinJson),
      env: {},
      initPiiRemover: (opts) => PIIRemover.init({ ...(opts ?? {}), config: localOnlyConfig() }),
      ...hookStubs(),
    });
    expect(code).toBe(0);
    expect(io.out.join("")).toBe("");
  });

  test("hook with PII without proxy -> exit 0 + decision:block", async () => {
    const io = makeIo();
    const stdinJson = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "s",
      transcript_path: "",
      cwd: "",
      permission_mode: "default",
      prompt: "user@example.com",
    });
    const code = await runCli(["hook"], {
      ...io,
      stdin: () => Promise.resolve(stdinJson),
      env: {},
      initPiiRemover: (opts) => PIIRemover.init({ ...(opts ?? {}), config: localOnlyConfig() }),
      ...hookStubs(),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out.join("").trim());
    expect(parsed.decision).toBe("block");
  });

  test("health uses provided fetchFn and --url", async () => {
    const io = makeIo();
    const code = await runCli(
      ["health", "--url", "http://127.0.0.1:9999"],
      {
        ...io,
        fetchFn: async () =>
          new Response("{\"ok\":true}", { status: 200 }),
      }
    );
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("\"ok\":true");
  });

  test("helpText snapshot includes default port", () => {
    expect(helpText()).toContain("8000");
  });
});
