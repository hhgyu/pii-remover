/**
 * Detect whether the user has configured `@pii-remover/proxy` as Claude's
 * upstream by inspecting `ANTHROPIC_BASE_URL` in the hook process env.
 *
 * Source: ADR-0012 §"proxy 구성됨" 판단.
 *
 * Treated as configured when ANY of:
 *   - URL host is localhost / 127.0.0.1 / ::1
 *   - URL path starts with `/anthropic/` (our proxy's required prefix, ADR-0004)
 *   - Env opt-in `PII_REMOVER_PROXY_TRUST=1` is set (user explicit trust)
 */

export interface ProxyDetectionResult {
  configured: boolean;
  /** Truthful explanation for logging. Never expose Authorization-like values. */
  reason: string;
  /** Raw URL string we inspected (or undefined). */
  inspected_url: string | undefined;
}

export interface ProxyDetectionEnv {
  ANTHROPIC_BASE_URL?: string;
  PII_REMOVER_PROXY_TRUST?: string;
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

const TRUSTED_PROXY_PATH_PREFIX = "/anthropic/";

export function detectProxy(env: ProxyDetectionEnv): ProxyDetectionResult {
  const trustOptIn = env.PII_REMOVER_PROXY_TRUST;
  if (trustOptIn === "1" || trustOptIn === "true") {
    return {
      configured: true,
      reason: "PII_REMOVER_PROXY_TRUST opt-in",
      inspected_url: env.ANTHROPIC_BASE_URL,
    };
  }

  const raw = env.ANTHROPIC_BASE_URL;
  if (typeof raw !== "string" || raw.length === 0) {
    return {
      configured: false,
      reason: "ANTHROPIC_BASE_URL not set",
      inspected_url: undefined,
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      configured: false,
      reason: "ANTHROPIC_BASE_URL is not a valid URL",
      inspected_url: raw,
    };
  }

  const hostMatch = LOCAL_HOSTS.has(url.hostname) || url.hostname === "[::1]";
  const pathMatch = url.pathname.startsWith(TRUSTED_PROXY_PATH_PREFIX);

  if (hostMatch && pathMatch) {
    return {
      configured: true,
      reason: `localhost + /anthropic/ prefix on ${url.host}`,
      inspected_url: raw,
    };
  }
  if (hostMatch) {
    return {
      configured: true,
      reason: `localhost upstream on ${url.host} (path '${url.pathname}' missing /anthropic/ prefix — proxy may not route correctly)`,
      inspected_url: raw,
    };
  }
  if (pathMatch) {
    return {
      configured: false,
      reason: `non-localhost host '${url.host}' even though path starts with /anthropic/ — refusing to trust`,
      inspected_url: raw,
    };
  }
  return {
    configured: false,
    reason: `ANTHROPIC_BASE_URL points to '${url.host}', not a recognised proxy`,
    inspected_url: raw,
  };
}
