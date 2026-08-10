import { afterEach, describe, expect, test } from "bun:test";
import { LocalRegexBackend } from "@pii-remover/core";

import {
  startProxy,
  type FetchLike,
  type ProxyServer,
} from "../src/server.js";

const TOKEN_RE = /__OPF_EMAIL__[a-z0-9]{16}__/;

function tokenFromInit(init?: RequestInit): string {
  const raw = typeof init?.body === "string" ? init.body : "";
  return raw.match(TOKEN_RE)?.[0] ?? "__OPF_EMAIL__ffffffffffffffff__";
}

function replaceFixtureTokens<T>(body: T, token: string): T {
  return JSON.parse(JSON.stringify(body).replace(/__OPF_EMAIL__0123456789abcdef__/g, token)) as T;
}

function makeSseFetch(chunksForToken: (token: string) => string[]): FetchLike {
  return async (_url, init) => {
    const chunks = chunksForToken(tokenFromInit(init));
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

function makeJsonFetch(body: unknown): FetchLike {
  return async (_url, init) =>
    new Response(JSON.stringify(replaceFixtureTokens(body, tokenFromInit(init))), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

async function consumeStream(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

const proxies: ProxyServer[] = [];
const envBackup: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in envBackup)) envBackup[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  while (proxies.length) {
    const p = proxies.pop();
    if (p) {
      try { await p.stop(); } catch (_e) { void _e; }
    }
  }
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(envBackup)) delete envBackup[k];
});

async function withProxy(fetch_impl: FetchLike): Promise<ProxyServer> {
  const proxy = await startProxy({
    port: 0,
    backends: [new LocalRegexBackend()],
    fetch_impl,
  });
  proxies.push(proxy);
  return proxy;
}

describe("Phase 3 — ANTHROPIC_BASE_URL roundtrip via env var", () => {
  test("client reads ANTHROPIC_BASE_URL and round-trips PII through proxy (non-streaming)", async () => {
    const proxy = await withProxy(
      makeJsonFetch({
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Will reach __OPF_EMAIL__0123456789abcdef__ soon." },
        ],
        model: "claude-test",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );

    setEnv("ANTHROPIC_BASE_URL", `${proxy.url}/anthropic/v1`);

    const base = process.env.ANTHROPIC_BASE_URL!;
    expect(base.startsWith("http://127.0.0.1")).toBe(true);

    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
      },
      body: JSON.stringify({
        model: "claude-test",
        messages: [
          { role: "user", content: "Email me at alice@example.com please." },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = json.content.map((c) => c.text).join("");
    expect(text).toContain("alice@example.com");
    expect(text).not.toContain("__OPF_EMAIL_");
  });

  test("ANTHROPIC_BASE_URL streaming SSE roundtrip", async () => {
    const chunksForToken = (token: string) => {
      const upstreamText = `OK, paging ${token} now.`;
      const chunks = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start" })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`,
    ];
      for (let i = 0; i < upstreamText.length; i += 2) {
      chunks.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: upstreamText.slice(i, i + 2) },
        })}\n\n`
      );
      }
      chunks.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      return chunks;
    };

    const proxy = await withProxy(makeSseFetch(chunksForToken));
    setEnv("ANTHROPIC_BASE_URL", `${proxy.url}/anthropic/v1`);

    const base = process.env.ANTHROPIC_BASE_URL!;
    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k" },
      body: JSON.stringify({
        model: "claude-test",
        stream: true,
        messages: [{ role: "user", content: "Email charlie@example.com." }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await consumeStream(res);
    expect(body).toContain("charlie@example.com");
    expect(body).not.toContain("__OPF_EMAIL_");
    expect(body).toContain("message_stop");
  });
});

describe("Phase 3 — OPENAI_API_BASE roundtrip via env var", () => {
  test("client reads OPENAI_API_BASE and round-trips PII (non-streaming)", async () => {
    const proxy = await withProxy(
      makeJsonFetch({
        id: "cmpl_test",
        object: "chat.completion",
        created: 1,
        model: "gpt-test",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Reaching __OPF_EMAIL__0123456789abcdef__ now." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
    setEnv("OPENAI_API_BASE", `${proxy.url}/openai/v1`);

    const base = process.env.OPENAI_API_BASE!;
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-test",
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "Ping dev@example.com." }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const text = json.choices[0]!.message.content;
    expect(text).toContain("dev@example.com");
    expect(text).not.toContain("__OPF_EMAIL_");
  });

  test("OPENAI_API_BASE + ANTHROPIC_BASE_URL share vault on single proxy (multi-provider)", async () => {
    let anthropicCount = 0;
    let openaiCount = 0;
    const fetch_impl: FetchLike = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const token = tokenFromInit(init);
      if (url.includes("anthropic.com")) {
        anthropicCount += 1;
        return new Response(
          JSON.stringify({
            id: "m1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: `Hi ${token}` }],
            model: "claude-test",
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      openaiCount += 1;
      return new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: "gpt-test",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `Hello ${token}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const proxy = await withProxy(fetch_impl);
    setEnv("ANTHROPIC_BASE_URL", `${proxy.url}/anthropic/v1`);
    setEnv("OPENAI_API_BASE", `${proxy.url}/openai/v1`);

    const anthRes = await fetch(`${process.env.ANTHROPIC_BASE_URL}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k" },
      body: JSON.stringify({
        model: "claude-test",
        messages: [{ role: "user", content: "Reach alice@example.com." }],
      }),
    });
    expect(anthRes.status).toBe(200);
    const anthJson = (await anthRes.json()) as {
      content: Array<{ text: string }>;
    };
    expect(anthJson.content[0]!.text).toContain("alice@example.com");

    const oaiRes = await fetch(`${process.env.OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk" },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "Page alice@example.com again." }],
      }),
    });
    expect(oaiRes.status).toBe(200);
    const oaiJson = (await oaiRes.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(oaiJson.choices[0]!.message.content).toContain("alice@example.com");

    expect(anthropicCount).toBe(1);
    expect(openaiCount).toBe(1);
  });
});
