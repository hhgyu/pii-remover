import { afterEach, describe, expect, test } from "bun:test";
import { LocalRegexBackend } from "@pii-remover/core";

import {
  startProxy,
  type FetchLike,
  type ProxyServer,
} from "../src/server.js";

interface UpstreamProbe {
  fetch_impl: FetchLike;
  upstreamCancelled: () => boolean;
  upstreamReason: () => unknown;
  chunksEmitted: () => number;
}

function makeInfiniteSseUpstream(eventTemplate: (i: number) => string): UpstreamProbe {
  let cancelled = false;
  let reason: unknown = undefined;
  let emitted = 0;

  const fetch_impl: FetchLike = async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cancelled) {
          try { controller.close(); } catch (_e) { void _e; }
          return;
        }
        const chunk = eventTemplate(emitted);
        controller.enqueue(encoder.encode(chunk));
        emitted += 1;
        await new Promise((r) => setTimeout(r, 10));
      },
      cancel(r) {
        cancelled = true;
        reason = r;
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  return {
    fetch_impl,
    upstreamCancelled: () => cancelled,
    upstreamReason: () => reason,
    chunksEmitted: () => emitted,
  };
}

const proxies: ProxyServer[] = [];

afterEach(async () => {
  while (proxies.length) {
    const p = proxies.pop();
    if (p) {
      try { await p.stop(); } catch (_e) { void _e; }
    }
  }
});

async function withProxy(probe: UpstreamProbe): Promise<ProxyServer> {
  const proxy = await startProxy({
    port: 0,
    backends: [new LocalRegexBackend()],
    fetch_impl: probe.fetch_impl,
  });
  proxies.push(proxy);
  return proxy;
}

const anthropicEvent = (i: number): string => {
  if (i === 0) {
    return (
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start" })}\n\n` +
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`
    );
  }
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: `tok${i} ` },
  })}\n\n`;
};

const openaiEvent = (i: number): string =>
  `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: `tok${i} ` } }],
  })}\n\n`;

describe("proxy stream — client abort triggers upstream cancel (Anthropic)", () => {
  test("AbortController.abort() on client fetch → upstream cancelled", async () => {
    const probe = makeInfiniteSseUpstream(anthropicEvent);
    const proxy = await withProxy(probe);

    const ac = new AbortController();
    const res = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({
        model: "claude-test",
        stream: true,
        messages: [{ role: "user", content: "Email alice@example.com please." }],
      }),
      signal: ac.signal,
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    for (let i = 0; i < 3; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) received += decoder.decode(value, { stream: true });
    }
    expect(received.length).toBeGreaterThan(0);
    expect(probe.upstreamCancelled()).toBe(false);

    const chunksBeforeCancel = probe.chunksEmitted();
    ac.abort();
    try { await reader.cancel("client aborted"); } catch (_e) { void _e; }

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !probe.upstreamCancelled()) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(probe.upstreamCancelled()).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    const chunksAfterCancel = probe.chunksEmitted();
    expect(chunksAfterCancel - chunksBeforeCancel).toBeLessThan(50);
  });
});

describe("proxy stream — client abort triggers upstream cancel (OpenAI)", () => {
  test("AbortController.abort() on client fetch → upstream cancelled", async () => {
    const probe = makeInfiniteSseUpstream(openaiEvent);
    const proxy = await withProxy(probe);

    const ac = new AbortController();
    const res = await fetch(`${proxy.url}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-x" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "Page dev@example.com please." }],
      }),
      signal: ac.signal,
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(value).toBeDefined();
    expect(probe.upstreamCancelled()).toBe(false);

    ac.abort();
    try { await reader.cancel("client gone"); } catch (_e) { void _e; }

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !probe.upstreamCancelled()) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(probe.upstreamCancelled()).toBe(true);
  });
});

describe("proxy stream — vault survives client abort", () => {
  test("session pool remains operable after stream cancel", async () => {
    const probe = makeInfiniteSseUpstream(anthropicEvent);
    const proxy = await withProxy(probe);

    const ac = new AbortController();
    const res = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-test",
        stream: true,
        messages: [{ role: "user", content: "Note: alice@example.com." }],
      }),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    try { await reader.cancel("done"); } catch (_e) { void _e; }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !probe.upstreamCancelled()) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(probe.upstreamCancelled()).toBe(true);

    const healthRes = await fetch(`${proxy.url}/health`);
    expect(healthRes.status).toBe(200);
    const body = (await healthRes.json()) as { ok: boolean; providers: string[] };
    expect(body.ok).toBe(true);
    expect(body.providers).toContain("anthropic");
  });
});
