import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LocalRegexBackend } from "@pii-remover/core";
import {
  forwardableRequestHeaders,
  forwardableResponseHeaders,
  isSensitiveHeaderName,
  safeHeaderLog,
} from "../src/headers.js";
import { startProxy, type ProxyServer, type FetchLike } from "../src/server.js";

describe("forwardableRequestHeaders — hop-by-hop strip + auth pass-through", () => {
  test("preserves Authorization and provider-specific keys", () => {
    const h = new Headers();
    h.set("authorization", "Bearer secret-abc");
    h.set("x-api-key", "sk-test-123");
    h.set("anthropic-version", "2023-06-01");
    const out = forwardableRequestHeaders(h);
    expect(out.get("authorization")).toBe("Bearer secret-abc");
    expect(out.get("x-api-key")).toBe("sk-test-123");
    expect(out.get("anthropic-version")).toBe("2023-06-01");
  });

  test("strips hop-by-hop headers", () => {
    const h = new Headers();
    h.set("connection", "keep-alive");
    h.set("keep-alive", "timeout=5");
    h.set("transfer-encoding", "chunked");
    h.set("host", "localhost:8765");
    h.set("content-length", "100");
    h.set("authorization", "Bearer x");
    const out = forwardableRequestHeaders(h);
    expect(out.get("connection")).toBeNull();
    expect(out.get("keep-alive")).toBeNull();
    expect(out.get("transfer-encoding")).toBeNull();
    expect(out.get("host")).toBeNull();
    expect(out.get("content-length")).toBeNull();
    expect(out.get("authorization")).toBe("Bearer x");
  });
});

describe("forwardableResponseHeaders — content-encoding strip", () => {
  test("removes content-encoding so the client never re-decodes", () => {
    const h = new Headers();
    h.set("content-type", "application/json");
    h.set("content-encoding", "gzip");
    h.set("anthropic-ratelimit-remaining", "42");
    const out = forwardableResponseHeaders(h);
    expect(out.get("content-encoding")).toBeNull();
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("anthropic-ratelimit-remaining")).toBe("42");
  });
});

describe("safeHeaderLog — redaction for diagnostics (Wave 3A logging contract)", () => {
  test("redacts authorization and api key headers", () => {
    const h = new Headers();
    h.set("authorization", "Bearer real-secret-xyz");
    h.set("x-api-key", "sk-very-secret");
    h.set("anthropic-api-key", "x-ant-key");
    h.set("openai-api-key", "sk-oai-key");
    h.set("cookie", "session=abc");
    h.set("content-type", "application/json");
    const out = safeHeaderLog(h);
    expect(out["authorization"]).toBe("<redacted>");
    expect(out["x-api-key"]).toBe("<redacted>");
    expect(out["anthropic-api-key"]).toBe("<redacted>");
    expect(out["openai-api-key"]).toBe("<redacted>");
    expect(out["cookie"]).toBe("<redacted>");
    expect(out["content-type"]).toBe("application/json");
  });

  test("sensitive name check is case-insensitive", () => {
    expect(isSensitiveHeaderName("Authorization")).toBe(true);
    expect(isSensitiveHeaderName("AUTHORIZATION")).toBe(true);
    expect(isSensitiveHeaderName("X-API-KEY")).toBe(true);
    expect(isSensitiveHeaderName("content-type")).toBe(false);
  });

  test("redacted output never echoes the raw secret in stringified form", () => {
    const h = new Headers();
    h.set("authorization", "Bearer real-secret-token-do-not-log");
    const out = JSON.stringify(safeHeaderLog(h));
    expect(out.includes("real-secret-token-do-not-log")).toBe(false);
  });
});

describe("startProxy — auth headers pass-through and never appear in warn logs", () => {
  const SECRET_BEARER = "Bearer ULTRA-SECRET-KEY-DO-NOT-LOG-abc123xyz";
  const SECRET_XKEY = "x-ant-key-DO-NOT-LOG-789";
  let proxy: ProxyServer;
  let capturedHeaders: Headers | null = null;
  const warnMessages: string[] = [];

  beforeAll(async () => {
    capturedHeaders = null;
    const fakeUpstream: FetchLike = async (_url, init) => {
      capturedHeaders = new Headers(
        (init?.headers as Record<string, string>) ?? {}
      );
      return new Response(
        JSON.stringify({
          id: "msg_x",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    proxy = await startProxy({
      port: 0,
      backends: [new LocalRegexBackend()],
      fetch_impl: fakeUpstream,
      warn: (msg) => warnMessages.push(msg),
    });
  });

  afterAll(async () => {
    await proxy.stop();
  });

  test("Authorization + x-api-key flow to upstream verbatim", async () => {
    const res = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: SECRET_BEARER,
        "x-api-key": SECRET_XKEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-test",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(capturedHeaders?.get("authorization")).toBe(SECRET_BEARER);
    expect(capturedHeaders?.get("x-api-key")).toBe(SECRET_XKEY);
    expect(capturedHeaders?.get("anthropic-version")).toBe("2023-06-01");
    // Hop-by-hop must NOT be forwarded.
    expect(capturedHeaders?.get("host")).toBeNull();
  });

  test("warn callback never receives any header value (secret-search)", async () => {
    // Trigger an error path that does log via warn (invalid JSON body).
    const res = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: SECRET_BEARER,
        "x-api-key": SECRET_XKEY,
      },
      body: "this is not json {",
    });
    expect(res.status).toBe(400);

    // Concatenate everything ever passed to warn during this proxy lifetime
    // and assert no header value (especially API keys) leaked.
    const allLogs = JSON.stringify(warnMessages);
    expect(allLogs.includes("ULTRA-SECRET-KEY-DO-NOT-LOG")).toBe(false);
    expect(allLogs.includes("x-ant-key-DO-NOT-LOG")).toBe(false);
    expect(allLogs.includes(SECRET_BEARER)).toBe(false);
    expect(allLogs.includes(SECRET_XKEY)).toBe(false);
  });
});
