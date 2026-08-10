import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  OpfHttpBackend,
  PIIRemover,
  SingleStrategy,
  type PiiRemoverConfig,
} from "@pii-remover/core";

import {
  PiiRemoverPlugin,
  configurePiiRemoverPlugin,
  createPluginHooks,
} from "../src/hooks.js";

interface MockServer {
  url: string;
  close(): Promise<void>;
}

interface MockOpfDetection {
  start: number;
  end: number;
  category: string;
  confidence?: number;
  text?: string;
}

function findEmail(text: string): MockOpfDetection | null {
  const m = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.exec(text);
  if (!m) return null;
  return {
    start: m.index,
    end: m.index + m[0].length,
    category: "private_email",
    confidence: 0.99,
    text: m[0],
  };
}

function findUrl(text: string): MockOpfDetection | null {
  const m = /\bhttps?:\/\/[^\s<>"'`)]+/.exec(text);
  if (!m) return null;
  const cleaned = m[0].replace(/[.,;:!?)\]}>]+$/, "");
  return {
    start: m.index,
    end: m.index + cleaned.length,
    category: "private_url",
    confidence: 0.95,
    text: cleaned,
  };
}

function detectAll(text: string): MockOpfDetection[] {
  const out: MockOpfDetection[] = [];
  const e = findEmail(text);
  if (e) out.push(e);
  const u = findUrl(text);
  if (u) out.push(u);
  return out;
}

async function startMockOpfServer(port: number): Promise<MockServer> {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const u = new URL(req.url);
      if (u.pathname === "/health") {
        return Response.json({ ok: true, version: "mock-0.0.1", model_loaded: true });
      }
      if (u.pathname === "/redact" && req.method === "POST") {
        const body = (await req.json()) as { text?: string };
        const text = typeof body.text === "string" ? body.text : "";
        return Response.json({ detections: detectAll(text) });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    async close(): Promise<void> {
      server.stop(true);
    },
  };
}

let mock: MockServer;

beforeAll(async () => {
  mock = await startMockOpfServer(0);
});

afterAll(async () => {
  await mock.close();
});

function configWithEndpoint(endpoint: string): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: {
      ...DEFAULT_CONFIG.backend,
      type: "single",
      endpoint: `${endpoint}/redact`,
    },
  };
}

describe("integration — plugin + OpfHttpBackend (mock HTTP)", () => {
  test("end-to-end: plugin masks tool arg using mock backend over HTTP", async () => {
    const remover = await PIIRemover.init({
      sessionId: "integration-session",
      config: configWithEndpoint(mock.url),
      env: {},
      warn: () => {},
      strategy: new SingleStrategy(new OpfHttpBackend({ endpoint: mock.url })),
    });
    const hooks = createPluginHooks(remover, {
      warn: () => {},
      experimental: false,
    });

    const output = {
      args: { content: "Please email alice@example.com about the meeting" },
    };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "s", callID: "c" },
    output);
    const masked = (output.args as { content: string }).content;
    expect(masked).not.toContain("alice@example.com");
    expect(masked).toMatch(/__OPF_EMAIL__[a-z0-9]{16}__/);

    remover.dispose();
  });

  test("end-to-end: vault survives session.idle (restore works after idle)", async () => {
    const remover = await PIIRemover.init({
      sessionId: "integration-session-2",
      config: configWithEndpoint(mock.url),
      env: {},
      warn: () => {},
      strategy: new SingleStrategy(new OpfHttpBackend({ endpoint: mock.url })),
    });
    const hooks = createPluginHooks(remover, {
      warn: () => {},
      experimental: false,
    });

    const first = { args: { msg: "contact alice@example.com" } };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "s", callID: "c1" },
    first);
    const maskedMsg = (first.args as { msg: string }).msg;
    expect(maskedMsg).toMatch(/__OPF_EMAIL__[a-z0-9]{16}__/);

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s" } },
    });

    const toolOutput = { title: "", output: maskedMsg, metadata: {} };
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "s", callID: "c2", args: {} },
      toolOutput
    );
    expect(toolOutput.output).toBe("contact alice@example.com");
    remover.dispose();
  });

  test("PiiRemoverPlugin factory: full path with health check via mock server", async () => {
    const factory = configurePiiRemoverPlugin({
      config: configWithEndpoint(mock.url),
      warn: () => {},
      backends: [new OpfHttpBackend({ endpoint: mock.url })],
      experimental: false,
    });

    const hooks = await factory({
      project: { id: "integration-project" },
      worktree: "/tmp/integration",
      directory: "/tmp/integration",
    });

    const output = {
      args: {
        content: "see https://github.com/example/repo for details please now",
      },
    };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "s", callID: "c1" },
    output);
    const masked = (output.args as { content: string }).content;
    expect(masked).toMatch(/__OPF_URL__[a-z0-9]{16}__/);
    expect(masked).not.toContain("github.com/example/repo");
  });
});
