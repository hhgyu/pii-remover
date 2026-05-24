import { describe, expect, test } from "bun:test";
import { Restorer, scanTokens, isInsidePath } from "../src/restorer/index.js";
import type { TokenMatch } from "../src/restorer/index.js";
import { VaultManager } from "../src/vault/manager.js";
import type { Detection, PIICategory } from "../src/types.js";

function det(
  start: number,
  end: number,
  category: PIICategory,
  text: string
): Detection {
  return { start, end, category, confidence: 0.95, text };
}

interface Seed {
  category: PIICategory;
  text: string;
}

function makeVault(sessionId: string, seeds: Seed[]): VaultManager {
  const v = new VaultManager();
  if (seeds.length === 0) {
    v.getOrCreate(sessionId);
    return v;
  }
  const detections: Detection[] = seeds.map((s, i) => {
    const start = i * 1000;
    return det(start, start + s.text.length, s.category, s.text);
  });
  v.assign(sessionId, detections);
  return v;
}

describe("scanTokens — strict + lenient detection (ADR-0002, ADR-0004)", () => {
  test("empty string returns no matches", () => {
    expect(scanTokens("")).toEqual([]);
  });

  test("text without tokens returns no matches", () => {
    expect(scanTokens("just a sentence with no PII tokens")).toEqual([]);
  });

  test("canonical token is a strict match", () => {
    const out = scanTokens("see __OPF_PERSON_1__ here");
    expect(out).toHaveLength(1);
    expect(out[0]!.matchType).toBe("strict");
    expect(out[0]!.token).toBe("__OPF_PERSON_1__");
    expect(out[0]!.normalizedToken).toBe("__OPF_PERSON_1__");
    expect(out[0]!.category).toBe("PERSON");
    expect(out[0]!.index).toBe(1);
  });

  test("lowercased token is a lenient match", () => {
    const out = scanTokens("see __opf_person_1__ here");
    expect(out).toHaveLength(1);
    expect(out[0]!.matchType).toBe("lenient");
    expect(out[0]!.token).toBe("__opf_person_1__");
    expect(out[0]!.normalizedToken).toBe("__OPF_PERSON_1__");
    expect(out[0]!.category).toBe("PERSON");
  });

  test("suffix-missing token is a lenient match", () => {
    const out = scanTokens("trailing __OPF_PERSON_1 cut off");
    expect(out).toHaveLength(1);
    expect(out[0]!.matchType).toBe("lenient");
    expect(out[0]!.token).toBe("__OPF_PERSON_1");
    expect(out[0]!.normalizedToken).toBe("__OPF_PERSON_1__");
  });

  test("suffix-missing + lowercased token is a lenient match", () => {
    const out = scanTokens("trailing __opf_person_1 cut off");
    expect(out).toHaveLength(1);
    expect(out[0]!.matchType).toBe("lenient");
    expect(out[0]!.normalizedToken).toBe("__OPF_PERSON_1__");
  });

  test("strict and lenient share the same span without double-counting", () => {
    const out = scanTokens("__OPF_EMAIL_1__");
    expect(out).toHaveLength(1);
    expect(out[0]!.matchType).toBe("strict");
  });

  test("non-OPF-prefixed text never matches", () => {
    expect(scanTokens("Person_1 and EMAIL_1 are normal words")).toEqual([]);
  });

  test("token adjacent to a word still matches strictly (no \\b in strict regex)", () => {
    const out = scanTokens("__OPF_EMAIL_1__please respond");
    expect(out).toHaveLength(1);
    expect(out[0]!.matchType).toBe("strict");
    expect(out[0]!.token).toBe("__OPF_EMAIL_1__");
  });

  test("two consecutive tokens both match strictly", () => {
    const out = scanTokens("__OPF_EMAIL_1__ and __OPF_EMAIL_2__");
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.matchType === "strict")).toBe(true);
    expect(out[0]!.index).toBe(1);
    expect(out[1]!.index).toBe(2);
  });

  test("matches are sorted by start position", () => {
    const out = scanTokens("see __OPF_PHONE_5__ then __opf_email_1");
    expect(out).toHaveLength(2);
    expect(out[0]!.start).toBeLessThan(out[1]!.start);
    expect(out[0]!.matchType).toBe("strict");
    expect(out[1]!.matchType).toBe("lenient");
  });

  test("multi-underscore categories like BIZ_NUM parse correctly", () => {
    const out = scanTokens("__OPF_BIZ_NUM_3__");
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe("BIZ_NUM");
    expect(out[0]!.index).toBe(3);
    expect(out[0]!.normalizedToken).toBe("__OPF_BIZ_NUM_3__");
  });
});

