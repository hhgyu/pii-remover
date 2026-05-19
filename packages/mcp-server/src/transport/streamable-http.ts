/**
 * Streamable HTTP transport binding. opt-in per ADR-0016 §2.
 *
 * Spawns one Node `http` server bound to 127.0.0.1 by default. Each MCP
 * client request is routed through a fresh `StreamableHTTPServerTransport`
 * instance — the SDK handles session id assignment via `sessionIdGenerator`
 * (here: stateless mode → undefined; vault state is in `VaultPool` keyed by
 * vault_id, not MCP session).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { PiiRemoverMcpServer } from "../server.js";

const DEFAULT_PORT = 8766;
const DEFAULT_HOST = "127.0.0.1";

export interface StreamableHttpOptions {
  port?: number;
  host?: string;
}

export interface StreamableHttpHandle {
  close(): Promise<void>;
  port: number;
  host: string;
}

export async function runStreamableHttp(
  server: PiiRemoverMcpServer,
  opts: StreamableHttpOptions = {},
): Promise<StreamableHttpHandle> {
  const desiredPort = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void transport.handleRequest(req, res).catch((err) => {
      server.logger.warn(`Streamable HTTP request error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(desiredPort, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const actualPort =
    typeof addr === "object" && addr !== null ? addr.port : desiredPort;

  return {
    port: actualPort,
    host,
    async close() {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      await server.shutdown();
    },
  };
}
