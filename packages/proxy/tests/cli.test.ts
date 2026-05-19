import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@pii-remover/core";

import { helpText, parseFlags, runCli } from "../src/cli.js";
import type { FetchLike } from "../src/server.js";

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    out,
    err,
  };
}

describe("parseFlags", () => {
  test("port + host + config", () => {
    const f = parseFlags(["--port", "9000", "--host", "0.0.0.0", "--config", "/etc/p.json"]);
    expect(f).toEqual({ port: 9000, host: "0.0.0.0", configPath: "/etc/p.json" });
  });

  test("short flags", () => {
    const f = parseFlags(["-p", "7777", "-c", "./cfg.json", "-u", "http://localhost:8765"]);
    expect(f.port).toBe(7777);
    expect(f.configPath).toBe("./cfg.json");
    expect(f.url).toBe("http://localhost:8765");
  });
});

describe("runCli", () => {
  test("version prints semver", async () => {
    const io = makeIo();
    const code = await runCli(["version"], io);
    expect(code).toBe(0);
    expect(io.out.join("")).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("help prints usage", async () => {
    const io = makeIo();
    const code = await runCli(["help"], io);
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("pii-remover-proxy");
    expect(io.out.join("")).toContain("Commands:");
  });

  test("no command defaults to help", async () => {
    const io = makeIo();
    const code = await runCli([], io);
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("Usage:");
  });

  test("unknown command returns 64", async () => {
    const io = makeIo();
    const code = await runCli(["fubar"], io);
    expect(code).toBe(64);
    expect(io.err.join("")).toContain("unknown command");
  });

  test("health succeeds against mock fetch", async () => {
    const io = makeIo();
    const fakeFetch: FetchLike = async () =>
          new Response(JSON.stringify({ ok: true, version: "0.0.1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const code = await runCli(["health", "--url", "http://localhost:8765"], {
      ...io,
      fetchFn: fakeFetch,
    });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("\"ok\":true");
  });

  test("health failure returns 2", async () => {
    const io = makeIo();
    const fakeFetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const code = await runCli(["health", "--url", "http://localhost:8765"], {
      ...io,
      fetchFn: fakeFetch,
    });
    expect(code).toBe(2);
    expect(io.err.join("")).toContain("health check failed");
  });

  test("start binds port via mock startProxy", async () => {
    const io = makeIo();
    let received: { port?: number; host?: string } = {};
    const fakeStart = (async (opts: { port?: number; host?: string }) => {
      received = opts;
      return {
        port: opts.port ?? 0,
        host: opts.host ?? "127.0.0.1",
        url: `http://${opts.host ?? "127.0.0.1"}:${opts.port ?? 0}`,
        resolvedConfig: {} as never,
        sessions: {} as never,
        stop: async () => {},
      };
    }) as never;
    const fakeLoad = async () => DEFAULT_CONFIG;
    const code = await runCli(["start", "--port", "0"], {
      ...io,
      startProxyFn: fakeStart,
      loadConfigFn: fakeLoad,
    });
    expect(code).toBe(0);
    expect(received.port).toBe(0);
    expect(io.out.join("")).toContain("listening on");
  });
});

describe("helpText", () => {
  test("includes both ANTHROPIC and OPENAI env hints", () => {
    const h = helpText();
    expect(h).toContain("ANTHROPIC_BASE_URL");
    expect(h).toContain("OPENAI_API_BASE");
  });
});
