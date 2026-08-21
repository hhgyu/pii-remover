import { describe, expect, test } from "bun:test";
import { VaultManager } from "../src/vault/manager.js";
import type { Detection, PIICategory } from "../src/types.js";

const TOKEN_RE = /^{{OPF:[A-Z_]+:[a-z0-9]{16}}}$/;
const EMAIL_UNKNOWN = "{{OPF:EMAIL:ffffffffffffffff}}";

function det(
  start: number,
  end: number,
  category: PIICategory,
  text: string
): Detection {
  return { start, end, category, confidence: 0.9, text };
}

describe("VaultManager — dedup and indexing (ADR-0003)", () => {
  test("same (label, canonical_text) reuses the same token", () => {
    const v = new VaultManager();
    const a = v.assign("s1", [det(0, 5, "private_person", "Alice")]);
    const b = v.assign("s1", [det(20, 25, "private_person", "Alice")]);
    expect(a[0]!.token).toMatch(TOKEN_RE);
    expect(b[0]!.token).toBe(a[0]!.token);
    expect(v.size("s1")).toBe(1);
  });

  test("whitespace differences canonicalize to the same token", () => {
    const v = new VaultManager();
    const a = v.assign("s1", [det(0, 5, "private_person", "Alice")]);
    const b = v.assign("s1", [det(10, 17, "private_person", "  Alice  ")]);
    expect(b[0]!.token).toBe(a[0]!.token);
  });

  test("different surface text yields different deterministic tokens", () => {
    const v = new VaultManager();
    const r = v.assign("s1", [
      det(0, 5, "private_person", "Alice"),
      det(10, 13, "private_person", "Bob"),
    ]);
    expect(r[0]!.token).toMatch(/^{{OPF:PERSON:[a-z0-9]{16}}}$/);
    expect(r[1]!.token).toMatch(/^{{OPF:PERSON:[a-z0-9]{16}}}$/);
    expect(r[0]!.token).not.toBe(r[1]!.token);
  });

  test("different label uses category-specific token labels", () => {
    const v = new VaultManager();
    const r = v.assign("s1", [
      det(0, 3, "private_person", "foo"),
      det(10, 13, "secret", "foo"),
    ]);
    expect(r[0]!.token).toMatch(/^{{OPF:PERSON:[a-z0-9]{16}}}$/);
    expect(r[1]!.token).toMatch(/^{{OPF:SECRET:[a-z0-9]{16}}}$/);
    expect(r[0]!.token).not.toBe(r[1]!.token);
  });
});

describe("VaultManager — session isolation (ADR-0003)", () => {
  test("same category tokens in session A and session B are independent", () => {
    const v = new VaultManager();
    const a = v.assign("A", [det(0, 5, "private_person", "Alice")]);
    const b = v.assign("B", [det(0, 3, "private_person", "Bob")]);
    expect(a[0]!.token).toMatch(/^{{OPF:PERSON:[a-z0-9]{16}}}$/);
    expect(b[0]!.token).toMatch(/^{{OPF:PERSON:[a-z0-9]{16}}}$/);
    const vaA = v.getOrCreate("A");
    const vaB = v.getOrCreate("B");
    expect(vaA.vault_id).not.toBe(vaB.vault_id);
    expect(v.lookup("A", a[0]!.token)!.text).toBe("Alice");
    expect(v.lookup("B", b[0]!.token)!.text).toBe("Bob");
  });

  test("dispose only removes the targeted session", () => {
    const v = new VaultManager();
    v.assign("A", [det(0, 5, "private_email", "a@b.c")]);
    const b = v.assign("B", [det(0, 5, "private_email", "x@y.z")]);
    v.dispose("A");
    expect(v.has("A")).toBe(false);
    expect(v.has("B")).toBe(true);
    expect(v.lookup("A", b[0]!.token)).toBeNull();
    expect(v.lookup("B", b[0]!.token)!.text).toBe("x@y.z");
  });
});

describe("VaultManager — overlap protection (ADR-0003 §6.2)", () => {
  test("throws RangeError on overlapping spans", () => {
    const v = new VaultManager();
    expect(() =>
      v.assign("s1", [
        det(0, 5, "private_person", "Alice"),
        det(3, 8, "secret", "ice s"),
      ])
    ).toThrow(RangeError);
  });

  test("touching spans (end == next start) are allowed", () => {
    const v = new VaultManager();
    const r = v.assign("s1", [
      det(0, 5, "private_person", "Alice"),
      det(5, 10, "private_person", "Bobby"),
    ]);
    expect(r).toHaveLength(2);
  });
});

describe("VaultManager — schema and ids", () => {
  test("new vault carries schema_version and a UUID-like vault_id", () => {
    const v = new VaultManager();
    const vault = v.getOrCreate("s1");
    expect(vault.schema_version).toBe("opf.reversible.v3");
    expect(typeof vault.vault_id).toBe("string");
    expect(vault.vault_id.length).toBeGreaterThan(8);
  });

  test("lookup returns null for unknown token", () => {
    const v = new VaultManager();
    v.assign("s1", [det(0, 5, "private_email", "u@e.c")]);
    expect(v.lookup("s1", EMAIL_UNKNOWN)).toBeNull();
  });
});
