import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DISPLAY_TOOL_NAMES,
  DEFAULT_DISPLAY_TOOL_SUFFIXES,
  isDisplayTool,
  resolveDisplayToolConfig,
} from "../src/display-tools.js";

describe("DEFAULT_DISPLAY_TOOL_NAMES / SUFFIXES — built-in display tools", () => {
  test("default name set contains `question` and `todowrite`", () => {
    expect(DEFAULT_DISPLAY_TOOL_NAMES.has("question")).toBe(true);
    expect(DEFAULT_DISPLAY_TOOL_NAMES.has("todowrite")).toBe(true);
    expect(DEFAULT_DISPLAY_TOOL_NAMES.has("write")).toBe(false);
    expect(DEFAULT_DISPLAY_TOOL_NAMES.has("read")).toBe(false);
  });

  test("default suffixes contain delimited `_question` and `_todowrite`", () => {
    expect(DEFAULT_DISPLAY_TOOL_SUFFIXES).toContain("_question");
    expect(DEFAULT_DISPLAY_TOOL_SUFFIXES).toContain("_todowrite");
    expect(DEFAULT_DISPLAY_TOOL_SUFFIXES).not.toContain("question");
    expect(DEFAULT_DISPLAY_TOOL_SUFFIXES).not.toContain("todowrite");
  });
});

describe("isDisplayTool — exact match (case-insensitive)", () => {
  test("OpenCode built-in `question` matches", () => {
    expect(isDisplayTool("question")).toBe(true);
  });

  test("uppercase `Question` matches (case-insensitive)", () => {
    expect(isDisplayTool("Question")).toBe(true);
    expect(isDisplayTool("QUESTION")).toBe(true);
  });

  test("OpenCode built-in `todowrite` matches (case-insensitive)", () => {
    expect(isDisplayTool("todowrite")).toBe(true);
    expect(isDisplayTool("TodoWrite")).toBe(true);
    expect(isDisplayTool("TODOWRITE")).toBe(true);
  });

  test("non-display tools never match", () => {
    expect(isDisplayTool("write")).toBe(false);
    expect(isDisplayTool("read")).toBe(false);
    expect(isDisplayTool("bash")).toBe(false);
    expect(isDisplayTool("task")).toBe(false);
    expect(isDisplayTool("edit")).toBe(false);
  });
});

describe("isDisplayTool — MCP suffix match", () => {
  test("`omo_question` matches (MCP suffix)", () => {
    expect(isDisplayTool("omo_question")).toBe(true);
  });

  test("`server_Question` matches (case-insensitive suffix)", () => {
    expect(isDisplayTool("server_Question")).toBe(true);
  });

  test("`my-mcp_question` matches (suffix with hyphen prefix)", () => {
    expect(isDisplayTool("my-mcp_question")).toBe(true);
  });

  test("`questionnaire` does NOT match (no delimiter — substring-only)", () => {
    expect(isDisplayTool("questionnaire")).toBe(false);
  });

  test("`questionnaire_builder` does NOT match (suffix is `_builder`, not `_question`)", () => {
    expect(isDisplayTool("questionnaire_builder")).toBe(false);
  });

  test("`question_followup` does NOT match (suffix is `_followup`, not `_question`)", () => {
    expect(isDisplayTool("question_followup")).toBe(false);
  });

  test("empty string does not match", () => {
    expect(isDisplayTool("")).toBe(false);
  });
});

describe("isDisplayTool — config overrides", () => {
  test("`extraNames` adds to defaults", () => {
    const cfg = { extraNames: ["todowrite"] };
    expect(isDisplayTool("question", cfg)).toBe(true);
    expect(isDisplayTool("todowrite", cfg)).toBe(true);
    expect(isDisplayTool("TODOWRITE", cfg)).toBe(true);
  });

  test("`extraSuffixes` adds to defaults", () => {
    const cfg = { extraSuffixes: ["_todowrite"] };
    expect(isDisplayTool("omo_todowrite", cfg)).toBe(true);
    expect(isDisplayTool("omo_question", cfg)).toBe(true);
  });

  test("`names` (without `extra`) REPLACES the default name set", () => {
    const cfg = { names: new Set(["confirm"]) };
    expect(isDisplayTool("question", cfg)).toBe(false);
    expect(isDisplayTool("confirm", cfg)).toBe(true);
  });

  test("`suffixes` (without `extra`) REPLACES the default suffix list", () => {
    const cfg = { suffixes: ["_confirm"] };
    expect(isDisplayTool("omo_question", cfg)).toBe(false);
    expect(isDisplayTool("omo_confirm", cfg)).toBe(true);
  });

  test("`excludeNames` removes matches even if name set would match", () => {
    const cfg = {
      extraNames: ["confirm"],
      excludeNames: ["confirm"],
    };
    expect(isDisplayTool("confirm", cfg)).toBe(false);
    expect(isDisplayTool("question", cfg)).toBe(true);
  });

  test("`excludeNames` removes matches even via suffix path", () => {
    const cfg = { excludeNames: ["omo_question"] };
    expect(isDisplayTool("omo_question", cfg)).toBe(false);
    expect(isDisplayTool("other_question", cfg)).toBe(true);
  });
});

describe("resolveDisplayToolConfig — lower-cases everything", () => {
  test("default returns lower-case name set", () => {
    const r = resolveDisplayToolConfig();
    expect(r.names.has("question")).toBe(true);
    expect(r.names.has("Question")).toBe(false);
  });

  test("upper-case input names are lower-cased", () => {
    const r = resolveDisplayToolConfig({ extraNames: ["CONFIRM", "Decide"] });
    expect(r.names.has("confirm")).toBe(true);
    expect(r.names.has("decide")).toBe(true);
    expect(r.names.has("CONFIRM")).toBe(false);
  });

  test("upper-case suffix entries are lower-cased", () => {
    const r = resolveDisplayToolConfig({ extraSuffixes: ["_Confirm"] });
    expect(r.suffixes).toContain("_confirm");
    expect(r.suffixes).not.toContain("_Confirm");
  });
});

describe("isDisplayTool — non-string input safety", () => {
  test("non-string input returns false (defensive)", () => {
    expect(isDisplayTool(undefined as unknown as string)).toBe(false);
    expect(isDisplayTool(null as unknown as string)).toBe(false);
    expect(isDisplayTool(42 as unknown as string)).toBe(false);
  });
});
