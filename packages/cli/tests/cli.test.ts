import { describe, expect, test } from "bun:test";
import { PIIRemover } from "@pii-remover/core";

import { helpText, parseFlags, runCli } from "../src/cli.js";
import type { InstallFs } from "../src/commands/install.js";

function makeIo(promptAnswers: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  let promptIdx = 0;
  return {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    prompt: async (_q: string) => promptAnswers[promptIdx++] ?? "",
    out,
    err,
  };
}

function memFs(): InstallFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
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

describe("parseFlags", () => {
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

  test("install without --target -> 64", async () => {
    const io = makeIo();
    const code = await runCli(["install"], { ...io, installFs: memFs() });
    expect(code).toBe(64);
    expect(io.err.join("")).toContain("--target");
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
        initPiiRemover: (opts) => PIIRemover.init(opts ?? {}),
      }
    );
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("__OPF_EMAIL_");
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
      initPiiRemover: (opts) => PIIRemover.init(opts ?? {}),
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
      initPiiRemover: (opts) => PIIRemover.init(opts ?? {}),
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
    expect(helpText()).toContain("8765");
  });
});
