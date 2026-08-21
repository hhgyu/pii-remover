/**
 * Emit golden SSE-boundary-buffer vectors from the TypeScript implementation.
 *
 * This is the per-delta hot path: an LLM splits a token across SSE chunks and
 * the buffer decides, on every chunk, how much is safe to release. Getting the
 * boundary one character wrong leaks `{{OPF:PE` to the user's screen.
 *
 * Two things are pinned:
 *
 *   `boundaries`  - findUnsafeBoundary() on hand-picked buffers, including
 *                   inputs that END IN A NEWLINE. JavaScript `$` (no `m` flag)
 *                   anchors at end-of-string; Python `$` also matches before a
 *                   trailing newline. A Python port using `$` returns a
 *                   different index for exactly these inputs, so they are the
 *                   reason this section exists.
 *   `sequences`   - the per-push release schedule, not just the concatenation.
 *                   Matching only the final text would hide a buffer that
 *                   releases too early and gets lucky on the total.
 *
 * Usage: bun run scripts/gen-stream-vectors.ts
 * Writes: packages/backend/tests/fixtures/stream_vectors.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveTokenKey, tokenHash } from "../packages/core/src/redaction/token-hash.js";
import { formatToken, MAX_TOKEN_LENGTH } from "../packages/core/src/token/format.js";
import {
  createStreamBuffer,
  findUnsafeBoundary,
  DEFAULT_BUFFER_WINDOW,
} from "../packages/proxy/src/stream/buffer.js";

const OUT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "backend",
  "tests",
  "fixtures",
  "stream_vectors.json"
);

const KEY = deriveTokenKey("pii-remover-baseline-secret");
const PERSON = formatToken("PERSON", tokenHash(KEY, "PERSON", "김철수"));
const EMAIL = formatToken("EMAIL", tokenHash(KEY, "EMAIL", "alice@example.com"));
const BIZNUM = formatToken("BIZNUM", tokenHash(KEY, "BIZNUM", "123-45-67890"));

// --- section: findUnsafeBoundary ------------------------------------------
const BOUNDARY_INPUTS: string[] = [
  "",
  "plain text with no token",
  PERSON,
  `${PERSON} trailing`,
  `leading ${PERSON}`,
  // Partial prefixes: every one must be held back.
  "_",
  "__",
  "__O",
  "__OP",
  "__OPF",
  "{{OPF:",
  "text _",
  "text {{OPF:",
  // Category in progress.
  "{{OPF:P",
  "{{OPF:PERSON",
  "{{OPF:PERSON:",
  "{{OPF:PERSON:",
  "{{OPF:PERSON:4ov",
  "{{OPF:PERSON:4ov9mhqtc1vepqf5",
  "{{OPF:PERSON:4ov9mhqtc1vepqf5_",
  "{{OPF:PERSON:4ov9mhqtc1vepqf5}}",
  // THE NEWLINE TRAP. JS `$` does not match before "\n"; Python `$` does.
  `${PERSON}\n`,
  `${PERSON}\n\n`,
  "{{OPF:PERSON:4ov9mhqtc1vepqf5}}\n",
  "{{OPF:PERS\n",
  "{{OPF:\n",
  "text\n",
  "text\n{{OPF:",
  `${PERSON} after\n`,
  // Underscores that are not a token.
  "snake_case_identifier",
  "___",
  "a__OPF",
  // Two tokens, second incomplete.
  `${PERSON} and {{OPF:EMA`,
  `${PERSON}${EMAIL}`,
  BIZNUM,
];

const boundaries = BOUNDARY_INPUTS.flatMap((buffer) =>
  [DEFAULT_BUFFER_WINDOW, 64, 16, 8].map((windowSize) => ({
    buffer,
    window_size: windowSize,
    boundary: findUnsafeBoundary(buffer, windowSize),
  }))
);

// --- section: push sequences ----------------------------------------------
function splitEvery(text: string, width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out;
}

interface SequenceCase {
  name: string;
  chunks: string[];
  buffer_window: number | null;
}

const SEQUENCE_TEXTS: ReadonlyArray<{ name: string; text: string }> = [
  { name: "token-only", text: PERSON },
  { name: "token-in-sentence", text: `Contact ${PERSON} today.` },
  { name: "two-tokens", text: `${PERSON} and ${EMAIL} both.` },
  { name: "token-then-newline", text: `${PERSON}\n` },
  { name: "newline-between", text: `${PERSON}\n${EMAIL}\n` },
  { name: "no-token", text: "just some ordinary streamed prose" },
  { name: "underscore-noise", text: `snake_case ${PERSON} __not_a_token__` },
  { name: "hangul-adjacent", text: `김철수${PERSON}입니다` },
  { name: "biznum-delimiter", text: `사업자 ${BIZNUM} 확인` },
];

const sequences: SequenceCase[] = [];
for (const { name, text } of SEQUENCE_TEXTS) {
  for (const width of [1, 2, 3, 5, 7]) {
    sequences.push({
      name: `${name}-split${width}`,
      chunks: splitEvery(text, width),
      buffer_window: null,
    });
  }
}
// A window smaller than MAX_TOKEN_LENGTH is misconfiguration; pin the behaviour
// so a "fix" in either language is a visible diff rather than a silent change.
sequences.push({
  name: "undersized-window",
  chunks: splitEvery(`Contact ${PERSON} today.`, 3),
  buffer_window: 8,
});
sequences.push({
  name: "empty-chunks-interleaved",
  chunks: ["Contact ", "", PERSON.slice(0, 10), "", PERSON.slice(10), "", " done"],
  buffer_window: null,
});

const sequenceCases = sequences.map((c) => {
  const buf = createStreamBuffer(
    c.buffer_window === null ? {} : { bufferWindow: c.buffer_window }
  );
  const pushes = c.chunks.map((chunk) => buf.push(chunk));
  const flushed = buf.flush();
  const joined = c.chunks.join("");
  return {
    name: c.name,
    chunks: c.chunks,
    buffer_window: c.buffer_window,
    expected: {
      pushes,
      flush: flushed,
      total: pushes.join("") + flushed,
      lossless: pushes.join("") + flushed === joined,
    },
  };
});

const lossy = sequenceCases.filter((c) => !c.expected.lossless);

const payload = {
  _generated_by: "scripts/gen-stream-vectors.ts",
  _contract:
    "Python must reproduce the per-push release schedule exactly, not merely " +
    "the concatenated total. Releasing early and catching up still sums to the " +
    "same string while showing the user a half-token.",
  constants: {
    DEFAULT_BUFFER_WINDOW,
    MAX_TOKEN_LENGTH,
  },
  tokens: { PERSON, EMAIL, BIZNUM },
  boundaries,
  sequences: sequenceCases,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(`wrote ${OUT_PATH}`);
console.log(`  DEFAULT_BUFFER_WINDOW=${DEFAULT_BUFFER_WINDOW} MAX_TOKEN_LENGTH=${MAX_TOKEN_LENGTH}`);
console.log(`  boundaries: ${boundaries.length}`);
console.log(`  sequences:  ${sequenceCases.length}`);
console.log(`  lossy sequences: ${lossy.length}${lossy.length ? " -> " + lossy.map((c) => c.name).join(", ") : ""}`);
const newlineCases = boundaries.filter((b) => b.buffer.includes("\n"));
console.log(`\n  newline-trap boundaries (JS \`$\` semantics):`);
for (const b of newlineCases.filter((b) => b.window_size === DEFAULT_BUFFER_WINDOW)) {
  console.log(`    ${JSON.stringify(b.buffer).padEnd(44)} -> ${b.boundary} / len ${b.buffer.length}`);
}
