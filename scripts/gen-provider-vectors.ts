/**
 * Emit golden provider-transform vectors from the TypeScript implementation.
 *
 * Covers the non-streaming request/response path for all three providers.
 *
 * The codec is deliberately trivial - masking is literal replacement of a fixed
 * PII table, restoring is the real Restorer against a pre-populated vault. That
 * isolates what is under test (the provider body walking: which fields are
 * touched, which pass through, where the system note lands) from the detection
 * pipeline, which lives on the other side of an HTTP boundary in Python and
 * would otherwise make these vectors untestable.
 *
 * Usage: bun run scripts/gen-provider-vectors.ts
 * Writes: packages/backend/tests/fixtures/provider_vectors.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PIIRemover } from "../packages/core/src/pii-remover.js";
import { deriveTokenKey } from "../packages/core/src/redaction/token-hash.js";
import { VaultManager } from "../packages/core/src/vault/manager.js";
import { Restorer } from "../packages/core/src/restorer/index.js";
import { OPF_PLACEHOLDER_SYSTEM_NOTE } from "../packages/core/src/policy/system-note.js";
import type { Detection } from "../packages/core/src/types.js";
import {
  transformAnthropicRequest,
  restoreAnthropicResponse,
} from "../packages/proxy/src/providers/anthropic.js";
import {
  transformOpenAIRequest,
  restoreOpenAIResponse,
} from "../packages/proxy/src/providers/openai.js";
import {
  transformCodexResponsesRequest,
  restoreCodexResponsesResponse,
} from "../packages/proxy/src/providers/codex.js";

const OUT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "backend",
  "tests",
  "fixtures",
  "provider_vectors.json"
);

const SECRET = "pii-remover-baseline-secret";
const SESSION = "provider-session";
const KEY = deriveTokenKey(SECRET);

const SPECS: ReadonlyArray<{ category: Detection["category"]; text: string }> = [
  { category: "private_person", text: "김철수" },
  { category: "private_email", text: "alice@example.com" },
  { category: "private_phone", text: "010-1234-5678" },
];

const detections: Detection[] = [];
{
  let cursor = 0;
  for (const s of SPECS) {
    detections.push({
      start: cursor,
      end: cursor + s.text.length,
      category: s.category,
      confidence: 0.99,
      text: s.text,
    });
    cursor += s.text.length + 1;
  }
}

const vault = new VaultManager({ tokenKey: KEY });
const assigned = vault.assign(SESSION, detections);
const PII_TABLE: Array<[string, string]> = SPECS.map((s, i) => [
  s.text,
  assigned[i]!.token,
]);
// Longest first so "alice@example.com" is never clipped by a shorter entry.
PII_TABLE.sort((a, b) => b[0].length - a[0].length);

const restorer = new Restorer(vault, { warn: () => {} });

function maskText(text: string): string {
  let out = text;
  for (const [plain, token] of PII_TABLE) out = out.split(plain).join(token);
  return out;
}

const remover = {
  mask: async (text: string) => ({ text: maskText(text) }),
  restore: (text: string) => restorer.restore(text, SESSION, { warn: () => {} }),
} as unknown as PIIRemover;

const TOK = Object.fromEntries(PII_TABLE.map(([plain, token]) => [plain, token]));
const PERSON = TOK["김철수"]!;
const EMAIL = TOK["alice@example.com"]!;

// --- request cases ---------------------------------------------------------
const anthropicRequests: Array<{ name: string; body: unknown }> = [
  {
    name: "string-content",
    body: { model: "m", messages: [{ role: "user", content: "저는 김철수입니다" }] },
  },
  {
    name: "block-content",
    body: {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "메일은 alice@example.com" },
            { type: "image", source: { type: "base64", data: "AAAA", media_type: "image/png" } },
          ],
        },
      ],
    },
  },
  {
    name: "system-string",
    body: { model: "m", system: "돕는 도우미. 김철수 담당.", messages: [] },
  },
  {
    name: "system-array",
    body: {
      model: "m",
      system: [{ type: "text", text: "연락처 010-1234-5678" }],
      messages: [],
    },
  },
  {
    name: "system-already-noted",
    body: {
      model: "m",
      system: [{ type: "text", text: OPF_PLACEHOLDER_SYSTEM_NOTE }],
      messages: [],
    },
  },
  { name: "no-system", body: { model: "m", messages: [] } },
  {
    name: "non-text-block-passthrough",
    body: { model: "m", messages: [{ role: "user", content: [{ type: "thinking" }] }] },
  },
];

const openaiRequests: Array<{ name: string; body: unknown }> = [
  {
    name: "string-content-no-system",
    body: { model: "m", messages: [{ role: "user", content: "김철수 010-1234-5678" }] },
  },
  {
    name: "with-system",
    body: {
      model: "m",
      messages: [
        { role: "system", content: "너는 조수다" },
        { role: "user", content: "alice@example.com 로 보내" },
      ],
    },
  },
  {
    name: "two-systems-note-goes-to-last",
    body: {
      model: "m",
      messages: [
        { role: "system", content: "first" },
        { role: "user", content: "hi" },
        { role: "system", content: "second" },
      ],
    },
  },
  {
    name: "system-already-noted",
    body: { model: "m", messages: [{ role: "system", content: OPF_PLACEHOLDER_SYSTEM_NOTE }] },
  },
  {
    name: "system-non-string-content",
    body: {
      model: "m",
      messages: [{ role: "system", content: [{ type: "text", text: "김철수" }] }],
    },
  },
  {
    name: "parts-content",
    body: {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "메일 alice@example.com" },
            { type: "image_url", image_url: { url: "https://x/y.png" } },
          ],
        },
      ],
    },
  },
  { name: "empty-messages", body: { model: "m", messages: [] } },
];

const codexRequests: Array<{ name: string; body: unknown }> = [
  {
    name: "instructions-and-string-input",
    body: { model: "m", instructions: "김철수를 도와라", input: "alice@example.com 확인" },
  },
  { name: "no-instructions", body: { model: "m", input: "김철수" } },
  {
    name: "input-items-content",
    body: {
      model: "m",
      input: [
        { type: "message", content: [{ type: "input_text", text: "전화 010-1234-5678" }] },
        { type: "message", content: [{ type: "other", text: "김철수" }] },
      ],
    },
  },
  {
    name: "input-item-arguments-NOT-masked",
    body: {
      model: "m",
      input: [
        { type: "function_call", arguments: JSON.stringify({ to: "alice@example.com" }) },
      ],
    },
  },
  {
    name: "input-item-arguments-invalid-json",
    body: { model: "m", input: [{ type: "function_call", arguments: "not json 김철수" }] },
  },
];

// --- response cases --------------------------------------------------------
const anthropicResponses: Array<{ name: string; body: unknown }> = [
  { name: "text-block", body: { content: [{ type: "text", text: `안녕 ${PERSON}` }] } },
  {
    name: "tool-use-input",
    body: {
      content: [
        { type: "tool_use", id: "t1", name: "send", input: { to: EMAIL, cc: [PERSON] } },
      ],
    },
  },
  { name: "no-content", body: { id: "x" } },
  { name: "unknown-block", body: { content: [{ type: "thinking", thinking: PERSON }] } },
];

const openaiResponses: Array<{ name: string; body: unknown }> = [
  { name: "string-content", body: { choices: [{ message: { content: `안녕 ${PERSON}` } }] } },
  {
    name: "array-content",
    body: { choices: [{ message: { content: [{ type: "text", text: EMAIL }] } }] },
  },
  {
    name: "tool-calls",
    body: {
      choices: [
        {
          message: {
            tool_calls: [
              { id: "c1", function: { name: "send", arguments: JSON.stringify({ to: EMAIL }) } },
            ],
          },
        },
      ],
    },
  },
  {
    name: "tool-calls-invalid-json",
    body: {
      choices: [
        { message: { tool_calls: [{ function: { name: "x", arguments: `bare ${PERSON}` } }] } },
      ],
    },
  },
  { name: "no-choices", body: { id: "x" } },
];

const codexResponses: Array<{ name: string; body: unknown }> = [
  {
    name: "output-text-parts",
    body: { output: [{ content: [{ type: "output_text", text: `안녕 ${PERSON}` }] }] },
  },
  {
    name: "output-arguments",
    body: { output: [{ arguments: JSON.stringify({ to: EMAIL }) }] },
  },
  { name: "output-text-top-level", body: { output_text: `연락 ${EMAIL}` } },
  {
    name: "non-restorable-part-type",
    body: { output: [{ content: [{ type: "refusal", text: PERSON }] }] },
  },
];

async function buildRequests(
  cases: Array<{ name: string; body: unknown }>,
  fn: (b: never, r: PIIRemover, o: object) => Promise<{ body: unknown }>
) {
  const out = [];
  for (const c of cases) {
    const result = await fn(c.body as never, remover, {});
    out.push({ name: c.name, input: c.body, expected: result.body });
  }
  return out;
}

async function buildResponses(
  cases: Array<{ name: string; body: unknown }>,
  fn: (b: never, r: PIIRemover, o: object) => Promise<unknown>
) {
  const out = [];
  for (const c of cases) {
    out.push({ name: c.name, input: c.body, expected: await fn(c.body as never, remover, {}) });
  }
  return out;
}

const payload = {
  _generated_by: "scripts/gen-provider-vectors.ts",
  _contract:
    "Python must produce identical request/response bodies given the same " +
    "trivial codec. Field order matters: these are compared as parsed JSON, " +
    "but the proxy re-serialises them, so a reordered key changes the bytes " +
    "on the wire.",
  setup: {
    secret: SECRET,
    session_id: SESSION,
    detections: SPECS.map((s) => ({ category: s.category, text: s.text })),
    pii_table: PII_TABLE,
    placeholder_note: OPF_PLACEHOLDER_SYSTEM_NOTE,
  },
  anthropic: {
    requests: await buildRequests(anthropicRequests, transformAnthropicRequest as never),
    responses: await buildResponses(anthropicResponses, restoreAnthropicResponse as never),
  },
  openai: {
    requests: await buildRequests(openaiRequests, transformOpenAIRequest as never),
    responses: await buildResponses(openaiResponses, restoreOpenAIResponse as never),
  },
  codex: {
    requests: await buildRequests(codexRequests, transformCodexResponsesRequest as never),
    responses: await buildResponses(codexResponses, restoreCodexResponsesResponse as never),
  },
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(`wrote ${OUT_PATH}`);
for (const p of ["anthropic", "openai", "codex"] as const) {
  console.log(
    `  ${p.padEnd(10)} requests=${payload[p].requests.length} responses=${payload[p].responses.length}`
  );
}
const codexArgs = payload.codex.requests.find(
  (r) => r.name === "input-item-arguments-NOT-masked"
);
console.log(
  `\n  codex input arguments defect: ${JSON.stringify(
    (codexArgs?.expected as { input?: Array<{ arguments?: string }> })?.input?.[0]?.arguments
  )}`
);
