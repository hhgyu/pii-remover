import { describe, expect, test } from "bun:test";
import {
  LocalRegexBackend,
  PIIRemover,
  SingleStrategy,
} from "@pii-remover/core";

import {
  isAnthropicThinkingBlock,
  restoreAnthropicResponse,
  transformAnthropicRequest,
} from "../src/providers/anthropic.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicThinkingBlock,
} from "../src/providers/types.js";
import { ProxySessionPool, SESSION_HEADER } from "../src/session.js";
import { AnthropicSseTransformer } from "../src/stream/anthropic-sse.js";
import { serializeSseEvent } from "../src/stream/sse-parser.js";
import { createThinkingCache } from "../src/stream/thinking-cache.js";

const PII = "alice@example.com";
const SIGNATURE = "ErUBCkYIBRgCIkC9+z/Rp0Nq4w==";
const OTHER_SIGNATURE = "ErUBCkYIBRgCIkDzzzzzzzz==";

async function makeRemover(): Promise<PIIRemover> {
  return PIIRemover.init({
    sessionId: `thinking-${Math.random().toString(36).slice(2)}`,
    strategy: new SingleStrategy(new LocalRegexBackend()),
    warn: () => {},
  });
}

/** Masked upstream thinking plus the restored text the client sees for it. */
async function thinkingPair(
  remover: PIIRemover
): Promise<{ raw: string; restored: string }> {
  const raw = (await remover.mask(`Reply to ${PII} about the invoice.`)).text;
  return { raw, restored: remover.restore(raw).text };
}

function blocksOf(message: AnthropicMessage | undefined): AnthropicContentBlock[] {
  const content = message?.content;
  if (content === undefined || typeof content === "string") {
    throw new Error("expected structured content blocks");
  }
  return content;
}

function onlyThinkingBlock(
  blocks: readonly AnthropicContentBlock[]
): AnthropicThinkingBlock {
  const found = blocks.filter(isAnthropicThinkingBlock);
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error(`expected exactly one thinking block, saw ${found.length}`);
  }
  return found[0];
}

function assistantTurn(blocks: AnthropicContentBlock[]): AnthropicMessage {
  return { role: "assistant", content: blocks };
}

function thinkingDelta(index: number, thinking: string): string {
  return serializeSseEvent({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking },
    }),
    raw: "",
  });
}

function signatureDelta(index: number, signature: string): string {
  return serializeSseEvent({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "signature_delta", signature },
    }),
    raw: "",
  });
}

function blockStop(index: number): string {
  return serializeSseEvent({
    event: "content_block_stop",
    data: JSON.stringify({ type: "content_block_stop", index }),
    raw: "",
  });
}

function aggregate(sse: string): { thinking: string; signature: string } {
  let thinking = "";
  let signature = "";
  for (const block of sse.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    if (line === undefined) continue;
    const data: { delta?: { thinking?: string; signature?: string } } = JSON.parse(
      line.slice(6)
    );
    thinking += data.delta?.thinking ?? "";
    signature += data.delta?.signature ?? "";
  }
  return { thinking, signature };
}

