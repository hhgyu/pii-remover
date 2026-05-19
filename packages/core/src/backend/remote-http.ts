import type {
  Detection,
  DetectOpts,
  DetectionResult,
  PIICategory,
  TrustTier,
} from "../types.js";
import type { BackendClient, BackendHealth } from "./client.js";
import type { FetchInitExtended, TlsRuntimeConfig } from "./tls.js";
import { buildFetchTlsExtension } from "./tls.js";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export type RemoteHttpAuth =
  | { type: "none" }
  | { type: "bearer"; token: string; header_name?: string }
  | { type: "api_key"; token: string; header_name?: string }
  | { type: "mtls" };

export interface RemoteHttpBackendOptions {
  endpoint: string;
  trust_tier?: TrustTier;
  timeout_ms?: number;
  retries?: number;
  auth?: RemoteHttpAuth;
  tls?: TlsRuntimeConfig;
  fetch_impl?: FetchLike;
  name?: string;
}

interface RemoteRedactRequest {
  text: string;
  categories?: string[];
  request_id?: string;
}

interface RemoteDetectionDto {
  start: number;
  end: number;
  category?: string;
  label?: string;
  confidence?: number;
  score?: number;
  text?: string;
}

interface RemoteRedactResponse {
  detections?: RemoteDetectionDto[];
  redacted_text?: string;
  model_version?: string;
}

interface RemoteHealthResponse {
  ok?: boolean;
  version?: string;
  model?: string;
}

const SUPPORTED_CATEGORIES: ReadonlySet<PIICategory> = new Set([
  "account_number",
  "private_address",
  "private_email",
  "private_person",
  "private_phone",
  "private_url",
  "private_date",
  "secret",
  "rrn",
  "biz_num",
  "card",
]);

const DEFAULT_API_KEY_HEADER = "x-api-key";
const DEFAULT_BEARER_HEADER = "authorization";

/**
 * Remote HTTPS PII-detection backend (ADR-0005/0008).
 *
 * Distinct from `OpfHttpBackend`: this targets *arbitrary* self-hosted
 * remote endpoints (operator-controlled, trust_tier defaults to
 * `self_hosted`) and supports the full auth + TLS matrix
 * (none / bearer / api_key / mTLS, plus pinning).
 *
 * Tiered-mode safety contract (see TieredStrategy): this backend MUST be
 * called only after local PII (Korean RRN/BizNum/card/phone/etc.) has
 * been redacted into placeholders. This class does not enforce that
 * itself; the strategy is the security boundary.
 *
 * Init-time fail-closed: TLS file reads happen synchronously when
 * `prepare()` is first awaited; missing cert/CA/key files throw before
 * any network call.
 */
export class RemoteHttpBackend implements BackendClient {
  readonly name: string;
  readonly trust_tier: TrustTier;
  private readonly baseEndpoint: string;
  private readonly timeout_ms: number;
  private readonly retries: number;
  private readonly auth: RemoteHttpAuth;
  private readonly tls: TlsRuntimeConfig | undefined;
  private readonly fetchImpl: FetchLike;
  private tlsExtensionPromise: Promise<FetchInitExtended | null> | null = null;

  constructor(opts: RemoteHttpBackendOptions) {
    if (typeof opts.endpoint !== "string" || opts.endpoint.length === 0) {
      throw new TypeError("RemoteHttpBackend: endpoint is required");
    }
    this.baseEndpoint = opts.endpoint.replace(/\/+$/, "");
    this.trust_tier = opts.trust_tier ?? "self_hosted";
    this.timeout_ms = opts.timeout_ms ?? 2000;
    const r = opts.retries;
    this.retries = typeof r === "number" && r >= 0 ? Math.floor(r) : 1;
    this.auth = opts.auth ?? { type: "none" };
    this.tls = opts.tls;
    this.fetchImpl = opts.fetch_impl ?? fetch;
    this.name = opts.name ?? `remote-http(${this.baseEndpoint})`;
    if (this.auth.type === "api_key") {
      if (typeof this.auth.token !== "string" || this.auth.token.length === 0) {
        throw new Error(
          "RemoteHttpBackend: api_key auth requires a non-empty token"
        );
      }
    }
    if (this.auth.type === "bearer") {
      if (typeof this.auth.token !== "string" || this.auth.token.length === 0) {
        throw new Error(
          "RemoteHttpBackend: bearer auth requires a non-empty token"
        );
      }
    }
  }

