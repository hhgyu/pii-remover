import { describe, expect, test } from "bun:test";
import { HmacTokenizer, deriveHmacKey } from "../src/redaction/hmac.js";
import { TypeRedactor } from "../src/redaction/redact.js";
import { PIIRemover } from "../src/pii-remover.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import type {
  PiiRemoverConfig,
  TypeRedactionOverride,
} from "../src/config/schema.js";

describe("HmacTokenizer", () => {
  test("same input yields the same token (deterministic)", () => {
    const t = new HmacTokenizer("secret-key");
    const a = t.tokenize("private_email", "alice@example.com");
    const b = t.tokenize("private_email", "alice@example.com");
    expect(a).toBe(b);
  });

  test("different secrets yield different tokens", () => {
    const a = new HmacTokenizer("key-a").tokenize("private_email", "x@y.z");
    const b = new HmacTokenizer("key-b").tokenize("private_email", "x@y.z");
    expect(a).not.toBe(b);
  });

  test("token embeds the category label and a digest segment", () => {
    const tok = new HmacTokenizer("k").tokenize("private_email", "x@y.z");
    expect(tok).toMatch(/^\[EMAIL:[A-Za-z0-9_-]{16}\]$/);
  });

  test("token_length controls the digest segment length", () => {
    const tok = new HmacTokenizer("k", 8).tokenize("secret", "value");
    expect(tok).toMatch(/^\[SECRET:[A-Za-z0-9_-]{8}\]$/);
  });

  test("deriveHmacKey is deterministic and rejects empty secrets", () => {
    expect(deriveHmacKey("k").equals(deriveHmacKey("k"))).toBe(true);
    expect(() => deriveHmacKey("")).toThrow();
  });
});

describe("TypeRedactor", () => {
  test("mask mode replaces with a category placeholder by default", () => {
    const r = new TypeRedactor([
      { category: "private_email", mode: "mask" },
    ]);
    expect(r.redact("private_email", "alice@example.com")).toBe("[EMAIL]");
  });

  test("mask mode honors a custom placeholder", () => {
    const r = new TypeRedactor([
      { category: "private_email", mode: "mask", placeholder: "<redacted>" },
    ]);
    expect(r.redact("private_email", "x@y.z")).toBe("<redacted>");
  });

  test("partial mode keeps the trailing N visible chars", () => {
    const r = new TypeRedactor([
      { category: "card", mode: "partial", visible_suffix: 4 },
    ]);
    expect(r.redact("card", "4111111111111234")).toBe("************1234");
  });

  test("partial mode masks alphanumerics but preserves separators", () => {
    const r = new TypeRedactor([
      { category: "card", mode: "partial", visible_suffix: 4 },
    ]);
    expect(r.redact("card", "4111-1111-1111-1234")).toBe("****-****-****-1234");
  });

  test("token mode (or no override) returns null to defer to the vault token", () => {
    const r = new TypeRedactor([
      { category: "private_email", mode: "token" },
    ]);
    expect(r.redact("private_email", "x@y.z")).toBeNull();
    expect(r.redact("private_phone", "x")).toBeNull();
  });
});

function baseConfig(): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
  };
}

describe("PIIRemover hmac mode", () => {
  test("masks emails into deterministic hmac tokens", async () => {
    const config: PiiRemoverConfig = {
      ...baseConfig(),
      restoration: {
        ...DEFAULT_CONFIG.restoration,
        mode: "hmac",
        hmac: { secret_env: "PII_HMAC_SECRET" },
      },
    };
    const remover = await PIIRemover.init({
      config,
      env: { PII_HMAC_SECRET: "test-secret" },
    });
    const r1 = await remover.mask("contact alice@example.com");
    const r2 = await remover.mask("write to alice@example.com again");
    expect(r1.text).not.toContain("alice@example.com");
    const tok1 = r1.text.match(/\[EMAIL:[^\]]+\]/)?.[0];
    const tok2 = r2.text.match(/\[EMAIL:[^\]]+\]/)?.[0];
    expect(tok1).toBeDefined();
    expect(tok1).toBe(tok2!);
    remover.dispose();
  });

  test("fails closed when the hmac secret env is unset", async () => {
    const config: PiiRemoverConfig = {
      ...baseConfig(),
      restoration: {
        ...DEFAULT_CONFIG.restoration,
        mode: "hmac",
        hmac: { secret_env: "MISSING_SECRET" },
      },
    };
    await expect(PIIRemover.init({ config, env: {} })).rejects.toThrow(
      /is not set/,
    );
  });
});

describe("PIIRemover type_overrides", () => {
  test("mask override replaces matched email with a placeholder", async () => {
    const overrides: TypeRedactionOverride[] = [
      { category: "private_email", mode: "mask", placeholder: "[EMAIL]" },
    ];
    const config: PiiRemoverConfig = {
      ...baseConfig(),
      restoration: { ...DEFAULT_CONFIG.restoration, type_overrides: overrides },
    };
    const remover = await PIIRemover.init({ config, env: {} });
    const r = await remover.mask("mail me at bob@example.com please");
    expect(r.text).toContain("[EMAIL]");
    expect(r.text).not.toContain("bob@example.com");
    remover.dispose();
  });
});