describe("transformAnthropicRequest — signature-safe thinking replay", () => {
  test("cache hit replays the exact signed bytes and leaves the signature untouched", async () => {
    // Given: a cache holding the masked bytes Anthropic signed, and a client
    // replaying the restored thinking it was shown
    const remover = await makeRemover();
    const { raw, restored } = await thinkingPair(remover);
    const thinkingCache = createThinkingCache();
    thinkingCache.set(SIGNATURE, raw);

    // When: the replayed turn is transformed
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        messages: [
          { role: "user", content: "continue" },
          assistantTurn([
            { type: "thinking", thinking: restored, signature: SIGNATURE },
            { type: "text", text: "Working on it." },
          ]),
        ],
      },
      remover,
      { thinkingCache }
    );

    // Then: upstream receives the signed bytes verbatim under the same signature
    const blocks = blocksOf(out.body.messages[1]);
    const thinking = onlyThinkingBlock(blocks);
    expect(thinking.thinking).toBe(raw);
    expect(thinking.signature).toBe(SIGNATURE);
    expect(JSON.stringify(out.body)).not.toContain(PII);
  });

  test("cache miss rejects the request locally instead of dropping the block", async () => {
    // Given: an empty cache and a replayed turn whose thinking carries live PII
    const remover = await makeRemover();
    const { restored } = await thinkingPair(remover);
    const thinkingCache = createThinkingCache();

    // When: the turn is transformed against a signature nobody cached
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        messages: [
          assistantTurn([
            { type: "thinking", thinking: restored, signature: OTHER_SIGNATURE },
            { type: "text", text: `Mailing ${PII} now.` },
          ]),
        ],
      },
      remover,
      { thinkingCache }
    );

    // Then: the caller is handed an explicit local refusal that names no secret
    expect(out.rejection?.status).toBe(400);
    expect(out.rejection?.body.error).toBe("thinking_replay_unavailable");
    expect(JSON.stringify(out.rejection)).not.toContain(PII);
    expect(JSON.stringify(out.rejection)).not.toContain(OTHER_SIGNATURE);
  });

  test("thinking without a usable signature is rejected, not dropped", async () => {
    // Given: a thinking block the model cannot have signed
    const remover = await makeRemover();
    const { raw, restored } = await thinkingPair(remover);
    const thinkingCache = createThinkingCache();
    thinkingCache.set(SIGNATURE, raw);

    // When: it arrives with an empty signature
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        messages: [
          assistantTurn([{ type: "thinking", thinking: restored, signature: "" }]),
        ],
      },
      remover,
      { thinkingCache }
    );

    // Then: unsigned thinking is unreplayable, so the turn is refused whole
    expect(out.rejection?.status).toBe(400);
    expect(out.rejection?.body.error).toBe("thinking_replay_unavailable");
    expect(JSON.stringify(out.rejection)).not.toContain(PII);
  });

  test("a resolvable turn is forwarded with no rejection", async () => {
    // Given: a cache holding the signed bytes for every replayed block
    const remover = await makeRemover();
    const { raw, restored } = await thinkingPair(remover);
    const thinkingCache = createThinkingCache();
    thinkingCache.set(SIGNATURE, raw);

    // When: the turn replays that block beside a redacted one
    const redacted = { type: "redacted_thinking", data: "EroBCkYIBRgCKkBc==" };
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        messages: [
          assistantTurn([
            { type: "thinking", thinking: restored, signature: SIGNATURE },
            redacted,
          ]),
        ],
      },
      remover,
      { thinkingCache }
    );

    // Then: nothing is refused and both blocks survive, the redacted one verbatim
    expect(out.rejection).toBeUndefined();
    const blocks = blocksOf(out.body.messages[0]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual(redacted);
  });

  test("redacted_thinking is forwarded byte-identical and never cached", async () => {
    // Given: a redacted thinking block, which has no plaintext to restore
    const remover = await makeRemover();
    const thinkingCache = createThinkingCache();
    const redacted = { type: "redacted_thinking", data: "EroBCkYIBRgCKkBc==" };

    // When: the turn is transformed
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        messages: [assistantTurn([redacted])],
      },
      remover,
      { thinkingCache }
    );

    // Then: it survives unchanged and contributes nothing to the cache
    expect(blocksOf(out.body.messages[0])).toEqual([redacted]);
    expect(thinkingCache.size()).toBe(0);
  });

  test("without a cache the thinking block is left exactly as it arrived", async () => {
    // Given: no cache configured — nothing was ever restored, so nothing to undo
    const remover = await makeRemover();
    const { raw } = await thinkingPair(remover);

    // When: the turn is transformed with default options
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        messages: [
          assistantTurn([{ type: "thinking", thinking: raw, signature: SIGNATURE }]),
        ],
      },
      remover
    );

    // Then: passthrough is preserved for callers that never restore
    const thinking = onlyThinkingBlock(blocksOf(out.body.messages[0]));
    expect(thinking.thinking).toBe(raw);
    expect(thinking.signature).toBe(SIGNATURE);
  });
});

