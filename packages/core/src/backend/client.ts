import type { DetectOpts, DetectionResult, TrustTier } from "../types.js";

export interface BackendHealth {
  ok: boolean;
  latency_ms: number;
  version?: string;
}

/**
 * BackendClient: detection provider interface (ADR-0005 §2).
 *
 * `trust_tier` is client-declared metadata used by config validation and
 * documentation; the backend's self-report MUST NOT be trusted.
 */
export interface BackendClient {
  readonly name: string;
  readonly trust_tier: TrustTier;
  detect(text: string, opts: DetectOpts): Promise<DetectionResult>;
  healthCheck(): Promise<BackendHealth>;
}
