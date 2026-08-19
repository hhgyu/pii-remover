import type {
  Detection,
  DetectOpts,
  DetectionResult,
  PIICategory,
  TrustTier,
} from "../types.js";
import type { BackendClient, BackendHealth } from "./client.js";
import { mergeDetections } from "./strategy.js";
import {
  findKoreanBizNums,
  findKoreanPhones,
  findKoreanRrns,
  findUsSsns,
} from "../detector/regex/index.js";
import { findKoreanNames } from "../detector/korean-heuristic/index.js";
import { findSecrets } from "../detector/secret-scanner.js";
import { isPrivateUrl } from "../detector/url-policy.js";
import type {
  IsPrivateUrlOptions,
  UrlPolicy,
} from "../detector/url-policy.js";

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const URL_REGEX = /\bhttps?:\/\/[^\s<>"'`)]+/g;

const PHONE_REGEX =
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;

const CARD_REGEX = /\b(?:\d{4}[- ]?){3}\d{4}\b/g;

const DEFAULT_ENABLED: ReadonlyArray<PIICategory> = [
  "private_email",
  "private_url",
  "private_phone",
  "private_person",
  "secret",
  "card",
  "rrn",
  "biz_num",
  "account_number",
];

const SUPPORTED: ReadonlySet<PIICategory> = new Set([
  "private_email",
  "private_url",
  "private_phone",
  "private_person",
  "secret",
  "card",
  "rrn",
  "biz_num",
  "account_number",
]);

export interface LocalRegexBackendOptions {
  enabledCategories?: ReadonlyArray<PIICategory>;
  name?: string;
  enable_korean_pii?: boolean;
  strict_rrn_checksum?: boolean;
  detect_us_ssn?: boolean;
  url_policy?: UrlPolicy;
  private_url_hosts?: ReadonlyArray<string>;
}

export class LocalRegexBackend implements BackendClient {
  readonly name: string;
  readonly trust_tier: TrustTier = "local";
  private readonly enabled: ReadonlySet<PIICategory>;
  private readonly enableKorean: boolean;
  private readonly strictRrnChecksum: boolean;
  private readonly detectUsSsn: boolean;
  private readonly urlPolicyOptions: IsPrivateUrlOptions;

  constructor(opts: LocalRegexBackendOptions = {}) {
    const requested = opts.enabledCategories ?? DEFAULT_ENABLED;
    this.enabled = new Set(requested.filter((c) => SUPPORTED.has(c)));
    this.name = opts.name ?? "local-regex";
    this.enableKorean = opts.enable_korean_pii !== false;
    this.strictRrnChecksum = opts.strict_rrn_checksum !== false;
    this.detectUsSsn = opts.detect_us_ssn === true;
    this.urlPolicyOptions = {
      policy: opts.url_policy ?? "heuristic",
      extraPrivateSuffixes: opts.private_url_hosts ?? [],
    };
  }

  async detect(text: string, opts: DetectOpts): Promise<DetectionResult> {
    const t0 = performance.now();
    const filter = opts.categories ? new Set(opts.categories) : null;
    const wants = (c: PIICategory): boolean =>
      this.enabled.has(c) && (!filter || filter.has(c));

    const all: Detection[] = [];

    if (wants("card")) {
      for (const m of text.matchAll(CARD_REGEX)) {
        const raw = m[0];
        const digits = raw.replace(/\D/g, "");
        if (digits.length === 16 && luhnCheck(digits)) {
          const start = m.index ?? 0;
          all.push({
            start,
            end: start + raw.length,
            category: "card",
            confidence: 0.99,
            text: raw,
          });
        }
      }
    }

    if (wants("private_email")) {
      for (const m of text.matchAll(EMAIL_REGEX)) {
        const start = m.index ?? 0;
        all.push({
          start,
          end: start + m[0].length,
          category: "private_email",
          confidence: 0.95,
          text: m[0],
        });
      }
    }

    if (wants("private_url")) {
      for (const m of text.matchAll(URL_REGEX)) {
        const start = m.index ?? 0;
        const cleaned = m[0].replace(/[.,;:!?)\]}>]+$/, "");
        if (!isPrivateUrl(cleaned, this.urlPolicyOptions)) continue;
        all.push({
          start,
          end: start + cleaned.length,
          category: "private_url",
          confidence: 0.95,
          text: cleaned,
        });
      }
    }

    if (wants("private_phone")) {
      for (const m of text.matchAll(PHONE_REGEX)) {
        const start = m.index ?? 0;
        all.push({
          start,
          end: start + m[0].length,
          category: "private_phone",
          confidence: 0.85,
          text: m[0],
        });
      }
      if (this.enableKorean) {
        for (const d of findKoreanPhones(text)) all.push(d);
      }
    }

    if (this.enableKorean) {
      if (wants("rrn")) {
        for (const d of findKoreanRrns(text, {
          strict_checksum: this.strictRrnChecksum,
        })) {
          all.push(d);
        }
      }
      if (wants("biz_num")) {
        for (const d of findKoreanBizNums(text)) all.push(d);
      }
      if (wants("private_person")) {
        for (const d of findKoreanNames(text)) all.push(d);
      }
    }

    if (this.detectUsSsn && wants("account_number")) {
      for (const d of findUsSsns(text)) all.push(d);
    }

    if (wants("secret")) {
      for (const d of findSecrets(text)) all.push(d);
    }

    return {
      detections: mergeDetections(all),
      backend_name: this.name,
      latency_ms: performance.now() - t0,
    };
  }

  async healthCheck(): Promise<BackendHealth> {
    return { ok: true, latency_ms: 0, version: "1.0.0" };
  }
}

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const code = digits.charCodeAt(i) - 48;
    if (code < 0 || code > 9) return false;
    let n = code;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
