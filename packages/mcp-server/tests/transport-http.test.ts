import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_CONFIG, type PiiRemoverConfig } from "@pii-remover/core";
import { createPiiRemoverMcpServer } from "../src/server.js";
import {
  runStreamableHttp,
  type StreamableHttpHandle,
} from "../src/transport/streamable-http.js";
import type { PiiRemoverMcpServer } from "../src/server.js";

function localOnlyConfig(): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
  };
}

let server: PiiRemoverMcpServer;
let handle: StreamableHttpHandle;
let baseUrl: URL;

beforeEach(async () => {
  server = createPiiRemoverMcpServer({
    vaultPoolOptions: { config: localOnlyConfig(), warn: () => {} },
  });
  handle = await runStreamableHttp(server, { port: 0, host: "127.0.0.1" });
  baseUrl = new URL(`http://${handle.host}:${handle.port}/mcp`);
});

afterEach(async () => {
  await handle.close();
});

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(baseUrl);
  const client = new Client(
    { name: "smoke-test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

describe("Streamable HTTP transport smoke", () => {
  test("server boots on OS-assigned port and exposes 5 tools", async () => {
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.host).toBe("127.0.0.1");

    const names = await withClient(async (client) => {
      const result = await client.listTools();
      return result.tools.map((t) => t.name).sort();
    });
    expect(names).toEqual([
      "analyze",
      "desanitize",
      "desanitize_batch",
      "sanitize",
      "sanitize_batch",
    ]);
  });

  test("sanitize → desanitize roundtrip via real HTTP", async () => {
    const restored = await withClient(async (client) => {
      const masked = await client.callTool({
        name: "sanitize",
        arguments: { text: "email me at user@example.com" },
      });
      const m = masked.structuredContent as {
        text: string;
        vault_id: string;
        token_count: number;
      };
      expect(m.text).toMatch(/^email me at {{OPF:EMAIL:[a-z0-9]{16}}}$/);
      expect(m.token_count).toBe(1);

      const out = await client.callTool({
        name: "desanitize",
        arguments: { text: m.text, vault_id: m.vault_id },
      });
      return out.structuredContent as {
        text: string;
        restored_count: number;
      };
    });
    expect(restored.text).toBe("email me at user@example.com");
    expect(restored.restored_count).toBe(1);
  });

  test("analyze response never contains the original PII over the wire", async () => {
    const result = await withClient(async (client) =>
      client.callTool({
        name: "analyze",
        arguments: { text: "secret user@example.com here" },
      }),
    );
    expect(result.isError).not.toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("user@example.com");
    const out = result.structuredContent as {
      detections: Array<{ category: string }>;
    };
    expect(out.detections.length).toBeGreaterThanOrEqual(1);
    expect(out.detections[0]!.category).toBe("private_email");
  });
});
