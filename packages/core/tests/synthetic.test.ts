import { describe, expect, test } from "bun:test";
import { PIIRemover, applyTokens } from "../src/pii-remover.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import type { PiiRemoverConfig } from "../src/config/schema.js";
import { VaultManager } from "../src/vault/manager.js";
import { restoreSynthetic } from "../src/synthetic/restore.js";
import {
  selectSyntheticName,
  syntheticBizNum,
  syntheticCard,
  syntheticRrn,
  synthesize,
} from "../src/synthetic/index.js";
import { LocalRegexBackend } from "../src/backend/local-regex.js";
import { SingleStrategy } from "../src/backend/strategy.js";

function syntheticConfig(): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
    restoration: { ...DEFAULT_CONFIG.restoration, mode: "synthetic" },
  };
}

function tokenConfig(): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
    restoration: { ...DEFAULT_CONFIG.restoration, mode: "token" },
  };
}

describe("synthesize() — category-specific strategies", () => {
  test("private_person picks from Korean pool when source is Hangul", () => {
    const v = synthesize("private_person", 1, "김철수");
    expect(/[\uAC00-\uD7A3]/.test(v)).toBe(true);
  });

  test("private_person picks from English pool when source is ASCII", () => {
    const v = synthesize("private_person", 1, "John Doe");
    expect(/^[A-Za-z ]+$/.test(v)).toBe(true);
  });

  test("private_email uses .invalid TLD (RFC 2606)", () => {
    expect(synthesize("private_email", 1, "user@x.com")).toBe(
      "synthetic.user1@example.invalid",
    );
  });

  test("private_phone uses 010-0000-NNNN reserved pattern", () => {
    expect(synthesize("private_phone", 7, "010-1234-5678")).toBe(
      "010-0000-0007",
    );
  });

  test("private_url uses .invalid TLD", () => {
    expect(synthesize("private_url", 3, "https://x.kr")).toBe(
      "https://example-3.invalid/",
    );
  });

  test("private_address uses 가상구 가상동 placeholder", () => {
    expect(synthesize("private_address", 12, "서울시 강남구 ...")).toBe(
      "서울시 가상구 가상동 12번지",
    );
  });

  test("private_date deterministic ISO-like value", () => {
    expect(synthesize("private_date", 5, "1990-01-01")).toBe("2000-01-05");
  });

  test("account_number padded with ACC- prefix", () => {
    expect(synthesize("account_number", 42, "1111")).toBe("ACC-00000042");
  });

  test("secret uses placeholder prefix to avoid LLM mis-identification", () => {
    expect(synthesize("secret", 9, "sk-real-token")).toBe("SYNTH_SECRET_9");
  });

  test("rrn synthetic value has valid checksum", () => {
    const v = syntheticRrn(1);
    expect(v).toMatch(/^\d{6}-\d{7}$/);
    const digits = v.replace("-", "").split("").map((c) => Number(c));
    const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
    let sum = 0;
    for (let i = 0; i < 12; i += 1) sum += digits[i]! * weights[i]!;
    const check = (11 - (sum % 11)) % 10;
    expect(digits[12]).toBe(check);
  });

  test("biz_num synthetic value has valid checksum", () => {
    const v = syntheticBizNum(1);
    const digits = v.replace(/-/g, "").split("").map((c) => Number(c));
    const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
    let partial = 0;
    for (let i = 0; i < 9; i += 1) partial += digits[i]! * w[i]!;
    const tail = Math.floor((digits[8]! * 5) / 10);
    const sum = partial + tail;
    expect(digits[9]).toBe((10 - (sum % 10)) % 10);
  });

  test("card synthetic value passes LUHN", () => {
    const v = syntheticCard(1);
    const digits = v.replace(/\s/g, "").split("").map((c) => Number(c));
    let total = 0;
    const reversed = [...digits].reverse();
    for (let i = 0; i < reversed.length; i += 1) {
      let d = reversed[i]!;
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      total += d;
    }
    expect(total % 10).toBe(0);
  });

  test("synthesize() is deterministic — same inputs produce same output", () => {
    for (let i = 1; i <= 10; i += 1) {
      const a = synthesize("private_person", i, "철수");
      const b = synthesize("private_person", i, "철수");
      expect(a).toBe(b);
    }
  });
});

