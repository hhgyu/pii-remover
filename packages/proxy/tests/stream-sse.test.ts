import { describe, expect, test } from "bun:test";
import { LocalRegexBackend, PIIRemover } from "@pii-remover/core";

import { AnthropicSseTransformer } from "../src/stream/anthropic-sse.js";
import { OpenAISseTransformer } from "../src/stream/openai-sse.js";
import { CodexSseTransformer } from "../src/stream/codex-sse.js";
import { SseLineParser, serializeSseEvent } from "../src/stream/sse-parser.js";

async function makeRemover() {
  return PIIRemover.init({
    sessionId: `sse-${Math.random().toString(36).slice(2)}`,
    backends: [new LocalRegexBackend()],
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
    await remover.mask("alice@example.com");
    const t = new AnthropicSseTransformer(remover);
    const input = anthropicDelta(0, "Email __OPF_EMAIL_1__ please");
    const out = t.push(input) + t.flush();
    expect(out).toContain("alice@example.com");
    expect(out).not.toContain("__OPF_EMAIL_");
  });

  test("reassembles token split across deltas (1-char chunks)", async () => {
    const remover = await makeRemover();
    await remover.mask("bob@example.com");
    const t = new AnthropicSseTransformer(remover);
    const fullText = "Ping __OPF_EMAIL_1__ tomorrow";
    let out = "";
    for (const ch of splitEvery(fullText, 1)) {
      out += t.push(anthropicDelta(0, ch));
    }
    out += t.flush();
    expect(out).toContain("bob@example.com");
    expect(out).not.toContain("__OPF_EMAIL_");
  });

  test("content_block_stop flushes pending buffer for that index (lenient: suffix dropped)", async () => {
    const remover = await makeRemover();
    await remover.mask("carol@example.com");
    const t = new AnthropicSseTransformer(remover);
    let out = "";
    out += t.push(anthropicDelta(0, "Hi __OPF_EMAIL_1"));
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
    await remover.mask("김철수");
    await remover.mask("alice@example.com");
    const t = new AnthropicSseTransformer(remover);
    const toolArgs = JSON.stringify({
      questions: [{ question: "__OPF_PERSON_1__님 __OPF_EMAIL_1__ 확인?" }],
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
    expect(out).not.toContain("__OPF_PERSON_");
    expect(out).not.toContain("__OPF_EMAIL_");
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
    await remover.mask("dev@example.com");
    const t = new AnthropicSseTransformer(remover);
    let out = "";
    out += t.push(anthropicDelta(0, "first __OPF_E"));
    out += t.push(anthropicDelta(1, "second __OPF_E"));
    out += t.push(anthropicDelta(0, "MAIL_1__ end0"));
    out += t.push(anthropicDelta(1, "MAIL_1__ end1"));
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
});

describe("OpenAISseTransformer — token-restoring delta pipeline", () => {
  test("restores token in single complete delta", async () => {
    const remover = await makeRemover();
    await remover.mask("alice@example.com");
    const t = new OpenAISseTransformer(remover);
    const out = t.push(openaiDelta("Email __OPF_EMAIL_1__ please")) + t.flush();
    expect(out).toContain("alice@example.com");
    expect(out).not.toContain("__OPF_EMAIL_");
  });

  test("reassembles token split across deltas", async () => {
    const remover = await makeRemover();
    await remover.mask("bob@example.com");
    const t = new OpenAISseTransformer(remover);
    const fullText = "ping __OPF_EMAIL_1__ now";
    let out = "";
    for (const ch of splitEvery(fullText, 1)) {
      out += t.push(openaiDelta(ch));
    }
    out += t.flush();
    expect(out).toContain("bob@example.com");
    expect(out).not.toContain("__OPF_EMAIL_");
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
    await remover.mask("김철수");
    await remover.mask("alice@example.com");
    const t = new OpenAISseTransformer(remover);
    const fullArgs = JSON.stringify({
      questions: [{ question: "__OPF_PERSON_1__님 __OPF_EMAIL_1__" }],
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
    expect(out).not.toContain("__OPF_PERSON_");
    expect(out).not.toContain("__OPF_EMAIL_");
    expect(out).toContain("tool_calls");
  });
});

describe("CodexSseTransformer — function_call_arguments restoration", () => {
  const sse = serializeSseEvent;

  test("response.function_call_arguments.delta: accumulates and restores PII on done", async () => {
    const remover = await makeRemover();
    await remover.mask("김철수");
    await remover.mask("alice@example.com");
    const t = new CodexSseTransformer(remover);
    const fullArgs = JSON.stringify({
      todos: [{ content: "__OPF_PERSON_1__님 todo: __OPF_EMAIL_1__ 확인" }],
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
    expect(out).not.toContain("__OPF_PERSON_");
    expect(out).not.toContain("__OPF_EMAIL_");
    expect(out).toContain("function_call_arguments.done");
  });

  test("response.output_text.delta still works after function_call changes", async () => {
    const remover = await makeRemover();
    await remover.mask("bob@example.com");
    const t = new CodexSseTransformer(remover);
    const out = t.push(sse({
      event: "response.output_text.delta",
      data: JSON.stringify({
        type: "response.output_text.delta",
        output_index: 0,
        delta: "Email __OPF_EMAIL_1__ done",
      }),
      raw: "",
    })) + t.flush();
    expect(out).toContain("bob@example.com");
    expect(out).not.toContain("__OPF_EMAIL_");
  });
});
