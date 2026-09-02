import { randomUUID } from "node:crypto";

import type {
  PIIRemover,
  PIIRemoverInitOptions,
  PiiRemoverConfig,
} from "@pii-remover/core";
import { AuditEmitter, maybeAutoStartBackend } from "@pii-remover/core";

import {
  DEFAULT_PROXY_BIND_HOST,
  DEFAULT_PROXY_PORT,
  resolveProxyConfig,
  normalizeUpstreamBase,
  type ResolvedProxyConfig,
} from "./config.js";
import {
  forwardableRequestHeaders,
  forwardableResponseHeaders,
} from "./headers.js";
import { resolveRoute, ROUTE_PATHS, type MaskedRouteMatch } from "./router.js";
import {
  transformAnthropicRequest,
  restoreAnthropicResponse,
} from "./providers/anthropic.js";
import {
  transformOpenAIRequest,
  restoreOpenAIResponse,
} from "./providers/openai.js";
import {
  transformCodexResponsesRequest,
  restoreCodexResponsesResponse,
} from "./providers/codex.js";
import type {
  AnthropicRequestBody,
  AnthropicResponseBody,
  CodexResponsesRequestBody,
  CodexResponsesResponseBody,
  OpenAIRequestBody,
  OpenAIResponseBody,
  ProviderName,
} from "./providers/types.js";
import { ProxySessionPool } from "./session.js";
import { AnthropicSseTransformer } from "./stream/anthropic-sse.js";
import { OpenAISseTransformer } from "./stream/openai-sse.js";
import { CodexSseTransformer } from "./stream/codex-sse.js";
import type { ThinkingCache } from "./stream/thinking-cache.js";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export interface StartProxyOptions {
  port?: number;
  host?: string;
  config?: PiiRemoverConfig;
  upstream?: { anthropic?: string; openai?: string; codex?: string };
  warn?: (msg: string) => void;
  fetch_impl?: FetchLike;
  backends?: PIIRemoverInitOptions["backends"];
  strategy?: PIIRemoverInitOptions["strategy"];
  audit?: AuditEmitter;
}

export interface ProxyServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly resolvedConfig: ResolvedProxyConfig;
  readonly sessions: ProxySessionPool;
  stop(): Promise<void>;
}

const VERSION = "0.0.4";

export async function startProxy(
  opts: StartProxyOptions = {}
): Promise<ProxyServer> {
  const warn = opts.warn ?? (() => {});
  const resolved = resolveProxyConfig(opts.config, {
    port: opts.port ?? DEFAULT_PROXY_PORT,
    host: opts.host ?? DEFAULT_PROXY_BIND_HOST,
    upstream: opts.upstream ?? {},
  });
  const fetchImpl: FetchLike = opts.fetch_impl ?? fetch;

  if (opts.config?.backend.auto_start === true) {
    await maybeAutoStartBackend({
      enabled: true,
      endpoint: opts.config.backend.endpoint,
      composeFile: opts.config.backend.compose_file ?? "cpu",
      startTimeoutMs: opts.config.backend.start_timeout_ms ?? 60000,
      bypassEnv: opts.config.bypass_env,
      warn,
    });
  }

  const sessionPoolOpts: Parameters<typeof buildSessionPool>[0] = { warn };
  if (opts.config) sessionPoolOpts.config = opts.config;
  if (opts.strategy) sessionPoolOpts.strategy = opts.strategy;
  if (opts.backends) sessionPoolOpts.backends = opts.backends;
  if (opts.audit) sessionPoolOpts.audit = opts.audit;
  const sessions = buildSessionPool(sessionPoolOpts);

  const bunGlobal = (globalThis as { Bun?: { serve: (cfg: unknown) => unknown } })
    .Bun;
  if (!bunGlobal || typeof bunGlobal.serve !== "function") {
    throw new Error(
      "@pii-remover/proxy requires the Bun runtime (Bun.serve is unavailable)."
    );
  }

  const handle = bunGlobal.serve({
    port: resolved.port,
    hostname: resolved.host,
    fetch: async (request: Request) => handleRequest(request, resolved, sessions, fetchImpl, warn),
  }) as { port: number; hostname: string; stop(): void };

  return {
    port: handle.port,
    host: handle.hostname,
    url: `http://${handle.hostname}:${handle.port}`,
    resolvedConfig: resolved,
    sessions,
    async stop(): Promise<void> {
      handle.stop();
      await sessions.disposeAll();
    },
  };
}

function buildSessionPool(opts: ConstructorParameters<typeof ProxySessionPool>[0]): ProxySessionPool {
  return new ProxySessionPool(opts);
}

