import { describe, expect, test } from "bun:test";
import {
  formatToken,
  isToken,
  parseToken,
  TOKEN_LENIENT_REGEX,
  TOKEN_STRICT_REGEX,
} from "../src/token/format.js";
import {
  CATEGORY_MAP,
  REVERSE_CATEGORY_MAP,
  categoryToTokenLabel,
  tokenLabelToCategory,
} from "../src/token/category-map.js";

const H1 = "0123456789abcdef";
const H2 = "fedcba9876543210";

describe("formatToken", () => {
  test("generates expected tokens for OPF + Korean categories", () => {
    expect(formatToken("PERSON", H1)).toBe(`{{OPF:PERSON:${H1}}}`);
    expect(formatToken("EMAIL", H1)).toBe(`{{OPF:EMAIL:${H1}}}`);
    expect(formatToken("RRN", H1)).toBe(`{{OPF:RRN:${H1}}}`);
    expect(formatToken("BIZ_NUM", H1)).toBe(`{{OPF:BIZ_NUM:${H1}}}`);
  });

  test("rejects invalid category (lowercase, starts with underscore, empty)", () => {
    expect(() => formatToken("person", H1)).toThrow(TypeError);
    expect(() => formatToken("_PERSON", H1)).toThrow(TypeError);
    expect(() => formatToken("", H1)).toThrow(TypeError);
    expect(() => formatToken("123", H1)).toThrow(TypeError);
  });

  test("rejects invalid hash (wrong length, uppercase, non-base36)", () => {
    expect(() => formatToken("PERSON", "short")).toThrow(TypeError);
    expect(() => formatToken("PERSON", "ABCDEF0123456789")).toThrow(TypeError);
    expect(() => formatToken("PERSON", "0123456789abcdeff")).toThrow(TypeError);
  });
});

describe("parseToken / isToken", () => {
  test("parseToken round-trips well-formed token", () => {
    expect(parseToken(`{{OPF:PERSON:${H1}}}`)).toEqual({
      category: "PERSON",
      hash: H1,
    });
    expect(parseToken(`{{OPF:BIZ_NUM:${H2}}}`)).toEqual({
      category: "BIZ_NUM",
      hash: H2,
    });
  });

  test("parseToken rejects malformed input", () => {
    expect(parseToken("not a token")).toBeNull();
    expect(parseToken(`{{OPF:person:${H1}}}`)).toBeNull();
    expect(parseToken(`{{OPF:PERSON:${H1}`)).toBeNull();
    expect(parseToken(`OPF_PERSON__${H1}`)).toBeNull();
    expect(parseToken("{{OPF:PERSON:short}}")).toBeNull();
  });

  test("isToken accepts strict format only", () => {
    expect(isToken(`{{OPF:PERSON:${H1}}}`)).toBe(true);
    expect(isToken(`{{OPF:PERSON:${H1}`)).toBe(false);
  });
});

describe("token regexes", () => {
  test("strict regex matches multiple tokens in text", () => {
    const text = `hello {{OPF:PERSON:${H1}}} and {{OPF:EMAIL:${H2}}} goodbye`;
    const matches = Array.from(text.matchAll(TOKEN_STRICT_REGEX)).map(
      (m) => m[0]
    );
    expect(matches).toEqual([
      `{{OPF:PERSON:${H1}}}`,
      `{{OPF:EMAIL:${H2}}}`,
    ]);
  });

  test("strict regex disambiguates underscore categories (BIZ_NUM)", () => {
    const text = `{{OPF:BIZ_NUM:${H1}}}`;
    const m = TOKEN_STRICT_REGEX.exec(text);
    TOKEN_STRICT_REGEX.lastIndex = 0;
    expect(m![1]).toBe("BIZ_NUM");
    expect(m![2]).toBe(H1);
  });

  test("lenient regex catches case variants and missing suffix", () => {
    const text = `see {{opf:person:${H1}}} then {{OPF:EMAIL:${H2}`;
    const matches = Array.from(text.matchAll(TOKEN_LENIENT_REGEX));
    expect(matches.length).toBe(2);
    expect(matches[0]![0].toLowerCase()).toBe(`{{opf:person:${H1}}}`);
    expect(matches[1]![0].toUpperCase()).toContain("{{OPF:EMAIL:");
  });
});

describe("category map (ADR-0010)", () => {
  test("has exactly 11 categories (OPF 8 + Korean 3)", () => {
    expect(Object.keys(CATEGORY_MAP).length).toBe(11);
  });

  test("category map is bijective", () => {
    for (const [k, v] of Object.entries(CATEGORY_MAP)) {
      expect(REVERSE_CATEGORY_MAP[v]).toBe(k as keyof typeof CATEGORY_MAP);
    }
  });

  test("helpers round-trip", () => {
    expect(categoryToTokenLabel("private_person")).toBe("PERSON");
    expect(categoryToTokenLabel("biz_num")).toBe("BIZNUM");
    expect(tokenLabelToCategory("RRN")).toBe("rrn");
    expect(tokenLabelToCategory("UNKNOWN")).toBeNull();
  });
});
