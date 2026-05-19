import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AuditEmitter,
  aggregateAuditCategories,
  type AuditEntry,
} from "../src/audit/index.js";
import { LocalRegexBackend } from "../src/backend/local-regex.js";
import { SingleStrategy } from "../src/backend/strategy.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { PIIRemover } from "../src/pii-remover.js";

function mkConfig() {
  return { ...DEFAULT_CONFIG };
}

function silentWarn(): (msg: string) => void {
  return () => {};
}

function makeRemover(audit?: AuditEmitter): Promise<PIIRemover> {
  return PIIRemover.init({
    sessionId: "audit-test",
    config: mkConfig(),
    env: {},
    warn: silentWarn(),
    strategy: new SingleStrategy(new LocalRegexBackend()),
    audit,
  });
}

describe("AuditEmitter", () => {
  test("is disabled by default", () => {
    const entries: AuditEntry[] = [];
    const emitter = new AuditEmitter({ stream: (entry) => entries.push(entry) });
    emitter.maskEvent({ vault_id: "vault-1" });
    emitter.dispose();
    expect(entries).toEqual([]);
  });

  test("stream callback receives structured entries with ISO timestamps", () => {
    const entries: AuditEntry[] = [];
    const emitter = new AuditEmitter({
      enabled: true,
      stream: (entry) => entries.push(entry),
    });

    emitter.maskEvent({
      vault_id: "vault-1",
      session_id: "session-1",
      request_id: "request-1",
      categories: { private_email: 2, rrn: 1 },
      backend_name: "local-regex",
      latency_ms: 1.5,
      provider: "openai",
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: "mask",
      vault_id: "vault-1",
      session_id: "session-1",
      request_id: "request-1",
      categories: { private_email: 2, rrn: 1 },
      backend_name: "local-regex",
      policy_result: "masked",
      provider: "openai",
    });
    expect(Date.parse(entries[0]!.timestamp)).not.toBeNaN();
  });

  test("logPath writes JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "pii-remover-audit-"));
    try {
      const logPath = join(dir, "audit.jsonl");
      const emitter = new AuditEmitter({ enabled: true, logPath });
      emitter.bypassEvent({ vault_id: "vault-1", backend_name: "local" });
      emitter.errorEvent({ error: "backend unavailable" });

      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        event: "bypass",
        policy_result: "bypassed",
      });
      expect(JSON.parse(lines[1]!)).toMatchObject({ event: "error" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("categories are aggregated by category only", () => {
    const categories = aggregateAuditCategories([
      { category: "private_email" },
      { category: "private_email" },
      { category: "rrn" },
    ]);
    expect(categories).toEqual({ private_email: 2, rrn: 1 });
  });

  test("PII plaintext does not appear in audit entries", () => {
    const entries: AuditEntry[] = [];
    const emitter = new AuditEmitter({
      enabled: true,
      stream: (entry) => entries.push(entry),
    });
    emitter.maskEvent({ categories: { private_email: 1 } });
    emitter.errorEvent({ error: "failed for user@example.com and 920101-1234562" });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain("920101-1234562");
    expect(serialized).toContain("private_email");
  });

  test("dispose is idempotent", () => {
    const entries: AuditEntry[] = [];
    const emitter = new AuditEmitter({
      enabled: true,
      stream: (entry) => entries.push(entry),
    });
    emitter.dispose();
    emitter.dispose();
    emitter.maskEvent({ vault_id: "vault-1" });
    expect(entries).toEqual([]);
  });

  test("convenience methods produce correct event types", () => {
    const entries: AuditEntry[] = [];
    const emitter = new AuditEmitter({
      enabled: true,
      stream: (entry) => entries.push(entry),
    });

    emitter.maskEvent({});
    emitter.restoreEvent({ restored_count: 1 });
    emitter.bypassEvent({});
    emitter.blockEvent({ error: "closed" });
    emitter.errorEvent({ error: "boom" });

    expect(entries.map((entry) => entry.event)).toEqual([
      "mask",
      "restore",
      "bypass",
      "block",
      "error",
    ]);
  });
});

describe("PIIRemover audit integration", () => {
  test("mask emits audit event when emitter is provided", async () => {
    const entries: AuditEntry[] = [];
    const audit = new AuditEmitter({
      enabled: true,
      stream: (entry) => entries.push(entry),
    });
    const pii = await makeRemover(audit);

    const result = await pii.mask(
      "email a@example.com b@example.com RRN 920101-1234562",
      { request_id: "req-mask", provider: "anthropic" }
    );

    expect(result.text).not.toContain("a@example.com");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: "mask",
      request_id: "req-mask",
      session_id: "audit-test",
      provider: "anthropic",
      policy_result: "masked",
      categories: { private_email: 2, rrn: 1 },
    });
    expect(JSON.stringify(entries[0])).not.toContain("a@example.com");
    pii.dispose();
  });

  test("restore emits audit event", async () => {
    const entries: AuditEntry[] = [];
    const audit = new AuditEmitter({
      enabled: true,
      stream: (entry) => entries.push(entry),
    });
    const pii = await makeRemover(audit);

    const masked = await pii.mask("contact user@example.com");
    const restored = pii.restore(`${masked.text} __OPF_EMAIL_999__`, {
      request_id: "req-restore",
      provider: "openai",
    });

    expect(restored.text).toContain("user@example.com");
    expect(entries.at(-1)).toMatchObject({
      event: "restore",
      request_id: "req-restore",
      provider: "openai",
      policy_result: "restored",
      restored_count: 1,
      unknown_token_count: 1,
    });
    pii.dispose();
  });

  test("no emitter preserves current behavior", async () => {
    const pii = await makeRemover();
    const masked = await pii.mask("contact user@example.com");
    const restored = pii.restore(masked.text);

    expect(masked.bypassed).toBe(false);
    expect(masked.text).toBe("contact __OPF_EMAIL_1__");
    expect(restored.text).toBe("contact user@example.com");
    pii.dispose();
  });

  test("PII_REMOVER_AUDIT=true enables audit regardless of config", async () => {
    const entries: AuditEntry[] = [];
    const audit = new AuditEmitter({
      enabled: true,
      stream: (e) => entries.push(e),
    });
    const pii = await PIIRemover.init({
      sessionId: "audit-env-test",
      config: {
        ...DEFAULT_CONFIG,
        audit: { enabled: false, log_path: null, audit_env: "PII_REMOVER_AUDIT" },
      },
      env: { PII_REMOVER_AUDIT: "true" },
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
      audit,
    });
    await pii.mask("call 010-1234-5678");
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!.event).toBe("mask");
    pii.dispose();
  });

  test("PII_REMOVER_AUDIT=false disables audit even when config has enabled:true", async () => {
    const entries: AuditEntry[] = [];
    const audit = new AuditEmitter({
      enabled: false,
      stream: (e) => entries.push(e),
    });
    const pii = await PIIRemover.init({
      sessionId: "audit-env-test",
      config: {
        ...DEFAULT_CONFIG,
        audit: { enabled: true, log_path: null, audit_env: "PII_REMOVER_AUDIT" },
      },
      env: { PII_REMOVER_AUDIT: "false" },
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
      audit,
    });
    await pii.mask("call 010-1234-5678");
    expect(entries.length).toBe(0);
    pii.dispose();
  });
});
