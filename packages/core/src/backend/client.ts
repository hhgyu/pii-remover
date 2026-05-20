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
 *
 * `critical` (default `false`): when `true`, this backend's failure MUST
 * propagate through `MergeStrategy` / `TieredStrategy` even if other
 * backends succeed, so that the higher-level `failure_policy` (closed /
 * hybrid / open) decides what to do. This is the fail-closed contract:
 * a downed remote backend cannot be silently substituted by local-regex
 * coverage when categories the remote owns (e.g. `private_address`,
 * `account_number`, English NER persons) would otherwise pass through.
 *
 * Local-only backends (regex, personal-data) leave `critical` undefined
 * — they are augmentations, never the primary security boundary.
 */
export interface BackendClient {
  readonly name: string;
  readonly trust_tier: TrustTier;
  readonly critical?: boolean;
  detect(text: string, opts: DetectOpts): Promise<DetectionResult>;
  healthCheck(): Promise<BackendHealth>;
}
