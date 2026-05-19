import type {
  Detection,
  DetectOpts,
  DetectionResult,
  PIICategory,
  TrustTier,
} from "../types.js";
import type { BackendClient, BackendHealth } from "./client.js";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export type OpfHttpAuth =
  | { type: "none" }
  | { type: "bearer"; token: string; header_name?: string }
  | { type: "api_key"; token: string; header_name: string };

export interface OpfHttpBackendOptions {
  endpoint: string;
  trust_tier?: TrustTier;
  timeout_ms?: number;
  auth?: OpfHttpAuth;
  fetch_impl?: FetchLike;
  name?: string;
}

interface OpfRedactRequest {
  text: string;
  categories?: string[];
  request_id?: string;
}

interface OpfDetectionDto {
  start: number;
  end: number;
  // Per ADR-0008 our backend (and gh0stkey-compatible servers) emit `label` +
  // `score`. We accept `category` + `confidence` too so synthetic test backends
  // and future wrappers can use either name.
  category?: string;
  label?: string;
  confidence?: number;
  score?: number;
  text?: string;
}

interface OpfRedactResponse {
  detections?: OpfDetectionDto[];
  redacted_text?: string;
  model_version?: string;
}

interface OpfHealthResponse {
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

export class OpfHttpBackend implements BackendClient {
  readonly name: string;
  readonly trust_tier: TrustTier;
  private readonly baseEndpoint: string;
  private readonly timeout_ms: number;
  private readonly auth: OpfHttpAuth;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OpfHttpBackendOptions) {
    if (typeof opts.endpoint !== "string" || opts.endpoint.length === 0) {
      throw new TypeError("OpfHttpBackend: endpoint is required");
    }
    this.baseEndpoint = opts.endpoint.replace(/\/+$/, "");
    this.trust_tier = opts.trust_tier ?? "local";
    this.timeout_ms = opts.timeout_ms ?? 2000;
    this.auth = opts.auth ?? { type: "none" };
    this.fetchImpl = opts.fetch_impl ?? fetch;
    this.name = opts.name ?? `opf-http(${this.baseEndpoint})`;
  }

  async detect(text: string, opts: DetectOpts): Promise<DetectionResult> {
    const t0 = performance.now();
    const body: OpfRedactRequest = {
      text,
    };
    const url = `${this.baseEndpoint}/redact`;
    const timeoutMs = opts.timeout_ms ?? this.timeout_ms;
    const res = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.buildHeaders(true),
      body: JSON.stringify(body),
    }, timeoutMs);

    if (!res.ok) {
      throw new Error(
        `OpfHttpBackend(${this.baseEndpoint}): HTTP ${res.status} ${res.statusText}`
      );
    }
    const data = (await res.json()) as OpfRedactResponse;
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
      const res = await this.fetchWithTimeout(
        url,
        { method: "GET", headers: this.buildHeaders(false) },
        this.timeout_ms
      );
      const latency_ms = performance.now() - t0;
      if (!res.ok) return { ok: false, latency_ms };
      const data = (await res.json()) as OpfHealthResponse;
      const result: BackendHealth = { ok: Boolean(data.ok), latency_ms };
      if (typeof data.version === "string") result.version = data.version;
      return result;
    } catch {
      return { ok: false, latency_ms: performance.now() - t0 };
    }
  }

  private buildHeaders(withBody: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json" };
    if (withBody) h["content-type"] = "application/json";
    if (this.auth.type === "bearer") {
      const headerName = this.auth.header_name ?? "authorization";
      h[headerName.toLowerCase()] = `Bearer ${this.auth.token}`;
    } else if (this.auth.type === "api_key") {
      h[this.auth.header_name.toLowerCase()] = this.auth.token;
    }
    return h;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private parseDetections(
    originalText: string,
    data: OpfRedactResponse
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
