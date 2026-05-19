import { describe, expect, test } from "bun:test";

import {
  HookProtocolError,
  parseHookInput,
  serializeOutput,
} from "../src/protocol/user-prompt-submit.js";
import { detectProxy } from "../src/protocol/proxy-detection.js";

describe("parseHookInput", () => {
  test("happy path with full payload", () => {
    const input = parseHookInput(
      JSON.stringify({
        session_id: "s1",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/home/user",
        permission_mode: "default",
        hook_event_name: "UserPromptSubmit",
        prompt: "hi user@example.com",
      })
    );
    expect(input.prompt).toBe("hi user@example.com");
    expect(input.session_id).toBe("s1");
    expect(input.hook_event_name).toBe("UserPromptSubmit");
  });

  test("defaults missing optional fields", () => {
    const input = parseHookInput(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "hi",
      })
    );
    expect(input.session_id).toBe("");
    expect(input.transcript_path).toBe("");
    expect(input.cwd).toBe("");
    expect(input.permission_mode).toBe("default");
  });

  test("rejects non-JSON", () => {
    expect(() => parseHookInput("{not json")).toThrow(HookProtocolError);
  });

  test("rejects array stdin", () => {
    expect(() => parseHookInput("[]")).toThrow(HookProtocolError);
  });

  test("rejects null stdin", () => {
    expect(() => parseHookInput("null")).toThrow(HookProtocolError);
  });

  test("rejects wrong event name", () => {
    expect(() =>
      parseHookInput(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          prompt: "hi",
        })
      )
    ).toThrow(/UserPromptSubmit/);
  });

  test("rejects missing prompt", () => {
    expect(() =>
      parseHookInput(
        JSON.stringify({ hook_event_name: "UserPromptSubmit" })
      )
    ).toThrow(/prompt/);
  });

  test("rejects non-string prompt", () => {
    expect(() =>
      parseHookInput(
        JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: 42 })
      )
    ).toThrow(/prompt/);
  });
});

describe("serializeOutput", () => {
  test("block decision serialises to single line + newline", () => {
    const s = serializeOutput({
      decision: "block",
      reason: "test reason",
    });
    expect(s.endsWith("\n")).toBe(true);
    expect(JSON.parse(s.trim())).toEqual({
      decision: "block",
      reason: "test reason",
    });
  });

  test("hookSpecificOutput.additionalContext round-trips", () => {
    const s = serializeOutput({
      hookSpecificOutput: { additionalContext: "context" },
    });
    expect(JSON.parse(s.trim())).toEqual({
      hookSpecificOutput: { additionalContext: "context" },
    });
  });
});

describe("detectProxy", () => {
  test("not configured when ANTHROPIC_BASE_URL is missing", () => {
    const r = detectProxy({});
    expect(r.configured).toBe(false);
    expect(r.reason).toContain("not set");
  });

  test("configured with localhost + /anthropic/ prefix", () => {
    const r = detectProxy({
      ANTHROPIC_BASE_URL: "http://localhost:8765/anthropic/v1",
    });
    expect(r.configured).toBe(true);
    expect(r.reason).toContain("/anthropic/");
  });

  test("configured with 127.0.0.1 + /anthropic/", () => {
    const r = detectProxy({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9000/anthropic/v1",
    });
    expect(r.configured).toBe(true);
  });

  test("configured-but-warned with localhost without /anthropic/ prefix", () => {
    const r = detectProxy({
      ANTHROPIC_BASE_URL: "http://localhost:8765/v1",
    });
    expect(r.configured).toBe(true);
    expect(r.reason).toMatch(/missing \/anthropic\//);
  });

  test("refuses non-localhost upstream even with /anthropic/ path", () => {
    const r = detectProxy({
      ANTHROPIC_BASE_URL: "https://example.com/anthropic/v1",
    });
    expect(r.configured).toBe(false);
    expect(r.reason).toContain("refusing to trust");
  });

  test("opt-in PII_REMOVER_PROXY_TRUST=1 forces configured", () => {
    const r = detectProxy({
      PII_REMOVER_PROXY_TRUST: "1",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    });
    expect(r.configured).toBe(true);
    expect(r.reason).toContain("opt-in");
  });

  test("non-localhost without /anthropic/ remains unconfigured", () => {
    const r = detectProxy({
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    });
    expect(r.configured).toBe(false);
  });

  test("malformed URL is treated as unconfigured", () => {
    const r = detectProxy({ ANTHROPIC_BASE_URL: "not a url" });
    expect(r.configured).toBe(false);
    expect(r.reason).toMatch(/not a valid URL/);
  });
});
