/**
 * VaultPool — server-internal `Map<vault_id, PIIRemover>` with LRU + TTL.
 *
 * ADR-0016 §4:
 *   - `vault_id` is server-generated and opaque, independent of MCP-Session-Id.
 *   - `sanitize` without vault_id → create new PIIRemover, return its
 *     `sessionId` as `vault_id`.
 *   - `sanitize` / `desanitize` with vault_id → look up existing PIIRemover.
 *   - Missing or expired vault → throw `VaultNotFoundError` / `VaultExpiredError`.
 *   - LRU eviction at maxSize (default 100).
 *   - TTL eviction after idle period (default 1h).
 *   - All vaults in-memory only (ADR-0003 invariant preserved).
 */

import { PIIRemover, type PIIRemoverInitOptions } from "@pii-remover/core";
import { VaultExpiredError, VaultNotFoundError } from "./errors.js";
import type { VaultPoolOptions } from "./types.js";

interface PoolEntry {
  remover: PIIRemover;
  lastAccess: number;
}

const DEFAULT_MAX_SIZE = 100;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_SWEEP_DIVISOR = 4;

export class VaultPool {
  private readonly pool = new Map<string, PoolEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly initOpts: Pick<
    PIIRemoverInitOptions,
    "config" | "configPath" | "env" | "warn"
  >;
  private readonly onDispose: VaultPoolOptions["onDispose"];
  private readonly now: () => number;
  private sweeperHandle: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: VaultPoolOptions = {}) {
    this.maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.sweepIntervalMs =
      opts.sweepIntervalMs ?? Math.max(1000, Math.floor(this.ttlMs / DEFAULT_SWEEP_DIVISOR));
    this.initOpts = {};
    if (opts.config !== undefined) this.initOpts.config = opts.config;
    if (opts.configPath !== undefined) this.initOpts.configPath = opts.configPath;
    if (opts.env !== undefined) this.initOpts.env = opts.env;
    if (opts.warn !== undefined) this.initOpts.warn = opts.warn;
    this.onDispose = opts.onDispose;
    this.now = opts.now ?? Date.now;
    if (this.maxSize <= 0) {
      throw new Error(`VaultPool: maxSize must be > 0 (got ${this.maxSize})`);
    }
    if (this.ttlMs <= 0) {
      throw new Error(`VaultPool: ttlMs must be > 0 (got ${this.ttlMs})`);
    }
  }

  /**
   * Resolve an existing vault by ID, or create a new one if `vaultId` is
   * undefined.
   *
   * @throws VaultNotFoundError when `vaultId` is provided but not in pool.
   * @throws VaultExpiredError when `vaultId` is provided but its entry exceeds TTL.
   */
  async resolve(vaultId?: string): Promise<PIIRemover> {
    this.assertNotDisposed();
    if (vaultId !== undefined && vaultId !== null && vaultId !== "") {
      const entry = this.pool.get(vaultId);
      if (!entry) throw new VaultNotFoundError(vaultId);
      const idleMs = this.now() - entry.lastAccess;
      if (idleMs > this.ttlMs) {
        this.evict(vaultId, "ttl");
        throw new VaultExpiredError(vaultId);
      }
      entry.lastAccess = this.now();
      return entry.remover;
    }
    if (this.pool.size >= this.maxSize) {
      this.evictOldest("lru");
    }
    const remover = await PIIRemover.init(this.initOpts);
    this.pool.set(remover.sessionId, { remover, lastAccess: this.now() });
    return remover;
  }

  /**
   * Explicit dispose of one vault. Returns true if disposed, false if not
   * present.
   */
  dispose(vaultId: string): boolean {
    return this.evict(vaultId, "explicit");
  }

  size(): number {
    return this.pool.size;
  }

  /**
   * Run one sweep pass: evict all entries whose `lastAccess` exceeds TTL.
   * Returns the number of vaults evicted.
   */
  sweep(): number {
    if (this.disposed) return 0;
    const now = this.now();
    let evicted = 0;
    for (const [id, entry] of this.pool) {
      if (now - entry.lastAccess > this.ttlMs) {
        this.evict(id, "ttl");
        evicted += 1;
      }
    }
    return evicted;
  }

  /**
   * Start the background sweeper. Safe to call multiple times — second call
   * is a no-op.
   */
  startSweeper(): void {
    if (this.sweeperHandle !== null || this.disposed) return;
    this.sweeperHandle = setInterval(() => {
      this.sweep();
    }, this.sweepIntervalMs);
    // Allow Node process to exit even if sweeper is pending.
    if (typeof this.sweeperHandle === "object" && this.sweeperHandle !== null) {
      const handle = this.sweeperHandle as { unref?: () => void };
      if (typeof handle.unref === "function") handle.unref();
    }
  }

  /**
   * Stop the background sweeper without disposing vaults.
   */
  stopSweeper(): void {
    if (this.sweeperHandle !== null) {
      clearInterval(this.sweeperHandle);
      this.sweeperHandle = null;
    }
  }

  /**
   * Dispose every vault and stop the sweeper. After this, the pool refuses
   * all further `resolve` calls.
   */
  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSweeper();
    const ids = [...this.pool.keys()];
    for (const id of ids) {
      this.evict(id, "shutdown");
    }
  }

  private evict(
    vaultId: string,
    reason: "lru" | "ttl" | "explicit" | "shutdown",
  ): boolean {
    const entry = this.pool.get(vaultId);
    if (!entry) return false;
    try {
      entry.remover.dispose();
    } catch {
      // Already disposed or noop; do not block eviction.
    }
    this.pool.delete(vaultId);
    if (this.onDispose) {
      try {
        this.onDispose(vaultId, reason);
      } catch {
        // Hook errors must not propagate.
      }
    }
    return true;
  }

  private evictOldest(reason: "lru"): void {
    let oldestId: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [id, entry] of this.pool) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestId = id;
      }
    }
    if (oldestId !== null) this.evict(oldestId, reason);
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("VaultPool: shutdown — cannot resolve more vaults");
    }
  }
}
