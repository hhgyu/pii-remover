/**
 * Token-grammar parity guard.
 *
 * `packages/core/src/token/format.ts` is the single source of truth for the
 * `__OPF_<CATEGORY>__<HASH>__` grammar. Before this guard existed the hash
 * length was hardcoded as `{16}` in three unrelated files, so changing
 * TOKEN_HASH_LENGTH would have silently broken the plugin's dead-token sweep
 * and the secret scanner's self-exclusion with no failing test.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOKEN_HASH_PATTERN,
  TOKEN_LENIENT_PATTERN,
  TOKEN_LENIENT_REGEX,
  TOKEN_STRICT_PATTERN,
  TOKEN_STRICT_REGEX,
  formatToken,
} from "../src/token/format.js";
import { TOKEN_HASH_LENGTH } from "../src/redaction/token-hash.js";
import { scanTokens } from "../src/restorer/index.js";
import { findSecrets } from "../src/detector/secret-scanner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

/**
 * A hand-written OPF token regex whose hash length is a literal digit rather
 * than TOKEN_HASH_LENGTH. Scoped to lines mentioning the token prefix so that
 * unrelated fixed-length secret patterns (Mailgun `key-[a-z0-9]{32}`) do not
 * trip the guard. Template interpolations like `${category}` carry no digits
 * inside the braces and are therefore not matched.
 */
const HARDCODED_OPF_QUANTIFIER = /__OPF_.*\{\s*\d+\s*\}/;

const HIGH_ENTROPY_HASH = "q7z3m9x1k5w8v2n4";
const SAMPLE_TOKEN = formatToken("SECRET", HIGH_ENTROPY_HASH);
const NON_TOKEN_CONTROL = "q7z3m9x1k5w8v2n4Q7Z3M9X1K5W8V2N4";

function collectSourceFiles(dir: string, acc: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (entry.name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function allPackageSourceFiles(): string[] {
  const acc: string[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = join(PACKAGES_DIR, pkg.name, "src");
    try {
      collectSourceFiles(srcDir, acc);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        continue;
      }
      throw err;
    }
  }
  return acc;
}

describe("token grammar — derived, never hardcoded", () => {
  test("every pattern export embeds TOKEN_HASH_LENGTH", () => {
    expect(TOKEN_HASH_PATTERN).toBe(`[a-z0-9]{${TOKEN_HASH_LENGTH}}`);
    expect(TOKEN_STRICT_PATTERN).toContain(TOKEN_HASH_PATTERN);
    expect(TOKEN_LENIENT_PATTERN).toContain(TOKEN_HASH_PATTERN);
  });

  test("compiled regexes are compiled from the exported pattern sources", () => {
    expect(TOKEN_STRICT_REGEX.source).toBe(TOKEN_STRICT_PATTERN);
    expect(TOKEN_LENIENT_REGEX.source).toBe(TOKEN_LENIENT_PATTERN);
  });

  test("no package source file hardcodes the hash-length quantifier", () => {
    const offenders: string[] = [];
    for (const file of allPackageSourceFiles()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (HARDCODED_OPF_QUANTIFIER.test(line)) {
          offenders.push(`${relative(REPO_ROOT, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("token grammar — consumers agree on the same token", () => {
  test("a freshly formatted token is a single strict match", () => {
    const matches = scanTokens(`prefix ${SAMPLE_TOKEN} suffix`);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchType).toBe("strict");
    expect(matches[0]?.category).toBe("SECRET");
    expect(matches[0]?.hash).toBe(HIGH_ENTROPY_HASH);
  });

  test("the secret scanner never re-flags an already-masked token", () => {
    const detections = findSecrets(`Bearer ${SAMPLE_TOKEN}`);

    expect(detections).toEqual([]);
  });

  test("a same-shape non-token of equal entropy is still flagged", () => {
    const detections = findSecrets(`Bearer ${NON_TOKEN_CONTROL}`);

    expect(detections.map((d) => d.text)).toEqual([NON_TOKEN_CONTROL]);
  });
});