describe("restoreAnthropicResponse — non-streaming thinking", () => {
  test("caches the signed bytes and returns thinking restored for display", async () => {
    // Given: a non-streaming response carrying masked, signed thinking
    const remover = await makeRemover();
    const { raw } = await thinkingPair(remover);
    const thinkingCache = createThinkingCache();

    // When: the response is restored for the client
    const out = await restoreAnthropicResponse(
      {
        content: [
          { type: "thinking", thinking: raw, signature: SIGNATURE },
          { type: "text", text: raw },
        ],
      },
      remover,
      { thinkingCache }
    );

    // Then: the client sees PII, the signature is intact, and replay bytes are kept
    const block = out.content?.[0];
    expect(block?.["thinking"]).toContain(PII);
    expect(block?.["signature"]).toBe(SIGNATURE);
    expect(thinkingCache.get(SIGNATURE)).toBe(raw);
  });

  test("without a cache the thinking block is passed through unrestored", async () => {
    // Given: no cache — restoring display text we could never replay is a 400 waiting to happen
    const remover = await makeRemover();
    const { raw } = await thinkingPair(remover);

    // When: the response is restored with default options
    const out = await restoreAnthropicResponse(
      { content: [{ type: "thinking", thinking: raw, signature: SIGNATURE }] },
      remover
    );

    // Then: the block is untouched
    expect(out.content?.[0]?.["thinking"]).toBe(raw);
  });

  test("redacted_thinking is neither restored nor cached", async () => {
    // Given: a redacted block in the response
    const remover = await makeRemover();
    const thinkingCache = createThinkingCache();
    const redacted = { type: "redacted_thinking", data: "EroBCkYIBRgCKkBc==" };

    // When: the response is restored
    const out = await restoreAnthropicResponse({ content: [redacted] }, remover, {
      thinkingCache,
    });

    // Then: it is untouched and nothing was cached
    expect(out.content?.[0]).toEqual(redacted);
    expect(thinkingCache.size()).toBe(0);
  });
});

describe("AnthropicSseTransformer — thinking cache population", () => {
  test("caches the exact raw upstream thinking at content_block_stop", async () => {
    // Given: masked thinking whose OPF token is split across two deltas
    const remover = await makeRemover();
    const { raw } = await thinkingPair(remover);
    const thinkingCache = createThinkingCache();
    const splitAt = raw.length >> 1;
    const t = new AnthropicSseTransformer(remover, { thinkingCache });

    // When: the block streams to completion
    let out = "";
    out += t.push(thinkingDelta(0, raw.slice(0, splitAt)));
    out += t.push(thinkingDelta(0, raw.slice(splitAt)));
    out += t.push(signatureDelta(0, SIGNATURE));
    out += t.push(blockStop(0));
    out += t.flush();

    // Then: the client saw PII while the cache kept the signed bytes verbatim
    expect(aggregate(out).thinking).toContain(PII);
    expect(thinkingCache.get(SIGNATURE)).toBe(raw);
  });

  test("a signature split across deltas is keyed by its concatenation", async () => {
    // Given: an upstream that chunks signature_delta
    const remover = await makeRemover();
    const { raw } = await thinkingPair(remover);
    const thinkingCache = createThinkingCache();
    const t = new AnthropicSseTransformer(remover, { thinkingCache });

    // When: the signature arrives in two pieces
    let out = "";
    out += t.push(thinkingDelta(0, raw));
    out += t.push(signatureDelta(0, SIGNATURE.slice(0, 5)));
    out += t.push(signatureDelta(0, SIGNATURE.slice(5)));
    out += t.push(blockStop(0));
    out += t.flush();

    // Then: both halves reach the client verbatim and key one cache entry
    expect(aggregate(out).signature).toBe(SIGNATURE);
    expect(thinkingCache.get(SIGNATURE)).toBe(raw);
  });

  test("a stream cut before content_block_stop shows the tail but caches nothing", async () => {
    // Given: a thinking block that never closes
    const remover = await makeRemover();
    const { raw } = await thinkingPair(remover);
    const thinkingCache = createThinkingCache();
    const t = new AnthropicSseTransformer(remover, { thinkingCache });

    // When: the stream ends after the deltas, with no stop event
    let out = "";
    out += t.push(thinkingDelta(0, raw));
    out += t.push(signatureDelta(0, SIGNATURE));
    out += t.flush();

    // Then: the user still reads the thinking, but nothing unverified is cached
    expect(aggregate(out).thinking).toContain(PII);
    expect(thinkingCache.size()).toBe(0);
  });

  test("text_delta blocks are unaffected by the thinking path", async () => {
    // Given: a plain text block streamed alongside the thinking machinery
    const remover = await makeRemover();
    const { raw } = await thinkingPair(remover);
    const thinkingCache = createThinkingCache();
    const t = new AnthropicSseTransformer(remover, { thinkingCache });

    // When: only text deltas arrive
    let out = "";
    out += t.push(
      serializeSseEvent({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: raw },
        }),
        raw: "",
      })
    );
    out += t.push(blockStop(0));
    out += t.flush();

    // Then: text is restored as before and never lands in the thinking cache
    expect(out).toContain("text_delta");
    expect(out).toContain(PII);
    expect(thinkingCache.size()).toBe(0);
  });
});

