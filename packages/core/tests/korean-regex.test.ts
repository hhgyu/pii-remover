import { describe, expect, test } from "bun:test";
import {
  findKoreanBizNums,
  findKoreanPhones,
  findKoreanRrns,
  isValidBizNumChecksum,
  isValidRrnChecksum,
} from "../src/detector/regex/index.js";

const VALID_RRNS: readonly string[] = [
  "9201011234562",
  "8508234567896",
  "0102031111111",
  "7512252222222",
  "0001013000008",
  "2012124123450",
];

const INVALID_RRNS: readonly string[] = [
  "9201011234561",
  "8508234567890",
  "0102031111119",
  "7512252222229",
  "0001013000000",
];

const VALID_BIZNUMS: readonly string[] = [
  "1234567891",
  "1048152702",
  "2208512349",
];

const INVALID_BIZNUMS: readonly string[] = [
  "1234567890",
  "1048152709",
  "2208512340",
];

function withDash(rrn: string): string {
  return `${rrn.slice(0, 6)}-${rrn.slice(6)}`;
}

function withBizDashes(b: string): string {
  return `${b.slice(0, 3)}-${b.slice(3, 5)}-${b.slice(5)}`;
}

describe("isValidRrnChecksum — algorithm", () => {
  test("accepts all valid RRN fixtures (>=5)", () => {
    expect(VALID_RRNS.length).toBeGreaterThanOrEqual(5);
    for (const rrn of VALID_RRNS) {
      expect(isValidRrnChecksum(rrn)).toBe(true);
    }
  });

  test("rejects all invalid RRN fixtures (>=5)", () => {
    expect(INVALID_RRNS.length).toBeGreaterThanOrEqual(5);
    for (const rrn of INVALID_RRNS) {
      expect(isValidRrnChecksum(rrn)).toBe(false);
    }
  });

  test("accepts dashed form '######-#######'", () => {
    for (const rrn of VALID_RRNS) {
      expect(isValidRrnChecksum(withDash(rrn))).toBe(true);
    }
  });

  test("rejects non-13-digit input", () => {
    expect(isValidRrnChecksum("123456789012")).toBe(false);
    expect(isValidRrnChecksum("12345678901234")).toBe(false);
    expect(isValidRrnChecksum("")).toBe(false);
  });
});

describe("findKoreanRrns — detection", () => {
  test("detects all valid RRNs (dashed) with rrn category", () => {
    const text = VALID_RRNS.map(withDash).join(" ");
    const dets = findKoreanRrns(text);
    expect(dets).toHaveLength(VALID_RRNS.length);
    for (const d of dets) {
      expect(d.category).toBe("rrn");
      expect(d.confidence).toBeCloseTo(0.99, 5);
    }
  });

  test("detects all valid RRNs (no-dash) with rrn category", () => {
    const text = VALID_RRNS.join(" ");
    const dets = findKoreanRrns(text);
    expect(dets).toHaveLength(VALID_RRNS.length);
  });

  test("rejects invalid-checksum RRNs in strict mode (default)", () => {
    const text = INVALID_RRNS.map(withDash).join(" ");
    const dets = findKoreanRrns(text);
    expect(dets).toHaveLength(0);
  });

  test("strict_checksum: false accepts shape-valid RRNs even when checksum fails", () => {
    const text = INVALID_RRNS.map(withDash).join(" ");
    const dets = findKoreanRrns(text, { strict_checksum: false });
    expect(dets).toHaveLength(INVALID_RRNS.length);
    for (const d of dets) {
      expect(d.category).toBe("rrn");
      expect(d.confidence).toBeCloseTo(0.7, 5);
    }
  });

  test("rejects shape-invalid (gender digit 5-9 or 0)", () => {
    expect(findKoreanRrns("900101-5234567")).toHaveLength(0);
    expect(findKoreanRrns("900101-0234567")).toHaveLength(0);
    expect(findKoreanRrns("900101-9234567")).toHaveLength(0);
  });

  test("span offsets reflect the matched substring", () => {
    const text = `주민번호 ${withDash(VALID_RRNS[0]!)} 입니다`;
    const dets = findKoreanRrns(text);
    expect(dets).toHaveLength(1);
    expect(text.slice(dets[0]!.start, dets[0]!.end)).toBe(
      withDash(VALID_RRNS[0]!)
    );
  });
});

