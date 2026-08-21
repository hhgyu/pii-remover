import type { PIICategory, TrustTier } from "../types.js";
import type { FailurePolicy } from "../policy/failure.js";

export type AuthType = "none" | "bearer" | "api_key" | "mtls";

export interface BackendAuthMtlsConfig {
  cert_path: string;
  key_path: string;
  passphrase_env?: string;
}

export interface BackendAuthConfig {
  type: AuthType;
  token_env?: string;
  header_name?: string;
  mtls?: BackendAuthMtlsConfig;
}

export interface BackendTlsConfig {
  verify: boolean;
  ca_bundle_path: string | null;
  pinning: {
    enabled: boolean;
    sha256_fingerprint: string | null;
  };
}

export interface BackendConfig {
  type: "single" | "tiered";
  endpoint: string;
  trust_tier: TrustTier;
  auth: BackendAuthConfig;
  tls: BackendTlsConfig;
  timeout_ms: number;
  retries: number;
  auto_start?: boolean;
  compose_file?: "cpu" | "gpu" | string;
  start_timeout_ms?: number;
}

export interface KoreanHeuristicsConfig {
  enabled: boolean;
  surname_list_path: string | null;
  stopwords_path: string | null;
}

export interface CustomPatternConfig {
  name: string;
  pattern: string;
  /** Extra regex flags (e.g. "i"); the global flag "g" is always forced on. */
  flags?: string;
  category: PIICategory;
  /** Detection confidence in [0, 1]. Default 0.9. */
  confidence?: number;
  /** When false the pattern is skipped. Default true. */
  enabled?: boolean;
}

export interface DetectionConfig {
  enabled_categories: PIICategory[];
  korean_heuristics: KoreanHeuristicsConfig;
  generic_secret_scan?: boolean;
  detect_us_ssn?: boolean;
  custom_patterns?: readonly CustomPatternConfig[];
}

export type RestorationMode = "token" | "synthetic" | "hmac";

export type RedactionMode = "token" | "mask" | "partial";

export interface TypeRedactionOverride {
  category: PIICategory;
  mode: RedactionMode;
  /** Placeholder for "mask" mode (e.g. "[EMAIL]"). Default "[<CATEGORY>]". */
  placeholder?: string;
  /** Trailing chars kept visible in "partial" mode. Default 4. */
  visible_suffix?: number;
}

export interface HmacConfig {
  /** Env var holding the HMAC secret. Required when mode is "hmac". */
  secret_env: string;
  /** Token length (chars of the base64 digest). Default 16. */
  token_length?: number;
}

export interface TokenKeyConfig {
  /** Env var holding the token-hash key (ADR-0020). Default PII_REMOVER_TOKEN_KEY. */
  secret_env?: string;
  /** Override the key file path. Default ~/.config/pii-remover/key. */
  key_path?: string;
}

export interface RestorationConfig {
  token_format: string;
  lenient_match: boolean;
  warn_on_partial: boolean;
  mode: RestorationMode;
  type_overrides?: readonly TypeRedactionOverride[];
  hmac?: HmacConfig;
  /** Deterministic token-hash key resolution (ADR-0020). */
  token_key?: TokenKeyConfig;
}

export interface VaultConfig {
  scope: "session";
  persist: false;
}

export interface ProxyStreamingConfig {
  enabled: boolean;
  buffer_window: number;
  flush_on_close: boolean;
}

export interface ProxyConfig {
  enabled: boolean;
  port: number;
  upstream: Record<string, string>;
  streaming: ProxyStreamingConfig;
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
  redact_logs: boolean;
  log_path: string | null;
}

export interface AuditConfig {
  enabled: boolean;
  log_path: string | null;
  audit_env: string;
}

export interface PersonalDataEntry {
  value: string;
  category: PIICategory;
  case_sensitive?: boolean;
  word_boundary?: boolean;
}

export interface PersonalDataConfig {
  enabled: boolean;
  entries: readonly PersonalDataEntry[];
  extra_paths?: readonly string[];
}

export interface PiiRemoverConfig {
  $schema?: string;
  backend: BackendConfig;
  detection: DetectionConfig;
  restoration: RestorationConfig;
  vault: VaultConfig;
  failure_policy: FailurePolicy;
  bypass_env: string;
  proxy: ProxyConfig;
  logging: LoggingConfig;
  audit: AuditConfig;
  personal_data: PersonalDataConfig;
}

export const DEFAULT_CONFIG: PiiRemoverConfig = {
  $schema: "https://pii-remover.dev/schema/v1.json",
  backend: {
    type: "single",
    endpoint: "http://localhost:8000/redact",
    trust_tier: "local",
    auth: { type: "none" },
    tls: {
      verify: true,
      ca_bundle_path: null,
      pinning: { enabled: false, sha256_fingerprint: null },
    },
    timeout_ms: 5000,
    retries: 2,
    auto_start: false,
    compose_file: "cpu",
    start_timeout_ms: 60000,
  },
  detection: {
    enabled_categories: [
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
    ],
    korean_heuristics: {
      enabled: true,
      surname_list_path: null,
      stopwords_path: null,
    },
    generic_secret_scan: false,
  },
  restoration: {
    token_format: "{{OPF:{CATEGORY}:{HASH}}}",
    lenient_match: true,
    warn_on_partial: true,
    mode: "token",
  },
  vault: { scope: "session", persist: false },
  failure_policy: "closed",
  bypass_env: "PII_REMOVER_BYPASS",
  proxy: {
    enabled: false,
    port: 8000,
    upstream: {
      anthropic: "https://api.anthropic.com",
      openai: "https://api.openai.com",
      codex: "https://api.openai.com",
    },
    streaming: {
      enabled: true,
      buffer_window: 64,
      flush_on_close: true,
    },
  },
  logging: {
    level: "info",
    redact_logs: true,
    log_path: null,
  },
  audit: {
    enabled: false,
    log_path: null,
    audit_env: "PII_REMOVER_AUDIT",
  },
  personal_data: {
    enabled: true,
    entries: [],
  },
};
