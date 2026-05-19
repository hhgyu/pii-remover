import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type PiiRemoverConfig } from "@pii-remover/core";
import { VaultPool } from "../src/vault-pool.js";
import { createSanitizeHandler } from "../src/tools/sanitize.js";
import { createSanitizeBatchHandler } from "../src/tools/sanitize-batch.js";
import { createDesanitizeHandler } from "../src/tools/desanitize.js";
import { createDesanitizeBatchHandler } from "../src/tools/desanitize-batch.js";
import { createAnalyzeHandler } from "../src/tools/analyze.js";
import type {
  SanitizeOutput,
} from "../src/tools/sanitize.js";
import type { SanitizeBatchOutput } from "../src/tools/sanitize-batch.js";
import type { DesanitizeOutput } from "../src/tools/desanitize.js";
import type { DesanitizeBatchOutput } from "../src/tools/desanitize-batch.js";
import type { AnalyzeOutput } from "../src/tools/analyze.js";
import type { StructuredErrorPayload } from "../src/types.js";

function localOnlyConfig(): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
  };
}

function mkPool(): VaultPool {
  return new VaultPool({
    config: localOnlyConfig(),
    warn: () => {},
  });
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe("sanitize tool", () => {
  test("masks email and returns vault_id + categories", async () => {
    const pool = mkPool();
    const handler = createSanitizeHandler({ vaultPool: pool });
    const result = await handler({ text: "contact user@example.com please" });
    expect(isError(result)).toBe(false);
    const out = structured<SanitizeOutput>(result);
    expect(out.text).toBe("contact __OPF_EMAIL_1__ please");
    expect(out.vault_id.length).toBeGreaterThan(0);
    expect(out.token_count).toBe(1);
    expect(out.categories).toEqual({ private_email: 1 });
    await pool.shutdown();
  });

  test("reuses tokens for same PII within the same vault", async () => {
    const pool = mkPool();
    const handler = createSanitizeHandler({ vaultPool: pool });
    const r1 = structured<SanitizeOutput>(
      await handler({ text: "first user@example.com" }),
    );
    const r2 = structured<SanitizeOutput>(
      await handler({ text: "again user@example.com", vault_id: r1.vault_id }),
    );
    expect(r1.vault_id).toBe(r2.vault_id);
    expect(r2.text).toContain("__OPF_EMAIL_1__");
  });

  test("returns vault_not_found when vault_id is unknown", async () => {
    const pool = mkPool();
    const handler = createSanitizeHandler({ vaultPool: pool });
    const result = await handler({ text: "hi", vault_id: "no_such" });
    expect(isError(result)).toBe(true);
    const err = structured<StructuredErrorPayload>(result);
    expect(err.error_code).toBe("vault_not_found");
    expect(err.vault_id).toBe("no_such");
    await pool.shutdown();
  });

  test("masks Korean RRN with valid checksum (rrn category)", async () => {
    const pool = mkPool();
    const handler = createSanitizeHandler({ vaultPool: pool });
    // 921011-1234568: weights [2,3,4,5,6,7,8,9,2,3,4,5], sum=135, check=(11-3)%10=8 → valid
    const result = await handler({ text: "주민번호 921011-1234568 임" });
    const out = structured<SanitizeOutput>(result);
    expect(out.token_count).toBeGreaterThanOrEqual(1);
    expect(out.text).toMatch(/__OPF_RRN_\d+__/);
    expect(out.categories.rrn).toBeGreaterThanOrEqual(1);
    await pool.shutdown();
  });

  test("masks Korean phone (010-XXXX-XXXX)", async () => {
    const pool = mkPool();
    const handler = createSanitizeHandler({ vaultPool: pool });
    const result = await handler({ text: "전화 010-1234-5678 임" });
    const out = structured<SanitizeOutput>(result);
    expect(out.text).toMatch(/__OPF_PHONE_\d+__/);
    expect(out.categories.private_phone).toBeGreaterThanOrEqual(1);
    await pool.shutdown();
  });

  test("zero detections produces token_count=0 and an explanatory content", async () => {
    const pool = mkPool();
    const handler = createSanitizeHandler({ vaultPool: pool });
    const result = (await handler({ text: "hello world" })) as {
      structuredContent: SanitizeOutput;
      content: Array<{ text: string }>;
    };
    expect(result.structuredContent.token_count).toBe(0);
    expect(result.content[0]!.text).toBe("No PII detected.");
    await pool.shutdown();
  });
});

describe("sanitize_batch tool", () => {
  test("processes all texts in a shared vault, dedups across inputs", async () => {
    const pool = mkPool();
    const handler = createSanitizeBatchHandler({ vaultPool: pool });
    const result = await handler({
      texts: ["a user@example.com x", "b user@example.com y", "c noone@nowhere.dev z"],
    });
    expect(isError(result)).toBe(false);
    const out = structured<SanitizeBatchOutput>(result);
    expect(out.results).toHaveLength(3);
    expect(out.results[0]!.text).toContain("__OPF_EMAIL_1__");
    expect(out.results[1]!.text).toContain("__OPF_EMAIL_1__");
    expect(out.results[2]!.text).toContain("__OPF_EMAIL_2__");
    expect(out.results[0]!.vault_id).toBe(out.vault_id);
    await pool.shutdown();
  });

  test("uses provided vault_id when valid", async () => {
    const pool = mkPool();
    const sanitize = createSanitizeHandler({ vaultPool: pool });
    const batch = createSanitizeBatchHandler({ vaultPool: pool });
    const seed = structured<SanitizeOutput>(
      await sanitize({ text: "seed user@example.com" }),
    );
    const out = structured<SanitizeBatchOutput>(
      await batch({ texts: ["x user@example.com"], vault_id: seed.vault_id }),
    );
    expect(out.vault_id).toBe(seed.vault_id);
    expect(out.results[0]!.text).toBe("x __OPF_EMAIL_1__");
    await pool.shutdown();
  });

  test("returns vault_not_found for unknown vault_id", async () => {
    const pool = mkPool();
    const handler = createSanitizeBatchHandler({ vaultPool: pool });
    const result = await handler({ texts: ["hi"], vault_id: "missing" });
    expect(isError(result)).toBe(true);
    await pool.shutdown();
  });
});

describe("desanitize tool", () => {
  test("restores tokens back to original PII", async () => {
    const pool = mkPool();
    const sanitize = createSanitizeHandler({ vaultPool: pool });
    const desanitize = createDesanitizeHandler({ vaultPool: pool });
    const masked = structured<SanitizeOutput>(
      await sanitize({ text: "say hi to user@example.com please" }),
    );
    const restored = structured<DesanitizeOutput>(
      await desanitize({ text: masked.text, vault_id: masked.vault_id }),
    );
    expect(restored.text).toBe("say hi to user@example.com please");
    expect(restored.restored_count).toBe(1);
    expect(restored.unknown_token_count).toBe(0);
    await pool.shutdown();
  });

  test("returns vault_not_found when vault_id is missing", async () => {
    const pool = mkPool();
    const desanitize = createDesanitizeHandler({ vaultPool: pool });
    const result = await desanitize({
      text: "__OPF_EMAIL_1__",
      vault_id: "unknown",
    });
    expect(isError(result)).toBe(true);
    const err = structured<StructuredErrorPayload>(result);
    expect(err.error_code).toBe("vault_not_found");
    await pool.shutdown();
  });

  test("unknown_token_count when token isn't in vault", async () => {
    const pool = mkPool();
    const sanitize = createSanitizeHandler({ vaultPool: pool });
    const desanitize = createDesanitizeHandler({ vaultPool: pool });
    const seed = structured<SanitizeOutput>(
      await sanitize({ text: "user@example.com" }),
    );
    const out = structured<DesanitizeOutput>(
      await desanitize({ text: "__OPF_EMAIL_99__", vault_id: seed.vault_id }),
    );
    expect(out.restored_count).toBe(0);
    expect(out.unknown_token_count).toBe(1);
    await pool.shutdown();
  });
});

describe("desanitize_batch tool", () => {
  test("restores tokens across multiple texts using a single vault", async () => {
    const pool = mkPool();
    const sanitize = createSanitizeHandler({ vaultPool: pool });
    const batch = createDesanitizeBatchHandler({ vaultPool: pool });
    const m1 = structured<SanitizeOutput>(
      await sanitize({ text: "a user@example.com x" }),
    );
    const m2 = structured<SanitizeOutput>(
      await sanitize({
        text: "b user@example.com y",
        vault_id: m1.vault_id,
      }),
    );
    const out = structured<DesanitizeBatchOutput>(
      await batch({ texts: [m1.text, m2.text], vault_id: m1.vault_id }),
    );
    expect(out.results[0]!.text).toBe("a user@example.com x");
    expect(out.results[1]!.text).toBe("b user@example.com y");
    expect(out.results[0]!.restored_count).toBe(1);
    expect(out.results[1]!.restored_count).toBe(1);
    await pool.shutdown();
  });

  test("returns vault_not_found for unknown vault_id", async () => {
    const pool = mkPool();
    const handler = createDesanitizeBatchHandler({ vaultPool: pool });
    const result = await handler({
      texts: ["__OPF_EMAIL_1__"],
      vault_id: "no_such",
    });
    expect(isError(result)).toBe(true);
    await pool.shutdown();
  });
});

describe("analyze tool", () => {
  test("returns detections without creating a vault entry", async () => {
    const pool = mkPool();
    const handler = createAnalyzeHandler({
      initOptions: { config: localOnlyConfig(), warn: () => {} },
    });
    const sizeBefore = pool.size();
    const result = await handler({ text: "ping me at user@example.com" });
    expect(isError(result)).toBe(false);
    const out = structured<AnalyzeOutput>(result);
    expect(out.detections.length).toBeGreaterThanOrEqual(1);
    expect(out.detections[0]!.category).toBe("private_email");
    expect(pool.size()).toBe(sizeBefore);
    await pool.shutdown();
  });

  test("never includes original PII text in the structured response", async () => {
    const handler = createAnalyzeHandler({
      initOptions: { config: localOnlyConfig(), warn: () => {} },
    });
    const result = await handler({ text: "secret user@example.com here" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("user@example.com");
  });

  test("returns empty detections array when text has no PII", async () => {
    const handler = createAnalyzeHandler({
      initOptions: { config: localOnlyConfig(), warn: () => {} },
    });
    const result = await handler({ text: "hello world" });
    const out = structured<AnalyzeOutput>(result);
    expect(out.detections).toEqual([]);
  });
});