describe("isValidBizNumChecksum — algorithm", () => {
  test("accepts all valid BIZNUM fixtures (>=3)", () => {
    expect(VALID_BIZNUMS.length).toBeGreaterThanOrEqual(3);
    for (const b of VALID_BIZNUMS) {
      expect(isValidBizNumChecksum(b)).toBe(true);
    }
  });

  test("rejects all invalid BIZNUM fixtures (>=3)", () => {
    expect(INVALID_BIZNUMS.length).toBeGreaterThanOrEqual(3);
    for (const b of INVALID_BIZNUMS) {
      expect(isValidBizNumChecksum(b)).toBe(false);
    }
  });

  test("accepts dashed form '###-##-#####'", () => {
    for (const b of VALID_BIZNUMS) {
      expect(isValidBizNumChecksum(withBizDashes(b))).toBe(true);
    }
  });

  test("rejects non-10-digit input", () => {
    expect(isValidBizNumChecksum("123456789")).toBe(false);
    expect(isValidBizNumChecksum("12345678901")).toBe(false);
  });
});

describe("findKoreanBizNums — detection", () => {
  test("detects all valid BIZNUMs (dashed)", () => {
    const text = VALID_BIZNUMS.map(withBizDashes).join(" ");
    const dets = findKoreanBizNums(text);
    expect(dets).toHaveLength(VALID_BIZNUMS.length);
    for (const d of dets) {
      expect(d.category).toBe("biz_num");
    }
  });

  test("detects all valid BIZNUMs (no dash)", () => {
    const text = VALID_BIZNUMS.join(" ");
    const dets = findKoreanBizNums(text);
    expect(dets).toHaveLength(VALID_BIZNUMS.length);
  });

  test("rejects invalid-checksum BIZNUMs", () => {
    const text = INVALID_BIZNUMS.map(withBizDashes).join(" ");
    const dets = findKoreanBizNums(text);
    expect(dets).toHaveLength(0);
  });

  test("span offsets reflect the matched substring", () => {
    const text = `사업자등록번호 ${withBizDashes(VALID_BIZNUMS[0]!)} 입니다`;
    const dets = findKoreanBizNums(text);
    expect(dets).toHaveLength(1);
    expect(text.slice(dets[0]!.start, dets[0]!.end)).toBe(
      withBizDashes(VALID_BIZNUMS[0]!)
    );
  });
});

describe("findKoreanPhones — detection", () => {
  const ELEVEN_DIGIT_VARIANTS: readonly string[] = [
    "010-1234-5678",
    "01012345678",
    "016-1234-5678",
    "017-1234-5678",
    "018-1234-5678",
    "019-1234-5678",
    "011-1234-5678",
  ];

  const TEN_DIGIT_VARIANTS: readonly string[] = [
    "011-123-4567",
    "016-123-4567",
    "017-123-4567",
    "018-123-4567",
    "019-123-4567",
    "0101234567",
  ];

  test("detects every 11-digit prefix variant (010/011/016/017/018/019)", () => {
    for (const phone of ELEVEN_DIGIT_VARIANTS) {
      const dets = findKoreanPhones(phone);
      expect(dets).toHaveLength(1);
      expect(dets[0]!.text).toBe(phone);
      expect(dets[0]!.category).toBe("private_phone");
    }
  });

  test("detects every 10-digit (3-3-4) variant for older prefixes", () => {
    for (const phone of TEN_DIGIT_VARIANTS) {
      const dets = findKoreanPhones(phone);
      expect(dets).toHaveLength(1);
      expect(dets[0]!.text).toBe(phone);
    }
  });

  test("rejects non-mobile prefixes (012/013/014/015/02/...)", () => {
    expect(findKoreanPhones("012-1234-5678")).toHaveLength(0);
    expect(findKoreanPhones("013-1234-5678")).toHaveLength(0);
    expect(findKoreanPhones("014-1234-5678")).toHaveLength(0);
    expect(findKoreanPhones("015-1234-5678")).toHaveLength(0);
    expect(findKoreanPhones("02-1234-5678")).toHaveLength(0);
  });

  test("rejects wrong-length numbers", () => {
    expect(findKoreanPhones("010-12-3456")).toHaveLength(0);
    expect(findKoreanPhones("010-12345-6789")).toHaveLength(0);
  });

  test("finds multiple phones in mixed text", () => {
    const text =
      "연락처는 010-1234-5678 또는 019-9876-5432 입니다";
    const dets = findKoreanPhones(text);
    expect(dets).toHaveLength(2);
    expect(dets.map((d) => d.text).sort()).toEqual(
      ["010-1234-5678", "019-9876-5432"].sort()
    );
  });
});