describe("Restorer.restore — happy path", () => {
  test("empty string is returned unchanged", () => {
    const v = makeVault("s1", []);
    const r = new Restorer(v);
    expect(r.restore("", "s1")).toEqual({
      text: "",
      matches: [],
      restoredCount: 0,
      partialMatchCount: 0,
      unknownTokenCount: 0,
      pathSkipCount: 0,
    });
  });

  test("text without tokens is returned unchanged", () => {
    const v = makeVault("s1", []);
    const r = new Restorer(v);
    const out = r.restore("just a sentence", "s1");
    expect(out.text).toBe("just a sentence");
    expect(out.restoredCount).toBe(0);
    expect(out.partialMatchCount).toBe(0);
    expect(out.unknownTokenCount).toBe(0);
  });

  test("strict token resolves and is replaced with the original", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("see __OPF_EMAIL_1__ today", "s1");
    expect(out.text).toBe("see alice@example.com today");
    expect(out.restoredCount).toBe(1);
    expect(out.partialMatchCount).toBe(0);
    expect(out.unknownTokenCount).toBe(0);
  });

  test("token-only text (no surrounding chars) is restored", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Alice" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("__OPF_PERSON_1__", "s1");
    expect(out.text).toBe("Alice");
    expect(out.restoredCount).toBe(1);
  });

  test("multiple tokens are restored right-to-left without offset drift", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
      { category: "private_url", text: "https://example.com/path?q=1" },
    ]);
    const r = new Restorer(v);
    const out = r.restore(
      "contact __OPF_EMAIL_1__ or visit __OPF_URL_1__",
      "s1"
    );
    expect(out.text).toBe(
      "contact alice@example.com or visit https://example.com/path?q=1"
    );
    expect(out.restoredCount).toBe(2);
  });

  test("right-to-left replacement is correct even when replacements have different lengths than tokens", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "X" },
      { category: "private_email", text: "very-long-email-address@example.com" },
    ]);
    const r = new Restorer(v);
    const out = r.restore(
      "__OPF_PERSON_1__ and __OPF_EMAIL_1__ done",
      "s1"
    );
    expect(out.text).toBe(
      "X and very-long-email-address@example.com done"
    );
  });
});

