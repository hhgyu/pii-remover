import { describe, expect, test } from "bun:test";
import {
  CATEGORY_MAP,
  MAX_TOKEN_LENGTH,
  TOKEN_DELIMITER,
  TOKEN_HASH_LENGTH,
  TOKEN_PREFIX,
  TOKEN_SUFFIX,
} from "@pii-remover/core";
import {
  createStreamBuffer,
  DEFAULT_BUFFER_WINDOW,
  findUnsafeBoundary,
} from "../src/stream/buffer.js";

const TOKEN_A = "__OPF_PERSON__0123456789abcdef__";
const TOKEN_B = "__OPF_EMAIL__fedcba9876543210__";

function feedChunks(chunks: string[]): { emitted: string; remainder: string } {
  const buf = createStreamBuffer({ bufferWindow: 64 });
  let emitted = "";
  for (const c of chunks) emitted += buf.push(c);
  const remainder = buf.flush();
  return { emitted, remainder };
}

function splitEvery(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe("findUnsafeBoundary — token-prefix boundary detection", () => {
  test("empty buffer → 0", () => {
    expect(findUnsafeBoundary("")).toBe(0);
  });

  test("buffer with no token prefix → length (all safe)", () => {
    expect(findUnsafeBoundary("hello world")).toBe(11);
  });

  test("complete token at end → length (all safe, token is whole)", () => {
    const s = `see ${TOKEN_A}`;
    expect(findUnsafeBoundary(s)).toBe(s.length);
  });

  test("partial prefix at end → holds back from prefix start", () => {
    const s = "before __OPF_PE";
    const boundary = findUnsafeBoundary(s);
    expect(s.slice(0, boundary)).toBe("before ");
    expect(s.slice(boundary)).toBe("__OPF_PE");
  });

  test("single underscore at end → held back (could become prefix)", () => {
    const s = "abc _";
    const boundary = findUnsafeBoundary(s);
    expect(s.slice(boundary)).toBe("_");
  });

  test("double underscore at end → held back", () => {
    const s = "abc __";
    const boundary = findUnsafeBoundary(s);
    expect(s.slice(boundary)).toBe("__");
  });

  test("token followed by trailing text → length (token complete + suffix safe)", () => {
    const s = `x ${TOKEN_A} y`;
    expect(findUnsafeBoundary(s)).toBe(s.length);
  });

  test("buffer beyond window keeps tail check only", () => {
    const longSafe = "a".repeat(200);
    const s = longSafe + "__OPF_E";
    const boundary = findUnsafeBoundary(s);
    expect(s.slice(boundary)).toBe("__OPF_E");
  });
});

describe("DEFAULT_BUFFER_WINDOW — must contain a whole token", () => {
  test("window is at least MAX_TOKEN_LENGTH", () => {
    expect(DEFAULT_BUFFER_WINDOW).toBeGreaterThanOrEqual(MAX_TOKEN_LENGTH);
  });

  test("MAX_TOKEN_LENGTH covers the longest label in CATEGORY_MAP", () => {
    for (const label of Object.values(CATEGORY_MAP)) {
      const token = `${TOKEN_PREFIX}${label}${TOKEN_DELIMITER}${"0".repeat(TOKEN_HASH_LENGTH)}${TOKEN_SUFFIX}`;
      expect(token.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);
    }
  });

  test("every category's token is held back when split one char at a time", () => {
    for (const label of Object.values(CATEGORY_MAP)) {
      const token = `${TOKEN_PREFIX}${label}${TOKEN_DELIMITER}${"0".repeat(TOKEN_HASH_LENGTH)}${TOKEN_SUFFIX}`;
      const buf = createStreamBuffer();
      let emitted = "";
      for (const ch of token.slice(0, -1)) emitted += buf.push(ch);
      expect(emitted).toBe("");
      expect(emitted + buf.push("_") + buf.flush()).toBe(token);
    }
  });

  test("a window below MAX_TOKEN_LENGTH releases a partial token raw", () => {
    const token = `${TOKEN_PREFIX}ADDRESS${TOKEN_DELIMITER}${"0".repeat(TOKEN_HASH_LENGTH)}${TOKEN_SUFFIX}`;
    const partial = token.slice(0, -1);
    const tooSmall = createStreamBuffer({ bufferWindow: MAX_TOKEN_LENGTH - 8 });
    expect(tooSmall.push(partial)).not.toBe("");

    const derived = createStreamBuffer();
    expect(derived.push(partial)).toBe("");
  });
});

describe("StreamBuffer.push/flush — round-trip with fuzz splits (ADR-0004 §12.3.3)", () => {
  test("1) full token in one chunk emits whole token", () => {
    const { emitted, remainder } = feedChunks([`prefix ${TOKEN_A} suffix`]);
    expect(emitted).toBe(`prefix ${TOKEN_A} suffix`);
    expect(remainder).toBe("");
  });

  test("2) token split exactly in half", () => {
    const half = TOKEN_A.length >> 1;
    const { emitted, remainder } = feedChunks([
      TOKEN_A.slice(0, half),
      TOKEN_A.slice(half),
    ]);
    expect(emitted + remainder).toBe(TOKEN_A);
    expect(emitted.includes(TOKEN_A) || (emitted + remainder).includes(TOKEN_A)).toBe(true);
  });

  test("3) token split by 1 char chunks reassembles intact", () => {
    const chunks = splitEvery(TOKEN_A, 1);
    const { emitted, remainder } = feedChunks(chunks);
    expect(emitted + remainder).toBe(TOKEN_A);
  });

  test("4) token split by 2 char chunks reassembles intact", () => {
    const chunks = splitEvery(TOKEN_A, 2);
    const { emitted, remainder } = feedChunks(chunks);
    expect(emitted + remainder).toBe(TOKEN_A);
  });

  test("5) token split by 3 char chunks reassembles intact", () => {
    const chunks = splitEvery(TOKEN_A, 3);
    const { emitted, remainder } = feedChunks(chunks);
    expect(emitted + remainder).toBe(TOKEN_A);
  });

  test("6) prefix-text + token + suffix-text mixed split", () => {
    const sentence = `Hi ${TOKEN_A}, email ${TOKEN_B} today.`;
    const chunks = splitEvery(sentence, 2);
    const { emitted, remainder } = feedChunks(chunks);
    expect(emitted + remainder).toBe(sentence);
  });

  test("7) two adjacent tokens split", () => {
    const sentence = `${TOKEN_A}${TOKEN_B}`;
    const chunks = splitEvery(sentence, 1);
    const { emitted, remainder } = feedChunks(chunks);
    expect(emitted + remainder).toBe(sentence);
  });

  test("8) only prefix received, stream closed → flush emits prefix as-is", () => {
    const buf = createStreamBuffer({ bufferWindow: 64 });
    const partial = "__OPF_PE";
    const emitted = buf.push(partial);
    expect(emitted).toBe("");
    const tail = buf.flush();
    expect(tail).toBe(partial);
  });

  test("9) single underscore in normal text does not stall stream", () => {
    const { emitted, remainder } = feedChunks(["abc _ def"]);
    expect(emitted + remainder).toBe("abc _ def");
  });

  test("10) lenient lowercase token split survives", () => {
    const lenient = "__opf_email__0123456789abcdef__";
    const chunks = splitEvery(lenient, 1);
    const { emitted, remainder } = feedChunks(chunks);
    expect(emitted + remainder).toBe(lenient);
  });

  test("11) lenient token without trailing __ split survives", () => {
    const lenient = "__opf_email__0123456789abcdef";
    const chunks = splitEvery(lenient, 1);
    const { emitted, remainder } = feedChunks(chunks);
    expect(emitted + remainder).toBe(lenient);
  });

  test("12) long safe prefix then partial token at end", () => {
    const safe = "lorem ipsum dolor sit amet ".repeat(5);
    const { emitted, remainder } = feedChunks([safe + "__OPF_PER"]);
    expect(emitted).toBe(safe);
    expect(remainder).toBe("__OPF_PER");
  });

  test("13) buffer.size() reports held characters", () => {
    const buf = createStreamBuffer();
    buf.push("safe text __OPF_PER");
    expect(buf.size()).toBe("__OPF_PER".length);
    buf.flush();
    expect(buf.size()).toBe(0);
  });

  test("14) empty chunks are no-ops", () => {
    const buf = createStreamBuffer();
    expect(buf.push("")).toBe("");
    expect(buf.flush()).toBe("");
  });

  test("15) successive flushes do not re-emit", () => {
    const buf = createStreamBuffer();
    const pushed = buf.push("pending __OPF_E");
    expect(pushed).toBe("pending ");
    expect(buf.flush()).toBe("__OPF_E");
    expect(buf.flush()).toBe("");
  });

  test("16) safe text emitted incrementally as chunks complete", () => {
    const buf = createStreamBuffer();
    expect(buf.push("hello ")).toBe("hello ");
    expect(buf.push("world")).toBe("world");
    expect(buf.flush()).toBe("");
  });

  test("17) prefix becomes complete token across multiple chunks", () => {
    const buf = createStreamBuffer();
    const emit1 = buf.push("intro __");
    expect(emit1).toBe("intro ");
    const emit2 = buf.push("OPF_PERSON__0123456789abcdef__ outro");
    expect((emit1 + emit2)).toBe(`intro ${TOKEN_A} outro`);
    expect(buf.flush()).toBe("");
  });

  test("18) korean PII token RRN split survives", () => {
    const token = "__OPF_RRN__0123456789abcdef__";
    const sentence = `주민 ${token} 등록됨`;
    const { emitted, remainder } = feedChunks(splitEvery(sentence, 1));
    expect(emitted + remainder).toBe(sentence);
  });

  test("19) hash token split survives", () => {
    const token = "__OPF_PERSON__ffffffffffffffff__";
    const chunks = splitEvery(token, 1);
    const { emitted, remainder } = feedChunks(chunks);
    expect(emitted + remainder).toBe(token);
  });

  test("20) random fuzz: 50 mixed sequences round-trip without loss", () => {
    const cases: string[] = [
      `Hi ${TOKEN_A}.`,
      `Email ${TOKEN_B} now.`,
      `${TOKEN_A} and ${TOKEN_B}`,
      `Call __OPF_PHONE__0123456789abcdef__ tomorrow`,
      `RRN __OPF_RRN__fedcba9876543210__ 등록`,
      "no tokens here",
      "single _ underscore",
      "double __ underscore",
      "partial __OPF",
      "partial __OPF_PE",
      "partial __OPF_PERSON_",
      "mixed text __OPF_PERSON__ffffffffffffffff__ end",
      "__OPF_EMAIL__0123456789abcdef____OPF_EMAIL__fedcba9876543210__",
      "prefix__OPF_URL__0123456789abcdef__suffix",
      `${TOKEN_A}${TOKEN_B}${TOKEN_A}`,
    ];
    for (const text of cases) {
      for (const chunkSize of [1, 2, 3, 5]) {
        const chunks = splitEvery(text, chunkSize);
        const { emitted, remainder } = feedChunks(chunks);
        expect(emitted + remainder).toBe(text);
      }
    }
  });

  test("21) custom bufferWindow respected (small window 16)", () => {
    const buf = createStreamBuffer({ bufferWindow: 16 });
    const longSafe = "x".repeat(100);
    const partial = longSafe + "__OPF_PE";
    const out = buf.push(partial);
    expect(out).toBe(longSafe);
    expect(buf.size()).toBe("__OPF_PE".length);
  });
});
