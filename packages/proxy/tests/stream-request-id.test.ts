/**
 * Phase A blocker B1 (docs/QUALITY-MEASUREMENT-PLAN.md §2).
 *
 * Streaming restores once per SSE delta. Before the request id was threaded
 * through the transformers every one of those audit events carried
 * `request_id: undefined`, so a response's restore events could not be grouped
 * back into the mask event that opened the request, and every rate computed
 * from the audit stream had an unknown denominator.
 */

import { describe, expect, test } from "bun:test";
import {
  AuditEmitter,
  LocalRegexBackend,
  PIIRemover,
  SingleStrategy,
  type AuditEntry,
} from "@pii-remover/core";

import { AnthropicSseTransformer } from "../src/stream/anthropic-sse.js";
import { CodexSseTransformer } from "../src/stream/codex-sse.js";
import { OpenAISseTransformer } from "../src/stream/openai-sse.js";
import { serializeSseEvent } from "../src/stream/sse-parser.js";

const EMAIL = "alice@example.com";
const REQUEST_ID = "req-stream-1";

interface Harness {
  remover: PIIRemover;
  entries: AuditEntry[];
  maskedToken: string;
}

async function makeHarness(label: string): Promise<Harness> {
  const entries: AuditEntry[] = [];
  const remover = await PIIRemover.init({
    sessionId: `sse-reqid-${label}`,
    strategy: new SingleStrategy(new LocalRegexBackend()),
    warn: () => {},
    audit: new AuditEmitter({ enabled: true, stream: (e) => entries.push(e) }),
  });
  const masked = await remover.mask(`contact ${EMAIL} now`, {
    request_id: REQUEST_ID,
  });
  entries.length = 0;
  return { remover, entries, maskedToken: masked.tokens[0]?.token ?? "" };
}

function restoreEvents(entries: readonly AuditEntry[]): AuditEntry[] {
  return entries.filter((e) => e.event === "restore");
}

function splitEvery(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe("SSE transformers — every restore event carries the request id", () => {
  test("anthropic tags each delta restore with request id and provider", async () => {
    const { remover, entries, maskedToken } = await makeHarness("anthropic");
    const transformer = new AnthropicSseTransformer(remover, {
      requestId: REQUEST_ID,
      provider: "anthropic",
    });
    const payload = `mail ${maskedToken} end`;

    for (const piece of splitEvery(payload, 3)) {
      transformer.push(
        serializeSseEvent({
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: piece },
          }),
          raw: "",
        })
      );
    }
    transformer.flush();

    const restores = restoreEvents(entries);
    expect(restores.length).toBeGreaterThan(0);
    for (const entry of restores) {
      expect(entry.request_id).toBe(REQUEST_ID);
      expect(entry.provider).toBe("anthropic");
    }
    remover.dispose();
  });

  test("openai tags each delta restore with request id and provider", async () => {
    const { remover, entries, maskedToken } = await makeHarness("openai");
    const transformer = new OpenAISseTransformer(remover, {
      requestId: REQUEST_ID,
      provider: "openai",
    });
    const payload = `mail ${maskedToken} end`;

    for (const piece of splitEvery(payload, 3)) {
      transformer.push(
        serializeSseEvent({
          data: JSON.stringify({
            choices: [{ index: 0, delta: { content: piece } }],
          }),
          raw: "",
        })
      );
    }
    transformer.flush();

    const restores = restoreEvents(entries);
    expect(restores.length).toBeGreaterThan(0);
    for (const entry of restores) {
      expect(entry.request_id).toBe(REQUEST_ID);
      expect(entry.provider).toBe("openai");
    }
    remover.dispose();
  });

  test("codex tags each delta restore with request id and provider", async () => {
    const { remover, entries, maskedToken } = await makeHarness("codex");
    const transformer = new CodexSseTransformer(remover, {
      requestId: REQUEST_ID,
      provider: "codex",
    });
    const payload = `mail ${maskedToken} end`;

    for (const piece of splitEvery(payload, 3)) {
      transformer.push(
        serializeSseEvent({
          event: "response.output_text.delta",
          data: JSON.stringify({
            type: "response.output_text.delta",
            output_index: 0,
            delta: piece,
          }),
          raw: "",
        })
      );
    }
    transformer.flush();

    const restores = restoreEvents(entries);
    expect(restores.length).toBeGreaterThan(0);
    for (const entry of restores) {
      expect(entry.request_id).toBe(REQUEST_ID);
      expect(entry.provider).toBe("codex");
    }
    remover.dispose();
  });

  test("token-free deltas emit no restore event at all", async () => {
    const { remover, entries } = await makeHarness("quiet");
    const transformer = new AnthropicSseTransformer(remover, {
      requestId: REQUEST_ID,
      provider: "anthropic",
    });

    for (const piece of splitEvery("a plain sentence with no tokens", 3)) {
      transformer.push(
        serializeSseEvent({
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: piece },
          }),
          raw: "",
        })
      );
    }
    transformer.flush();

    expect(restoreEvents(entries)).toEqual([]);
    remover.dispose();
  });
});
