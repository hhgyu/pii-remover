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

describe("formatToken", () => {
  test("generates expected tokens for OPF + Korean categories", () => {
    expect(formatToken("PERSON", 1)).toBe("__OPF_PERSON_1__");
    expect(formatToken("EMAIL", 7)).toBe("__OPF_EMAIL_7__");
    expect(formatToken("RRN", 42)).toBe("__OPF_RRN_42__");
    expect(formatToken("BIZ_NUM", 3)).toBe("__OPF_BIZ_NUM_3__");
  });

  test("rejects invalid category (lowercase, starts with underscore, empty)", () => {
    expect(() => formatToken("person", 1)).toThrow(TypeError);
    expect(() => formatToken("_PERSON", 1)).toThrow(TypeError);
    expect(() => formatToken("", 1)).toThrow(TypeError);
    expect(() => formatToken("123", 1)).toThrow(TypeError);
  });

  test("rejects invalid index", () => {
    expect(() => formatToken("PERSON", 0)).toThrow(RangeError);
    expect(() => formatToken("PERSON", -1)).toThrow(RangeError);
    expect(() => formatToken("PERSON", 1.5)).toThrow(RangeError);
  });
});

describe("parseToken / isToken", () => {
  test("parseToken round-trips well-formed token", () => {
    expect(parseToken("__OPF_PERSON_1__")).toEqual({
      category: "PERSON",
      index: 1,
    });
    expect(parseToken("__OPF_BIZ_NUM_99__")).toEqual({
      category: "BIZ_NUM",
      index: 99,
    });
  });

  test("parseToken rejects malformed input", () => {
    expect(parseToken("not a token")).toBeNull();
    expect(parseToken("__OPF_person_1__")).toBeNull();
    expect(parseToken("__OPF_PERSON_1")).toBeNull();
    expect(parseToken("OPF_PERSON_1")).toBeNull();
  });

  test("isToken accepts strict format only", () => {
    expect(isToken("__OPF_PERSON_1__")).toBe(true);
    expect(isToken("__OPF_PERSON_1")).toBe(false);
  });
});

describe("token regexes", () => {
  test("strict regex matches multiple tokens in text", () => {
    const text = "hello __OPF_PERSON_1__ and __OPF_EMAIL_2__ goodbye";
    const matches = Array.from(text.matchAll(TOKEN_STRICT_REGEX)).map(
      (m) => m[0]
    );
    expect(matches).toEqual(["__OPF_PERSON_1__", "__OPF_EMAIL_2__"]);
  });

  test("lenient regex catches case variants and missing suffix", () => {
    const text = "see __opf_person_1__ then __OPF_EMAIL_2";
    const matches = Array.from(text.matchAll(TOKEN_LENIENT_REGEX));
    expect(matches.length).toBe(2);
    expect(matches[0]![0].toLowerCase()).toBe("__opf_person_1__");
    expect(matches[1]![0].toUpperCase()).toContain("__OPF_EMAIL_2");
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
