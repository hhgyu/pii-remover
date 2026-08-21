import { describe, expect, test } from "bun:test";
import { LocalRegexBackend } from "@pii-remover/core";
import {
  DEFAULT_SESSION_ID,
  ProxySessionPool,
  SESSION_HEADER,
} from "../src/session.js";

function backends() {
  return [new LocalRegexBackend()];
}

describe("ProxySessionPool — default + per-session vault management", () => {
  test("default session shared across all calls without X-PII-Session header", async () => {
    const pool = new ProxySessionPool({ backends: backends() });
    const a = await pool.get(new Headers());
    const b = await pool.get(new Headers());
    expect(a.sessionId).toBe(DEFAULT_SESSION_ID);
    expect(b.sessionId).toBe(DEFAULT_SESSION_ID);
    expect(a.remover).toBe(b.remover);
    expect(pool.size()).toBe(1);
    await pool.disposeAll();
  });

  test("X-PII-Session header isolates vaults", async () => {
    const pool = new ProxySessionPool({ backends: backends() });
    const headerA = new Headers({ [SESSION_HEADER]: "alice" });
    const headerB = new Headers({ [SESSION_HEADER]: "bob" });
    const a = await pool.get(headerA);
    const b = await pool.get(headerB);
    expect(a.sessionId).toBe("proxy:alice");
    expect(b.sessionId).toBe("proxy:bob");
    expect(a.remover).not.toBe(b.remover);
    expect(pool.size()).toBe(2);
    await pool.disposeAll();
  });

  test("multi-provider vault sharing within one session", async () => {
    const pool = new ProxySessionPool({ backends: backends() });
    const { remover } = await pool.get(new Headers());
    const masked = await remover.mask("alice@example.com here");
    expect(masked.text).toMatch(/{{OPF:EMAIL:[a-z0-9]{16}}}/);

    const restored = remover.restore(masked.text);
    expect(restored.text).toContain("alice@example.com");
    await pool.disposeAll();
  });

  test("empty / whitespace / oversized header values fall back to default", async () => {
    const pool = new ProxySessionPool({ backends: backends() });
    const tooLong = "a".repeat(200);
    const cases = [
      new Headers({ [SESSION_HEADER]: "" }),
      new Headers({ [SESSION_HEADER]: "   " }),
      new Headers({ [SESSION_HEADER]: tooLong }),
    ];
    for (const h of cases) {
      const r = await pool.get(h);
      expect(r.sessionId).toBe(DEFAULT_SESSION_ID);
    }
    expect(pool.size()).toBe(1);
    await pool.disposeAll();
  });

  test("disposeAll drains all sessions", async () => {
    const pool = new ProxySessionPool({ backends: backends() });
    await pool.get(new Headers({ [SESSION_HEADER]: "s1" }));
    await pool.get(new Headers({ [SESSION_HEADER]: "s2" }));
    expect(pool.size()).toBe(2);
    await pool.disposeAll();
    expect(pool.size()).toBe(0);
  });
});
