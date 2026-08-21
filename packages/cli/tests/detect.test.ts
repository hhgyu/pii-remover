import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  PIIRemover,
  type PiiRemoverConfig,
} from "@pii-remover/core";

function localOnlyConfig(): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
  };
}

import { runDetectCommand } from "../src/commands/detect.js";

describe("runDetectCommand", () => {
  test("masks email and prints tokens", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const r = await runDetectCommand({
      text: "Email me at user@example.com please.",
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: {},
      initPiiRemover: (opts) => PIIRemover.init({ ...(opts ?? {}), config: localOnlyConfig() }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.detections).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(out.join("").trim());
    expect(parsed.masked).toContain("{{OPF:EMAIL:");
    expect(parsed.tokens[0].category).toBe("private_email");
    expect(parsed.tokens[0].original).toBe("user@example.com");
    expect(typeof parsed.latency_ms).toBe("number");
  });

  test("no PII -> tokens=[] but still exit 0", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const r = await runDetectCommand({
      text: "Nothing sensitive here at all.",
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: {},
      initPiiRemover: (opts) => PIIRemover.init({ ...(opts ?? {}), config: localOnlyConfig() }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.detections).toBe(0);
    const parsed = JSON.parse(out.join("").trim());
    expect(parsed.tokens).toEqual([]);
  });

  test("init failure -> exit 2", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const r = await runDetectCommand({
      text: "anything",
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: {},
      initPiiRemover: async () => {
        throw new Error("init exploded");
      },
    });
    expect(r.exitCode).toBe(2);
    expect(err.join("")).toContain("init exploded");
  });
});
