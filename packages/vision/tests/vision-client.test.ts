import { describe, expect, test } from "bun:test";
import { VaultManager } from "@pii-remover/core";

import {
  VisionClient,
  VisionClientError,
  type RedactImageResponse,
} from "../src/index.js";

function mockResponse(body: object, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const ONE_DETECTION_RESPONSE: RedactImageResponse = {
  redacted_image_b64: "iVBORw0KGgo=",
  detections: [
    {
      label: "private_email",
      score: 0.99,
      text: "alice@example.com",
      regions: [{ left: 10, top: 10, width: 200, height: 20 }],
      text_start: 6,
      text_end: 23,
    },
  ],
  low_confidence_regions: [],
  ocr_text: "Email alice@example.com",
  image_dimensions: { width: 400, height: 50 },
  processing_time_ms: 42.5,
  warnings: [],
};

describe("VisionClient", () => {
  test("returns redacted image and detections on success", async () => {
    const client = new VisionClient({
      backendUrl: "http://localhost:8000",
      fetchImpl: mockResponse(ONE_DETECTION_RESPONSE),
    });
    const r = await client.redactImage({ image_b64: "Zm9vYmFy" });
    expect(r.redacted_image_b64).toBe("iVBORw0KGgo=");
    expect(r.raw_detections).toHaveLength(1);
    expect(r.tokens).toHaveLength(0);
    expect(r.warnings).toEqual([]);
    expect(r.backend_latency_ms).toBe(42.5);
    expect(r.client_latency_ms).toBeGreaterThanOrEqual(0);
  });

  test("assigns vault tokens when a vault is provided", async () => {
    const client = new VisionClient({
      fetchImpl: mockResponse(ONE_DETECTION_RESPONSE),
    });
    const manager = new VaultManager();
    const sessionId = "test-session";
    const r = await client.redactImage(
      { image_b64: "Zm9vYmFy" },
      { manager, sessionId }
    );
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0]!.token).toMatch(/^__OPF_EMAIL_\d+__$/);
  });

  test("throws on empty image_b64", async () => {
    const client = new VisionClient({ fetchImpl: mockResponse({}) });
    expect(() => client.redactImage({ image_b64: "" })).toThrow(
      VisionClientError
    );
  });

  test("throws when base64 exceeds 8 MB", async () => {
    const client = new VisionClient({ fetchImpl: mockResponse({}) });
    const big = "A".repeat(12_000_000);
    expect(() => client.redactImage({ image_b64: big })).toThrow(/too large/);
  });

  test("throws VisionClientError on HTTP 400", async () => {
    const client = new VisionClient({
      fetchImpl: mockResponse({ detail: "bad" }, 400),
    });
    await expect(
      client.redactImage({ image_b64: "Zm9vYmFy" })
    ).rejects.toThrow(/HTTP 400/);
  });

  test("throws on malformed backend response", async () => {
    const client = new VisionClient({
      fetchImpl: mockResponse({ not_redacted: "wrong" }),
    });
    await expect(
      client.redactImage({ image_b64: "Zm9vYmFy" })
    ).rejects.toThrow(/missing 'redacted_image_b64'/);
  });

  test("healthCheck returns true on ok=true", async () => {
    const client = new VisionClient({
      fetchImpl: mockResponse({ ok: true }),
    });
    expect(await client.healthCheck()).toBe(true);
  });

  test("healthCheck returns false on network error", async () => {
    const failingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new VisionClient({ fetchImpl: failingFetch });
    expect(await client.healthCheck()).toBe(false);
  });

  test("vault sharing: same email → same token across calls", async () => {
    const client = new VisionClient({
      fetchImpl: mockResponse(ONE_DETECTION_RESPONSE),
    });
    const manager = new VaultManager();
    const sessionId = "shared";
    const a = await client.redactImage(
      { image_b64: "Zm9vYmFy" },
      { manager, sessionId }
    );
    const b = await client.redactImage(
      { image_b64: "Zm9vYmFy" },
      { manager, sessionId }
    );
    expect(a.tokens[0]!.token).toBe(b.tokens[0]!.token);
  });
});
