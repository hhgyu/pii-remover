import { describe, expect, test } from "bun:test";
import {
  RemoteHttpBackend,
  type FetchLike,
} from "../src/backend/remote-http.js";
import type { DetectOpts } from "../src/types.js";

const baseOpts: DetectOpts = { request_id: "test-req" };

interface Captured {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: unknown;
}

function captureFetch(
  respond: (call: number) => Response | Promise<Response>
): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fakeFetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown = null;
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, init: init ?? {}, headers, body });
    return respond(calls.length - 1);
  };
  return { fetch: fakeFetch, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("RemoteHttpBackend — auth", () => {
  test("bearer auth sends Authorization: Bearer <token>", async () => {
    const cap = captureFetch(() => jsonResponse({ detections: [] }));
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example/api",
      auth: { type: "bearer", token: "tok-abc" },
      fetch_impl: cap.fetch,
    });
    await b.detect("hi", baseOpts);
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]!.headers["authorization"]).toBe("Bearer tok-abc");
  });

  test("api_key auth uses default x-api-key header when header_name absent", async () => {
    const cap = captureFetch(() => jsonResponse({ detections: [] }));
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      auth: { type: "api_key", token: "k-1" },
      fetch_impl: cap.fetch,
    });
    await b.detect("hi", baseOpts);
    expect(cap.calls[0]!.headers["x-api-key"]).toBe("k-1");
    expect(cap.calls[0]!.headers["authorization"]).toBeUndefined();
  });

  test("api_key auth uses custom header_name (lowercased)", async () => {
    const cap = captureFetch(() => jsonResponse({ detections: [] }));
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      auth: { type: "api_key", token: "k-2", header_name: "X-Vendor-Key" },
      fetch_impl: cap.fetch,
    });
    await b.detect("hi", baseOpts);
    expect(cap.calls[0]!.headers["x-vendor-key"]).toBe("k-2");
  });

  test("mtls auth sets no auth headers (TLS handles identity)", async () => {
    const cap = captureFetch(() => jsonResponse({ detections: [] }));
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      auth: { type: "mtls" },
      fetch_impl: cap.fetch,
    });
    await b.detect("hi", baseOpts);
    const h = cap.calls[0]!.headers;
    expect(h["authorization"]).toBeUndefined();
    expect(h["x-api-key"]).toBeUndefined();
  });

  test("api_key with empty token throws at construction (fail-closed)", () => {
    expect(
      () =>
        new RemoteHttpBackend({
          endpoint: "https://remote.example",
          auth: { type: "api_key", token: "" },
        })
    ).toThrow(/non-empty token/);
  });

  test("bearer with empty token throws at construction (fail-closed)", () => {
    expect(
      () =>
        new RemoteHttpBackend({
          endpoint: "https://remote.example",
          auth: { type: "bearer", token: "" },
        })
    ).toThrow(/non-empty token/);
  });
});

describe("RemoteHttpBackend — request shape", () => {
  test("POSTs to /redact with categories + request_id (ADR-0008)", async () => {
    const cap = captureFetch(() => jsonResponse({ detections: [] }));
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example/api",
      fetch_impl: cap.fetch,
    });
    await b.detect("hi", {
      request_id: "req-x",
      categories: ["private_email", "private_phone"],
    });
    const call = cap.calls[0]!;
    expect(call.url).toBe("https://remote.example/api/redact");
    expect(call.init.method).toBe("POST");
    const body = call.body as Record<string, unknown>;
    expect(body.request_id).toBe("req-x");
    expect(body.categories).toEqual(["private_email", "private_phone"]);
    expect(body.text).toBe("hi");
  });

  test("strips trailing slash from endpoint", async () => {
    const cap = captureFetch(() => jsonResponse({ detections: [] }));
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example/api///",
      fetch_impl: cap.fetch,
    });
    await b.detect("hi", baseOpts);
    expect(cap.calls[0]!.url).toBe("https://remote.example/api/redact");
  });
});

describe("RemoteHttpBackend — response parsing (dual-key tolerance)", () => {
  test("parses label+score (gh0stkey wire format)", async () => {
    const cap = captureFetch(() =>
      jsonResponse({
        detections: [
          { start: 6, end: 22, label: "private_email", score: 0.97 },
          { start: 27, end: 30, label: "private_person", score: 0.88 },
        ],
      })
    );
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      fetch_impl: cap.fetch,
    });
    const r = await b.detect("hello user@example.com and Bob", baseOpts);
    expect(r.detections).toHaveLength(2);
    expect(r.detections[0]!.category).toBe("private_email");
    expect(r.detections[0]!.confidence).toBeCloseTo(0.97, 5);
    expect(r.detections[1]!.category).toBe("private_person");
  });

  test("parses category+confidence (mock test backends)", async () => {
    const cap = captureFetch(() =>
      jsonResponse({
        detections: [
          { start: 6, end: 22, category: "private_email", confidence: 0.93 },
        ],
      })
    );
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      fetch_impl: cap.fetch,
    });
    const r = await b.detect("hello user@example.com here", baseOpts);
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.confidence).toBeCloseTo(0.93, 5);
  });

  test("rejects malformed offsets and unknown categories", async () => {
    const cap = captureFetch(() =>
      jsonResponse({
        detections: [
          { start: -1, end: 5, label: "private_email" },
          { start: 0, end: 100, label: "private_email" },
          { start: 5, end: 5, label: "private_email" },
          { start: 0, end: 5, label: "not-a-category" },
          { start: 0, end: 5, label: "private_email" },
        ],
      })
    );
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      fetch_impl: cap.fetch,
    });
    const r = await b.detect("hello world", baseOpts);
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.category).toBe("private_email");
  });
});

