import { DEFAULT_PROXY_PORT } from "../constants.js";

/**
 * One upstream API surface the proxy mounts a path prefix for (ADR-0004).
 * Prefixes are NOT interchangeable: Anthropic traffic sent to `/codex/v1`
 * 404s, and traffic sent to the bare root silently bypasses masking.
 */
export type ProxyRoute = "anthropic" | "openai" | "codex";

const PROXY_PATH_BY_ROUTE: Readonly<Record<ProxyRoute, string>> = {
  anthropic: "/anthropic/v1",
  openai: "/openai/v1",
  codex: "/codex/v1",
};

const PROXY_ROUTE_SUFFIXES: readonly string[] = Object.values(PROXY_PATH_BY_ROUTE);

/**
 * A proxy base URL with no route suffix — `http://localhost:8000`, never
 * `http://localhost:8000/anthropic/v1`. A value object rather than a bare
 * string so a route URL cannot be fed back into the derivation helpers and
 * produce `/anthropic/v1/openai/v1`. Build one with {@link normalizeProxyRoot}
 * or {@link defaultProxyRoot}; read the URL back off `value`.
 */
export interface ProxyRoot {
  readonly value: string;
}

/**
 * Parse any user-supplied proxy URL into its root so every provider route can
 * be derived from it. Only the suffixes the proxy actually mounts are stripped,
 * and only from the end: an unrecognized path is part of the root, because a
 * reverse proxy may legitimately mount us under `https://gw.corp/pii`.
 */
export function normalizeProxyRoot(input: string): ProxyRoot {
  const trimmed = stripTrailingSlashes(input.trim());
  for (const suffix of PROXY_ROUTE_SUFFIXES) {
    if (trimmed.endsWith(suffix)) {
      return { value: stripTrailingSlashes(trimmed.slice(0, -suffix.length)) };
    }
  }
  return { value: trimmed };
}

/** Root of the proxy this CLI ships with, for callers that have no user input. */
export function defaultProxyRoot(port: number = DEFAULT_PROXY_PORT): ProxyRoot {
  return normalizeProxyRoot(`http://localhost:${port}`);
}

/** The masking URL a host must be pointed at to reach `route` through the proxy. */
export function proxyUrlForRoute(root: ProxyRoot, route: ProxyRoute): string {
  return `${root.value}${PROXY_PATH_BY_ROUTE[route]}`;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
