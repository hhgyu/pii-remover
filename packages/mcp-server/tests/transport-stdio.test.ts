import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG, type PiiRemoverConfig } from "@pii-remover/core";
import { createPiiRemoverMcpServer } from "../src/server.js";

function localOnlyConfig(): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
  };
}

async function setup() {
  const server = createPiiRemoverMcpServer({
    vaultPoolOptions: { config: localOnlyConfig(), warn: () => {} },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return { server, client };
}

describe("MCP transport JSON-RPC roundtrip (in-memory)", () => {
  test("tools/list returns the 5 documented tools", async () => {
    const { server, client } = await setup();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "analyze",
      "desanitize",
      "desanitize_batch",
      "sanitize",
      "sanitize_batch",
    ]);
    await client.close();
    await server.shutdown();
  });

  test("sanitize → desanitize roundtrip via MCP tool call", async () => {
    const { server, client } = await setup();
    const masked = await client.callTool({
      name: "sanitize",
      arguments: { text: "ping user@example.com please" },
    });
    expect(masked.isError).not.toBe(true);
    const m = masked.structuredContent as {
      text: string;
      vault_id: string;
      token_count: number;
    };
    expect(m.text).toMatch(/^ping __OPF_EMAIL__[a-z0-9]{16}__ please$/);
    expect(m.token_count).toBe(1);
    expect(m.vault_id.length).toBeGreaterThan(0);

    const restored = await client.callTool({
      name: "desanitize",
      arguments: { text: m.text, vault_id: m.vault_id },
    });
    expect(restored.isError).not.toBe(true);
    const r = restored.structuredContent as {
      text: string;
      restored_count: number;
    };
    expect(r.text).toBe("ping user@example.com please");
    expect(r.restored_count).toBe(1);
    await client.close();
    await server.shutdown();
  });

  test("desanitize with unknown vault_id returns isError + vault_not_found", async () => {
    const { server, client } = await setup();
    const result = await client.callTool({
      name: "desanitize",
      arguments: { text: "__OPF_EMAIL__ffffffffffffffff__", vault_id: "no_such" },
    });
    expect(result.isError).toBe(true);
    const err = result.structuredContent as { error_code?: string };
    expect(err.error_code).toBe("vault_not_found");
    await client.close();
    await server.shutdown();
  });

  test("analyze returns detections; original PII text never appears in response", async () => {
    const { server, client } = await setup();
    const result = await client.callTool({
      name: "analyze",
      arguments: { text: "secret user@example.com here" },
    });
    expect(result.isError).not.toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("user@example.com");
    const out = result.structuredContent as {
      detections: Array<{ category: string }>;
    };
    expect(out.detections.length).toBeGreaterThanOrEqual(1);
    expect(out.detections[0]!.category).toBe("private_email");
    await client.close();
    await server.shutdown();
  });

  test("sanitize_batch keeps tokens consistent across inputs via shared vault", async () => {
    const { server, client } = await setup();
    const result = await client.callTool({
      name: "sanitize_batch",
      arguments: {
        texts: ["a user@example.com x", "b user@example.com y"],
      },
    });
    const out = result.structuredContent as {
      results: Array<{ text: string }>;
      vault_id: string;
    };
    const token = out.results[0]!.text.match(/__OPF_EMAIL__[a-z0-9]{16}__/)![0];
    expect(out.results[1]!.text).toContain(token);
    await client.close();
    await server.shutdown();
  });
});
