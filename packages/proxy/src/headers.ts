const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "anthropic-api-key",
  "openai-api-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

export function forwardableRequestHeaders(input: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of input.entries()) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out.set(name, value);
  }
  return out;
}

export function forwardableResponseHeaders(input: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of input.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "content-encoding") continue;
    out.set(name, value);
  }
  return out;
}

export function safeHeaderLog(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(lower)) {
      out[name] = "<redacted>";
    } else {
      out[name] = value;
    }
  }
  return out;
}

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.toLowerCase());
}
