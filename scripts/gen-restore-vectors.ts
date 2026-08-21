/**
 * Emit golden restore vectors from the TypeScript implementation.
 *
 * Companion to `gen-token-vectors.ts`, which pins the *minting* half. This pins
 * the *reading* half: scanning, miss classification, vault-bounded repair, the
 * filesystem-path guard, and the end-to-end Restorer counts.
 *
 * Every section corresponds to one Python module so a failure localises:
 *
 *   scan              -> server/pii/scan.py
 *   is_within_one_edit-> server/pii/repair.py
 *   resolve_miss      -> server/pii/repair.py
 *   is_inside_path    -> server/pii/path.py
 *   restore           -> server/pii/restorer.py
 *
 * Offsets are UTF-16 code-unit indices on the TypeScript side and code-point
 * indices in Python. Every offset-bearing case below stays inside the BMP
 * (ASCII + Hangul), where the two agree; astral characters are deliberately
 * excluded rather than papered over.
 *
 * Usage: bun run scripts/gen-restore-vectors.ts
 * Writes: packages/backend/tests/fixtures/restore_vectors.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveTokenKey, tokenHash } from "../packages/core/src/redaction/token-hash.js";
import { formatToken } from "../packages/core/src/token/format.js";
import { VaultManager } from "../packages/core/src/vault/manager.js";
import { Restorer, type RestoreOptions } from "../packages/core/src/restorer/index.js";
import {
  scanTokens,
  scanTokensWithRepairCandidates,
} from "../packages/core/src/restorer/scan.js";
import { isInsidePath } from "../packages/core/src/restorer/path.js";
import {
  buildRepairIndex,
  isWithinOneEdit,
  resolveMiss,
  type RepairCandidate,
} from "../packages/core/src/restorer/repair.js";
import type { Detection } from "../packages/core/src/types.js";

const OUT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "backend",
  "tests",
  "fixtures",
  "restore_vectors.json"
);

const SECRET = "pii-remover-baseline-secret";
const KEY = deriveTokenKey(SECRET);
const SESSION = "restore-session";

// --- vault under test ------------------------------------------------------
const SPECS: ReadonlyArray<{ category: Detection["category"]; text: string }> = [
  { category: "private_person", text: "김철수" },
  { category: "private_email", text: "alice@example.com" },
  { category: "private_phone", text: "010-1234-5678" },
  { category: "rrn", text: "900101-1234567" },
];

const detections: Detection[] = [];
{
  let cursor = 0;
  for (const spec of SPECS) {
    detections.push({
      start: cursor,
      end: cursor + spec.text.length,
      category: spec.category,
      confidence: 0.99,
      text: spec.text,
    });
    cursor += spec.text.length + 1;
  }
}

const vault = new VaultManager({ tokenKey: KEY });
const assigned = vault.assign(SESSION, detections);
const TOK = Object.fromEntries(
  assigned.map((a, i) => [SPECS[i]!.text, a.token])
) as Record<string, string>;

const PERSON = TOK["김철수"]!;
const EMAIL = TOK["alice@example.com"]!;
const PHONE = TOK["010-1234-5678"]!;

const epoch = vault.epoch();

/** Same epoch, body that no vault entry is within one edit of. */
const EXPIRED_TOKEN = formatToken("PERSON", `${epoch}zzzzzzzzzzzzz`);
/** Epoch that this key never produces. */
const foreignEpoch = epoch === "aaa" ? "bbb" : "aaa";
const FOREIGN_TOKEN = formatToken("PERSON", `${foreignEpoch}zzzzzzzzzzzzz`);

/** One character of the PERSON hash mutated -> exactly one repair candidate. */
function mutateOneChar(token: string): string {
  const hash = token.slice("{{OPF:PERSON:".length, -2);
  const idx = hash.length - 1;
  const replacement = hash[idx] === "a" ? "b" : "a";
  return formatToken("PERSON", hash.slice(0, idx) + replacement + hash.slice(idx + 1));
}
const REPAIRABLE_TOKEN = mutateOneChar(PERSON);

function markdownEscape(token: string): string {
  return token.replace(/_/g, "\\_");
}

// --- section: scan ---------------------------------------------------------
const SCAN_INPUTS: string[] = [
  "",
  "no tokens here at all",
  `Contact ${PERSON} today.`,
  `${PERSON} and ${EMAIL} both.`,
  // lenient: case-folded category
  `{{OPF:person:${PERSON.slice("{{OPF:PERSON:".length, -2)}}}`,
  // lenient: trailing suffix dropped
  PERSON.slice(0, -2),
  // Korean butting directly against the token: JS `\b` is ASCII-only, so this
  // must still match. Python's Unicode `\b` would not.
  `김철수${PERSON}입니다`,
  // repair-only: markdown-escaped underscores
  markdownEscape(PERSON),
  // repair-only: hash one char too long
  `{{OPF:PERSON:${"a".repeat(17)}}}`,
  `path D:\\Git\\${PERSON}\\file.ts here`,
];
const scanCases = SCAN_INPUTS.map((text) => ({
  text,
  strict_and_lenient: scanTokens(text),
  with_repair: scanTokensWithRepairCandidates(text),
}));

