import { describe, expect, test } from "bun:test";
import {
  LocalRegexBackend,
  PIIRemover,
  SingleStrategy,
} from "@pii-remover/core";

import { AnthropicSseTransformer } from "../src/stream/anthropic-sse.js";
import { OpenAISseTransformer } from "../src/stream/openai-sse.js";
import { CodexSseTransformer } from "../src/stream/codex-sse.js";
import { SseLineParser, serializeSseEvent } from "../src/stream/sse-parser.js";
import { createThinkingCache } from "../src/stream/thinking-cache.js";

async function makeRemover() {
  return PIIRemover.init({
    sessionId: `sse-${Math.random().toString(36).slice(2)}`,
    strategy: new SingleStrategy(new LocalRegexBackend()),
    warn: () => {},
  });
}

function anthropicDelta(index: number, text: string): string {
  return serializeSseEvent({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    }),
    raw: "",
  });
}

function anthropicThinkingDelta(index: number, thinking: string): string {
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

function anthropicSignatureDelta(index: number, signature: string): string {
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

function aggregateSseThinking(sse: string): {
  thinking: string;
  signature: string;
} {
  let thinking = "";
  let signature = "";
  for (const block of sse.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    try {
      const data: { delta?: { thinking?: string; signature?: string } } =
        JSON.parse(line.slice(6));
      thinking += data.delta?.thinking ?? "";
      signature += data.delta?.signature ?? "";
    } catch {
      // ignore sentinels
    }
  }
  return { thinking, signature };
}

function openaiDelta(content: string, index = 0): string {
  return serializeSseEvent({
    data: JSON.stringify({
      choices: [{ index, delta: { content } }],
    }),
    raw: "",
  });
}

function splitEvery(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function aggregateSseText(sse: string): string {
  let text = "";
  for (const block of sse.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    try {
      const data = JSON.parse(line.slice(6));
      text += data.delta?.text ?? data.choices?.[0]?.delta?.content ?? "";
    } catch {
      // ignore sentinels
    }
  }
  return text;
}

describe("SseLineParser — event block parsing", () => {
  test("parses event + data line", () => {
    const parser = new SseLineParser();
    const evs = parser.push("event: foo\ndata: bar\n\n");
    expect(evs).toHaveLength(1);
    expect(evs[0]!.event).toBe("foo");
    expect(evs[0]!.data).toBe("bar");
  });

  test("parses multi-line data", () => {
    const parser = new SseLineParser();
    const evs = parser.push("data: line1\ndata: line2\n\n");
    expect(evs).toHaveLength(1);
    expect(evs[0]!.data).toBe("line1\nline2");
  });

  test("ignores comment lines", () => {
    const parser = new SseLineParser();
    const evs = parser.push(": ping\nevent: heartbeat\ndata: {}\n\n");
    expect(evs).toHaveLength(1);
    expect(evs[0]!.event).toBe("heartbeat");
  });

  test("buffers partial events", () => {
    const parser = new SseLineParser();
    expect(parser.push("event: foo\ndata: ")).toHaveLength(0);
    const evs = parser.push("bar\n\n");
    expect(evs).toHaveLength(1);
    expect(evs[0]!.data).toBe("bar");
  });
});

describe("AnthropicSseTransformer — token-restoring delta pipeline", () => {
  test("restores token in single complete delta", async () => {
    const remover = await makeRemover();
    const token = (await remover.mask("alice@example.com")).tokens[0]!.token;
    const t = new AnthropicSseTransformer(remover);
    const input = anthropicDelta(0, `Email ${token} please`);
    const out = t.push(input) + t.flush();
    expect(out).toContain("alice@example.com");
    expect(out).not.toContain("{{OPF:EMAIL:");
  });

  test("reassembles token split across deltas", async () => {
    const remover = await makeRemover();
    const token = (await remover.mask("bob@example.com")).tokens[0]!.token;
    const t = new AnthropicSseTransformer(remover);
    const fullText = `Ping ${token} tomorrow`;
    const splitAt = `Ping ${token.slice(0, token.length >> 1)}`.length;
    let out = "";
    out += t.push(anthropicDelta(0, fullText.slice(0, splitAt)));
    out += t.push(anthropicDelta(0, fullText.slice(splitAt)));
    out += t.flush();
    expect(aggregateSseText(out)).toContain("bob@example.com");
    expect(out).not.toContain("{{OPF:EMAIL:");
  });

  test("content_block_stop flushes pending buffer for that index (lenient: suffix dropped)", async () => {
    const remover = await makeRemover();
    const token = (await remover.mask("carol@example.com")).tokens[0]!.token.slice(0, -2);
    const t = new AnthropicSseTransformer(remover);
    let out = "";
    out += t.push(anthropicDelta(0, `Hi ${token}`));
    out += t.push(
      serializeSseEvent({
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index: 0 }),
        raw: "",
      })
    );
    out += t.flush();
    expect(out).toContain("carol@example.com");
  });

  test("input_json_delta: accumulates and restores PII tokens in tool call args", async () => {
    const remover = await makeRemover();
    const person = (await remover.mask("김철수")).tokens[0]!.token;
    const email = (await remover.mask("alice@example.com")).tokens[0]!.token;
    const t = new AnthropicSseTransformer(remover);
    const toolArgs = JSON.stringify({
      questions: [{ question: `${person}님 ${email} 확인?` }],
    });
    const chunks = splitEvery(toolArgs, 5);
    let out = "";
    for (const chunk of chunks) {
      out += t.push(serializeSseEvent({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: chunk },
        }),
        raw: "",
      }));
    }
    out += t.push(serializeSseEvent({
      event: "content_block_stop",
      data: JSON.stringify({ type: "content_block_stop", index: 0 }),
      raw: "",
    }));
    out += t.flush();
    expect(out).toContain("김철수");
    expect(out).toContain("alice@example.com");
    expect(out).not.toContain("{{OPF:PERSON:");
    expect(out).not.toContain("{{OPF:EMAIL:");
    expect(out).toContain("input_json_delta");
  });

  test("input_json_delta without PII passes through as-is", async () => {
    const remover = await makeRemover();
    const t = new AnthropicSseTransformer(remover);
    const toolArgs = JSON.stringify({ action: "confirm", value: 42 });
    const chunks = splitEvery(toolArgs, 4);
    let out = "";
    for (const chunk of chunks) {
      out += t.push(serializeSseEvent({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: chunk },
        }),
        raw: "",
      }));
    }
    out += t.push(serializeSseEvent({
      event: "content_block_stop",
      data: JSON.stringify({ type: "content_block_stop", index: 1 }),
      raw: "",
    }));
    out += t.flush();
    expect(out).toContain("input_json_delta");
    expect(out).toContain("confirm");
  });

  test("multi-block indices buffered independently", async () => {
    const remover = await makeRemover();
    const token = (await remover.mask("dev@example.com")).tokens[0]!.token;
    const t = new AnthropicSseTransformer(remover);
    let out = "";
    const cut = "{{OPF:E".length;
    out += t.push(anthropicDelta(0, `first ${token.slice(0, cut)}`));
    out += t.push(anthropicDelta(1, `second ${token.slice(0, cut)}`));
    out += t.push(anthropicDelta(0, `${token.slice(cut)} end0`));
    out += t.push(anthropicDelta(1, `${token.slice(cut)} end1`));
    out += t.flush();
    const emailCount = (out.match(/dev@example\.com/g) ?? []).length;
    expect(emailCount).toBe(2);
  });

  test("passes through message_start / message_stop", async () => {
    const remover = await makeRemover();
    const t = new AnthropicSseTransformer(remover);
    const out =
      t.push(
        serializeSseEvent({
          event: "message_start",
          data: JSON.stringify({ type: "message_start" }),
          raw: "",
        })
      ) +
      t.push(
        serializeSseEvent({
          event: "message_stop",
          data: JSON.stringify({ type: "message_stop" }),
          raw: "",
        })
      ) +
      t.flush();
    expect(out).toContain("message_start");
    expect(out).toContain("message_stop");
  });

  test("with a thinking cache, thinking_delta restores a split token while signature_delta replays byte-identical", async () => {
    // Given: a minted OPF token split across two thinking deltas, plus an opaque signature
    const remover = await makeRemover();
    const token = (await remover.mask("alice@example.com")).tokens[0]!.token;
    const signature = "ErUBCkYIBRgCIkC9+z/Rp0Nq4w==";
    const splitAt = token.length >> 1;
    const thinkingCache = createThinkingCache();
    const t = new AnthropicSseTransformer(remover, { thinkingCache });

    // When: the client streams thinking deltas, a signature delta, then content_block_stop
    let out = "";
    out += t.push(anthropicThinkingDelta(0, `Reply to ${token.slice(0, splitAt)}`));
    out += t.push(anthropicThinkingDelta(0, `${token.slice(splitAt)} shortly`));
    out += t.push(anthropicSignatureDelta(0, signature));
    out += t.push(
      serializeSseEvent({
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index: 0 }),
        raw: "",
      })
    );
    out += t.flush();

    // Then: thinking is restored to the original PII while the signature is unchanged
    const aggregated = aggregateSseThinking(out);
    expect(aggregated.thinking).toContain("alice@example.com");
    expect(aggregated.thinking).not.toContain("{{OPF:");
    expect(aggregated.signature).toBe(signature);
    expect(thinkingCache.get(signature)).toBe(`Reply to ${token} shortly`);
  });

  test("without a thinking cache, thinking_delta stays masked and the signature is still verbatim", async () => {
    // Given: the same stream through a transformer that has nowhere to cache
    //        the signed bytes, so restoring for display would be unreplayable
    const remover = await makeRemover();
    const token = (await remover.mask("alice@example.com")).tokens[0]!.token;
    const signature = "ErUBCkYIBRgCIkC9+z/Rp0Nq4w==";
    const splitAt = token.length >> 1;
    const t = new AnthropicSseTransformer(remover);

    // When: the client streams thinking deltas, a signature delta, then content_block_stop
    let out = "";
    out += t.push(anthropicThinkingDelta(0, `Reply to ${token.slice(0, splitAt)}`));
    out += t.push(anthropicThinkingDelta(0, `${token.slice(splitAt)} shortly`));
    out += t.push(anthropicSignatureDelta(0, signature));
    out += t.push(
      serializeSseEvent({
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index: 0 }),
        raw: "",
      })
    );
    out += t.flush();

    // Then: the upstream bytes reach the client untouched, signature included
    const aggregated = aggregateSseThinking(out);
    expect(aggregated.thinking).toBe(`Reply to ${token} shortly`);
    expect(aggregated.thinking).not.toContain("alice@example.com");
    expect(aggregated.signature).toBe(signature);
  });
});

