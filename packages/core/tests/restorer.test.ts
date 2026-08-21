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

function vaultToken(v: VaultManager, sessionId: string, seed: Seed): string {
  return v.assign(sessionId, [det(0, seed.text.length, seed.category, seed.text)])[0]!.token;
}

const H1 = "0123456789abcdef";
const H2 = "fedcba9876543210";
const H3 = "aaaaaaaaaaaaaaaa";
const PERSON1 = `{{OPF:PERSON:${H1}}}`;
const PERSON1_LOWER = `{{opf:person:${H1}}}`;
const PERSON1_MISSING_SUFFIX = `{{OPF:PERSON:${H1}`;
const PERSON1_LOWER_MISSING_SUFFIX = `{{opf:person:${H1}`;
const EMAIL1 = `{{OPF:EMAIL:${H1}}}`;
const EMAIL1_LOWER = `{{opf:email:${H1}}}`;
const EMAIL1_MISSING_SUFFIX = `{{OPF:EMAIL:${H1}`;
const EMAIL1_LOWER_MISSING_SUFFIX = `{{opf:email:${H1}`;
const EMAIL2 = `{{OPF:EMAIL:${H2}}}`;
const PHONE = `{{OPF:PHONE:${H3}}}`;
const BIZNUM = `{{OPF:BIZ_NUM:${H1}}}`;
const FAKE = `{{OPF:FAKE:ffffffffffffffff}}`;
const FAKE_LOWER = `{{opf:fake:ffffffffffffffff}}`;
const FAKE_LOWER_MISSING_SUFFIX = `{{opf:fake:ffffffffffffffff`;
const PERSON_UNKNOWN = `{{OPF:PERSON:ffffffffffffffff}}`;
const EMAIL_UNKNOWN = `{{OPF:EMAIL:ffffffffffffffff}}`;