describe("Restorer.restore — LLM variation scenarios (ADR-0004)", () => {
  test("case-folded token still restores via lenient matcher", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("see __opf_email_1__ tomorrow", "s1");
    expect(out.text).toBe("see alice@example.com tomorrow");
    expect(out.restoredCount).toBe(1);
    expect(out.partialMatchCount).toBe(1);
    expect(out.unknownTokenCount).toBe(0);
  });

  test("suffix-missing token still restores via lenient matcher", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Alice" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("trailing __OPF_PERSON_1 cut off", "s1");
    expect(out.text).toBe("trailing Alice cut off");
    expect(out.restoredCount).toBe(1);
    expect(out.partialMatchCount).toBe(1);
  });

  test("case-folded + suffix-missing token still restores", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Alice" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("trailing __opf_person_1 cut off", "s1");
    expect(out.text).toBe("trailing Alice cut off");
    expect(out.restoredCount).toBe(1);
    expect(out.partialMatchCount).toBe(1);
  });

  test("hallucinated strict token preserves original + bumps unknownTokenCount", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("see __OPF_FAKE_99__ here", "s1");
    expect(out.text).toBe("see __OPF_FAKE_99__ here");
    expect(out.restoredCount).toBe(0);
    expect(out.partialMatchCount).toBe(0);
    expect(out.unknownTokenCount).toBe(1);
  });

  test("hallucinated lenient token preserves original + bumps both partial and unknown", () => {
    const v = makeVault("s1", []);
    const r = new Restorer(v);
    const out = r.restore("__opf_fake_42__ trailing", "s1");
    expect(out.text).toBe("__opf_fake_42__ trailing");
    expect(out.restoredCount).toBe(0);
    expect(out.partialMatchCount).toBe(1);
    expect(out.unknownTokenCount).toBe(1);
  });

  test("emits warning on hallucinated strict token", () => {
    const v = makeVault("s1", []);
    const warnings: string[] = [];
    const r = new Restorer(v, { warn: (m) => warnings.push(m) });
    r.restore("__OPF_FAKE_99__", "s1");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/hallucinated/);
  });

  test("emits warning on lenient match even when it resolves", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
    ]);
    const warnings: string[] = [];
    const r = new Restorer(v, { warn: (m) => warnings.push(m) });
    r.restore("see __opf_email_1__ tomorrow", "s1");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/lenient/);
    expect(warnings[0]).toMatch(/LLM transformation/);
  });

  test("warnings can be suppressed via warnOnPartial:false / warnOnUnknownToken:false", () => {
    const v = makeVault("s1", []);
    const warnings: string[] = [];
    const r = new Restorer(v, { warn: (m) => warnings.push(m) });
    r.restore("__OPF_FAKE_99__ __opf_fake_42__", "s1", {
      warnOnPartial: false,
      warnOnUnknownToken: false,
    });
    expect(warnings).toEqual([]);
  });

  test("custom unknownTokenHandler replaces strict misses with handler output", () => {
    const v = makeVault("s1", []);
    const r = new Restorer(v);
    const out = r.restore("see __OPF_FAKE_99__ here", "s1", {
      unknownTokenHandler: (tok) => `[unknown:${tok}]`,
      warnOnUnknownToken: false,
    });
    expect(out.text).toBe("see [unknown:__OPF_FAKE_99__] here");
    expect(out.unknownTokenCount).toBe(1);
  });

  test("custom partialMatchHandler replaces lenient misses with handler output", () => {
    const v = makeVault("s1", []);
    const r = new Restorer(v);
    const out = r.restore("see __opf_fake_42 here", "s1", {
      partialMatchHandler: (tok, match) =>
        `[partial:${tok}->${match.normalizedToken}]`,
      warnOnPartial: false,
    });
    expect(out.text).toBe(
      "see [partial:__opf_fake_42->__OPF_FAKE_42__] here"
    );
    expect(out.partialMatchCount).toBe(1);
    expect(out.unknownTokenCount).toBe(1);
  });

  test("lenient:false disables fallback matching", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("see __opf_email_1__ here", "s1", {
      lenient: false,
    });
    expect(out.text).toBe("see __opf_email_1__ here");
    expect(out.matches).toHaveLength(0);
    expect(out.restoredCount).toBe(0);
    expect(out.partialMatchCount).toBe(0);
  });
});

