export { createPiiRemoverMcpServer } from "./server.js";
export type { PiiRemoverMcpServer } from "./server.js";

export { VaultPool } from "./vault-pool.js";

export { runStdio } from "./transport/stdio.js";
export { runStreamableHttp } from "./transport/streamable-http.js";
export type { StreamableHttpOptions } from "./transport/streamable-http.js";

export { parseArgs, usage, main } from "./cli.js";

export {
  VaultNotFoundError,
  VaultExpiredError,
  buildToolError,
  toToolErrorResult,
  withToolErrorMapping,
} from "./errors.js";
export type { ToolErrorResult } from "./errors.js";

export { createMcpLogger, NOOP_LOGGER } from "./logging.js";
export type { Logger, LogLevel, LogPayload } from "./logging.js";

export type {
  ErrorCode,
  StructuredErrorPayload,
  VaultPoolOptions,
  ServerOptions,
  TransportKind,
  CliOptions,
} from "./types.js";

export {
  SANITIZE_TOOL_DEFINITION,
  SanitizeInputSchema,
  SanitizeOutputSchema,
  createSanitizeHandler,
} from "./tools/sanitize.js";
export type { SanitizeInput, SanitizeOutput } from "./tools/sanitize.js";

export {
  SANITIZE_BATCH_TOOL_DEFINITION,
  SanitizeBatchInputSchema,
  SanitizeBatchOutputSchema,
  createSanitizeBatchHandler,
} from "./tools/sanitize-batch.js";
export type {
  SanitizeBatchInput,
  SanitizeBatchOutput,
} from "./tools/sanitize-batch.js";

export {
  DESANITIZE_TOOL_DEFINITION,
  DesanitizeInputSchema,
  DesanitizeOutputSchema,
  createDesanitizeHandler,
} from "./tools/desanitize.js";
export type {
  DesanitizeInput,
  DesanitizeOutput,
} from "./tools/desanitize.js";

export {
  DESANITIZE_BATCH_TOOL_DEFINITION,
  DesanitizeBatchInputSchema,
  DesanitizeBatchOutputSchema,
  createDesanitizeBatchHandler,
} from "./tools/desanitize-batch.js";
export type {
  DesanitizeBatchInput,
  DesanitizeBatchOutput,
} from "./tools/desanitize-batch.js";

export {
  ANALYZE_TOOL_DEFINITION,
  AnalyzeInputSchema,
  AnalyzeOutputSchema,
  createAnalyzeHandler,
} from "./tools/analyze.js";
export type { AnalyzeInput, AnalyzeOutput } from "./tools/analyze.js";

export { aggregateCategories } from "./tools/shared.js";
