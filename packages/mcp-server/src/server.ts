/**
 * MCP server factory.
 *
 * Composes the 5 tools from `./tools/*` with a shared `VaultPool` and an
 * MCP-routed logger. Transport binding is intentionally left to the caller —
 * see `./transport/stdio.ts` and `./transport/streamable-http.ts`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { VaultPool } from "./vault-pool.js";
import { createMcpLogger } from "./logging.js";
import type { Logger } from "./logging.js";
import type { ServerOptions } from "./types.js";
import {
  SANITIZE_TOOL_DEFINITION,
  createSanitizeHandler,
} from "./tools/sanitize.js";
import {
  SANITIZE_BATCH_TOOL_DEFINITION,
  createSanitizeBatchHandler,
} from "./tools/sanitize-batch.js";
import {
  DESANITIZE_TOOL_DEFINITION,
  createDesanitizeHandler,
} from "./tools/desanitize.js";
import {
  DESANITIZE_BATCH_TOOL_DEFINITION,
  createDesanitizeBatchHandler,
} from "./tools/desanitize-batch.js";
import {
  ANALYZE_TOOL_DEFINITION,
  createAnalyzeHandler,
} from "./tools/analyze.js";

const DEFAULT_NAME = "pii-remover";
const DEFAULT_VERSION = "0.0.1";

export interface PiiRemoverMcpServer {
  readonly mcp: McpServer;
  readonly vaultPool: VaultPool;
  readonly logger: Logger;
  connect(transport: Transport): Promise<void>;
  shutdown(): Promise<void>;
}

export function createPiiRemoverMcpServer(
  opts: ServerOptions = {},
): PiiRemoverMcpServer {
  const vaultPool = new VaultPool(opts.vaultPoolOptions ?? {});
  const mcp = new McpServer(
    {
      name: opts.name ?? DEFAULT_NAME,
      version: opts.version ?? DEFAULT_VERSION,
    },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
    },
  );
  const logger = createMcpLogger(mcp.server, opts.name ?? DEFAULT_NAME);

  registerTool(mcp, SANITIZE_TOOL_DEFINITION, createSanitizeHandler({ vaultPool, logger }));
  registerTool(
    mcp,
    SANITIZE_BATCH_TOOL_DEFINITION,
    createSanitizeBatchHandler({ vaultPool, logger }),
  );
  registerTool(mcp, DESANITIZE_TOOL_DEFINITION, createDesanitizeHandler({ vaultPool, logger }));
  registerTool(
    mcp,
    DESANITIZE_BATCH_TOOL_DEFINITION,
    createDesanitizeBatchHandler({ vaultPool, logger }),
  );
  registerTool(mcp, ANALYZE_TOOL_DEFINITION, createAnalyzeHandler({ logger }));

  vaultPool.startSweeper();

  return {
    mcp,
    vaultPool,
    logger,
    async connect(transport) {
      await mcp.connect(transport);
    },
    async shutdown() {
      await vaultPool.shutdown();
      await mcp.close();
    },
  };
}

function registerTool(
  mcp: McpServer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def: { name: string } & Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (input: any) => Promise<any>,
): void {
  const { name, ...rest } = def;
  mcp.registerTool(name, rest, handler);
}