async function handleRequest(
  request: Request,
  resolved: ResolvedProxyConfig,
  sessions: ProxySessionPool,
  fetchImpl: FetchLike,
  warn: (msg: string) => void
): Promise<Response> {
  const url = new URL(request.url);
  const route = resolveRoute(url.pathname);

  if (route.kind === "health") {
    return jsonResponse(200, {
      ok: true,
      version: VERSION,
      providers: ["anthropic", "openai", "codex"],
    });
  }

  if (route.kind === "not_found" || !route.match) {
    return jsonResponse(404, {
      error: "no_route",
      message: `No proxy route for ${url.pathname}`,
    });
  }

  const match = route.match;
  const upstreamUrl = `${normalizeUpstreamBase(
    resolved.upstream[match.upstream]
  )}${match.upstreamPath}${url.search}`;

  if (match.transform === "passthrough") {
    return passthrough(request, upstreamUrl, fetchImpl, warn);
  }

  const provider = match.provider;

  if (request.method !== "POST") {
    return jsonResponse(405, {
      error: "method_not_allowed",
      message: "Only POST is supported on provider chat routes.",
    });
  }

  const { remover, thinkingCache } = await sessions.get(request.headers);

  // One id per HTTP request, shared by the request-side mask event and every
  // response-side restore event (streaming emits one per SSE delta). Without a
  // shared key the audit stream cannot reassemble a request's restore events.
  const requestId = `req_${randomUUID()}`;

  let parsedBody: unknown;
  const rawBody = await request.text();
  try {
    parsedBody = rawBody.length === 0 ? {} : JSON.parse(rawBody);
  } catch (err) {
    warn(`[pii-remover/proxy] invalid JSON body: ${(err as Error).message}`);
    return jsonResponse(400, {
      error: "invalid_json",
      message: "Request body must be JSON.",
    });
  }

  if (match.transform === "anthropic_messages") {
    const result = await transformAnthropicRequest(
      parsedBody as AnthropicRequestBody,
      remover,
      { provider, requestId, thinkingCache }
    );
    if (result.rejection)
      return jsonResponse(result.rejection.status, result.rejection.body);

    const isStreaming = result.body.stream === true;
    const upstreamRes = await callUpstream(
      upstreamUrl,
      request,
      result.body,
      fetchImpl
    );
    if (!upstreamRes.ok) {
      return relayResponse(upstreamRes);
    }
    if (isStreaming) {
      return streamingResponse(upstreamRes, {
        transform: match.transform,
        provider,
        remover,
        resolved,
        requestId,
        thinkingCache,
        clientSignal: request.signal,
      });
    }
    const responseBody = (await upstreamRes.json()) as AnthropicResponseBody;
    const restored = await restoreAnthropicResponse(responseBody, remover, {
      provider,
      requestId,
      thinkingCache,
    });
    return jsonResponse(
      upstreamRes.status,
      restored,
      forwardableResponseHeaders(upstreamRes.headers)
    );
  }

  if (match.transform === "openai_chat") {
    const result = await transformOpenAIRequest(
      parsedBody as OpenAIRequestBody,
      remover,
      { provider, requestId }
    );
    if (result.rejection)
      return jsonResponse(result.rejection.status, result.rejection.body);

    const isStreaming = result.body.stream === true;
    const upstreamRes = await callUpstream(
      upstreamUrl,
      request,
      result.body,
      fetchImpl
    );
    if (!upstreamRes.ok) {
      return relayResponse(upstreamRes);
    }
    if (isStreaming) {
      return streamingResponse(upstreamRes, {
        transform: match.transform,
        provider,
        remover,
        resolved,
        requestId,
        clientSignal: request.signal,
      });
    }
    const responseBody = (await upstreamRes.json()) as OpenAIResponseBody;
    const restored = await restoreOpenAIResponse(responseBody, remover, {
      provider,
      requestId,
    });
    return jsonResponse(
      upstreamRes.status,
      restored,
      forwardableResponseHeaders(upstreamRes.headers)
    );
  }

  if (match.transform === "responses") {
    const result = await transformCodexResponsesRequest(
      parsedBody as CodexResponsesRequestBody,
      remover,
      { provider, requestId }
    );
    if (result.rejection)
      return jsonResponse(result.rejection.status, result.rejection.body);

    const isStreaming = result.body.stream === true;
    const upstreamRes = await callUpstream(
      upstreamUrl,
      request,
      result.body,
      fetchImpl
    );
    if (!upstreamRes.ok) {
      return relayResponse(upstreamRes);
    }
    if (isStreaming) {
      return streamingResponse(upstreamRes, {
        transform: match.transform,
        provider,
        remover,
        resolved,
        requestId,
        clientSignal: request.signal,
      });
    }
    const responseBody = (await upstreamRes.json()) as CodexResponsesResponseBody;
    const restored = await restoreCodexResponsesResponse(responseBody, remover, {
      provider,
      requestId,
    });
    return jsonResponse(
      upstreamRes.status,
      restored,
      forwardableResponseHeaders(upstreamRes.headers)
    );
  }

  const unhandled: never = match.transform;
  return jsonResponse(500, {
    error: "internal",
    message: `Unreachable route transform: ${JSON.stringify(unhandled)}`,
  });
}

interface StreamingTransformer {
  push(chunk: string): string;
  flush(): string;
}

