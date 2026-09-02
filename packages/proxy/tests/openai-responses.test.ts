/**
 * OpenCode's built-in OpenAI provider posts the Responses API, so with
 * `baseURL = http://127.0.0.1:PORT/openai/v1` its traffic lands on
 * `/openai/v1/responses`. That path used to fall through to passthrough, which
 * shipped the conversation upstream in the clear. These tests assert the leak
 * is closed at the HTTP boundary, with the OpenAI and Codex upstream bases held
 * distinct so a fix that merely borrowed the Codex upstream cannot pass.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  AuditEmitter,
  LocalRegexBackend,
  SingleStrategy,
  type AuditEntry,
} from "@pii-remover/core";

import { startProxy, type FetchLike, type ProxyServer } from "../src/server.js";

const OPENAI_BASE = "https://openai-upstream.test";
const CODEX_BASE = "https://codex-upstream.test";
const EMAIL = "alice@example.com";
const TOKEN_RE = /{{OPF:EMAIL:[a-z0-9]{16}}}/;
// The test's own statement of the Responses wire contract, deliberately not
// imported from the transformer it exercises.
const DELTA_EVENT = "response.output_text.delta";

interface UpstreamCall {
  url: string;
  body: string;
}

// The passthrough branch forwards an ArrayBuffer while the masking branch
// forwards a string. Decoding both is what makes "no plaintext upstream" a real
// assertion instead of one that passes on an empty recording.
function bodyText(raw: RequestInit["body"]): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  return "";
}

function record(calls: UpstreamCall[], url: string | URL, init?: RequestInit): string {
  const body = bodyText(init?.body);
  calls.push({ url: String(url), body });
  return body;
}

function echoedToken(requestBody: string): string {
  return TOKEN_RE.exec(requestBody)?.[0] ?? "{{OPF:EMAIL:ffffffffffffffff}}";
}

function sseEvent(name: string, payload: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function jsonUpstream(calls: UpstreamCall[]): FetchLike {
  return async (url, init) => {
    const text = `Paging ${echoedToken(record(calls, url, init))} now.`;
    return new Response(
      JSON.stringify({
        id: "resp_test",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        ],
        output_text: text,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
}

function sseUpstream(calls: UpstreamCall[]): FetchLike {
  return async (url, init) => {
    const text = `Paging ${echoedToken(record(calls, url, init))} now.`;
    const events = [sseEvent("response.created", { type: "response.created" })];
    // Two characters per delta splits the token across many events, which is
    // what the boundary buffer has to reassemble before it can restore.
    for (let i = 0; i < text.length; i += 2) {
      events.push(
        sseEvent(DELTA_EVENT, {
          type: DELTA_EVENT,
          output_index: 0,
          delta: text.slice(i, i + 2),
        })
      );
    }
    events.push(sseEvent("response.completed", { type: "response.completed" }));
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const e of events) controller.enqueue(encoder.encode(e));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  };
}

function responsesRequest(stream: boolean): string {
  return JSON.stringify({
    model: "gpt-test",
    stream,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Email ${EMAIL} about it.` }],
      },
    ],
  });
}

async function post(url: string, body: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
    body,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const key of path) {
    if (!isRecord(cursor)) {
      throw new Error(`no object at "${key}" while reading ${path.join(".")}`);
    }
    cursor = cursor[key];
  }
  return cursor;
}

function readString(value: unknown, path: readonly string[]): string {
  const found = readPath(value, path);
  if (typeof found !== "string") {
    throw new Error(`expected a string at ${path.join(".")}`);
  }
  return found;
}

function onlyCall(calls: readonly UpstreamCall[]): UpstreamCall {
  if (calls.length !== 1) throw new Error(`expected 1 upstream call, got ${calls.length}`);
  return calls[0];
}

function aggregateDeltas(sse: string): string {
  let text = "";
  for (const block of sse.split("\n\n")) {
    const lines = block.split("\n");
    if (!lines.includes(`event: ${DELTA_EVENT}`)) continue;
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (dataLine === undefined) {
      throw new Error(`${DELTA_EVENT} block carried no data line`);
    }
    const payload: unknown = JSON.parse(dataLine.slice(6));
    const delta = readPath(payload, ["delta"]);
    if (typeof delta !== "string") {
      throw new Error(`${DELTA_EVENT} carried a non-string delta`);
    }
    text += delta;
  }
  return text;
}

function providersFor(entries: readonly AuditEntry[], event: string): string[] {
  return entries.filter((e) => e.event === event).map((e) => e.provider ?? "unset");
}

describe("/openai/v1/responses — non-streaming", () => {
  const calls: UpstreamCall[] = [];
  const entries: AuditEntry[] = [];
  let proxy: ProxyServer;

  beforeAll(async () => {
    proxy = await startProxy({
      port: 0,
      strategy: new SingleStrategy(new LocalRegexBackend()),
      upstream: { openai: OPENAI_BASE, codex: CODEX_BASE },
      audit: new AuditEmitter({ enabled: true, stream: (e) => entries.push(e) }),
      fetch_impl: jsonUpstream(calls),
    });
  });

  afterAll(async () => {
    await proxy.stop();
  });

  beforeEach(() => {
    calls.length = 0;
    entries.length = 0;
  });

  test("plaintext PII never reaches the upstream body", async () => {
    await post(`${proxy.url}/openai/v1/responses`, responsesRequest(false));
    const sent = onlyCall(calls);
    expect(sent.body).not.toContain(EMAIL);
    expect(sent.body).toMatch(TOKEN_RE);
    expect(readString(JSON.parse(sent.body), ["input", "0", "content", "0", "text"])).toMatch(
      TOKEN_RE
    );
  });

  test("forwards to the OpenAI upstream, not the Codex one", async () => {
    await post(`${proxy.url}/openai/v1/responses`, responsesRequest(false));
    expect(onlyCall(calls).url).toBe(`${OPENAI_BASE}/v1/responses`);
  });

  test("tokens are restored in the downstream response", async () => {
    const res = await post(`${proxy.url}/openai/v1/responses`, responsesRequest(false));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("{{OPF:");
    const parsed: unknown = JSON.parse(raw);
    expect(readString(parsed, ["output", "0", "content", "0", "text"])).toContain(EMAIL);
    expect(readString(parsed, ["output_text"])).toContain(EMAIL);
  });

  test("audit identity stays openai on both mask and restore", async () => {
    await post(`${proxy.url}/openai/v1/responses`, responsesRequest(false));
    const masks = providersFor(entries, "mask");
    const restores = providersFor(entries, "restore");
    expect(masks.length).toBeGreaterThan(0);
    expect(restores.length).toBeGreaterThan(0);
    expect(new Set([...masks, ...restores])).toEqual(new Set(["openai"]));
  });

  test("/codex/v1/responses keeps the Codex upstream and codex identity", async () => {
    await post(`${proxy.url}/codex/v1/responses`, responsesRequest(false));
    expect(onlyCall(calls).url).toBe(`${CODEX_BASE}/v1/responses`);
    expect(new Set(providersFor(entries, "mask"))).toEqual(new Set(["codex"]));
  });

  test("child resource /openai/v1/responses/resp_123 relays body byte-identical to OpenAI upstream", async () => {
    const childBody = JSON.stringify({
      stream: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `Email ${EMAIL} about it.` }],
        },
      ],
    });
    await post(`${proxy.url}/openai/v1/responses/resp_123`, childBody);
    const sent = onlyCall(calls);
    expect(sent.url).toBe(`${OPENAI_BASE}/v1/responses/resp_123`);
    expect(sent.body).toBe(childBody);
    expect(sent.body).toContain(EMAIL);
    expect(providersFor(entries, "mask")).toHaveLength(0);
  });

  test("child resource /codex/v1/responses/resp_456 relays body byte-identical to Codex upstream", async () => {
    const childBody = JSON.stringify({
      stream: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `Email ${EMAIL} about it.` }],
        },
      ],
    });
    await post(`${proxy.url}/codex/v1/responses/resp_456`, childBody);
    const sent = onlyCall(calls);
    expect(sent.url).toBe(`${CODEX_BASE}/v1/responses/resp_456`);
    expect(sent.body).toBe(childBody);
    expect(sent.body).toContain(EMAIL);
    expect(providersFor(entries, "mask")).toHaveLength(0);
  });
});

describe("/openai/v1/responses — streaming", () => {
  const calls: UpstreamCall[] = [];
  const entries: AuditEntry[] = [];
  let proxy: ProxyServer;

  beforeAll(async () => {
    proxy = await startProxy({
      port: 0,
      strategy: new SingleStrategy(new LocalRegexBackend()),
      upstream: { openai: OPENAI_BASE, codex: CODEX_BASE },
      audit: new AuditEmitter({ enabled: true, stream: (e) => entries.push(e) }),
      fetch_impl: sseUpstream(calls),
    });
  });

  afterAll(async () => {
    await proxy.stop();
  });

  beforeEach(() => {
    calls.length = 0;
    entries.length = 0;
  });

  test("masks the streamed request and restores tokens across deltas", async () => {
    const res = await post(`${proxy.url}/openai/v1/responses`, responsesRequest(true));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const sent = onlyCall(calls);
    expect(sent.url).toBe(`${OPENAI_BASE}/v1/responses`);
    expect(sent.body).not.toContain(EMAIL);
    expect(sent.body).toMatch(TOKEN_RE);

    const sse = await res.text();
    expect(aggregateDeltas(sse)).toContain(EMAIL);
    expect(sse).not.toContain("{{OPF:");
    expect(sse).toContain("event: response.completed");
  });

  test("streamed restore events are audited as openai", async () => {
    const res = await post(`${proxy.url}/openai/v1/responses`, responsesRequest(true));
    await res.text();
    const restores = providersFor(entries, "restore");
    expect(restores.length).toBeGreaterThan(0);
    expect(new Set(restores)).toEqual(new Set(["openai"]));
  });
});
