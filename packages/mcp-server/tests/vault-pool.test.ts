import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type PiiRemoverConfig } from "@pii-remover/core";
import { VaultPool } from "../src/vault-pool.js";
import { VaultExpiredError, VaultNotFoundError } from "../src/errors.js";

function localOnlyConfig(): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
  };
}

const baseOpts = () => ({
  config: localOnlyConfig(),
  warn: () => {},
});

describe("VaultPool - basic resolve / size", () => {
  test("resolve() without vault_id creates a new vault", async () => {
    const pool = new VaultPool(baseOpts());
    const remover = await pool.resolve();
    expect(remover).toBeDefined();
    expect(typeof remover.sessionId).toBe("string");
    expect(pool.size()).toBe(1);
    await pool.shutdown();
  });

  test("resolve() with known vault_id returns the same PIIRemover", async () => {
    const pool = new VaultPool(baseOpts());
    const r1 = await pool.resolve();
    const r2 = await pool.resolve(r1.sessionId);
    expect(r2).toBe(r1);
    expect(pool.size()).toBe(1);
    await pool.shutdown();
  });

  test("resolve() with unknown vault_id throws VaultNotFoundError", async () => {
    const pool = new VaultPool(baseOpts());
    await expect(pool.resolve("does_not_exist")).rejects.toThrow(VaultNotFoundError);
    await pool.shutdown();
  });

  test("resolve() with empty string vault_id is treated as undefined (creates new)", async () => {
    const pool = new VaultPool(baseOpts());
    const r = await pool.resolve("");
    expect(pool.size()).toBe(1);
    expect(r.sessionId.length).toBeGreaterThan(0);
    await pool.shutdown();
  });

  test("multiple new vaults are independent", async () => {
    const pool = new VaultPool(baseOpts());
    const r1 = await pool.resolve();
    const r2 = await pool.resolve();
    expect(r1.sessionId).not.toBe(r2.sessionId);
    expect(pool.size()).toBe(2);
    await pool.shutdown();
  });
});

describe("VaultPool - TTL expiry", () => {
  test("entry past ttlMs throws VaultExpiredError and is evicted", async () => {
    let now = 0;
    const pool = new VaultPool({
      ...baseOpts(),
      ttlMs: 1000,
      now: () => now,
    });
    const r = await pool.resolve();
    expect(pool.size()).toBe(1);
    now = 2000;
    await expect(pool.resolve(r.sessionId)).rejects.toThrow(VaultExpiredError);
    expect(pool.size()).toBe(0);
    await pool.shutdown();
  });

  test("resolve refreshes lastAccess so vault stays alive", async () => {
    let now = 0;
    const pool = new VaultPool({
      ...baseOpts(),
      ttlMs: 1000,
      now: () => now,
    });
    const r = await pool.resolve();
    now = 500;
    await pool.resolve(r.sessionId);
    now = 1400;
    const r2 = await pool.resolve(r.sessionId);
    expect(r2).toBe(r);
    await pool.shutdown();
  });

  test("sweep() evicts expired entries en masse", async () => {
    let now = 0;
    const pool = new VaultPool({
      ...baseOpts(),
      ttlMs: 100,
      now: () => now,
    });
    await pool.resolve();
    await pool.resolve();
    expect(pool.size()).toBe(2);
    now = 1000;
    const evicted = pool.sweep();
    expect(evicted).toBe(2);
    expect(pool.size()).toBe(0);
    await pool.shutdown();
  });
});

describe("VaultPool - LRU eviction at maxSize", () => {
  test("evicts the oldest vault when maxSize is reached", async () => {
    let now = 0;
    const pool = new VaultPool({
      ...baseOpts(),
      maxSize: 2,
      now: () => ++now,
    });
    const r1 = await pool.resolve();
    const r2 = await pool.resolve();
    const r3 = await pool.resolve();
    expect(pool.size()).toBe(2);
    await expect(pool.resolve(r1.sessionId)).rejects.toThrow(VaultNotFoundError);
    await pool.resolve(r2.sessionId);
    await pool.resolve(r3.sessionId);
    await pool.shutdown();
  });

  test("onDispose hook fires with reason='lru' on eviction", async () => {
    let now = 0;
    const evicted: Array<{ id: string; reason: string }> = [];
    const pool = new VaultPool({
      ...baseOpts(),
      maxSize: 1,
      now: () => ++now,
      onDispose: (id, reason) => evicted.push({ id, reason }),
    });
    const r1 = await pool.resolve();
    await pool.resolve();
    expect(evicted).toHaveLength(1);
    expect(evicted[0]!.id).toBe(r1.sessionId);
    expect(evicted[0]!.reason).toBe("lru");
    await pool.shutdown();
  });
});

describe("VaultPool - explicit dispose / shutdown", () => {
  test("dispose() returns true for existing vault, false otherwise", async () => {
    const pool = new VaultPool(baseOpts());
    const r = await pool.resolve();
    expect(pool.dispose(r.sessionId)).toBe(true);
    expect(pool.dispose(r.sessionId)).toBe(false);
    expect(pool.size()).toBe(0);
    await pool.shutdown();
  });

  test("onDispose fires with reason='explicit'", async () => {
    const seen: string[] = [];
    const pool = new VaultPool({
      ...baseOpts(),
      onDispose: (_, reason) => seen.push(reason),
    });
    const r = await pool.resolve();
    pool.dispose(r.sessionId);
    expect(seen).toEqual(["explicit"]);
    await pool.shutdown();
  });

  test("shutdown disposes all vaults and refuses further resolves", async () => {
    const reasons: string[] = [];
    const pool = new VaultPool({
      ...baseOpts(),
      onDispose: (_, r) => reasons.push(r),
    });
    await pool.resolve();
    await pool.resolve();
    await pool.shutdown();
    expect(reasons.filter((r) => r === "shutdown")).toHaveLength(2);
    await expect(pool.resolve()).rejects.toThrow(/shutdown/);
  });

  test("shutdown is idempotent", async () => {
    const pool = new VaultPool(baseOpts());
    await pool.shutdown();
    await pool.shutdown();
    expect(pool.size()).toBe(0);
  });
});

describe("VaultPool - construction guards", () => {
  test("rejects maxSize <= 0", () => {
    expect(() => new VaultPool({ ...baseOpts(), maxSize: 0 })).toThrow();
    expect(() => new VaultPool({ ...baseOpts(), maxSize: -1 })).toThrow();
  });

  test("rejects ttlMs <= 0", () => {
    expect(() => new VaultPool({ ...baseOpts(), ttlMs: 0 })).toThrow();
  });
});
