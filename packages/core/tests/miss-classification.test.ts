/**
 * ADR-0021: a vault miss is classified, and repair is bounded by the vault.
 *
 * The safety invariant under test is I1 (docs/QUALITY-MEASUREMENT-PLAN.md §8):
 * a mutated token may only resolve when EXACTLY ONE live vault entry lies
 * within a single edit. Two candidates must fail closed — restoring the wrong
 * person's value is a privacy incident, strictly worse than leaving the token.
 */

import { describe, expect, test } from "bun:test";

import {
  Restorer,
  scanTokens,
  scanTokensWithRepairCandidates,
} from "../src/restorer/index.js";
import { isWithinOneEdit } from "../src/restorer/repair.js";
import { resolveMiss, type RepairCandidate } from "../src/restorer/repair.js";
import { deriveTokenKey, tokenEpoch } from "../src/redaction/token-hash.js";
import { VaultManager } from "../src/vault/manager.js";
import type { Detection } from "../src/types.js";

const KEY_A = deriveTokenKey("key-alpha");
const KEY_B = deriveTokenKey("key-bravo");

function detection(text: string): Detection {
  return {
    start: 0,
    end: text.length,
    category: "private_email",
    confidence: 1,
    text,
  };
}

function mintToken(vault: VaultManager, session: string, value: string): string {
  const [assigned] = vault.assign(session, [detection(value)]);
  return assigned?.token ?? "";
}

function mutateHash(token: string, replacement: string): string {
  const chars = [...token];
  const hashEnd = chars.length - 2;
  chars[hashEnd - 1] = replacement;
  return chars.join("");
}

// A token is <head><16-char hash>}}, so the hash is always slice(-18, -2).
const head = (token: string): string => token.slice(0, -18);
const hashOf = (token: string): string => token.slice(-18, -2);

function dropHashChar(token: string): string {
  const hash = hashOf(token);
  return `${head(token)}${hash.slice(0, 8)}${hash.slice(9)}}}`;
}

function insertHashChar(token: string): string {
  const hash = hashOf(token);
  return `${head(token)}${hash.slice(0, 8)}z${hash.slice(8)}}}`;
}

function corruptEpochChar(token: string): string {
  const hash = hashOf(token);
  const swapped = hash[0] === "q" ? "r" : "q";
  return `${head(token)}${swapped}${hash.slice(1)}}}`;
}

function braceStrip(token: string): string {
  return token.replace(/^\{\{/, "{").replace(/\}\}$/, "}");
}

describe("isWithinOneEdit", () => {
  test("identical, one substitution, one insertion and one deletion all qualify", () => {
    expect(isWithinOneEdit("abcd", "abcd")).toBe(true);
    expect(isWithinOneEdit("abcd", "abxd")).toBe(true);
    expect(isWithinOneEdit("abcd", "abcxd")).toBe(true);
    expect(isWithinOneEdit("abcd", "abd")).toBe(true);
  });

  test("two edits or a length gap over one do not qualify", () => {
    expect(isWithinOneEdit("abcd", "axxd")).toBe(false);
    expect(isWithinOneEdit("abcd", "ab")).toBe(false);
  });
});

describe("resolveMiss — classification", () => {
  const epoch = "abc";
  const candidate = (suffix: string, category = "EMAIL"): RepairCandidate => ({
    category,
    hash: `${epoch}${suffix}`,
      token: `{{OPF:${category}:${epoch}${suffix}}}`,
  });
  const observed = (suffix: string, category = "EMAIL") => ({
    category,
    hash: `${epoch}${suffix}`,
  });

  test("an epoch this key never produced is foreign", () => {
    const out = resolveMiss(
      { category: "EMAIL", hash: "zzz0000000000" },
      epoch,
      [candidate("0000000000000")]
    );

    expect(out).toEqual({ kind: "unresolved", cause: "foreign" });
  });

  test("a matching epoch with no near candidate is expired", () => {
    const out = resolveMiss(observed("9999999999999"), epoch, [
      candidate("0000000000000"),
    ]);

    expect(out).toEqual({ kind: "unresolved", cause: "expired" });
  });

  test("a matching epoch with exactly one near candidate repairs", () => {
    const out = resolveMiss(observed("0000000000002"), epoch, [
      candidate("0000000000000"),
    ]);

    expect(out).toEqual({
      kind: "repaired",
      normalizedToken: `{{OPF:EMAIL:${epoch}0000000000000}}`,
    });
  });

  test("SAFETY: two candidates within one edit fail closed, never guess", () => {
    const out = resolveMiss(observed("0000000000002"), epoch, [
      candidate("0000000000000"),
      candidate("0000000000001"),
    ]);

    expect(out).toEqual({ kind: "unresolved", cause: "ambiguous" });
  });

  test("SAFETY: an exact hash under a different category is withheld", () => {
    const out = resolveMiss(observed("0000000000000", "PERSON"), epoch, [
      candidate("0000000000000", "EMAIL"),
    ]);

    expect(out).toEqual({ kind: "unresolved", cause: "expired" });
  });
});