interface StreamingContext {
  /** Picks the SSE transformer. `provider` cannot: `/openai/v1/responses` is
   *  audited as `openai` but streams the Responses event shape. */
  transform: MaskedRouteMatch["transform"];
  provider: ProviderName;
  remover: PIIRemover;
  resolved: ResolvedProxyConfig;
  requestId: string;
  /** Anthropic-only: no other provider signs its reasoning blocks. */
  thinkingCache?: ThinkingCache;
  clientSignal?: AbortSignal;
}

function selectStreamTransformer(ctx: StreamingContext): StreamingTransformer {
  const { transform, provider, remover, resolved, requestId } = ctx;
  const opts = {
    bufferWindow: resolved.buffer_window,
    flushOnClose: resolved.flush_on_close,
    requestId,
    provider,
  };
  switch (transform) {
    case "anthropic_messages":
      return new AnthropicSseTransformer(remover, {
        ...opts,
        ...(ctx.thinkingCache !== undefined
          ? { thinkingCache: ctx.thinkingCache }
          : {}),
      });
    case "openai_chat":
      return new OpenAISseTransformer(remover, opts);
    case "responses":
      return new CodexSseTransformer(remover, opts);
  }
}

function streamingResponse(
  upstream: Response,
  ctx: StreamingContext
): Response {
  const { clientSignal } = ctx;
  const sourceBody = upstream.body;
  if (!sourceBody) {
    return jsonResponse(502, {
      error: "bad_gateway",
      message: "Upstream returned an empty streaming body.",
    });
  }
  const transformer = selectStreamTransformer(ctx);

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let aborted = false;
  type StreamReaderLike = {
  read(): Promise<{ value?: Uint8Array | undefined; done: boolean }>;
  releaseLock(): void;
  cancel(reason?: unknown): Promise<void>;
};
let activeReader: StreamReaderLike | null = null;
  const abort = (reason: unknown): void => {
    if (aborted) return;
    aborted = true;
    const r = activeReader;
    if (r) {
      try { r.cancel(reason).catch(() => undefined); } catch (_e) { void _e; }
    } else {
      try { sourceBody.cancel(reason).catch(() => undefined); } catch (_e) { void _e; }
    }
  };
  let removeSignalListener: (() => void) | undefined;
  if (clientSignal) {
    if (clientSignal.aborted) {
      abort(clientSignal.reason ?? "client aborted");
    } else {
      const onAbort = (): void => abort(clientSignal.reason ?? "client aborted");
      clientSignal.addEventListener("abort", onAbort, { once: true });
      removeSignalListener = (): void =>
        clientSignal.removeEventListener("abort", onAbort);
    }
  }
  const transformed = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = sourceBody.getReader() as unknown as StreamReaderLike;
      activeReader = reader;
      try {
        while (true) {
          if (aborted) break;
          const { value, done } = await reader.read();
          if (done) break;
          if (aborted) break;
          const chunk = decoder.decode(value, { stream: true });
          const out = transformer.push(chunk);
          if (out.length > 0) {
            try { controller.enqueue(encoder.encode(out)); } catch (_e) { void _e; break; }
          }
        }
        if (!aborted) {
          const tail = decoder.decode();
          if (tail.length > 0) {
            const out = transformer.push(tail);
            if (out.length > 0) {
              try { controller.enqueue(encoder.encode(out)); } catch (_e) { void _e; }
            }
          }
          const finalChunk = transformer.flush();
          if (finalChunk.length > 0) {
            try { controller.enqueue(encoder.encode(finalChunk)); } catch (_e) { void _e; }
          }
        }
        try { controller.close(); } catch (_e) { void _e; }
      } catch (err) {
        try { controller.error(err); } catch (_e) { void _e; }
      } finally {
        if (removeSignalListener) removeSignalListener();
        activeReader = null;
        try { reader.releaseLock(); } catch (_err) { void _err; }
      }
    },
    cancel(reason) {
      abort(reason);
      if (removeSignalListener) removeSignalListener();
    },
  });

  const headers = forwardableResponseHeaders(upstream.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/event-stream");
  }
  return new Response(transformed, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function callUpstream(
  url: string,
  request: Request,
  body: unknown,
  fetchImpl: FetchLike
): Promise<Response> {
  const headers = forwardableRequestHeaders(request.headers);
  headers.set("content-type", "application/json");
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  };
  if (request.signal) init.signal = request.signal;
  return fetchImpl(url, init);
}

async function passthrough(
  request: Request,
  upstreamUrl: string,
  fetchImpl: FetchLike,
  warn: (msg: string) => void
): Promise<Response> {
  const headers = forwardableRequestHeaders(request.headers);
  const init: RequestInit = { method: request.method, headers };
  // fetch rejects GET/HEAD carrying a body, even a zero-length one.
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  try {
    const upstream = await fetchImpl(upstreamUrl, init);
    return relayResponse(upstream);
  } catch (err) {
    warn(`[pii-remover/proxy] passthrough failed: ${(err as Error).message}`);
    return jsonResponse(502, {
      error: "bad_gateway",
      message: "Upstream call failed.",
    });
  }
}

function relayResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardableResponseHeaders(upstream.headers),
  });
}

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Headers
): Response {
  const h = headers ?? new Headers();
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: h });
}
