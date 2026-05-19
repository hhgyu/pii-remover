import { describe, expect, test } from "bun:test";
import { VaultManager } from "../src/vault/manager.js";
import type { Detection, PIICategory } from "../src/types.js";

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
    expect(a[0]!.token).toBe("__OPF_PERSON_1__");
    expect(b[0]!.token).toBe("__OPF_PERSON_1__");
    expect(v.size("s1")).toBe(1);
  });

  test("whitespace differences canonicalize to the same token", () => {
    const v = new VaultManager();
    const a = v.assign("s1", [det(0, 5, "private_person", "Alice")]);
    const b = v.assign("s1", [det(10, 17, "private_person", "  Alice  ")]);
    expect(b[0]!.token).toBe(a[0]!.token);
  });

  test("different surface text advances the index", () => {
    const v = new VaultManager();
    const r = v.assign("s1", [
      det(0, 5, "private_person", "Alice"),
      det(10, 13, "private_person", "Bob"),
    ]);
    expect(r[0]!.token).toBe("__OPF_PERSON_1__");
    expect(r[1]!.token).toBe("__OPF_PERSON_2__");
  });

  test("different label uses an independent index family", () => {
    const v = new VaultManager();
    const r = v.assign("s1", [
      det(0, 3, "private_person", "foo"),
      det(10, 13, "secret", "foo"),
    ]);
    expect(r[0]!.token).toBe("__OPF_PERSON_1__");
    expect(r[1]!.token).toBe("__OPF_SECRET_1__");
  });
});

describe("VaultManager — session isolation (ADR-0003)", () => {
  test("PERSON_1 in session A and session B are independent", () => {
    const v = new VaultManager();
    const a = v.assign("A", [det(0, 5, "private_person", "Alice")]);
    const b = v.assign("B", [det(0, 3, "private_person", "Bob")]);
    expect(a[0]!.token).toBe("__OPF_PERSON_1__");
    expect(b[0]!.token).toBe("__OPF_PERSON_1__");
    const vaA = v.getOrCreate("A");
    const vaB = v.getOrCreate("B");
    expect(vaA.vault_id).not.toBe(vaB.vault_id);
    expect(v.lookup("A", "__OPF_PERSON_1__")!.text).toBe("Alice");
    expect(v.lookup("B", "__OPF_PERSON_1__")!.text).toBe("Bob");
  });

  test("dispose only removes the targeted session", () => {
    const v = new VaultManager();
    v.assign("A", [det(0, 5, "private_email", "a@b.c")]);
    v.assign("B", [det(0, 5, "private_email", "x@y.z")]);
    v.dispose("A");
    expect(v.has("A")).toBe(false);
    expect(v.has("B")).toBe(true);
    expect(v.lookup("A", "__OPF_EMAIL_1__")).toBeNull();
    expect(v.lookup("B", "__OPF_EMAIL_1__")!.text).toBe("x@y.z");
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
    expect(vault.schema_version).toBe("opf.reversible.v1");
    expect(typeof vault.vault_id).toBe("string");
    expect(vault.vault_id.length).toBeGreaterThan(8);
  });

  test("lookup returns null for unknown token", () => {
    const v = new VaultManager();
    v.assign("s1", [det(0, 5, "private_email", "u@e.c")]);
    expect(v.lookup("s1", "__OPF_EMAIL_99__")).toBeNull();
  });
});