// --- section: isWithinOneEdit ---------------------------------------------
const EDIT_PAIRS: ReadonlyArray<[string, string]> = [
  ["", ""],
  ["abc", "abc"],
  ["abc", "abd"],
  ["abc", "ab"],
  ["ab", "abc"],
  ["abc", "abcd"],
  ["abc", "axd"],
  ["abc", "cba"],
  ["abc", "abcde"],
  ["abcdef", "abcdf"],
  ["abcdef", "abdcef"],
  ["a", ""],
  ["", "a"],
  ["4ov9mhqtc1vepqf5", "4ov9mhqtc1vepqf6"],
  ["4ov9mhqtc1vepqf5", "4ov9mhqtc1vepq5"],
];
const editCases = EDIT_PAIRS.map(([a, b]) => ({
  a,
  b,
  within_one_edit: isWithinOneEdit(a, b),
}));

// --- section: resolveMiss --------------------------------------------------
// Ambiguity cannot arise from a real vault (two deterministic hashes differing
// in exactly two positions is a ~1e-15 event), so it is exercised against a
// synthetic index — exactly how the TypeScript suite covers it.
const realIndex = buildRepairIndex(vault.tokens(SESSION));
const syntheticIndex: RepairCandidate[] = [
  { category: "PERSON", hash: "aaabbbbbbbbbbbb", token: "{{OPF:PERSON:aaabbbbbbbbbbbb}}" },
  { category: "PERSON", hash: "aaabbbbbbbbbbbc", token: "{{OPF:PERSON:aaabbbbbbbbbbbc}}" },
];
const RESOLVE_CASES: ReadonlyArray<{
  name: string;
  category: string;
  hash: string;
  index: RepairCandidate[];
}> = [
  { name: "exact-live-entry", category: "PERSON", hash: PERSON.slice(14, -2), index: realIndex },
  { name: "repairable-one-edit", category: "PERSON", hash: REPAIRABLE_TOKEN.slice(14, -2), index: realIndex },
  { name: "category-mismatch-blocks-repair", category: "EMAIL", hash: REPAIRABLE_TOKEN.slice(14, -2), index: realIndex },
  { name: "expired-same-epoch", category: "PERSON", hash: `${epoch}zzzzzzzzzzzzz`, index: realIndex },
  { name: "foreign-other-epoch", category: "PERSON", hash: `${foreignEpoch}zzzzzzzzzzzzz`, index: realIndex },
  { name: "ambiguous-two-candidates", category: "PERSON", hash: "aaabbbbbbbbbbbb".slice(0, 14) + "d", index: syntheticIndex },
  { name: "empty-index", category: "PERSON", hash: `${epoch}zzzzzzzzzzzzz`, index: [] },
];
const resolveCases = RESOLVE_CASES.map((c) => ({
  name: c.name,
  category: c.category,
  hash: c.hash,
  epoch,
  index: c.index,
  resolution: resolveMiss({ category: c.category, hash: c.hash }, epoch, c.index),
}));

// --- section: isInsidePath -------------------------------------------------
const PATH_INPUTS: ReadonlyArray<string> = [
  `D:\\Git\\${PERSON}\\file.ts`,
  `C:/Users/${PERSON}/doc.txt`,
  `\\\\server\\share\\${PERSON}`,
  `/home/${PERSON}/notes.md`,
  `./src/${PERSON}/index.ts`,
  `../${PERSON}/x`,
  `https://example.com/${PERSON}/page`,
  `${PERSON} please respond`,
  `Contact ${PERSON}, thanks`,
  `a/${PERSON}`,
  `a/b/${PERSON}`,
  `${PERSON}/b/c`,
  `prefix\u00a0${PERSON}\u00a0suffix`,
  `prefix\ufeff/a/b/${PERSON}`,
];
const pathCases = PATH_INPUTS.map((text) => {
  const start = text.indexOf(PERSON);
  return {
    text,
    start,
    end: start + PERSON.length,
    inside_path: isInsidePath(text, start, start + PERSON.length),
  };
});