describe("OpenAISseTransformer — token-restoring delta pipeline", () => {
  test("restores token in single complete delta", async () => {
    const remover = await makeRemover();
    const token = (await remover.mask("alice@example.com")).tokens[0]!.token;
    const t = new OpenAISseTransformer(remover);
    const out = t.push(openaiDelta(`Email ${token} please`)) + t.flush();
    expect(out).toContain("alice@example.com");
    expect(out).not.toContain("{{OPF:EMAIL:");
  });

  test("reassembles token split across deltas", async () => {
    const remover = await makeRemover();
    const token = (await remover.mask("bob@example.com")).tokens[0]!.token;
    const t = new OpenAISseTransformer(remover);
    const fullText = `ping ${token} now`;
    let out = "";
    const splitAt = `ping ${token.slice(0, token.length >> 1)}`.length;
    out += t.push(openaiDelta(fullText.slice(0, splitAt)));
    out += t.push(openaiDelta(fullText.slice(splitAt)));
    out += t.flush();
    expect(aggregateSseText(out)).toContain("bob@example.com");
    expect(out).not.toContain("{{OPF:EMAIL:");
  });

  test("[DONE] sentinel passes through", async () => {
    const remover = await makeRemover();
    const t = new OpenAISseTransformer(remover);
    const out =
      t.push(openaiDelta("hi ")) +
      t.push(`data: [DONE]\n\n`) +
      t.flush();
    expect(out).toContain("[DONE]");
  });

  test("deltas without content (role marker etc.) pass through", async () => {
    const remover = await makeRemover();
    const t = new OpenAISseTransformer(remover);
    const data = JSON.stringify({
      choices: [{ index: 0, delta: { role: "assistant" } }],
    });
    const out = t.push(`data: ${data}\n\n`) + t.flush();
    expect(out).toContain("assistant");
  });

  test("delta.tool_calls arguments: accumulates and restores PII tokens", async () => {
    const remover = await makeRemover();
    const person = (await remover.mask("김철수")).tokens[0]!.token;
    const email = (await remover.mask("alice@example.com")).tokens[0]!.token;
    const t = new OpenAISseTransformer(remover);
    const fullArgs = JSON.stringify({
      questions: [{ question: `${person}님 ${email}` }],
    });
    let out = "";
    for (const chunk of splitEvery(fullArgs, 6)) {
      out += t.push(serializeSseEvent({
        data: JSON.stringify({
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: chunk } }] },
          }],
        }),
        raw: "",
      }));
    }
    out += t.flush();
    expect(out).toContain("김철수");
    expect(out).toContain("alice@example.com");
    expect(out).not.toContain("{{OPF:PERSON:");
    expect(out).not.toContain("{{OPF:EMAIL:");
    expect(out).toContain("tool_calls");
  });
});