describe("Restorer.restore — edge cases", () => {
  test("matches array is sorted by start position even in result", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "a@b.c" },
      { category: "private_url", text: "https://x.y" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("__OPF_URL_1__ ... __OPF_EMAIL_1__", "s1");
    expect(out.matches.map((m) => m.normalizedToken)).toEqual([
      "__OPF_URL_1__",
      "__OPF_EMAIL_1__",
    ]);
    expect(out.matches[0]!.start).toBeLessThan(out.matches[1]!.start);
  });

  test("empty sessionId throws TypeError", () => {
    const v = makeVault("s1", []);
    const r = new Restorer(v);
    expect(() => r.restore("__OPF_PERSON_1__", "")).toThrow(TypeError);
  });

  test("unknown sessionId yields all-unknown counters without throwing", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Alice" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("__OPF_PERSON_1__", "never-existed");
    expect(out.text).toBe("__OPF_PERSON_1__");
    expect(out.restoredCount).toBe(0);
    expect(out.unknownTokenCount).toBe(1);
  });

  test("session populated but token not present yields one unknown", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Alice" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("__OPF_EMAIL_5__", "s1");
    expect(out.text).toBe("__OPF_EMAIL_5__");
    expect(out.unknownTokenCount).toBe(1);
  });

  test("token adjacent to a word restores via strict regex", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("__OPF_EMAIL_1__please reply", "s1");
    expect(out.text).toBe("alice@example.complease reply");
    expect(out.restoredCount).toBe(1);
    expect(out.matches[0]!.matchType).toBe("strict");
  });

  test("per-call opts override Restorer defaults", () => {
    const v = makeVault("s1", []);
    const captured: string[] = [];
    const r = new Restorer(v, {
      warn: (m) => captured.push(`default:${m}`),
      warnOnUnknownToken: true,
    });
    const callSiteCaptured: string[] = [];
    r.restore("__OPF_FAKE_1__", "s1", {
      warn: (m) => callSiteCaptured.push(`call:${m}`),
    });
    expect(captured).toEqual([]);
    expect(callSiteCaptured.length).toBe(1);
    expect(callSiteCaptured[0]).toMatch(/^call:/);
  });

  test("matches array exposes all detected tokens for debugging", () => {
    const v = makeVault("s1", []);
    const r = new Restorer(v);
    const out = r.restore(
      "__OPF_PERSON_1__ and __opf_email_2 and __OPF_FAKE_99__",
      "s1",
      { warnOnPartial: false, warnOnUnknownToken: false }
    );
    expect(out.matches).toHaveLength(3);
    const types = out.matches.map((m: TokenMatch) => m.matchType);
    expect(types).toEqual(["strict", "lenient", "strict"]);
    expect(out.unknownTokenCount).toBe(3);
    expect(out.partialMatchCount).toBe(1);
  });
});

describe("isInsidePath — path-context detection", () => {
  function findToken(text: string, token: string): { start: number; end: number } {
    const idx = text.indexOf(token);
    expect(idx).toBeGreaterThanOrEqual(0);
    return { start: idx, end: idx + token.length };
  }

  test("Windows drive path with token embedded in directory name", () => {
    const { start, end } = findToken(
      "NotFound: FileSystem.access (D:\\Git\\__OPF_PERSON_2__Plugin)",
      "__OPF_PERSON_2__"
    );
    expect(isInsidePath("NotFound: FileSystem.access (D:\\Git\\__OPF_PERSON_2__Plugin)", start, end)).toBe(true);
  });

  test("POSIX absolute path with token", () => {
    const path = "/tmp/__OPF_PERSON_2__Plugin";
    const { start, end } = findToken(path, "__OPF_PERSON_2__");
    expect(isInsidePath(path, start, end)).toBe(true);
  });

  test("UNC path", () => {
    const path = "\\\\server\\share\\__OPF_EMAIL_1__dir";
    const { start, end } = findToken(path, "__OPF_EMAIL_1__");
    expect(isInsidePath(path, start, end)).toBe(true);
  });

  test("relative path with ./ prefix", () => {
    const path = "./src/__OPF_PERSON_1__file.ts";
    const { start, end } = findToken(path, "__OPF_PERSON_1__");
    expect(isInsidePath(path, start, end)).toBe(true);
  });

  test("file:// URL", () => {
    const path = "file:///home/__OPF_EMAIL_1__dir";
    const { start, end } = findToken(path, "__OPF_EMAIL_1__");
    expect(isInsidePath(path, start, end)).toBe(true);
  });

  test("token followed by regular text (NOT a path)", () => {
    const text = "__OPF_EMAIL_1__please respond";
    const { start, end } = findToken(text, "__OPF_EMAIL_1__");
    expect(isInsidePath(text, start, end)).toBe(false);
  });

  test("token in normal sentence (NOT a path)", () => {
    const text = "see __OPF_PERSON_1__ here";
    const { start, end } = findToken(text, "__OPF_PERSON_1__");
    expect(isInsidePath(text, start, end)).toBe(false);
  });

  test("token at sentence start (NOT a path)", () => {
    const text = "__OPF_EMAIL_1__ is the email";
    const { start, end } = findToken(text, "__OPF_EMAIL_1__");
    expect(isInsidePath(text, start, end)).toBe(false);
  });

  test("token followed by newline (NOT a path)", () => {
    const text = "see __OPF_PERSON_2__\nnext line";
    const { start, end } = findToken(text, "__OPF_PERSON_2__");
    expect(isInsidePath(text, start, end)).toBe(false);
  });

  test("https:// URL with token in path segment", () => {
    const text = "https://example.com/__OPF_PERSON_2__page";
    const { start, end } = findToken(text, "__OPF_PERSON_2__");
    expect(isInsidePath(text, start, end)).toBe(true);
  });
});

