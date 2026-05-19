import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LocalRegexBackend } from "@pii-remover/core";

import {
  startProxy,
  type FetchLike,
  type ProxyServer,
} from "../src/server.js";

function anthropicSseChunks(text: string, chunkSize: number): string[] {
  const events: string[] = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start" })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })}\n\n`,
  ];
  for (let i = 0; i < text.length; i += chunkSize) {
    const slice = text.slice(i, i + chunkSize);
    events.push(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: slice },
      })}\n\n`
    );
  }
  events.push(
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: 0,
    })}\n\n`
  );
  events.push(
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
  );
  return events;
}

function openaiSseChunks(text: string, chunkSize: number): string[] {
  const events: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    const slice = text.slice(i, i + chunkSize);
    events.push(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: slice } }],
      })}\n\n`
    );
  }
  events.push(`data: [DONE]\n\n`);
  return events;
}

function makeSseFetch(chunks: string[]): FetchLike {
  return async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

async function consumeSseBody(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("e2e SSE — Anthropic streaming round-trip", () => {
  let proxy: ProxyServer;

  beforeAll(async () => {
    const upstreamText = "Reply to __OPF_EMAIL_1__ tomorrow.";
    const chunks = anthropicSseChunks(upstreamText, 1);
    proxy = await startProxy({
      port: 0,
      backends: [new LocalRegexBackend()],
      fetch_impl: makeSseFetch(chunks),
    });
  });

  afterAll(async () => {
    await proxy.stop();
  });

  test("masks request and restores tokens across SSE deltas", async () => {
    const res = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test",
      },
      body: JSON.stringify({
        model: "claude-test",
        stream: true,
        messages: [
          { role: "user", content: "Email alice@example.com about it." },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await consumeSseBody(res);
    expect(body).toContain("alice@example.com");
    expect(body).not.toContain("__OPF_EMAIL_");
    expect(body).toContain("message_start");
    expect(body).toContain("message_stop");
  });
});

describe("e2e SSE — OpenAI streaming round-trip", () => {
  let proxy: ProxyServer;

  beforeAll(async () => {
    const upstreamText = "Got it, paging __OPF_EMAIL_1__.";
    const chunks = openaiSseChunks(upstreamText, 2);
    proxy = await startProxy({
      port: 0,
      backends: [new LocalRegexBackend()],
      fetch_impl: makeSseFetch(chunks),
    });
  });

  afterAll(async () => {
    await proxy.stop();
  });

  test("masks request and restores tokens across delta chunks", async () => {
    const res = await fetch(`${proxy.url}/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-test",
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [
          { role: "user", content: "Page dev@example.com please." },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const body = await consumeSseBody(res);
    expect(body).toContain("dev@example.com");
    expect(body).not.toContain("__OPF_EMAIL_");
    expect(body).toContain("[DONE]");
  });
});