describe("CodexSseTransformer — function_call_arguments restoration", () => {
  const sse = serializeSseEvent;

  test("response.function_call_arguments.delta: accumulates and restores PII on done", async () => {
    const remover = await makeRemover();
    const person = (await remover.mask("김철수")).tokens[0]!.token;
    const email = (await remover.mask("alice@example.com")).tokens[0]!.token;
    const t = new CodexSseTransformer(remover);
    const fullArgs = JSON.stringify({
      todos: [{ content: `${person}님 todo: ${email} 확인` }],
    });
    let out = "";
    for (const chunk of splitEvery(fullArgs, 7)) {
      out += t.push(sse({
        event: "response.function_call_arguments.delta",
        data: JSON.stringify({
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: chunk,
        }),
        raw: "",
      }));
    }
    out += t.push(sse({
      event: "response.function_call_arguments.done",
      data: JSON.stringify({
        type: "response.function_call_arguments.done",
        output_index: 0,
        delta: fullArgs,
      }),
      raw: "",
    }));
    out += t.flush();
    expect(out).toContain("김철수");
    expect(out).toContain("alice@example.com");
    expect(out).not.toContain("{{OPF:PERSON:");
    expect(out).not.toContain("{{OPF:EMAIL:");
    expect(out).toContain("function_call_arguments.done");
  });

  test("response.output_text.delta still works after function_call changes", async () => {
    const remover = await makeRemover();
    const token = (await remover.mask("bob@example.com")).tokens[0]!.token;
    const t = new CodexSseTransformer(remover);
    const out = t.push(sse({
      event: "response.output_text.delta",
      data: JSON.stringify({
        type: "response.output_text.delta",
        output_index: 0,
        delta: `Email ${token} done`,
      }),
      raw: "",
    })) + t.flush();
    expect(out).toContain("bob@example.com");
    expect(out).not.toContain("{{OPF:EMAIL:");
  });
});
