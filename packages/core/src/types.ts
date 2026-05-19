/**
 * Common types shared across detector, vault, backend, and policy.
 *
 * Categories follow ADR-0010 (OPF 8 + Korean extension 3 = 11 total).
 * Trust tiers follow ADR-0005 (4-Tier trust model).
 */

/**
 * PII category. Lowercase string union for serialization compatibility
 * with the OPF HTTP API (ADR-0008).
 *
 * - OPF 8 (standard, also produced by the remote ML backend)
 * - Korean extension 3 (rrn / biz_num / card — local detection only in v1)
 */
export type PIICategory =
  | "account_number"
  | "private_address"
  | "private_email"
  | "private_person"
  | "private_phone"
  | "private_url"
  | "private_date"
  | "secret"
  | "rrn"
  | "biz_num"
  | "card";

export const ALL_CATEGORIES: readonly PIICategory[] = [
  "private_person",
  "private_email",
  "private_phone",
  "private_address",
  "account_number",
  "private_date",
  "private_url",
  "secret",
  "rrn",
  "biz_num",
  "card",
];

export const CATEGORY_LABELS: Record<PIICategory, string> = {
  private_person: "Person names",
  private_email: "Email addresses",
  private_phone: "Phone numbers",
  private_address: "Physical addresses",
  account_number: "Account / ID numbers",
  private_date: "Dates of birth",
  private_url: "Private URLs",
  secret: "Secrets / API keys",
  rrn: "Korean RRN (주민등록번호)",
  biz_num: "Korean business number (사업자번호)",
  card: "Credit / debit card numbers",
};

/**
 * Trust tier of a detection backend (ADR-0005 §3).
 *
 * Client-declared; backend self-report is never trusted.
 */
export type TrustTier = "local" | "self_hosted" | "vendor" | "public";

/**
 * Per-call options forwarded to backends.
 *
 * `request_id` is used for tracing/correlation. MUST NOT contain PII.
 */
export interface DetectOpts {
  /** Optional whitelist of categories to detect. */
  categories?: PIICategory[];
  /** Timeout for the call. Overrides backend default. */
  timeout_ms?: number;
  /** Tracing ID; never contains PII. */
  request_id: string;
}

/**
 * Single PII detection. Offsets are codepoint-based (`string.length`) and
 * half-open: `text[start..end)`.
 */
export interface Detection {
  start: number;
  end: number;
  category: PIICategory;
  confidence: number;
  /** Original substring (for vault storage). */
  text: string;
}

/**
 * Result of one detection call. Detections are deduped/merged per backend.
 */
export interface DetectionResult {
  detections: Detection[];
  backend_name: string;
  latency_ms: number;
}

/**
 * A Detection that has been assigned a vault token.
 * (Returned by VaultManager.assign.)
 */
export interface TokenizedSpan extends Detection {
  token: string;
}
