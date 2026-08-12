/**
 * Emit golden token vectors from the TypeScript implementation so the Python
 * port (packages/backend/server/pii) can be verified byte-for-byte against it.
 *
 * The hook (TS, host process) and the proxy (Python, container) must mint the
 * SAME token for the same (key, category, text) or restoration breaks across
 * the boundary. That equivalence is the hard gate of the port, and this file
 * is its reference.
 *
 * Deliberately included traps:
 *   - Unicode whitespace in canonicalize(). JS `String.trim()` and `\s` cover
 *     \u00a0 \u1680 \u2000-\u200a \u2028 \u2029 \u202f \u205f \u3000 \ufeff.
 *     Python's `str.strip()` / `re.sub(r"\s+")` do NOT match \ufeff and DO
 *     match \x1c-\x1f. A naive Python port silently mints different tokens for
 *     text carrying a BOM or an ideographic space.
 *   - base36 left-padding, exercised by scanning for a short digest.
 *   - Category labels that contain no underscore (BIZNUM) next to the `__`
 *     delimiter, which is what the lazy category pattern must not swallow.
 *
 * Usage: bun run scripts/gen-token-vectors.ts
 * Writes: packages/backend/tests/fixtures/token_vectors.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveTokenKey,
  tokenEpoch,
  tokenHash,
  TOKEN_EPOCH_LENGTH,
  TOKEN_HASH_LENGTH,
} from "../packages/core/src/redaction/token-hash.js";
import {
  formatToken,
  parseToken,
  isToken,
  MAX_TOKEN_LENGTH,
  TOKEN_DELIMITER,
  TOKEN_PREFIX,
  TOKEN_SUFFIX,
} from "../packages/core/src/token/format.js";
import { CATEGORY_MAP } from "../packages/core/src/token/category-map.js";
import { VaultManager } from "../packages/core/src/vault/manager.js";
import type { Detection, PIICategory } from "../packages/core/src/types.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(
  SCRIPT_DIR,
  "..",
  "packages",
  "backend",
  "tests",
  "fixtures",
  "token_vectors.json"
);

/** Mirrors the private canonicalize() in packages/core/src/vault/manager.ts. */
function canonicalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

const SECRETS = [
  "pii-remover-baseline-secret",
  "a",
  "0123456789abcdef0123456789abcdef",
  "한글 시크릿 키",
  "with spaces and\ttabs",
];

const CANONICALIZE_CASES: string[] = [
  "김철수",
  "  김철수  ",
  "김  철수",
  "김\t철수",
  "김\n\n철수",
  "  multiple   internal    spaces  ",
  // Unicode whitespace traps — JS trim()/\s vs Python strip()/\s diverge here.
  "\u00a0김철수\u00a0", // NBSP
  "\u3000김철수\u3000", // ideographic space
  "\ufeff김철수\ufeff", // BOM: JS trims, Python str.strip() does not
  "김\u00a0철수", // NBSP as internal separator
  "김\u2009철수", // thin space
  "김\u205f철수", // medium mathematical space
  "\u2028김철수\u2029", // line/paragraph separator
  "\u000b김철수\u000c", // vertical tab / form feed
  "alice@example.com",
  "  alice@example.com\n",
  "010-1234-5678",
  "",
  "   ",
];

const HASH_TEXTS = [
  "김철수",
  "John Doe",
  "alice@example.com",
  "010-1234-5678",
  "900101-1234567",
  "123-45-67890",
  "4111 1111 1111 1111",
  "https://internal.corp.example/secret",
  "sk-proj-AAAABBBBCCCCDDDD",
  "",
  "\u0000",
  "a".repeat(1000),
  "이모지 🙂 포함",
  "tab\tand\nnewline",
];

const CATEGORY_LABELS = Object.values(CATEGORY_MAP);

interface HashVector {
  secret: string;
  category: string;
  canonical_text: string;
  hash: string;
  token: string;
}

const key0 = deriveTokenKey(SECRETS[0]!);

// --- derived keys + epochs -------------------------------------------------
const keyVectors = SECRETS.map((secret) => {
  const key = deriveTokenKey(secret);
  return {
    secret,
    derived_key_hex: key.toString("hex"),
    epoch: tokenEpoch(key),
  };
});

// --- canonicalize ----------------------------------------------------------
const canonicalizeVectors = CANONICALIZE_CASES.map((input) => ({
  input,
  input_codepoints: Array.from(input).map((c) => c.codePointAt(0)!),
  output: canonicalize(input),
  output_codepoints: Array.from(canonicalize(input)).map(
    (c) => c.codePointAt(0)!
  ),
}));

// --- tokenHash + formatToken ----------------------------------------------
const hashVectors: HashVector[] = [];
for (const secret of SECRETS) {
  const key = deriveTokenKey(secret);
  for (const category of CATEGORY_LABELS) {
    for (const raw of HASH_TEXTS) {
      const canonical = canonicalize(raw);
      const hash = tokenHash(key, category, canonical);
      hashVectors.push({
        secret,
        category,
        canonical_text: canonical,
        hash,
        token: formatToken(category, hash),
      });
    }
  }
}

// Hunt for a digest whose base36 rendering is short enough to require the
// left-pad branch in base36Digest(). Without a hit the Python port can pass
// while silently omitting the padding.
let padVector: HashVector | null = null;
for (let i = 0; i < 200_000 && padVector === null; i++) {
  const canonical = `pad-probe-${i}`;
  const hash = tokenHash(key0, "PERSON", canonical);
  if (hash[TOKEN_EPOCH_LENGTH] === "0") {
    padVector = {
      secret: SECRETS[0]!,
      category: "PERSON",
      canonical_text: canonical,
      hash,
      token: formatToken("PERSON", hash),
    };
  }
}