describe("Restorer.restore — path-skip behavior", () => {
  test("token inside Windows path is skipped (not restored)", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Alice" },
    ]);
    const r = new Restorer(v);
    const out = r.restore(
      "NotFound: FileSystem.access (D:\\Git\\__OPF_PERSON_1__Plugin)",
      "s1"
    );
    expect(out.text).toBe("NotFound: FileSystem.access (D:\\Git\\__OPF_PERSON_1__Plugin)");
    expect(out.pathSkipCount).toBe(1);
    expect(out.restoredCount).toBe(0);
  });

  test("token inside POSIX path is skipped", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Bob" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("error: /tmp/__OPF_PERSON_1__dir not found", "s1");
    expect(out.text).toBe("error: /tmp/__OPF_PERSON_1__dir not found");
    expect(out.pathSkipCount).toBe(1);
  });

  test("token adjacent to text is still restored (legitimate LLM output)", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("__OPF_EMAIL_1__please respond", "s1");
    expect(out.text).toBe("alice@example.complease respond");
    expect(out.restoredCount).toBe(1);
    expect(out.pathSkipCount).toBe(0);
  });

  test("mixed: path token skipped, normal token restored", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Charlie" },
      { category: "private_email", text: "charlie@ex.com" },
    ]);
    const r = new Restorer(v);
    const out = r.restore(
      "D:\\Git\\__OPF_PERSON_1__Plugin and __OPF_EMAIL_1__ please",
      "s1"
    );
    expect(out.text).toBe("D:\\Git\\__OPF_PERSON_1__Plugin and charlie@ex.com please");
    expect(out.pathSkipCount).toBe(1);
    expect(out.restoredCount).toBe(1);
  });

  test("skipPathMatches:false disables path-aware skipping", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Dave" },
    ]);
    const r = new Restorer(v);
    const out = r.restore(
      "D:\\Git\\__OPF_PERSON_1__Plugin",
      "s1",
      { skipPathMatches: false }
    );
    expect(out.text).toBe("D:\\Git\\DavePlugin");
    expect(out.pathSkipCount).toBe(0);
    expect(out.restoredCount).toBe(1);
  });

  test("pathSkipCount is 0 when no tokens are in paths", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "x@y.z" },
    ]);
    const r = new Restorer(v);
    const out = r.restore("see __OPF_EMAIL_1__ here", "s1");
    expect(out.pathSkipCount).toBe(0);
    expect(out.restoredCount).toBe(1);
  });
});
