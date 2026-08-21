import { describe, expect, test } from "bun:test";
import { PIIRemover } from "../src/pii-remover.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import type { PiiRemoverConfig } from "../src/config/schema.js";
import {
  tokenHash,
  deriveTokenKey,
  TOKEN_HASH_LENGTH,
} from "../src/redaction/token-hash.js";

function localOnlyConfig(): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
  };
}

describe("tokenHash — deterministic base36", () => {
  test("same key + category + text yields the same 16-char base36 hash", () => {
    const key = deriveTokenKey("shared-secret");
    const a = tokenHash(key, "EMAIL", "user@example.com");
    const b = tokenHash(key, "EMAIL", "user@example.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z0-9]{16}$/);
    expect(a.length).toBe(TOKEN_HASH_LENGTH);
  });

  test("different keys yield different hashes", () => {
    const a = tokenHash(deriveTokenKey("key-a"), "EMAIL", "user@example.com");
    const b = tokenHash(deriveTokenKey("key-b"), "EMAIL", "user@example.com");
    expect(a).not.toBe(b);
  });

  test("different text yields different hashes", () => {
    const key = deriveTokenKey("k");
    expect(tokenHash(key, "EMAIL", "a@b.c")).not.toBe(
      tokenHash(key, "EMAIL", "x@y.z"),
    );
  });

  test("same text under different category yields different hashes", () => {
    const key = deriveTokenKey("k");
    expect(tokenHash(key, "EMAIL", "value")).not.toBe(
      tokenHash(key, "SECRET", "value"),
    );
  });
});

describe("PIIRemover — cross-instance determinism (ADR-0020)", () => {
  test("two independent instances with the same key mint identical tokens", async () => {
    const env = { PII_REMOVER_TOKEN_KEY: "fixed-shared-key" };
    const a = await PIIRemover.init({ config: localOnlyConfig(), env });
    const b = await PIIRemover.init({ config: localOnlyConfig(), env });

    const ra = await a.mask("email me at alice@example.com please");
    const rb = await b.mask("write to alice@example.com now");

    const tokenA = ra.text.match(/{{OPF:EMAIL:[a-z0-9]{16}}}/)?.[0];
    const tokenB = rb.text.match(/{{OPF:EMAIL:[a-z0-9]{16}}}/)?.[0];
    expect(tokenA).toBeDefined();
    expect(tokenA).toBe(tokenB!);

    a.dispose();
    b.dispose();
  });

  test("a token minted by one instance restores in another with the same key", async () => {
    const env = { PII_REMOVER_TOKEN_KEY: "fixed-shared-key" };
    const a = await PIIRemover.init({ config: localOnlyConfig(), env });
    const b = await PIIRemover.init({ config: localOnlyConfig(), env });

    const masked = (await a.mask("contact bob@example.com")).text;
    // b re-encounters the same raw PII, rehydrating its vault with the same token.
    await b.mask("bob@example.com is the address");
    const restored = b.restore(masked).text;
    expect(restored).toContain("bob@example.com");

    a.dispose();
    b.dispose();
  });

  test("different keys produce non-interchangeable tokens", async () => {
    const a = await PIIRemover.init({
      config: localOnlyConfig(),
      env: { PII_REMOVER_TOKEN_KEY: "key-one" },
    });
    const b = await PIIRemover.init({
      config: localOnlyConfig(),
      env: { PII_REMOVER_TOKEN_KEY: "key-two" },
    });
    const ta = (await a.mask("user@example.com")).text.match(/{{OPF:EMAIL:[a-z0-9]{16}}}/)?.[0];
    const tb = (await b.mask("user@example.com")).text.match(/{{OPF:EMAIL:[a-z0-9]{16}}}/)?.[0];
    expect(ta).toBeDefined();
    expect(tb).toBeDefined();
    expect(ta).not.toBe(tb);
    a.dispose();
    b.dispose();
  });
});
