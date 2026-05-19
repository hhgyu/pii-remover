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
} from "../detector/regex/index.js";
import { findKoreanNames } from "../detector/korean-heuristic/index.js";

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const URL_REGEX = /\bhttps?:\/\/[^\s<>"'`)]+/g;

const PHONE_REGEX =
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;

const CARD_REGEX = /\b(?:\d{4}[- ]?){3}\d{4}\b/g;

const AWS_ACCESS_KEY_REGEX = /(?:^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}(?=[^A-Za-z0-9]|$)/g;

const GITHUB_PAT_REGEX = /(?:^|[^A-Za-z0-9])ghp_[A-Za-z0-9]{36,}(?=[^A-Za-z0-9]|$)/g;

const OPENAI_KEY_REGEX = /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9]|$)/g;

const PEM_PRIVATE_KEY_REGEX =
  /-----BEGIN [A-Z0-9 -]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 -]*PRIVATE KEY-----/g;

const JWT_REGEX =
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

const CONNECTION_STRING_REGEX =
  /[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi;

const NPM_TOKEN_REGEX =
  /(?:\/\/[^/\s]+\/:_authToken=|_authToken=)[A-Za-z0-9_-]{8,}/g;

const ANTHROPIC_KEY_REGEX =
  /(?:^|[^A-Za-z0-9])sk-ant-api03-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9]|$)/g;

const GOOGLE_API_KEY_REGEX =
  /(?:^|[^A-Za-z0-9])AIza[A-Za-z0-9_-]{35}(?=[^A-Za-z0-9]|$)/g;

const SLACK_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9])xox[bpak]-[A-Za-z0-9-]{10,}(?=[^A-Za-z0-9-]|$)/g;

const STRIPE_KEY_REGEX =
  /(?:^|[^A-Za-z0-9])[sr]k_live_[A-Za-z0-9]{20,}(?=[^A-Za-z0-9]|$)/g;

const GITLAB_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-]|$)/g;

const TELEGRAM_BOT_TOKEN_REGEX =
  /(?:^|[^0-9])[1-9]\d{5,9}:[A-Za-z0-9_-]{35}(?=[^A-Za-z0-9_-]|$)/g;

const GITHUB_FINE_GRAINED_PAT_REGEX =
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}(?=[^A-Za-z0-9_]|$)/g;

const GITHUB_OAUTH_REGEX =
  /(?:^|[^A-Za-z0-9])gho_[A-Za-z0-9]{20,}(?=[^A-Za-z0-9]|$)/g;

const GITHUB_USER_TO_SERVER_REGEX =
  /(?:^|[^A-Za-z0-9])ghu_[A-Za-z0-9]{20,}(?=[^A-Za-z0-9]|$)/g;

const GITHUB_SERVER_TO_SERVER_REGEX =
  /(?:^|[^A-Za-z0-9])ghs_[A-Za-z0-9]{20,}(?=[^A-Za-z0-9]|$)/g;

const GITHUB_REFRESH_REGEX =
  /(?:^|[^A-Za-z0-9])ghr_[A-Za-z0-9]{20,}(?=[^A-Za-z0-9]|$)/g;

const SENDGRID_KEY_REGEX =
  /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g;

const DIGITALOCEAN_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9])do[opr]_v1_[a-f0-9]{64}(?=[^a-f0-9]|$)/g;

const TWILIO_ACCOUNT_SID_REGEX =
  /(?:^|[^A-Za-z0-9])AC[a-f0-9]{32}(?=[^a-f0-9]|$)/gi;

const TWILIO_API_KEY_REGEX =
  /(?:^|[^A-Za-z0-9])SK[a-zA-Z0-9]{32}(?=[^A-Za-z0-9]|$)/g;

const SHOPIFY_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9])shp(?:at|pa|ca|ss)_[a-f0-9]{32}(?=[^a-f0-9]|$)/g;

const POSTMAN_KEY_REGEX =
  /PMAK-[A-Za-z0-9-]{59}/g;

const DISCORD_BOT_TOKEN_REGEX =
  /[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27}/g;

const DATABRICKS_TOKEN_REGEX =
  /(?:^|[^A-Za-z0-9])dapi[a-h0-9]{32}(?=[^A-Za-z0-9]|$)/g;

const PYPI_TOKEN_REGEX =
  /pypi-AgEI[A-Za-z0-9_-]{50,}/g;

const MAILGUN_KEY_REGEX =
  /(?:^|[^A-Za-z0-9])key-[a-z0-9]{32}(?=[^a-z0-9]|$)/g;