describe("scanTokens — strict + lenient detection (ADR-0002, ADR-0004)", () => {
  test("empty string returns no matches", () => {
    expect(scanTokens("")).toEqual([]);
  });

  test("text without tokens returns no matches", () => {
    expect(scanTokens("just a sentence with no PII tokens")).toEqual([]);
  });

  test("canonical token is a strict match", () => {
    const out = scanTokens(`see ${PERSON1} here`);
    expect(out).toHaveLength(1);
    expect(out[0]!.matchType).toBe("strict");
    expect(out[0]!.token).toBe(PERSON1);
    expect(out[0]!.normalizedToken).toBe(PERSON1);
    expect(out[0]!.category).toBe("PERSON");
    expect(out[0]!.hash).toBe(H1);
  });

  test("lowercased token is a lenient match", () => {
    const out = scanTokens(`see ${PERSON1_LOWER} here`);
    expect(out).toHaveLength(1);
    expect(out[0]!.matchType).toBe("lenient");
    expect(out[0]!.token).toBe(PERSON1_LOWER);
    expect(out[0]!.normalizedToken).toBe(PERSON1);
    expect(out[0]!.category).toBe("PERSON");
  });

  test("suffix-missing token is a lenient match", () => {
    const out = scanTokens(`trailing ${PERSON1_MISSING_SUFFIX} cut off`);
    expect(out).toHaveLength(1);
    expect(out[0]!.matchType).toBe("lenient");
    expect(out[0]!.token).toBe(PERSON1_MISSING_SUFFIX);
    expect(out[0]!.normalizedToken).toBe(PERSON1);
  });

  test("suffix-missing + lowercased token is a lenient match", () => {
    const out = scanTokens(`trailing ${PERSON1_LOWER_MISSING_SUFFIX} cut off`);
    expect(out).toHaveLength(1);
    expect(out[0]!.matchType).toBe("lenient");
    expect(out[0]!.normalizedToken).toBe(PERSON1);
  });

  test("strict and lenient share the same span without double-counting", () => {
    const out = scanTokens(EMAIL1);
    expect(out).toHaveLength(1);
    expect(out[0]!.matchType).toBe("strict");
  });

  test("non-OPF-prefixed text never matches", () => {
    expect(scanTokens("Person_1 and EMAIL_1 are normal words")).toEqual([]);
  });

  test("token adjacent to a word still matches strictly (no \\b in strict regex)", () => {
    const out = scanTokens(`${EMAIL1}please respond`);
    expect(out).toHaveLength(1);
    expect(out[0]!.matchType).toBe("strict");
    expect(out[0]!.token).toBe(EMAIL1);
  });

  test("two consecutive tokens both match strictly", () => {
    const out = scanTokens(`${EMAIL1} and ${EMAIL2}`);
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.matchType === "strict")).toBe(true);
    expect(out[0]!.hash).toBe(H1);
    expect(out[1]!.hash).toBe(H2);
  });

  test("matches are sorted by start position", () => {
    const out = scanTokens(`see ${PHONE} then ${EMAIL1_LOWER_MISSING_SUFFIX}`);
    expect(out).toHaveLength(2);
    expect(out[0]!.start).toBeLessThan(out[1]!.start);
    expect(out[0]!.matchType).toBe("strict");
    expect(out[1]!.matchType).toBe("lenient");
  });

  test("multi-underscore categories like BIZ_NUM parse correctly", () => {
    const out = scanTokens(BIZNUM);
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe("BIZ_NUM");
    expect(out[0]!.hash).toBe(H1);
    expect(out[0]!.normalizedToken).toBe(BIZNUM);
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
      lenientRestoredCount: 0,
      repairedCount: 0,
      unknownTokenCount: 0,
      foreignCount: 0,
      deadTokenCount: 0,
      ambiguousCount: 0,
      pathSkipCount: 0,
      residualTokenCount: 0,
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
    const token = vaultToken(v, "s1", { category: "private_email", text: "alice@example.com" });
    const out = r.restore(`see ${token} today`, "s1");
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
    const token = vaultToken(v, "s1", { category: "private_person", text: "Alice" });
    const out = r.restore(token, "s1");
    expect(out.text).toBe("Alice");
    expect(out.restoredCount).toBe(1);
  });

  test("multiple tokens are restored right-to-left without offset drift", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
      { category: "private_url", text: "https://example.com/path?q=1" },
    ]);
    const r = new Restorer(v);
    const email = vaultToken(v, "s1", { category: "private_email", text: "alice@example.com" });
    const url = vaultToken(v, "s1", { category: "private_url", text: "https://example.com/path?q=1" });
    const out = r.restore(
      `contact ${email} or visit ${url}`,
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
    const person = vaultToken(v, "s1", { category: "private_person", text: "X" });
    const email = vaultToken(v, "s1", { category: "private_email", text: "very-long-email-address@example.com" });
    const out = r.restore(
      `${person} and ${email} done`,
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
    const token = vaultToken(v, "s1", { category: "private_email", text: "alice@example.com" }).toLowerCase();
    const out = r.restore(`see ${token} tomorrow`, "s1");
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
    const token = vaultToken(v, "s1", { category: "private_person", text: "Alice" }).slice(0, -2);
    const out = r.restore(`trailing ${token} cut off`, "s1");
    expect(out.text).toBe("trailing Alice cut off");
    expect(out.restoredCount).toBe(1);
    expect(out.partialMatchCount).toBe(1);
  });

  test("case-folded + suffix-missing token still restores", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Alice" },
    ]);
    const r = new Restorer(v);
    const token = vaultToken(v, "s1", { category: "private_person", text: "Alice" }).toLowerCase().slice(0, -2);
    const out = r.restore(`trailing ${token} cut off`, "s1");
    expect(out.text).toBe("trailing Alice cut off");
    expect(out.restoredCount).toBe(1);
    expect(out.partialMatchCount).toBe(1);
  });

  test("hallucinated strict token preserves original + bumps unknownTokenCount", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
    ]);
    const r = new Restorer(v);
    const out = r.restore(`see ${FAKE} here`, "s1");
    expect(out.text).toBe(`see ${FAKE} here`);
    expect(out.restoredCount).toBe(0);
    expect(out.partialMatchCount).toBe(0);
    expect(out.unknownTokenCount).toBe(1);
  });

  test("hallucinated lenient token preserves original + bumps both partial and unknown", () => {
    const v = makeVault("s1", []);
    const r = new Restorer(v);
    const out = r.restore(`${FAKE_LOWER} trailing`, "s1");
    expect(out.text).toBe(`${FAKE_LOWER} trailing`);
    expect(out.restoredCount).toBe(0);
    expect(out.partialMatchCount).toBe(1);
    expect(out.unknownTokenCount).toBe(1);
  });

  test("emits warning on hallucinated strict token", () => {
    const v = makeVault("s1", []);
    const warnings: string[] = [];
    const r = new Restorer(v, { warn: (m) => warnings.push(m) });
    r.restore(FAKE, "s1");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/hallucinated/);
  });

  test("emits warning on lenient match even when it resolves", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
    ]);
    const warnings: string[] = [];
    const r = new Restorer(v, { warn: (m) => warnings.push(m) });
    const token = vaultToken(v, "s1", { category: "private_email", text: "alice@example.com" }).toLowerCase();
    r.restore(`see ${token} tomorrow`, "s1");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/lenient/);
    expect(warnings[0]).toMatch(/LLM transformation/);
  });

  test("warnings can be suppressed via warnOnPartial:false / warnOnUnknownToken:false", () => {
    const v = makeVault("s1", []);
    const warnings: string[] = [];
    const r = new Restorer(v, { warn: (m) => warnings.push(m) });
    r.restore(`${FAKE} ${FAKE_LOWER}`, "s1", {
      warnOnPartial: false,
      warnOnUnknownToken: false,
    });
    expect(warnings).toEqual([]);
  });

  test("custom unknownTokenHandler replaces strict misses with handler output", () => {
    const v = makeVault("s1", []);
    const r = new Restorer(v);
    const out = r.restore(`see ${FAKE} here`, "s1", {
      unknownTokenHandler: (tok) => `[unknown:${tok}]`,
      warnOnUnknownToken: false,
    });
    expect(out.text).toBe(`see [unknown:${FAKE}] here`);
    expect(out.unknownTokenCount).toBe(1);
  });

  test("custom partialMatchHandler replaces lenient misses with handler output", () => {
    const v = makeVault("s1", []);
    const r = new Restorer(v);
    const out = r.restore(`see ${FAKE_LOWER_MISSING_SUFFIX} here`, "s1", {
      partialMatchHandler: (tok, match) =>
        `[partial:${tok}->${match.normalizedToken}]`,
      warnOnPartial: false,
    });
    expect(out.text).toBe(
      `see [partial:${FAKE_LOWER_MISSING_SUFFIX}->${FAKE}] here`
    );
    expect(out.partialMatchCount).toBe(1);
    expect(out.unknownTokenCount).toBe(1);
  });

  test("lenient:false disables fallback matching", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
    ]);
    const r = new Restorer(v);
    const out = r.restore(`see ${EMAIL1_LOWER} here`, "s1", {
      lenient: false,
    });
    expect(out.text).toBe(`see ${EMAIL1_LOWER} here`);
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
    const email = vaultToken(v, "s1", { category: "private_email", text: "a@b.c" });
    const url = vaultToken(v, "s1", { category: "private_url", text: "https://x.y" });
    const out = r.restore(`${url} ... ${email}`, "s1");
    expect(out.matches.map((m) => m.normalizedToken)).toEqual([
      url,
      email,
    ]);
    expect(out.matches[0]!.start).toBeLessThan(out.matches[1]!.start);
  });

  test("empty sessionId throws TypeError", () => {
    const v = makeVault("s1", []);
    const r = new Restorer(v);
    expect(() => r.restore(PERSON1, "")).toThrow(TypeError);
  });

  test("unknown sessionId yields all-unknown counters without throwing", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Alice" },
    ]);
    const r = new Restorer(v);
    const token = vaultToken(v, "s1", { category: "private_person", text: "Alice" });
    const out = r.restore(token, "never-existed");
    expect(out.text).toBe(token);
    expect(out.restoredCount).toBe(0);
    expect(out.unknownTokenCount).toBe(1);
  });

  test("session populated but token not present yields one unknown", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Alice" },
    ]);
    const r = new Restorer(v);
    const out = r.restore(EMAIL_UNKNOWN, "s1");
    expect(out.text).toBe(EMAIL_UNKNOWN);
    expect(out.unknownTokenCount).toBe(1);
  });

  test("token adjacent to a word restores via strict regex", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
    ]);
    const r = new Restorer(v);
    const token = vaultToken(v, "s1", { category: "private_email", text: "alice@example.com" });
    const out = r.restore(`${token}please reply`, "s1");
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
    r.restore(FAKE, "s1", {
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
      `${PERSON1} and ${EMAIL2.toLowerCase().slice(0, -2)} and ${FAKE}`,
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
      `NotFound: FileSystem.access (D:\\Git\\${PERSON1}Plugin)`,
      PERSON1
    );
    expect(isInsidePath(`NotFound: FileSystem.access (D:\\Git\\${PERSON1}Plugin)`, start, end)).toBe(true);
  });

  test("POSIX absolute path with token", () => {
    const path = `/tmp/${PERSON1}Plugin`;
    const { start, end } = findToken(path, PERSON1);
    expect(isInsidePath(path, start, end)).toBe(true);
  });

  test("UNC path", () => {
    const path = `\\\\server\\share\\${EMAIL1}dir`;
    const { start, end } = findToken(path, EMAIL1);
    expect(isInsidePath(path, start, end)).toBe(true);
  });

  test("relative path with ./ prefix", () => {
    const path = `./src/${PERSON1}file.ts`;
    const { start, end } = findToken(path, PERSON1);
    expect(isInsidePath(path, start, end)).toBe(true);
  });

  test("file:// URL", () => {
    const path = `file:///home/${EMAIL1}dir`;
    const { start, end } = findToken(path, EMAIL1);
    expect(isInsidePath(path, start, end)).toBe(true);
  });

  test("token followed by regular text (NOT a path)", () => {
    const text = `${EMAIL1}please respond`;
    const { start, end } = findToken(text, EMAIL1);
    expect(isInsidePath(text, start, end)).toBe(false);
  });

  test("token in normal sentence (NOT a path)", () => {
    const text = `see ${PERSON1} here`;
    const { start, end } = findToken(text, PERSON1);
    expect(isInsidePath(text, start, end)).toBe(false);
  });

  test("token at sentence start (NOT a path)", () => {
    const text = `${EMAIL1} is the email`;
    const { start, end } = findToken(text, EMAIL1);
    expect(isInsidePath(text, start, end)).toBe(false);
  });

  test("token followed by newline (NOT a path)", () => {
    const text = `see ${PERSON1}\nnext line`;
    const { start, end } = findToken(text, PERSON1);
    expect(isInsidePath(text, start, end)).toBe(false);
  });

  test("https:// URL with token in path segment", () => {
    const text = `https://example.com/${PERSON1}page`;
    const { start, end } = findToken(text, PERSON1);
    expect(isInsidePath(text, start, end)).toBe(true);
  });
});

