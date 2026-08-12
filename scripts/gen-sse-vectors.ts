/**
 * Emit golden SSE transformer vectors from the TypeScript implementation.
 *
 * Covers the incremental parser and all three provider transformers. Every
 * stream is replayed at several chunk widths because upstream chunk boundaries
 * never align with SSE event boundaries — a transformer that only works when a
 * whole event arrives at once is broken in production and green in a naive test.
 *
 * The restore scope is built from a VaultManager + Restorer rather than a full
 * PIIRemover so the Python side can reproduce the vault exactly from the same
 * key and the same detection list. `createStreamRestoreScope` only ever calls
 * `remover.restore(value, opts).text`, so a minimal stand-in is faithful.
 *
 * Usage: bun run scripts/gen-sse-vectors.ts
 * Writes: packages/backend/tests/fixtures/sse_vectors.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PIIRemover } from "../packages/core/src/pii-remover.js";
import { deriveTokenKey } from "../packages/core/src/redaction/token-hash.js";
import { VaultManager } from "../packages/core/src/vault/manager.js";
import { Restorer } from "../packages/core/src/restorer/index.js";
import type { Detection } from "../packages/core/src/types.js";
import {
  SseLineParser,
  serializeSseEvent,
} from "../packages/proxy/src/stream/sse-parser.js";
import { AnthropicSseTransformer } from "../packages/proxy/src/stream/anthropic-sse.js";
import { OpenAISseTransformer } from "../packages/proxy/src/stream/openai-sse.js";
import { CodexSseTransformer } from "../packages/proxy/src/stream/codex-sse.js";

const OUT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "backend",
  "tests",
  "fixtures",
  "sse_vectors.json"
);

const SECRET = "pii-remover-baseline-secret";
const SESSION = "sse-session";
const KEY = deriveTokenKey(SECRET);

const SPECS: ReadonlyArray<{ category: Detection["category"]; text: string }> = [
  { category: "private_person", text: "김철수" },
  { category: "private_email", text: "alice@example.com" },
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
const PERSON = assigned[0]!.token;
const EMAIL = assigned[1]!.token;

const restorer = new Restorer(vault, { warn: () => {} });
/** Minimal stand-in: the scope only reads `.restore(value, opts).text`. */
const remover = {
  restore: (value: string) => restorer.restore(value, SESSION, { warn: () => {} }),
} as unknown as PIIRemover;

// --- section: parser -------------------------------------------------------
const PARSER_STREAMS: ReadonlyArray<{ name: string; raw: string }> = [
  { name: "single-data", raw: "data: hello\n\n" },
  { name: "event-and-data", raw: "event: ping\ndata: {}\n\n" },
  { name: "crlf", raw: "event: ping\r\ndata: {}\r\n\r\n" },
  { name: "multi-line-data", raw: "data: line1\ndata: line2\n\n" },
  { name: "comment-ignored", raw: ": keepalive\ndata: x\n\n" },
  { name: "data-no-space", raw: "data:tight\n\n" },
  { name: "data-two-spaces", raw: "data:  two\n\n" },
  { name: "two-events", raw: "data: a\n\ndata: b\n\n" },
  { name: "done-sentinel", raw: "data: [DONE]\n\n" },
  { name: "blank-padding", raw: "\n\ndata: a\n\n\n\ndata: b\n\n" },
  { name: "event-only-no-data", raw: "event: solo\n\n" },
  { name: "trailing-incomplete", raw: "data: a\n\ndata: partial" },
];

const parserCases = PARSER_STREAMS.flatMap(({ name, raw }) =>
  [1, 3, 8, raw.length].map((width) => {
    const parser = new SseLineParser();
    const chunks: string[] = [];
    for (let i = 0; i < raw.length; i += width) chunks.push(raw.slice(i, i + width));
    const pushes = chunks.map((c) => parser.push(c));
    const flushed = parser.flush();
    return {
      name: `${name}-w${width}`,
      raw,
      chunks,
      expected: {
        pushes: pushes.map((evs) =>
          evs.map((e) => ({ event: e.event ?? null, data: e.data }))
        ),
        flush: flushed.map((e) => ({ event: e.event ?? null, data: e.data })),
      },
    };
  })
);

// --- section: serialize ----------------------------------------------------
const serializeCases = [
  { event: undefined, data: "hello" },
  { event: "ping", data: "{}" },
  { event: undefined, data: "line1\nline2" },
  { event: "x", data: "" },
  { event: undefined, data: "[DONE]" },
].map((e) => ({
  input: { event: e.event ?? null, data: e.data },
  output: serializeSseEvent({ event: e.event, data: e.data, raw: "" }),
}));

// --- section: transformers -------------------------------------------------
function anthropicStream(): string {
  const ev = (event: string, data: unknown) =>
    serializeSseEvent({ event, data: JSON.stringify(data), raw: "" });
  return (
    ev("message_start", { type: "message_start", message: { id: "msg_1" } }) +
    ev("content_block_start", { type: "content_block_start", index: 0 }) +
    ev("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: `Hi ${PERSON.slice(0, 12)}` },
    }) +
    ev("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: `${PERSON.slice(12)} and ${EMAIL}` },
    }) +
    ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
    ev("message_stop", { type: "message_stop" })
  );
}

