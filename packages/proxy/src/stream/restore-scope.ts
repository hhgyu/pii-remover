import type { PIIRemover } from "@pii-remover/core";

/**
 * Binds a `PIIRemover` to the audit identity of one proxy HTTP request so the
 * SSE transformers can restore text and tool-call JSON without threading
 * `requestId` / `provider` through every recursive call.
 *
 * Streaming restores once per delta, so without a shared `request_id` the audit
 * stream has no key to group a response's restore events back into the single
 * mask event that opened the request.
 */
export interface StreamRestoreScope {
  text(value: string): string;
  json(raw: string): string;
}

export interface StreamRestoreScopeOptions {
  requestId?: string;
  provider?: string;
}

export function createStreamRestoreScope(
  remover: PIIRemover,
  opts: StreamRestoreScopeOptions = {}
): StreamRestoreScope {
  const restoreOpts: Parameters<PIIRemover["restore"]>[1] = {};
  if (opts.requestId !== undefined) restoreOpts.request_id = opts.requestId;
  if (opts.provider !== undefined) restoreOpts.provider = opts.provider;

  const text = (value: string): string =>
    value.length === 0 ? value : remover.restore(value, restoreOpts).text;

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  };

  const json = (raw: string): string => {
    if (raw.length === 0) return raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // A tool-call argument stream can be cut mid-object; restoring the raw
      // fragment is the documented fallback (README §Streaming).
      if (err instanceof SyntaxError) return text(raw);
      throw err;
    }
    return JSON.stringify(walk(parsed));
  };

  return { text, json };
}