  async detect(text: string, opts: DetectOpts): Promise<DetectionResult> {
    const t0 = performance.now();
    const body: RemoteRedactRequest = { text, request_id: opts.request_id };
    if (opts.categories && opts.categories.length > 0) {
      body.categories = [...opts.categories];
    }
    const url = `${this.baseEndpoint}/redact`;
    const timeoutMs = opts.timeout_ms ?? this.timeout_ms;
    const tlsExt = await this.resolveTlsExtension();
    const baseInit: FetchInitExtended = {
      method: "POST",
      headers: this.buildHeaders(true),
      body: JSON.stringify(body),
      ...(tlsExt ?? {}),
    };
    const res = await this.fetchWithRetries(url, baseInit, timeoutMs);
    if (!res.ok) {
      throw new Error(
        `RemoteHttpBackend(${this.baseEndpoint}): HTTP ${res.status} ${res.statusText}`
      );
    }
    const data = (await res.json()) as RemoteRedactResponse;
    return {
      detections: this.parseDetections(text, data),
      backend_name: this.name,
      latency_ms: performance.now() - t0,
    };
  }

  async healthCheck(): Promise<BackendHealth> {
    const t0 = performance.now();
    const url = `${this.baseEndpoint}/health`;
    try {
      const tlsExt = await this.resolveTlsExtension();
      const init: FetchInitExtended = {
        method: "GET",
        headers: this.buildHeaders(false),
        ...(tlsExt ?? {}),
      };
      const res = await this.fetchWithTimeout(url, init, this.timeout_ms);
      const latency_ms = performance.now() - t0;
      if (!res.ok) return { ok: false, latency_ms };
      const data = (await res.json()) as RemoteHealthResponse;
      const out: BackendHealth = { ok: Boolean(data.ok), latency_ms };
      if (typeof data.version === "string") out.version = data.version;
      return out;
    } catch {
      return { ok: false, latency_ms: performance.now() - t0 };
    }
  }

  private resolveTlsExtension(): Promise<FetchInitExtended | null> {
    if (!this.tlsExtensionPromise) {
      this.tlsExtensionPromise = buildFetchTlsExtension(this.tls);
    }
    return this.tlsExtensionPromise;
  }

  private buildHeaders(withBody: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json" };
    if (withBody) h["content-type"] = "application/json";
    switch (this.auth.type) {
      case "bearer": {
        const name = (this.auth.header_name ?? DEFAULT_BEARER_HEADER).toLowerCase();
        h[name] = `Bearer ${this.auth.token}`;
        break;
      }
      case "api_key": {
        const name = (this.auth.header_name ?? DEFAULT_API_KEY_HEADER).toLowerCase();
        h[name] = this.auth.token;
        break;
      }
      case "mtls":
      case "none":
        break;
    }
    return h;
  }

  private async fetchWithTimeout(
    url: string,
    init: FetchInitExtended,
    timeoutMs: number
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...(init as RequestInit),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchWithRetries(
    url: string,
    init: FetchInitExtended,
    timeoutMs: number
  ): Promise<Response> {
    let lastErr: unknown = null;
    const total = this.retries + 1;
    for (let attempt = 0; attempt < total; attempt++) {
      try {
        const res = await this.fetchWithTimeout(url, init, timeoutMs);
        if (isTransientHttpStatus(res.status) && attempt < total - 1) {
          lastErr = new Error(
            `RemoteHttpBackend(${this.baseEndpoint}): HTTP ${res.status} ${res.statusText} (transient)`
          );
          continue;
        }
        return res;
      } catch (e) {
        if (!isTransientNetworkError(e) || attempt >= total - 1) {
          throw e;
        }
        lastErr = e;
      }
    }
    if (lastErr instanceof Error) throw lastErr;
    throw new Error(
      `RemoteHttpBackend(${this.baseEndpoint}): exhausted retries`
    );
  }

  private parseDetections(
    originalText: string,
    data: RemoteRedactResponse
  ): Detection[] {
    const out: Detection[] = [];
    if (!Array.isArray(data.detections)) return out;
    for (const d of data.detections) {
      if (typeof d.start !== "number" || typeof d.end !== "number") continue;
      if (d.start < 0 || d.end > originalText.length || d.start >= d.end) continue;
      const rawCategory = d.category ?? d.label;
      const cat = normalizeCategory(rawCategory);
      if (!cat) continue;
      const rawConfidence =
        typeof d.confidence === "number"
          ? d.confidence
          : typeof d.score === "number"
            ? d.score
            : 0.9;
      const slice = originalText.slice(d.start, d.end);
      out.push({
        start: d.start,
        end: d.end,
        category: cat,
        confidence: rawConfidence,
        text: typeof d.text === "string" ? d.text : slice,
      });
    }
    return out;
  }
}

function normalizeCategory(raw: unknown): PIICategory | null {
  if (typeof raw !== "string") return null;
  const lower = raw.toLowerCase();
  return SUPPORTED_CATEGORIES.has(lower as PIICategory)
    ? (lower as PIICategory)
    : null;
}

function isTransientHttpStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

function isTransientNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "AbortError") return true;
  const code =
    e && typeof e === "object" && "code" in e
      ? (e as { code?: unknown }).code
      : undefined;
  if (typeof code === "string") {
    if (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "EAI_AGAIN" ||
      code === "ENETUNREACH"
    ) {
      return true;
    }
  }
  return /network|fetch failed|reset|timeout|aborted/i.test(e.message);
}
