import { describe, expect, test } from "bun:test";
import { findUsSsns, isValidSsn } from "../src/detector/regex/us-ssn.js";
import { LocalRegexBackend } from "../src/backend/local-regex.js";

const opts = { request_id: "test" };

describe("findUsSsns", () => {
  test("detects a valid hyphenated SSN as account_number", () => {
    const found = findUsSsns("SSN: 123-45-6789 on file");
    expect(found).toHaveLength(1);
    expect(found[0]!.category).toBe("account_number");
    expect(found[0]!.text).toBe("123-45-6789");
    expect(found[0]!.start).toBe(5);
  });

  test("rejects 000, 666, and 9xx area numbers", () => {
    expect(findUsSsns("000-45-6789")).toHaveLength(0);
    expect(findUsSsns("666-45-6789")).toHaveLength(0);
    expect(findUsSsns("900-45-6789")).toHaveLength(0);
    expect(findUsSsns("999-45-6789")).toHaveLength(0);
  });

  test("rejects 00 group and 0000 serial", () => {
    expect(findUsSsns("123-00-6789")).toHaveLength(0);
    expect(findUsSsns("123-45-0000")).toHaveLength(0);
  });
});

describe("isValidSsn", () => {
  test("accepts a valid breakdown", () => {
    expect(isValidSsn("123", "45", "6789")).toBe(true);
  });
  test("rejects invalid breakdowns", () => {
    expect(isValidSsn("000", "45", "6789")).toBe(false);
    expect(isValidSsn("666", "45", "6789")).toBe(false);
    expect(isValidSsn("900", "45", "6789")).toBe(false);
    expect(isValidSsn("123", "00", "6789")).toBe(false);
    expect(isValidSsn("123", "45", "0000")).toBe(false);
  });
});

describe("LocalRegexBackend SSN gating", () => {
  test("does not detect SSN by default (opt-in)", async () => {
    const b = new LocalRegexBackend({ enabledCategories: ["account_number"] });
    const r = await b.detect("123-45-6789", opts);
    expect(r.detections).toHaveLength(0);
  });

  test("detects SSN when detect_us_ssn is enabled", async () => {
    const b = new LocalRegexBackend({
      enabledCategories: ["account_number"],
      detect_us_ssn: true,
    });
    const r = await b.detect("123-45-6789", opts);
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.category).toBe("account_number");
  });
});
