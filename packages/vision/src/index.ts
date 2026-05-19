/**
 * Thin HTTP client for `@pii-remover/backend` /redact/image (Phase 6, ADR-0009).
 *
 * Heavy work (OCR via Tesseract, image redaction via Pillow) runs server-side.
 * This client only:
 *   - validates inputs
 *   - performs the HTTP call
 *   - maps detections back to AssignedToken via the shared VaultManager
 *   - hands the redacted base64 back to the caller
 *
 * Token assignment intentionally reuses the same VaultManager that masks
 * text PII so an image's PERSON_2 and a follow-up text's PERSON_2 stay
 * consistent inside one session.
 */

import { VaultManager, type AssignedToken } from "@pii-remover/core";
import type { Detection, PIICategory } from "@pii-remover/core";

export const DEFAULT_BACKEND_URL = "http://localhost:8000";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type ImagePiiCategory =
  | "private_email"
  | "private_phone"
  | "rrn"
  | "biz_num"
  | "card"
  | "private_person"
  | "private_address"
  | "private_url"
  | "private_date"
  | "secret"
  | "account_number";

export type MaskMethod = "fill" | "blur" | "pixelate";
export type LowConfPolicy = "mask" | "warn" | "block";

export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ImageDetection {
  label: ImagePiiCategory;
  score: number;
  text: string;
  regions: Region[];
  text_start: number;
  text_end: number;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface RedactImageResponse {
  redacted_image_b64: string;
  detections: ImageDetection[];
  low_confidence_regions: Region[];
  ocr_text: string | null;
  image_dimensions: ImageDimensions;
  processing_time_ms: number;
  warnings: string[];
}

export interface VisionClientOptions {
  backendUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RedactImageRequest {
  image_b64: string;
  languages?: string[];
  mask_method?: MaskMethod;
  confidence_threshold?: number;
  policy_on_low_confidence?: LowConfPolicy;
  categories?: ImagePiiCategory[];
}

export interface RedactImageResult {
  /** The masked image as a base64 string (PNG). */
  redacted_image_b64: string;
  /** Vault-assigned tokens. Empty if no PII was found. */
  tokens: AssignedToken[];
  /** Raw backend detections (post-vault, kept for diagnostics). */
  raw_detections: ImageDetection[];
  /** Warnings emitted by the backend (e.g., low confidence). */
  warnings: string[];
  /** Backend processing latency in ms (Python side). */
  backend_latency_ms: number;
  /** Total round-trip latency in ms (network included). */
  client_latency_ms: number;
}

/**
 * Image PII redaction client. Backend agnostic — works against any server
 * that implements the `/redact/image` contract (ADR-0009).
 *
 * Vault integration: when a VaultManager + sessionId is provided, the
 * image's detected PII spans are assigned the same token names that
 * matching text spans would receive. Image-only categories (`rrn`,
 * `biz_num`, `card`) reuse the core category map.
 */
export class VisionClient {
  private readonly backendUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: VisionClientOptions = {}) {
    this.backendUrl = (opts.backendUrl ?? DEFAULT_BACKEND_URL).replace(
      /\/+$/,
      ""
    );
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async redactImage(
    req: RedactImageRequest,
    vault?: { manager: VaultManager; sessionId: string }
  ): Promise<RedactImageResult> {
    validateBase64Size(req.image_b64);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const t0 = performance.now();

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.backendUrl}/redact/image`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const reason = await safeReadBody(response);
      throw new VisionClientError(
        `vision backend returned HTTP ${response.status}`,
        { status: response.status, body_snippet: reason }
      );
    }

    const body = (await response.json()) as RedactImageResponse;
    validateBackendResponse(body);

    let tokens: AssignedToken[] = [];
    if (vault) {
      const detections: Detection[] = body.detections.map((d, i) =>
        toCoreDetection(d, i)
      );
      tokens = vault.manager.assign(vault.sessionId, detections);
    }

    return {
      redacted_image_b64: body.redacted_image_b64,
      tokens,
      raw_detections: body.detections,
      warnings: body.warnings,
      backend_latency_ms: body.processing_time_ms,
      client_latency_ms: performance.now() - t0,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.backendUrl}/health`);
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean };
      return body.ok === true;
    } catch {
      return false;
    }
  }
}

export class VisionClientError extends Error {
  readonly meta: Record<string, unknown>;
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message);
    this.name = "VisionClientError";
    this.meta = meta;
  }
}

function validateBase64Size(b64: string): void {
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new VisionClientError("image_b64 must be a non-empty string");
  }
  const approxBytes = Math.floor((b64.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    throw new VisionClientError(
      `image_b64 too large (~${approxBytes} bytes); limit is ${MAX_IMAGE_BYTES}`,
      { approx_bytes: approxBytes, limit: MAX_IMAGE_BYTES }
    );
  }
}

function validateBackendResponse(body: unknown): asserts body is RedactImageResponse {
  if (body === null || typeof body !== "object") {
    throw new VisionClientError("backend response is not a JSON object");
  }
  const o = body as Record<string, unknown>;
  if (typeof o.redacted_image_b64 !== "string") {
    throw new VisionClientError("backend response missing 'redacted_image_b64'");
  }
  if (!Array.isArray(o.detections)) {
    throw new VisionClientError("backend response missing 'detections'");
  }
  if (
    !o.image_dimensions ||
    typeof (o.image_dimensions as Record<string, unknown>).width !== "number"
  ) {
    throw new VisionClientError("backend response missing 'image_dimensions'");
  }
}

const VISION_ONLY_CATEGORIES = new Set<string>([
  "rrn",
  "biz_num",
  "card",
]);

function toCoreDetection(d: ImageDetection, fallbackOffset: number): Detection {
  const category: PIICategory = mapCategory(d.label);
  return {
    start: typeof d.text_start === "number" ? d.text_start : fallbackOffset,
    end:
      typeof d.text_end === "number" ? d.text_end : fallbackOffset + d.text.length,
    category,
    confidence: d.score,
    text: d.text,
  };
}

function mapCategory(label: ImagePiiCategory): PIICategory {
  if (VISION_ONLY_CATEGORIES.has(label)) {
    return label as PIICategory;
  }
  return label as PIICategory;
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 240);
  } catch {
    return "";
  }
}