function anthropicToolStream(): string {
  const ev = (event: string, data: unknown) =>
    serializeSseEvent({ event, data: JSON.stringify(data), raw: "" });
  const args = JSON.stringify({ to: EMAIL, name: PERSON });
  return (
    ev("content_block_start", { type: "content_block_start", index: 1 }) +
    ev("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: args.slice(0, 20) },
    }) +
    ev("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: args.slice(20) },
    }) +
    ev("content_block_stop", { type: "content_block_stop", index: 1 }) +
    ev("message_stop", { type: "message_stop" })
  );
}

function anthropicUnterminatedStream(): string {
  const ev = (event: string, data: unknown) =>
    serializeSseEvent({ event, data: JSON.stringify(data), raw: "" });
  return (
    ev("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: `tail ${PERSON.slice(0, 9)}` },
    }) +
    ev("content_block_delta", {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: `{"n":"${PERSON}"` },
    })
  );
}

function openaiStream(): string {
  const ev = (data: unknown) =>
    serializeSseEvent({ data: JSON.stringify(data), raw: "" });
  return (
    ev({ choices: [{ index: 0, delta: { content: `Hello ${PERSON.slice(0, 8)}` } }] }) +
    ev({ choices: [{ index: 0, delta: { content: `${PERSON.slice(8)}!` } }] }) +
    ev({ choices: [{ index: 0, delta: { content: ` Mail ${EMAIL}.` } }] }) +
    ev({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    serializeSseEvent({ data: "[DONE]", raw: "" })
  );
}

function openaiToolStream(): string {
  const ev = (data: unknown) =>
    serializeSseEvent({ data: JSON.stringify(data), raw: "" });
  const args = JSON.stringify({ email: EMAIL });
  return (
    ev({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 9) } }] } },
      ],
    }) +
    ev({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(9) } }] } },
      ],
    }) +
    serializeSseEvent({ data: "[DONE]", raw: "" })
  );
}

function codexStream(): string {
  const ev = (event: string, data: unknown) =>
    serializeSseEvent({ event, data: JSON.stringify(data), raw: "" });
  const args = JSON.stringify({ who: PERSON });
  return (
    ev("response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: 0,
      delta: `Name ${PERSON.slice(0, 10)}`,
    }) +
    ev("response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: 0,
      delta: `${PERSON.slice(10)} ok`,
    }) +
    ev("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: args.slice(0, 8),
    }) +
    ev("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: args.slice(8),
    }) +
    ev("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      output_index: 1,
      delta: "",
    }) +
    ev("response.completed", { type: "response.completed" })
  );
}

const TRANSFORMER_STREAMS: ReadonlyArray<{
  provider: "anthropic" | "openai" | "codex";
  name: string;
  raw: string;
}> = [
  { provider: "anthropic", name: "text", raw: anthropicStream() },
  { provider: "anthropic", name: "tool-input", raw: anthropicToolStream() },
  { provider: "anthropic", name: "unterminated", raw: anthropicUnterminatedStream() },
  { provider: "openai", name: "text", raw: openaiStream() },
  { provider: "openai", name: "tool-calls", raw: openaiToolStream() },
  { provider: "codex", name: "text-and-tool", raw: codexStream() },
];

function makeTransformer(provider: string) {
  const opts = { bufferWindow: 64, flushOnClose: true, requestId: "req_fixture", provider };
  if (provider === "anthropic") return new AnthropicSseTransformer(remover, opts);
  if (provider === "openai") return new OpenAISseTransformer(remover, opts);
  return new CodexSseTransformer(remover, opts);
}

const transformerCases = TRANSFORMER_STREAMS.flatMap(({ provider, name, raw }) =>
  [1, 5, 17, raw.length].map((width) => {
    const t = makeTransformer(provider);
    const chunks: string[] = [];
    for (let i = 0; i < raw.length; i += width) chunks.push(raw.slice(i, i + width));
    const pushes = chunks.map((c) => t.push(c));
    const flushed = t.flush();
    return {
      provider,
      name: `${provider}-${name}-w${width}`,
      chunks,
      expected: { pushes, flush: flushed, total: pushes.join("") + flushed },
    };
  })
);

const payload = {
  _generated_by: "scripts/gen-sse-vectors.ts",
  _contract:
    "Python must reproduce the per-push output byte-for-byte. JSON re-encoding " +
    "must match JSON.stringify: compact separators and raw non-ASCII.",
  setup: {
    secret: SECRET,
    session_id: SESSION,
    detections: SPECS.map((s) => ({ category: s.category, text: s.text })),
    tokens: { PERSON, EMAIL },
  },
  parser: parserCases,
  serialize: serializeCases,
  transformers: transformerCases,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(`wrote ${OUT_PATH}`);
console.log(`  parser:       ${parserCases.length}`);
console.log(`  serialize:    ${serializeCases.length}`);
console.log(`  transformers: ${transformerCases.length}`);
for (const c of transformerCases.filter((c) => c.name.endsWith(`-w1`))) {
  const restoredPerson = c.expected.total.includes("김철수");
  console.log(`    ${c.name.padEnd(34)} bytes=${String(c.expected.total.length).padStart(5)} restored-hangul=${restoredPerson}`);
}
