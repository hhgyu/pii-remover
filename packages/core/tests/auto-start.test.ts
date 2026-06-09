import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  deriveHealthUrl,
  maybeAutoStartBackend,
  _resetAutoStartDedup,
  type AutoStartOptions,
} from "../src/backend/auto-start.js";
import { FailClosedError } from "../src/policy/failure.js";

function silentWarn(): (msg: string) => void {
  return () => {};
}

type WarmupBehavior =
  | { kind: "success"; loaded?: boolean }
  | { kind: "http_error"; status: number; body?: string }
  | { kind: "throw"; error: Error };

function mkFetch(
  script: ReadonlyArray<{ ok: boolean; loaded: boolean }>,
  warmup: WarmupBehavior = { kind: "success" }
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  let i = 0;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/warmup")) {
      if (warmup.kind === "throw") throw warmup.error;
      if (warmup.kind === "http_error") {
        return new Response(warmup.body ?? "", {
          status: warmup.status,
          headers: { "content-type": "text/plain" },
        });
      }
      const loaded = warmup.loaded ?? true;
      return new Response(
        JSON.stringify({
          ok: true,
          model_loaded: loaded,
          korean_ner_loaded: false,
          elapsed_ms: 100,
          warnings: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    const step = script[Math.min(i, script.length - 1)]!;
    i += 1;
    if (!step.ok) {
      throw new Error("ECONNREFUSED");
    }
    return new Response(
      JSON.stringify({ ok: true, model_loaded: step.loaded }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
}

function mkSpawn(opts: {
  exitCode: number;
  stderr?: string;
  throws?: Error;
}): unknown {
  return (() => {
    if (opts.throws) throw opts.throws;
    const proc = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdout: EventEmitter;
    };
    proc.stderr = new EventEmitter();
    proc.stdout = new EventEmitter();
    setImmediate(() => {
      if (opts.stderr) proc.stderr.emit("data", Buffer.from(opts.stderr));
      proc.emit("close", opts.exitCode);
    });
    return proc;
  }) as never;
}

describe("deriveHealthUrl", () => {
  test("strips /redact suffix", () => {
    expect(deriveHealthUrl("http://localhost:8000/redact")).toBe(
      "http://localhost:8000/health"
    );
  });
  test("strips trailing slash", () => {
    expect(deriveHealthUrl("http://localhost:8000/redact/")).toBe(
      "http://localhost:8000/health"
    );
  });
  test("appends /health when no /redact suffix", () => {
    expect(deriveHealthUrl("http://localhost:8000")).toBe(
      "http://localhost:8000/health"
    );
  });
});

describe("maybeAutoStartBackend", () => {
  const base: Omit<AutoStartOptions, "spawnImpl" | "fetchImpl" | "composePathResolver"> =
    {
      enabled: true,
      endpoint: "http://localhost:8000/redact",
      composeFile: "cpu",
      startTimeoutMs: 4000,
      warn: silentWarn(),
      bypassEnv: "PII_REMOVER_BYPASS",
    };

  test("no-op when disabled", async () => {
    let fetchCalls = 0;
    await maybeAutoStartBackend({
      ...base,
      enabled: false,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
      spawnImpl: mkSpawn({ exitCode: 0 }) as never,
      composePathResolver: () => "/fake/docker-compose.yml",
    });
    expect(fetchCalls).toBe(0);
  });

  test("skips spawn when backend already healthy", async () => {
    let spawnCalls = 0;
    await maybeAutoStartBackend({
      ...base,
      fetchImpl: mkFetch([{ ok: true, loaded: true }]),
      spawnImpl: (() => {
        spawnCalls += 1;
        return mkSpawn({ exitCode: 0 });
      }) as never,
      composePathResolver: () => "/fake/docker-compose.yml",
    });
    expect(spawnCalls).toBe(0);
  });

  test("warms up backend when container is up but model is idle-unloaded", async () => {
    let spawnCalls = 0;
    const fetchCalls: { url: string; method: string }[] = [];
    const logs: string[] = [];
    const warn = (msg: string) => logs.push(msg);

    const tracingFetch = async (
      input: string | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      fetchCalls.push({ url, method });
      if (method === "POST" && url.includes("/warmup")) {
        return new Response(
          JSON.stringify({
            ok: true,
            model_loaded: true,
            korean_ner_loaded: false,
            elapsed_ms: 200,
            warnings: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ ok: true, model_loaded: false }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    await maybeAutoStartBackend({
      ...base,
      warn,
      fetchImpl: tracingFetch,
      spawnImpl: (() => {
        spawnCalls += 1;
        return mkSpawn({ exitCode: 0 });
      }) as never,
      composePathResolver: () => "/fake/docker-compose.yml",
    });
    expect(spawnCalls).toBe(0);
    expect(
      fetchCalls.some(
        (c) => c.method === "POST" && c.url.endsWith("/warmup")
      )
    ).toBe(true);
    expect(logs.some((l) => l.includes("warming up"))).toBe(true);
    expect(logs.some((l) => l.includes("warmup complete"))).toBe(true);
  });

  test("throws FailClosedError when warmup returns HTTP 503", async () => {
    await expect(
      maybeAutoStartBackend({
        ...base,
        fetchImpl: mkFetch([{ ok: true, loaded: false }], {
          kind: "http_error",
          status: 503,
          body: "OPF load failed: simulated",
        }),
        spawnImpl: mkSpawn({ exitCode: 0 }) as never,
        composePathResolver: () => "/fake/docker-compose.yml",
      })
    ).rejects.toThrow(FailClosedError);
  });

  test("throws FailClosedError when warmup network call throws", async () => {
    await expect(
      maybeAutoStartBackend({
        ...base,
        fetchImpl: mkFetch([{ ok: true, loaded: false }], {
          kind: "throw",
          error: new Error("ECONNRESET"),
        }),
        spawnImpl: mkSpawn({ exitCode: 0 }) as never,
        composePathResolver: () => "/fake/docker-compose.yml",
      })
    ).rejects.toThrow(FailClosedError);
  });

  test("throws FailClosedError when warmup returns model_loaded=false", async () => {
    await expect(
      maybeAutoStartBackend({
        ...base,
        fetchImpl: mkFetch([{ ok: true, loaded: false }], {
          kind: "success",
          loaded: false,
        }),
        spawnImpl: mkSpawn({ exitCode: 0 }) as never,
        composePathResolver: () => "/fake/docker-compose.yml",
      })
    ).rejects.toThrow(/warmup failed/);
  });

  test("throws FailClosedError when compose path cannot be resolved", async () => {
    await expect(
      maybeAutoStartBackend({
        ...base,
        fetchImpl: mkFetch([{ ok: false, loaded: false }]),
        spawnImpl: mkSpawn({ exitCode: 0 }) as never,
        composePathResolver: () => null,
      })
    ).rejects.toThrow(FailClosedError);
  });

  test("throws FailClosedError when docker spawn fails", async () => {
    await expect(
      maybeAutoStartBackend({
        ...base,
        fetchImpl: mkFetch([{ ok: false, loaded: false }]),
        spawnImpl: mkSpawn({
          exitCode: 1,
          stderr: "docker: command not found",
        }) as never,
        composePathResolver: () => "/fake/docker-compose.yml",
      })
    ).rejects.toThrow(FailClosedError);
  });

  test("succeeds when spawn returns 0 and health polls report ready", async () => {
    await maybeAutoStartBackend({
      ...base,
      startTimeoutMs: 3000,
      fetchImpl: mkFetch([
        { ok: false, loaded: false },
        { ok: true, loaded: false },
        { ok: true, loaded: true },
      ]),
      spawnImpl: mkSpawn({ exitCode: 0 }) as never,
      composePathResolver: () => "/fake/docker-compose.yml",
    });
  });

  test("throws FailClosedError when health never becomes ready within timeout", async () => {
    await expect(
      maybeAutoStartBackend({
        ...base,
        startTimeoutMs: 1500,
        fetchImpl: mkFetch([{ ok: false, loaded: false }]),
        spawnImpl: mkSpawn({ exitCode: 0 }) as never,
        composePathResolver: () => "/fake/docker-compose.yml",
      })
    ).rejects.toThrow(/did not become healthy/);
  });

  test("docker spawn throw is wrapped into FailClosedError", async () => {
    await expect(
      maybeAutoStartBackend({
        ...base,
        fetchImpl: mkFetch([{ ok: false, loaded: false }]),
        spawnImpl: mkSpawn({
          exitCode: 0,
          throws: new Error("ENOENT: spawn docker"),
        }) as never,
        composePathResolver: () => "/fake/docker-compose.yml",
      })
    ).rejects.toThrow(FailClosedError);
  });

  test("deduplicates concurrent calls — docker compose runs only once", async () => {
    _resetAutoStartDedup();
    let spawnCalls = 0;
    const logs: string[] = [];
    const warn = (msg: string) => logs.push(msg);

    const countingSpawn = (...args: unknown[]) => {
      spawnCalls += 1;
      const fn = mkSpawn({ exitCode: 0 }) as (...a: unknown[]) => unknown;
      return fn(...args);
    };

    const mkOpts = (): AutoStartOptions => ({
      ...base,
      warn,
      startTimeoutMs: 4000,
      fetchImpl: mkFetch([
        { ok: false, loaded: false },
        { ok: false, loaded: false },
        { ok: true, loaded: true },
      ]),
      spawnImpl: countingSpawn as never,
      composePathResolver: () => "/fake/docker-compose.yml",
    });

    const [r1, r2] = await Promise.allSettled([
      maybeAutoStartBackend(mkOpts()),
      maybeAutoStartBackend(mkOpts()),
    ]);
    if (r1.status === "rejected") console.error("r1 rejected:", r1.reason);
    if (r2.status === "rejected") console.error("r2 rejected:", r2.reason);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    expect(spawnCalls).toBe(1);
    expect(logs.some((l) => l.includes("auto-start already in progress"))).toBe(true);
  });
});
