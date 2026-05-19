import { describe, expect, test } from "bun:test";

import { runHealthCommand, type FetchLike } from "../src/commands/health.js";

function mockFetch(body: object, status = 200): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("runHealthCommand", () => {
  test("happy path: ANTHROPIC_BASE_URL set, /health returns 200", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const r = await runHealthCommand({
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: { ANTHROPIC_BASE_URL: "http://localhost:8765/anthropic/v1" },
      fetchFn: mockFetch({ ok: true, version: "0.0.1" }),
    });
    expect(r.exitCode).toBe(0);
    expect(out.join("")).toContain("\"ok\":true");
  });

  test("--url overrides env detection", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const urls: string[] = [];
    const fetchFn: FetchLike = async (u) => {
      urls.push(u);
      return new Response("{\"ok\":true}", { status: 200 });
    };
    await runHealthCommand({
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: { ANTHROPIC_BASE_URL: "http://localhost:8765/anthropic/v1" },
      url: "http://127.0.0.1:9999",
      fetchFn,
    });
    expect(urls[0]).toBe("http://127.0.0.1:9999/health");
  });

  test("--port overrides env detection", async () => {
    const urls: string[] = [];
    const fetchFn: FetchLike = async (u) => {
      urls.push(u);
      return new Response("{\"ok\":true}", { status: 200 });
    };
    await runHealthCommand({
      stdout: () => {},
      stderr: () => {},
      env: {},
      port: 7777,
      fetchFn,
    });
    expect(urls[0]).toBe("http://127.0.0.1:7777/health");
  });

  test("missing env emits stderr warning + defaults to 8765", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const urls: string[] = [];
    const fetchFn: FetchLike = async (u) => {
      urls.push(u);
      return new Response("{\"ok\":true}", { status: 200 });
    };
    await runHealthCommand({
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: {},
      fetchFn,
    });
    expect(err.join("")).toContain("ANTHROPIC_BASE_URL not set");
    expect(urls[0]).toBe("http://127.0.0.1:8765/health");
  });

  test("fetch failure -> exit 2", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const fetchFn: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await runHealthCommand({
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: { ANTHROPIC_BASE_URL: "http://localhost:8765/anthropic/v1" },
      fetchFn,
    });
    expect(r.exitCode).toBe(2);
    expect(err.join("")).toContain("ECONNREFUSED");
  });

  test("non-200 response -> exit 1 (still prints body)", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const r = await runHealthCommand({
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: { ANTHROPIC_BASE_URL: "http://localhost:8765/anthropic/v1" },
      fetchFn: mockFetch({ ok: false }, 503),
    });
    expect(r.exitCode).toBe(1);
    expect(out.join("")).toContain("\"ok\":false");
  });
});
