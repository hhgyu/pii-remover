/**
 * stdio transport binding. Default per ADR-0016 §2.
 * stdout is the JSON-RPC channel — runtime logs MUST go via MCP `notifications/message`, never to stdout.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { PiiRemoverMcpServer } from "../server.js";

export async function runStdio(server: PiiRemoverMcpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      void server.shutdown().finally(() => resolve());
    };
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
    process.stdin.once("close", cleanup);
  });
}