describe("VaultManager — synthetic_value lifecycle", () => {
  test("entries[].synthetic_value is undefined when no generator provided", () => {
    const vault = new VaultManager();
    vault.assign("s1", [
      { start: 0, end: 5, category: "private_person", confidence: 1, text: "Smith" },
    ]);
    const entries = vault.entries("s1");
    expect(entries[0]!.synthetic_value).toBeUndefined();
  });

  test("entries[].synthetic_value is populated when generator provided", () => {
    const vault = new VaultManager({ syntheticGenerator: synthesize });
    const tokens = vault.assign("s1", [
      { start: 0, end: 5, category: "private_person", confidence: 1, text: "Smith" },
    ]);
    const entries = vault.entries("s1");
    expect(typeof entries[0]!.synthetic_value).toBe("string");
    expect(tokens[0]!.syntheticValue).toBe(entries[0]!.synthetic_value);
  });

  test("entries() returns [] for unknown sessionId", () => {
    const vault = new VaultManager();
    expect(vault.entries("nope")).toEqual([]);
  });
});

describe("applyTokens — mode dispatch", () => {
  test("mode='token' replaces with __OPF_*__ tokens (default)", () => {
    const out = applyTokens(
      "x",
      [
        {
          start: 0,
          end: 1,
          category: "private_person",
          confidence: 1,
          text: "x",
          token: "__OPF_PERSON__0123456789abcdef__",
        },
      ],
    );
    expect(out).toBe("__OPF_PERSON__0123456789abcdef__");
  });

  test("mode='synthetic' uses syntheticValue when present", () => {
    const out = applyTokens(
      "x",
      [
        {
          start: 0,
          end: 1,
          category: "private_person",
          confidence: 1,
          text: "x",
          token: "__OPF_PERSON__0123456789abcdef__",
          syntheticValue: "Jane Doe",
        },
      ],
      "synthetic",
    );
    expect(out).toBe("Jane Doe");
  });

  test("mode='synthetic' falls back to token when syntheticValue is missing", () => {
    const out = applyTokens(
      "x",
      [
        {
          start: 0,
          end: 1,
          category: "secret",
          confidence: 1,
          text: "x",
          token: "__OPF_SECRET__0123456789abcdef__",
        },
      ],
      "synthetic",
    );
    expect(out).toBe("__OPF_SECRET__0123456789abcdef__");
  });
});

describe("restoreSynthetic — direct API", () => {
  test("replaces an English synthetic value with original text", () => {
    const out = restoreSynthetic("Email Jane Doe at hi@x.com", [
      {
        label: "private_person",
        text: "Alice Kim",
        canonical_text: "Alice Kim",
        id: "0123456789abcdef",
        synthetic_value: "Jane Doe",
      },
    ]);
    expect(out.text).toBe("Email Alice Kim at hi@x.com");
    expect(out.restoredCount).toBe(1);
  });

  test("does NOT match inside a larger English word (word_boundary)", () => {
    const out = restoreSynthetic("Janeway is captain", [
      {
        label: "private_person",
        text: "Alice",
        canonical_text: "Alice",
        id: "0123456789abcdef",
        synthetic_value: "Jane",
      },
    ]);
    expect(out.restoredCount).toBe(0);
  });

  test("entries without synthetic_value are ignored", () => {
    const out = restoreSynthetic("Jane Doe here", [
      {
        label: "private_person",
        text: "Alice",
        canonical_text: "Alice",
        id: "0123456789abcdef",
      },
    ]);
    expect(out.restoredCount).toBe(0);
  });

  test("Korean particle suffix lenient: '김민준씨가' → restores with '씨가' consumed", () => {
    const out = restoreSynthetic("김민준씨가 도착했다", [
      {
        label: "private_person",
        text: "위석호",
        canonical_text: "위석호",
        id: "0123456789abcdef",
        synthetic_value: "김민준",
      },
    ]);
    expect(out.text.startsWith("위석호")).toBe(true);
    expect(out.restoredCount).toBe(1);
  });

  test("Korean: synthetic followed by another Hangul name letter does NOT match (boundary)", () => {
    const out = restoreSynthetic("김민준희가 도착", [
      {
        label: "private_person",
        text: "위석호",
        canonical_text: "위석호",
        id: "0123456789abcdef",
        synthetic_value: "김민준",
      },
    ]);
    expect(out.restoredCount).toBe(0);
  });

  test("longer synthetic value matches first (no double-replace)", () => {
    const out = restoreSynthetic("Mr Jane Doe Smith", [
      {
        label: "private_person",
        text: "Alice",
        canonical_text: "Alice",
        id: "0123456789abcdef",
        synthetic_value: "Jane Doe",
      },
      {
        label: "private_person",
        text: "Bob",
        canonical_text: "Bob",
        id: "fedcba9876543210",
        synthetic_value: "Jane",
      },
    ]);
    expect(out.text).toBe("Mr Alice Smith");
    expect(out.restoredCount).toBe(1);
  });
});