describe("RemoteHttpBackend — failure modes", () => {
  test("throws on 401 without leaking auth token in error message", async () => {
    const cap = captureFetch(() =>
      new Response("unauthorized", { status: 401, statusText: "Unauthorized" })
    );
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      auth: { type: "bearer", token: "super-secret-token" },
      fetch_impl: cap.fetch,
    });
    try {
      await b.detect("hi", baseOpts);
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("HTTP 401");
      expect(msg).not.toContain("super-secret-token");
    }
  });

  test("throws on 404 (non-transient) without retry", async () => {
    let attempts = 0;
    const cap = captureFetch(() => {
      attempts++;
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      fetch_impl: cap.fetch,
      retries: 3,
    });
    await expect(b.detect("hi", baseOpts)).rejects.toThrow(/HTTP 404/);
    expect(attempts).toBe(1);
  });

  test("aborts on timeout", async () => {
    const cap = captureFetch(
      () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new Error("not reached")), 1000);
        })
    );
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      fetch_impl: cap.fetch,
      timeout_ms: 10,
      retries: 0,
    });
    await expect(b.detect("hi", baseOpts)).rejects.toBeInstanceOf(Error);
  });
});

describe("RemoteHttpBackend — retries (transient only)", () => {
  test("retries on 503, succeeds on second attempt", async () => {
    let n = 0;
    const cap = captureFetch(() => {
      n++;
      if (n === 1) {
        return new Response("busy", { status: 503, statusText: "Service Unavailable" });
      }
      return jsonResponse({ detections: [] });
    });
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      fetch_impl: cap.fetch,
      retries: 2,
    });
    const r = await b.detect("hi", baseOpts);
    expect(r.detections).toEqual([]);
    expect(n).toBe(2);
  });

  test("does NOT retry on 400 (client error)", async () => {
    let n = 0;
    const cap = captureFetch(() => {
      n++;
      return new Response("bad", { status: 400, statusText: "Bad Request" });
    });
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      fetch_impl: cap.fetch,
      retries: 3,
    });
    await expect(b.detect("hi", baseOpts)).rejects.toThrow(/HTTP 400/);
    expect(n).toBe(1);
  });

  test("retries on network reset error (transient)", async () => {
    let n = 0;
    const fakeFetch: FetchLike = async () => {
      n++;
      if (n === 1) {
        const err = new Error("connection ECONNRESET") as NodeJS.ErrnoException;
        err.code = "ECONNRESET";
        throw err;
      }
      return jsonResponse({ detections: [] });
    };
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      fetch_impl: fakeFetch,
      retries: 1,
    });
    const r = await b.detect("hi", baseOpts);
    expect(r.detections).toEqual([]);
    expect(n).toBe(2);
  });
});

describe("RemoteHttpBackend — TLS extension injection", () => {
  test("injects { tls } block when TLS config provided (Bun runtime)", async () => {
    let capturedInit: RequestInit | null = null;
    const fakeFetch: FetchLike = async (_url, init) => {
      capturedInit = init ?? null;
      return jsonResponse({ detections: [] });
    };
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      fetch_impl: fakeFetch,
      tls: {
        verify: true,
        ca_bundle_path: null,
        pinning: {
          enabled: true,
          sha256_fingerprint:
            "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
        },
      },
    });
    await b.detect("hi", baseOpts);
    expect(capturedInit).not.toBeNull();
    const ext = capturedInit as unknown as RequestInit & {
      tls?: Record<string, unknown>;
    };
    expect(ext.tls).toBeDefined();
    expect(typeof (ext.tls as Record<string, unknown>).checkServerIdentity).toBe("function");
  });
});

describe("RemoteHttpBackend — metadata", () => {
  test("trust_tier defaults to self_hosted", () => {
    const b = new RemoteHttpBackend({ endpoint: "https://remote.example" });
    expect(b.trust_tier).toBe("self_hosted");
  });

  test("trust_tier can be overridden", () => {
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      trust_tier: "vendor",
    });
    expect(b.trust_tier).toBe("vendor");
  });

  test("name embeds the (stripped) endpoint", () => {
    const b = new RemoteHttpBackend({ endpoint: "https://remote.example/api/" });
    expect(b.name).toBe("remote-http(https://remote.example/api)");
  });

  test("healthCheck returns ok=false (without throwing) when transport errors", async () => {
    const fakeFetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const b = new RemoteHttpBackend({
      endpoint: "https://remote.example",
      fetch_impl: fakeFetch,
    });
    const h = await b.healthCheck();
    expect(h.ok).toBe(false);
  });

  test("endpoint validation: rejects empty string", () => {
    expect(() => new RemoteHttpBackend({ endpoint: "" })).toThrow(/endpoint is required/);
  });
});
