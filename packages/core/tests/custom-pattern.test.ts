import { describe, expect, test } from "bun:test";
import { CustomPatternBackend } from "../src/backend/custom-pattern.js";
import { PIIRemover } from "../src/pii-remover.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import type {
  CustomPatternConfig,
  PiiRemoverConfig,
} from "../src/config/schema.js";

const opts = { request_id: "test" };

describe("CustomPatternBackend", () => {
  test("detects a configured pattern with its category", async () => {
    const b = new CustomPatternBackend([
      { name: "emp_id", pattern: "EMP-\\d{6}", category: "account_number" },
    ]);
    const r = await b.detect("ticket from EMP-123456 here", opts);
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.category).toBe("account_number");
    expect(r.detections[0]!.text).toBe("EMP-123456");
    expect(r.detections[0]!.start).toBe(12);
  });

  test("applies the configured confidence, defaulting to 0.9", async () => {
    const b = new CustomPatternBackend([
      { name: "a", pattern: "AAA", category: "secret", confidence: 0.42 },
      { name: "b", pattern: "BBB", category: "secret" },
    ]);
    const r = await b.detect("AAA BBB", opts);
    const byText = new Map(r.detections.map((d) => [d.text, d.confidence]));
    expect(byText.get("AAA")).toBe(0.42);
    expect(byText.get("BBB")).toBe(0.9);
  });

  test("honors extra flags while forcing the global flag on", async () => {
    const b = new CustomPatternBackend([
      { name: "ci", pattern: "secret", flags: "i", category: "secret" },
    ]);
    const r = await b.detect("SECRET secret SeCrEt", opts);
    expect(r.detections).toHaveLength(3);
  });

  test("skips patterns with enabled: false", () => {
    const b = new CustomPatternBackend([
      { name: "off", pattern: "X", category: "secret", enabled: false },
    ]);
    expect(b.size()).toBe(0);
  });

  test("throws on an invalid regex (fail-closed)", () => {
    expect(
      () =>
        new CustomPatternBackend([
          { name: "bad", pattern: "(", category: "secret" },
        ]),
    ).toThrow(/invalid regex/);
  });

  test("throws on an unknown category (fail-closed)", () => {
    expect(
      () =>
        new CustomPatternBackend([
          {
            name: "bad",
            pattern: "X",
            category: "not_a_category" as CustomPatternConfig["category"],
          },
        ]),
    ).toThrow(/not a known PIICategory/);
  });

  test("throws on out-of-range confidence (fail-closed)", () => {
    expect(
      () =>
        new CustomPatternBackend([
          { name: "bad", pattern: "X", category: "secret", confidence: 1.5 },
        ]),
    ).toThrow(/confidence must be within/);
  });
});

describe("PIIRemover with custom_patterns", () => {
  function config(patterns: readonly CustomPatternConfig[]): PiiRemoverConfig {
    return {
      ...DEFAULT_CONFIG,
      backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
      detection: { ...DEFAULT_CONFIG.detection, custom_patterns: patterns },
    };
  }

  test("masks text matched by a config-driven custom pattern", async () => {
    const remover = await PIIRemover.init({
      config: config([
        { name: "emp", pattern: "EMP-\\d{6}", category: "account_number" },
      ]),
      env: {},
    });
    const result = await remover.mask("see EMP-987654 in the log");
    expect(result.text).not.toContain("EMP-987654");
    expect(result.text).toMatch(/__OPF_ACCOUNT__[a-z0-9]{16}__/);
    remover.dispose();
  });
});