describe("PIIRemover — synthetic round-trip", () => {
  test("synthetic mode produces non-token mask and restores correctly", async () => {
    const pii = await PIIRemover.init({
      config: syntheticConfig(),
      warn: () => {},
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const masked = await pii.mask("contact user@example.com please");
    expect(masked.text).not.toContain("__OPF_EMAIL_");
    expect(masked.text).toContain("synthetic.user");
    expect(masked.text).toContain("@example.invalid");
    const restored = pii.restore(masked.text);
    expect(restored.text).toBe("contact user@example.com please");
    expect(restored.restoredCount).toBe(1);
    pii.dispose();
  });

  test("synthetic mode round-trip with Korean person via custom vault wrap", async () => {
    const pii = await PIIRemover.init({
      config: {
        ...syntheticConfig(),
        personal_data: {
          enabled: true,
          entries: [{ value: "위석호", category: "private_person" }],
        },
      },
      warn: () => {},
    });
    const masked = await pii.mask("저자는 위석호님이다");
    expect(masked.text).not.toContain("__OPF_PERSON_");
    expect(masked.text).not.toContain("위석호");
    const restored = pii.restore(masked.text);
    expect(restored.text).toBe("저자는 위석호님이다");
    pii.dispose();
  });

  test("token mode (default) is unaffected — no synthetic substitution", async () => {
    const pii = await PIIRemover.init({
      config: tokenConfig(),
      warn: () => {},
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const masked = await pii.mask("contact user@example.com please");
    expect(masked.text).toMatch(/__OPF_EMAIL__[a-z0-9]{16}__/);
    expect(masked.text).not.toContain("synthetic.user");
    const restored = pii.restore(masked.text);
    expect(restored.text).toBe("contact user@example.com please");
    pii.dispose();
  });

  test("synthetic mode preserves dedup — same PII gets same synthetic value", async () => {
    const pii = await PIIRemover.init({
      config: syntheticConfig(),
      warn: () => {},
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const m1 = await pii.mask("a user@x.com b");
    const m2 = await pii.mask("c user@x.com d");
    expect(m1.tokens[0]!.syntheticValue).toBe(m2.tokens[0]!.syntheticValue);
    pii.dispose();
  });
});

describe("selectSyntheticName — pool selection details", () => {
  test("uses Hangul pool only when source contains Hangul", () => {
    const v = selectSyntheticName("철수", 1);
    expect(/[\uAC00-\uD7A3]/.test(v)).toBe(true);
  });

  test("wraps via modulo when index exceeds pool size", () => {
    const a = selectSyntheticName("철수", 1);
    const b = selectSyntheticName("철수", 51);
    expect(a).toBe(b);
  });
});
