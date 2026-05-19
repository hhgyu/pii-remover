import { describe, expect, test } from "bun:test";
import { PIIRemover } from "@pii-remover/core";

import { runHookCommand } from "../src/commands/hook.js";

function ioFromStdin(payload: object, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdin: () => Promise.resolve(JSON.stringify(payload)),
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    env,
    out,
    err,
    initPiiRemover: (opts: Parameters<typeof PIIRemover.init>[0]) =>
      PIIRemover.init(opts ?? {}),
  };
}

describe("runHookCommand", () => {
  test("no PII -> empty stdout, exit 0, allow_silent", async () => {
    const io = ioFromStdin({
      hook_event_name: "UserPromptSubmit",
      session_id: "s",
      transcript_path: "",
      cwd: "",
      permission_mode: "default",
      prompt: "Just a normal sentence about nothing in particular.",
    });
    const r = await runHookCommand(io);
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe("allow_silent");
    expect(r.detection_count).toBe(0);
    expect(io.out.join("")).toBe("");
  });

  test("PII without proxy -> decision:block with reason listing tokens", async () => {
    const io = ioFromStdin(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s",
        transcript_path: "",
        cwd: "",
        permission_mode: "default",
        prompt: "Contact me at user@example.com or 010-1234-5678.",
      },
      {}
    );
    const r = await runHookCommand(io);
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe("block");
    expect(r.proxy_configured).toBe(false);
    expect(r.detection_count).toBeGreaterThanOrEqual(2);
    const stdout = io.out.join("");
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("__OPF_");
    expect(parsed.reason).toContain("ANTHROPIC_BASE_URL");
  });

  test("PII with proxy -> additionalContext, exit 0", async () => {
    const io = ioFromStdin(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s",
        transcript_path: "",
        cwd: "",
        permission_mode: "default",
        prompt: "Contact me at user@example.com.",
      },
      { ANTHROPIC_BASE_URL: "http://localhost:8765/anthropic/v1" }
    );
    const r = await runHookCommand(io);
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe("allow_warn");
    expect(r.proxy_configured).toBe(true);
    const parsed = JSON.parse(io.out.join("").trim());
    expect(parsed.hookSpecificOutput.additionalContext).toContain("__OPF_EMAIL_");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("pii-remover");
  });

  test("invalid stdin JSON -> exit 2, block_error", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const r = await runHookCommand({
      stdin: () => Promise.resolve("{not json"),
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: {},
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe("block_error");
    expect(err.join("")).toContain("not valid JSON");
    expect(out.join("")).toContain("\"decision\":\"block\"");
  });

  test("missing hook_event_name -> exit 2", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const r = await runHookCommand({
      stdin: () =>
        Promise.resolve(JSON.stringify({ prompt: "hi", whatever: 1 })),
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: {},
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe("block_error");
  });

  test("stdin read failure -> exit 2", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const r = await runHookCommand({
      stdin: () => Promise.reject(new Error("pipe broken")),
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: {},
    });
    expect(r.exitCode).toBe(2);
    expect(err.join("")).toContain("pipe broken");
  });

  test("PIIRemover init failure is fail-closed (block_error)", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const r = await runHookCommand({
      stdin: () =>
        Promise.resolve(
          JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            session_id: "s",
            transcript_path: "",
            cwd: "",
            permission_mode: "default",
            prompt: "user@example.com",
          })
        ),
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: {},
      initPiiRemover: async () => {
        throw new Error("synthetic init failure");
      },
    });
    expect(r.exitCode).toBe(2);
    expect(r.decision).toBe("block_error");
    expect(out.join("")).toContain("synthetic init failure");
  });

  test("PII_REMOVER_BYPASS=1 yields no detections -> allow_silent", async () => {
    const io = ioFromStdin(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s",
        transcript_path: "",
        cwd: "",
        permission_mode: "default",
        prompt: "Contact me at user@example.com.",
      },
      { PII_REMOVER_BYPASS: "1" }
    );
    const r = await runHookCommand(io);
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe("allow_silent");
    expect(r.detection_count).toBe(0);
  });

  test("PII_REMOVER_PROXY_TRUST=1 with PII -> additionalContext", async () => {
    const io = ioFromStdin(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "s",
        transcript_path: "",
        cwd: "",
        permission_mode: "default",
        prompt: "Hello user@example.com.",
      },
      { PII_REMOVER_PROXY_TRUST: "1" }
    );
    const r = await runHookCommand(io);
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe("allow_warn");
    expect(r.proxy_configured).toBe(true);
  });
});
