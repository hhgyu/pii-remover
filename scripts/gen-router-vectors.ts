/**
 * Emit golden routing + header-hygiene vectors from the TypeScript proxy.
 *
 * Routing decides which bodies get masked. A path that lands on `passthrough`
 * when it should have landed on the masking branch ships the conversation
 * upstream in the clear, so the table below is a security surface, not a
 * convenience.
 *
 * Usage: bun run scripts/gen-router-vectors.ts
 * Writes: packages/backend/tests/fixtures/router_vectors.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRoute, ROUTE_PATHS } from "../packages/proxy/src/router.js";
import {
  forwardableRequestHeaders,
  forwardableResponseHeaders,
  isSensitiveHeaderName,
  safeHeaderLog,
} from "../packages/proxy/src/headers.js";

const OUT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "backend",
  "tests",
  "fixtures",
  "router_vectors.json"
);

const PATHS: string[] = [
  "/health",
  "/",
  "",
  "/unknown",
  "/anthropic",
  "/anthropic/",
  "/anthropic/v1/messages",
  // Posts the whole conversation — must stay on the masking branch.
  "/anthropic/v1/messages/count_tokens",
  "/anthropic/v1/complete",
  "/anthropic/api/organizations",
  "/anthropic/api/",
  "/anthropicx/v1/messages",
  "/openai",
  "/openai/",
  "/openai/v1/chat/completions",
  "/openai/v1/embeddings",
  "/openai/v1/models",
  "/codex",
  "/codex/v1/responses",
  "/codex/v1/models",
  "/CODEX/v1/responses",
  "/anthropic/v1/messages?beta=true",
];

const routes = PATHS.map((pathname) => {
  const r = resolveRoute(pathname);
  return {
    pathname,
    kind: r.kind,
    provider: r.match?.provider ?? null,
    upstream_path: r.match?.upstreamPath ?? null,
  };
});

const REQUEST_HEADERS: Array<[string, string]> = [
  ["authorization", "Bearer sk-secret-value"],
  ["x-api-key", "anthropic-secret"],
  ["anthropic-version", "2023-06-01"],
  ["content-type", "application/json"],
  ["content-length", "1234"],
  ["host", "localhost:8000"],
  ["connection", "keep-alive"],
  ["transfer-encoding", "chunked"],
  ["te", "trailers"],
  ["upgrade", "websocket"],
  ["proxy-authorization", "Basic abc"],
  ["accept", "text/event-stream"],
  ["x-pii-session", "proj-a"],
];

const RESPONSE_HEADERS: Array<[string, string]> = [
  ["content-type", "text/event-stream"],
  ["content-encoding", "gzip"],
  ["content-length", "999"],
  ["transfer-encoding", "chunked"],
  ["connection", "close"],
  ["set-cookie", "sid=abc"],
  ["anthropic-request-id", "req_123"],
];

function toHeaders(pairs: Array<[string, string]>): Headers {
  const h = new Headers();
  for (const [k, v] of pairs) h.set(k, v);
  return h;
}

function toObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of h.entries()) out[k] = v;
  return out;
}

const payload = {
  _generated_by: "scripts/gen-router-vectors.ts",
  _contract:
    "A route that flips from a masking target to a passthrough target is a " +
    "PII leak, not a routing nit. Header sets must match exactly: a relayed " +
    "content-length disagrees with the re-serialised masked body.",
  route_paths: ROUTE_PATHS,
  routes,
  headers: {
    request_input: REQUEST_HEADERS,
    request_forwardable: toObject(forwardableRequestHeaders(toHeaders(REQUEST_HEADERS))),
    response_input: RESPONSE_HEADERS,
    response_forwardable: toObject(
      forwardableResponseHeaders(toHeaders(RESPONSE_HEADERS))
    ),
    safe_log: safeHeaderLog(toHeaders(REQUEST_HEADERS)),
    sensitive: Object.fromEntries(
      [
        "authorization",
        "Authorization",
        "AUTHORIZATION",
        "x-api-key",
        "anthropic-api-key",
        "openai-api-key",
        "cookie",
        "set-cookie",
        "proxy-authorization",
        "content-type",
        "x-pii-session",
      ].map((n) => [n, isSensitiveHeaderName(n)])
    ),
  },
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.log(`wrote ${OUT_PATH}`);
console.log(`  routes: ${routes.length}`);
for (const r of routes) {
  console.log(
    `    ${r.pathname.padEnd(38)} ${r.kind.padEnd(10)} ${String(r.provider).padEnd(22)} ${r.upstream_path ?? ""}`
  );
}