describe("ProxySessionPool — one thinking cache per session", () => {
  test("the same session id reuses one cache, different ids stay isolated", async () => {
    // Given: a pool serving two distinct X-PII-Session values
    const pool = new ProxySessionPool({ backends: [new LocalRegexBackend()] });
    const alice = await pool.get(new Headers({ [SESSION_HEADER]: "alice" }));
    const aliceAgain = await pool.get(new Headers({ [SESSION_HEADER]: "alice" }));
    const bob = await pool.get(new Headers({ [SESSION_HEADER]: "bob" }));

    // When: alice's stream caches thinking under a signature
    alice.thinkingCache.set(SIGNATURE, "alice thinking");

    // Then: her next request sees it and bob's session cannot
    expect(aliceAgain.thinkingCache).toBe(alice.thinkingCache);
    expect(aliceAgain.thinkingCache.get(SIGNATURE)).toBe("alice thinking");
    expect(bob.thinkingCache.get(SIGNATURE)).toBeUndefined();
    await pool.disposeAll();
  });
});

describe("thinking round trip — stream out, replay in", () => {
  test("what Anthropic signed is exactly what it gets back", async () => {
    // Given: a thinking block streamed to the client through the transformer
    const remover = await makeRemover();
    const { raw } = await thinkingPair(remover);
    const thinkingCache = createThinkingCache();
    const t = new AnthropicSseTransformer(remover, { thinkingCache });
    let sse = "";
    sse += t.push(thinkingDelta(0, raw.slice(0, 9)));
    sse += t.push(thinkingDelta(0, raw.slice(9)));
    sse += t.push(signatureDelta(0, SIGNATURE));
    sse += t.push(blockStop(0));
    sse += t.flush();
    const displayed = aggregate(sse).thinking;

    // When: the client replays exactly what it was shown
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        messages: [
          assistantTurn([
            { type: "thinking", thinking: displayed, signature: SIGNATURE },
          ]),
        ],
      },
      remover,
      { thinkingCache }
    );

    // Then: the bytes upstream verifies are byte-identical to what it emitted
    const thinking = onlyThinkingBlock(blocksOf(out.body.messages[0]));
    expect(displayed).not.toBe(raw);
    expect(thinking.thinking).toBe(raw);
    expect(thinking.signature).toBe(SIGNATURE);
  });

  test("without a cache the client is shown the signed bytes and replays them unchanged", async () => {
    // Given: a transformer with nowhere to keep the signed bytes
    const remover = await makeRemover();
    const { raw } = await thinkingPair(remover);
    const t = new AnthropicSseTransformer(remover);

    // When: the block streams and the client replays exactly what it saw
    let sse = "";
    sse += t.push(thinkingDelta(0, raw.slice(0, 9)));
    sse += t.push(thinkingDelta(0, raw.slice(9)));
    sse += t.push(signatureDelta(0, SIGNATURE));
    sse += t.push(blockStop(0));
    sse += t.flush();
    const displayed = aggregate(sse).thinking;
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        messages: [
          assistantTurn([
            { type: "thinking", thinking: displayed, signature: SIGNATURE },
          ]),
        ],
      },
      remover
    );

    // Then: display stayed masked, so the replay is already signature-exact
    expect(displayed).toBe(raw);
    expect(displayed).not.toContain(PII);
    expect(out.rejection).toBeUndefined();
    const thinking = onlyThinkingBlock(blocksOf(out.body.messages[0]));
    expect(thinking.thinking).toBe(raw);
    expect(thinking.signature).toBe(SIGNATURE);
  });

  test("a signature with no thinking_delta caches the empty string it signed", async () => {
    // Given: display:"omitted" — Anthropic signs the block but streams no text
    const remover = await makeRemover();
    const thinkingCache = createThinkingCache();
    const t = new AnthropicSseTransformer(remover, { thinkingCache });

    // When: only the signature and the stop event arrive, then the client
    // replays the empty thinking block it was shown
    let sse = "";
    sse += t.push(signatureDelta(0, SIGNATURE));
    sse += t.push(blockStop(0));
    sse += t.flush();
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        messages: [
          assistantTurn([{ type: "thinking", thinking: "", signature: SIGNATURE }]),
        ],
      },
      remover,
      { thinkingCache }
    );

    // Then: the empty signed string is cached and replays instead of being refused
    expect(aggregate(sse).signature).toBe(SIGNATURE);
    expect(thinkingCache.get(SIGNATURE)).toBe("");
    expect(out.rejection).toBeUndefined();
    const thinking = onlyThinkingBlock(blocksOf(out.body.messages[0]));
    expect(thinking.thinking).toBe("");
    expect(thinking.signature).toBe(SIGNATURE);
  });
});