// --- section: restore (end to end) ----------------------------------------
interface RestoreCase {
  name: string;
  text: string;
  opts: RestoreOptions;
}
const RESTORE_CASES: ReadonlyArray<RestoreCase> = [
  { name: "empty", text: "", opts: {} },
  { name: "no-tokens", text: "nothing to restore", opts: {} },
  { name: "strict-single", text: `Hello ${PERSON}!`, opts: {} },
  { name: "strict-multiple", text: `${PERSON} <${EMAIL}> ${PHONE}`, opts: {} },
  { name: "strict-repeated", text: `${PERSON} and again ${PERSON}`, opts: {} },
  {
    name: "lenient-case-folded",
    text: `see {{OPF:person:${PERSON.slice(14, -2)}}} here`,
    opts: {},
  },
  { name: "lenient-suffix-dropped", text: `see ${PERSON.slice(0, -2)} here`, opts: {} },
  {
    name: "lenient-disabled",
    text: `see {{OPF:person:${PERSON.slice(14, -2)}}} here`,
    opts: { lenient: false },
  },
  { name: "repairable-one-edit", text: `see ${REPAIRABLE_TOKEN} here`, opts: {} },
  {
    name: "repair-disabled",
    text: `see ${REPAIRABLE_TOKEN} here`,
    opts: { repair: false },
  },
  { name: "expired-same-epoch", text: `see ${EXPIRED_TOKEN} here`, opts: {} },
  { name: "foreign-other-epoch", text: `see ${FOREIGN_TOKEN} here`, opts: {} },
  {
    name: "path-skip-miss-inside-path",
    text: `open D:\\Git\\${EXPIRED_TOKEN}\\file.ts now`,
    opts: {},
  },
  {
    name: "path-skip-disabled",
    text: `open D:\\Git\\${EXPIRED_TOKEN}\\file.ts now`,
    opts: { skipPathMatches: false },
  },
  {
    name: "vault-hit-inside-path-still-restores",
    text: `open D:\\Git\\${PERSON}\\file.ts now`,
    opts: {},
  },
  { name: "markdown-escaped", text: `see ${markdownEscape(PERSON)} here`, opts: {} },
  { name: "korean-adjacent", text: `김철수${PERSON}입니다`, opts: {} },
  { name: "mixed-hit-and-miss", text: `${PERSON} then ${FOREIGN_TOKEN}`, opts: {} },
];

const restorer = new Restorer(vault, { warn: () => {} });
const restoreCases = RESTORE_CASES.map((c) => {
  const r = restorer.restore(c.text, SESSION, { ...c.opts, warn: () => {} });
  return {
    name: c.name,
    text: c.text,
    opts: {
      lenient: c.opts.lenient ?? null,
      repair: c.opts.repair ?? null,
      skip_path_matches: c.opts.skipPathMatches ?? null,
    },
    expected: {
      text: r.text,
      match_count: r.matches.length,
      restored_count: r.restoredCount,
      partial_match_count: r.partialMatchCount,
      lenient_restored_count: r.lenientRestoredCount,
      repaired_count: r.repairedCount,
      unknown_token_count: r.unknownTokenCount,
      foreign_count: r.foreignCount,
      dead_token_count: r.deadTokenCount,
      ambiguous_count: r.ambiguousCount,
      path_skip_count: r.pathSkipCount,
      residual_token_count: r.residualTokenCount,
    },
  };
});

const payload = {
  _generated_by: "scripts/gen-restore-vectors.ts",
  _contract:
    "Python must reproduce every `expected` field exactly. A diff means the " +
    "restore semantics diverged between the host-side hook and the backend.",
  setup: {
    secret: SECRET,
    session_id: SESSION,
    epoch,
    detections: SPECS.map((s) => ({ category: s.category, text: s.text })),
    tokens: TOK,
    expired_token: EXPIRED_TOKEN,
    foreign_token: FOREIGN_TOKEN,
    repairable_token: REPAIRABLE_TOKEN,
  },
  scan: scanCases,
  is_within_one_edit: editCases,
  resolve_miss: resolveCases,
  is_inside_path: pathCases,
  restore: restoreCases,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(`wrote ${OUT_PATH}`);
console.log(`  scan:               ${scanCases.length}`);
console.log(`  is_within_one_edit: ${editCases.length}`);
console.log(`  resolve_miss:       ${resolveCases.length}`);
console.log(`  is_inside_path:     ${pathCases.length}`);
console.log(`  restore:            ${restoreCases.length}`);
console.log(`  epoch=${epoch} person=${PERSON}`);
for (const c of restoreCases) {
  console.log(
    `    ${c.name.padEnd(38)} restored=${c.expected.restored_count} ` +
      `unknown=${c.expected.unknown_token_count} repaired=${c.expected.repaired_count} ` +
      `pathskip=${c.expected.path_skip_count} residual=${c.expected.residual_token_count}`
  );
}