// --- parseToken ------------------------------------------------------------
const validToken = formatToken("BIZNUM", tokenHash(key0, "BIZNUM", "123-45-67890"));
const parseVectors = [
  validToken,
  formatToken("PERSON", tokenHash(key0, "PERSON", "김철수")),
  formatToken("RRN", tokenHash(key0, "RRN", "900101-1234567")),
  // Negatives: wrong hash length, uppercase hash, missing suffix, missing
  // delimiter, lowercase category, empty category.
  `${TOKEN_PREFIX}PERSON${TOKEN_DELIMITER}${"a".repeat(TOKEN_HASH_LENGTH - 1)}${TOKEN_SUFFIX}`,
  `${TOKEN_PREFIX}PERSON${TOKEN_DELIMITER}${"a".repeat(TOKEN_HASH_LENGTH + 1)}${TOKEN_SUFFIX}`,
  `${TOKEN_PREFIX}PERSON${TOKEN_DELIMITER}${"A".repeat(TOKEN_HASH_LENGTH)}${TOKEN_SUFFIX}`,
  `${TOKEN_PREFIX}PERSON${TOKEN_DELIMITER}${"a".repeat(TOKEN_HASH_LENGTH)}`,
  `${TOKEN_PREFIX}PERSON${"a".repeat(TOKEN_HASH_LENGTH)}${TOKEN_SUFFIX}`,
  `${TOKEN_PREFIX}person${TOKEN_DELIMITER}${"a".repeat(TOKEN_HASH_LENGTH)}${TOKEN_SUFFIX}`,
  `${TOKEN_PREFIX}${TOKEN_DELIMITER}${"a".repeat(TOKEN_HASH_LENGTH)}${TOKEN_SUFFIX}`,
  `prefix ${validToken} suffix`,
  "",
].map((text) => ({
  text,
  parsed: parseToken(text),
  is_token: isToken(text),
}));

// --- end-to-end: VaultManager.assign --------------------------------------
// Exercises canonicalize + categoryToTokenLabel + tokenHash + formatToken in
// one shot, plus dedup (same canonical text -> same token).
const assignCategories: PIICategory[] = [
  "private_person",
  "private_email",
  "private_phone",
  "rrn",
  "biz_num",
  "card",
  "secret",
  "private_url",
  "private_date",
  "private_address",
  "account_number",
];
const assignTexts = [
  "김철수",
  "alice@example.com",
  "010-1234-5678",
  "900101-1234567",
  "123-45-67890",
  "4111111111111111",
  "sk-proj-AAAABBBBCCCC",
  "https://internal.corp.example",
  "1990-01-01",
  "서울시 강남구 테헤란로 1",
  "1002-345-678901",
];
const assignDetections: Detection[] = [];
{
  let cursor = 0;
  for (let i = 0; i < assignCategories.length; i++) {
    const text = assignTexts[i]!;
    assignDetections.push({
      start: cursor,
      end: cursor + text.length,
      category: assignCategories[i]!,
      confidence: 0.99,
      text,
    });
    cursor += text.length + 1;
  }
  // Duplicate of the first span (different offsets, whitespace-padded) so the
  // dedup path must resolve to the SAME token.
  assignDetections.push({
    start: cursor,
    end: cursor + 8,
    category: "private_person",
    confidence: 0.99,
    text: "  김철수 ",
  });
}
const assignVault = new VaultManager({ tokenKey: key0 });
const assignedTokens = assignVault.assign("vector-session", assignDetections);
const assignVectors = {
  secret: SECRETS[0]!,
  epoch: assignVault.epoch(),
  detections: assignDetections.map((d) => ({
    category: d.category,
    text: d.text,
  })),
  tokens: assignedTokens.map((t) => t.token),
  dedup_holds:
    assignedTokens[0]!.token ===
    assignedTokens[assignedTokens.length - 1]!.token,
};

const payload = {
  _generated_by: "scripts/gen-token-vectors.ts",
  _contract:
    "Python must reproduce every field below byte-for-byte. Regenerate with " +
    "`bun run scripts/gen-token-vectors.ts` only when the TS token grammar " +
    "changes intentionally — a diff here is a wire-format break.",
  constants: {
    TOKEN_PREFIX,
    TOKEN_SUFFIX,
    TOKEN_DELIMITER,
    TOKEN_HASH_LENGTH,
    TOKEN_EPOCH_LENGTH,
    MAX_TOKEN_LENGTH,
    HKDF_SALT: "pii-remover-token-hash-v2",
    HKDF_INFO: "deterministic-token-index",
    EPOCH_INFO: "opf-key-epoch-v1",
    DERIVED_KEY_LENGTH: 32,
    CATEGORY_MAP,
  },
  keys: keyVectors,
  canonicalize: canonicalizeVectors,
  hashes: hashVectors,
  base36_pad_probe: padVector,
  parse: parseVectors,
  assign: assignVectors,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(`wrote ${OUT_PATH}`);
console.log(`  keys:         ${keyVectors.length}`);
console.log(`  canonicalize: ${canonicalizeVectors.length}`);
console.log(`  hashes:       ${hashVectors.length}`);
console.log(`  parse:        ${parseVectors.length}`);
console.log(`  assign:       ${assignVectors.tokens.length} tokens, dedup_holds=${assignVectors.dedup_holds}`);
console.log(
  `  base36 pad probe: ${padVector ? `found (${padVector.hash})` : "NOT FOUND — padding branch unverified"}`
);
