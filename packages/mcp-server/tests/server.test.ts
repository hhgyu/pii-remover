import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type PiiRemoverConfig } from "@pii-remover/core";
import { createPiiRemoverMcpServer } from "../src/server.js";

function localOnlyConfig(): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
  };
}

describe("createPiiRemoverMcpServer", () => {
  test("constructs successfully with no options", async () => {
    const server = createPiiRemoverMcpServer({
      vaultPoolOptions: { config: localOnlyConfig(), warn: () => {} },
    });
    expect(server.mcp).toBeDefined();
    expect(server.vaultPool).toBeDefined();
    expect(server.logger).toBeDefined();
    await server.shutdown();
  });

  test("vault pool integration: can resolve, sanitize, desanitize end-to-end", async () => {
    const server = createPiiRemoverMcpServer({
      vaultPoolOptions: { config: localOnlyConfig(), warn: () => {} },
    });
    const remover = await server.vaultPool.resolve();
    const masked = await remover.mask("contact user@example.com");
    expect(masked.text).toMatch(/^contact {{OPF:EMAIL:[a-z0-9]{16}}}$/);
    const restored = remover.restore(masked.text);
    expect(restored.text).toBe("contact user@example.com");
    await server.shutdown();
  });

  test("shutdown disposes all vaults", async () => {
    const reasons: string[] = [];
    const server = createPiiRemoverMcpServer({
      vaultPoolOptions: {
        config: localOnlyConfig(),
        warn: () => {},
        onDispose: (_, r) => reasons.push(r),
      },
    });
    await server.vaultPool.resolve();
    await server.vaultPool.resolve();
    await server.shutdown();
    expect(reasons.filter((r) => r === "shutdown")).toHaveLength(2);
  });
});