describe("Restorer.restore — path-skip behavior", () => {
  test("token inside Windows path is restored when vault has the entry", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Alice" },
    ]);
    const r = new Restorer(v);
    const out = r.restore(
      "NotFound: FileSystem.access (D:\\Git\\AlicePlugin)",
      "s1"
    );
    expect(out.text).toBe("NotFound: FileSystem.access (D:\\Git\\AlicePlugin)");
    expect(out.restoredCount).toBe(0);
    expect(out.pathSkipCount).toBe(0);
  });

  test("unknown token inside path is skipped (not counted as unknown)", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "x@y.z" },
    ]);
    const r = new Restorer(v);
    const out = r.restore(
      `error: D:\\Git\\${PERSON_UNKNOWN}Plugin not found`,
      "s1"
    );
    expect(out.text).toBe(`error: D:\\Git\\${PERSON_UNKNOWN}Plugin not found`);
    expect(out.pathSkipCount).toBe(1);
    expect(out.unknownTokenCount).toBe(0);
  });

  test("vault token inside path is always restored", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: PERSON1 },
    ]);
    const r = new Restorer(v);
    const token = vaultToken(v, "s1", { category: "private_person", text: PERSON1 });
    const out = r.restore(
      `NotFound: FileSystem.access (D:\\Git\\${token}Plugin)`,
      "s1"
    );
    expect(out.text).toBe(`NotFound: FileSystem.access (D:\\Git\\${PERSON1}Plugin)`);
    expect(out.restoredCount).toBe(1);
    expect(out.pathSkipCount).toBe(0);
  });

  test("token inside POSIX path is restored when vault has it", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Bob" },
    ]);
    const r = new Restorer(v);
    const token = vaultToken(v, "s1", { category: "private_person", text: "Bob" });
    const out = r.restore(`error: /tmp/${token}dir not found`, "s1");
    expect(out.text).toBe("error: /tmp/Bobdir not found");
    expect(out.restoredCount).toBe(1);
    expect(out.pathSkipCount).toBe(0);
  });

  test("token adjacent to text is still restored (legitimate LLM output)", () => {
    const v = makeVault("s1", [
      { category: "private_email", text: "alice@example.com" },
    ]);
    const r = new Restorer(v);
    const token = vaultToken(v, "s1", { category: "private_email", text: "alice@example.com" });
    const out = r.restore(`${token}please respond`, "s1");
    expect(out.text).toBe("alice@example.complease respond");
    expect(out.restoredCount).toBe(1);
    expect(out.pathSkipCount).toBe(0);
  });

  test("mixed: vault token in path restored, unknown standalone token counted", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: PERSON1 },
      { category: "private_email", text: EMAIL1 },
    ]);
    const r = new Restorer(v);
    const person = vaultToken(v, "s1", { category: "private_person", text: PERSON1 });
    const email = vaultToken(v, "s1", { category: "private_email", text: EMAIL1 });
    const out = r.restore(
      `D:\\Git\\${person}Plugin and ${email} and ${PERSON_UNKNOWN}dir`,
      "s1"
    );
    expect(out.text).toBe(`D:\\Git\\${PERSON1}Plugin and ${EMAIL1} and ${PERSON_UNKNOWN}dir`);
    expect(out.restoredCount).toBe(2);
    expect(out.unknownTokenCount).toBe(1);
    expect(out.pathSkipCount).toBe(0);
  });

  test("skipPathMatches:false disables path-aware skipping", () => {
    const v = makeVault("s1", [
      { category: "private_person", text: "Dave" },
    ]);
    const r = new Restorer(v);
    const token = vaultToken(v, "s1", { category: "private_person", text: "Dave" });
    const out = r.restore(
      `D:\\Git\\${token}Plugin`,
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
    const token = vaultToken(v, "s1", { category: "private_email", text: "x@y.z" });
    const out = r.restore(`see ${token} here`, "s1");
    expect(out.pathSkipCount).toBe(0);
    expect(out.restoredCount).toBe(1);
  });
});