describe("Restorer — end-to-end miss classification", () => {
  test("a token minted under another key is reported as foreign, not dead", () => {
    const minting = new VaultManager({ tokenKey: KEY_A });
    const foreignToken = mintToken(minting, "s1", "alice@example.com");
    const local = new VaultManager({ tokenKey: KEY_B });
    const restorer = new Restorer(local);

    const out = restorer.restore(`saw ${foreignToken} today`, "s1");

    expect(out.foreignCount).toBe(1);
    expect(out.deadTokenCount).toBe(0);
    expect(out.unknownTokenCount).toBe(1);
  });

  test("a token minted by this key whose vault was disposed is reported as dead", () => {
    const vault = new VaultManager({ tokenKey: KEY_A });
    const token = mintToken(vault, "s1", "alice@example.com");
    vault.dispose("s1");
    const restorer = new Restorer(vault);

    const out = restorer.restore(`saw ${token} today`, "s1");

    expect(out.deadTokenCount).toBe(1);
    expect(out.foreignCount).toBe(0);
  });

  test("a single mutated hash character is repaired back to the original value", () => {
    const vault = new VaultManager({ tokenKey: KEY_A });
    const token = mintToken(vault, "s1", "alice@example.com");
    const mutated = mutateHash(token, token.at(-3) === "q" ? "r" : "q");
    const restorer = new Restorer(vault);

    const out = restorer.restore(`mail ${mutated} now`, "s1");

    expect(out.repairedCount).toBe(1);
    expect(out.restoredCount).toBe(1);
    expect(out.text).toBe("mail alice@example.com now");
  });

  test("repair can be switched off, and then the same token is only classified", () => {
    const vault = new VaultManager({ tokenKey: KEY_A });
    const token = mintToken(vault, "s1", "alice@example.com");
    const mutated = mutateHash(token, token.at(-3) === "q" ? "r" : "q");
    const restorer = new Restorer(vault);

    const out = restorer.restore(`mail ${mutated} now`, "s1", { repair: false });

    expect(out.repairedCount).toBe(0);
    expect(out.deadTokenCount).toBe(1);
    expect(out.text).toContain(mutated);
  });

  test("a hash with one character deleted is repaired", () => {
    const vault = new VaultManager({ tokenKey: KEY_A });
    const token = mintToken(vault, "s1", "alice@example.com");
    const restorer = new Restorer(vault);

    const out = restorer.restore(`mail ${dropHashChar(token)} now`, "s1");

    expect(out.repairedCount).toBe(1);
    expect(out.text).toBe("mail alice@example.com now");
  });

  test("a hash with one character inserted is repaired", () => {
    const vault = new VaultManager({ tokenKey: KEY_A });
    const token = mintToken(vault, "s1", "alice@example.com");
    const restorer = new Restorer(vault);

    const out = restorer.restore(`mail ${insertHashChar(token)} now`, "s1");

    expect(out.repairedCount).toBe(1);
    expect(out.text).toBe("mail alice@example.com now");
  });

  test("corruption landing inside the epoch is still repaired, not called foreign", () => {
    const vault = new VaultManager({ tokenKey: KEY_A });
    const token = mintToken(vault, "s1", "alice@example.com");
    const restorer = new Restorer(vault);

    const out = restorer.restore(`mail ${corruptEpochChar(token)} now`, "s1");

    expect(out.repairedCount).toBe(1);
    expect(out.foreignCount).toBe(0);
    expect(out.text).toBe("mail alice@example.com now");
  });

  test("a brace-stripped token restores without needing repair", () => {
    const vault = new VaultManager({ tokenKey: KEY_A });
    const token = mintToken(vault, "s1", "alice@example.com");
    const restorer = new Restorer(vault);

    const out = restorer.restore(`mail ${braceStrip(token)} now`, "s1");

    expect(out.restoredCount).toBe(1);
    expect(out.repairedCount).toBe(0);
    expect(out.text).toBe("mail alice@example.com now");
  });

  test("the general matcher was NOT widened — only the candidate scan sees these", () => {
    const vault = new VaultManager({ tokenKey: KEY_A });
    const token = mintToken(vault, "s1", "alice@example.com");

    for (const mangled of [
      dropHashChar(token),
      insertHashChar(token),
      braceStrip(token),
    ]) {
      expect(scanTokens(mangled)).toEqual([]);
      expect(scanTokensWithRepairCandidates(mangled)).toHaveLength(1);
    }
  });

  test("SAFETY: a candidate with no live vault entry is left byte-for-byte alone", () => {
    const vault = new VaultManager({ tokenKey: KEY_A });
    mintToken(vault, "s1", "alice@example.com");
    const restorer = new Restorer(vault);
    const strayLookalike = "{{OPF:EMAIL:zzzzzzzzzzzzzzzzz}}";

    const out = restorer.restore(`see ${strayLookalike} here`, "s1", {
      unknownTokenHandler: () => "[SHOULD NOT APPLY]",
    });

    expect(out.text).toBe(`see ${strayLookalike} here`);
    expect(out.repairedCount).toBe(0);
  });

  test("repair:false turns the candidate scan off entirely", () => {
    const vault = new VaultManager({ tokenKey: KEY_A });
    const token = mintToken(vault, "s1", "alice@example.com");
    const restorer = new Restorer(vault);
    const mangled = dropHashChar(token);

    const out = restorer.restore(`mail ${mangled} now`, "s1", { repair: false });

    expect(out.matches).toEqual([]);
    expect(out.text).toBe(`mail ${mangled} now`);
  });

  test("the epoch of a token equals the fingerprint of the key that minted it", () => {
    const vault = new VaultManager({ tokenKey: KEY_A });
    const token = mintToken(vault, "s1", "alice@example.com");

    const hash = token.slice(token.lastIndexOf(":") + 1, -2);

    expect(hash.slice(0, 3)).toBe(tokenEpoch(KEY_A));
    expect(hash.slice(0, 3)).not.toBe(tokenEpoch(KEY_B));
  });
});