const SECRET_PATTERNS: readonly {
  regex: RegExp;
  label: string;
  validate?: (match: string) => boolean;
}[] = [
  { regex: AWS_ACCESS_KEY_REGEX, label: "aws_access_key" },
  { regex: GITHUB_PAT_REGEX, label: "github_pat" },
  { regex: OPENAI_KEY_REGEX, label: "openai_api_key" },
  { regex: ANTHROPIC_KEY_REGEX, label: "anthropic_api_key" },
  { regex: GOOGLE_API_KEY_REGEX, label: "google_api_key" },
  { regex: SLACK_TOKEN_REGEX, label: "slack_token" },
  { regex: STRIPE_KEY_REGEX, label: "stripe_key" },
  { regex: GITLAB_TOKEN_REGEX, label: "gitlab_token" },
  { regex: TELEGRAM_BOT_TOKEN_REGEX, label: "telegram_bot_token" },
  { regex: PEM_PRIVATE_KEY_REGEX, label: "pem_private_key" },
  { regex: JWT_REGEX, label: "jwt_token" },
  { regex: CONNECTION_STRING_REGEX, label: "connection_string_password", validate: hasCredentials },
  { regex: NPM_TOKEN_REGEX, label: "npm_token" },
  { regex: GITHUB_FINE_GRAINED_PAT_REGEX, label: "github_fine_grained_pat" },
  { regex: GITHUB_OAUTH_REGEX, label: "github_oauth_token" },
  { regex: GITHUB_USER_TO_SERVER_REGEX, label: "github_user_to_server" },
  { regex: GITHUB_SERVER_TO_SERVER_REGEX, label: "github_server_to_server" },
  { regex: GITHUB_REFRESH_REGEX, label: "github_refresh_token" },
  { regex: SENDGRID_KEY_REGEX, label: "sendgrid_api_key" },
  { regex: DIGITALOCEAN_TOKEN_REGEX, label: "digitalocean_token" },
  { regex: TWILIO_ACCOUNT_SID_REGEX, label: "twilio_account_sid" },
  { regex: TWILIO_API_KEY_REGEX, label: "twilio_api_key" },
  { regex: SHOPIFY_TOKEN_REGEX, label: "shopify_token" },
  { regex: POSTMAN_KEY_REGEX, label: "postman_api_key" },
  { regex: DISCORD_BOT_TOKEN_REGEX, label: "discord_bot_token" },
  { regex: DATABRICKS_TOKEN_REGEX, label: "databricks_token" },
  { regex: PYPI_TOKEN_REGEX, label: "pypi_token" },
  { regex: MAILGUN_KEY_REGEX, label: "mailgun_api_key" },
];

function hasCredentials(uri: string): boolean {
  const afterScheme = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const atIndex = afterScheme.indexOf("@");
  if (atIndex < 0) return false;
  const userInfo = afterScheme.slice(0, atIndex);
  return userInfo.includes(":");
}

const DEFAULT_ENABLED: ReadonlyArray<PIICategory> = [
  "private_email",
  "private_url",
  "private_phone",
  "private_person",
  "secret",
  "card",
  "rrn",
  "biz_num",
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
]);

export interface LocalRegexBackendOptions {
  enabledCategories?: ReadonlyArray<PIICategory>;
  name?: string;
  enable_korean_pii?: boolean;
  strict_rrn_checksum?: boolean;
}

export class LocalRegexBackend implements BackendClient {
  readonly name: string;
  readonly trust_tier: TrustTier = "local";
  private readonly enabled: ReadonlySet<PIICategory>;
  private readonly enableKorean: boolean;
  private readonly strictRrnChecksum: boolean;

  constructor(opts: LocalRegexBackendOptions = {}) {
    const requested = opts.enabledCategories ?? DEFAULT_ENABLED;
    this.enabled = new Set(requested.filter((c) => SUPPORTED.has(c)));
    this.name = opts.name ?? "local-regex";
    this.enableKorean = opts.enable_korean_pii !== false;
    this.strictRrnChecksum = opts.strict_rrn_checksum !== false;
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

    if (wants("secret")) {
      for (const { regex, validate } of SECRET_PATTERNS) {
        for (const m of text.matchAll(regex)) {
          const matchStart = m.index ?? 0;
          const full = m[0];
          const prefixLen = full.length - full.replace(/^[^A-Za-z0-9]?/, "").length;
          const secretStart = matchStart + prefixLen;
          const secretText = full.slice(prefixLen);
          if (validate && !validate(secretText)) continue;
          all.push({
            start: secretStart,
            end: secretStart + secretText.length,
            category: "secret",
            confidence: 0.99,
            text: secretText,
          });
        }
      }
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
