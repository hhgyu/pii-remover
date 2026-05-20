export {
  type PIICategory,
  type TrustTier,
  type DetectOpts,
  type Detection,
  type DetectionResult,
  type TokenizedSpan,
  ALL_CATEGORIES,
  CATEGORY_LABELS,
} from "./types.js";

export {
  formatToken,
  parseToken,
  isToken,
  TOKEN_STRICT_REGEX,
  TOKEN_LENIENT_REGEX,
  TOKEN_PREFIX,
  TOKEN_SUFFIX,
} from "./token/format.js";
export type { ParsedToken } from "./token/format.js";

export {
  CATEGORY_MAP,
  REVERSE_CATEGORY_MAP,
  categoryToTokenLabel,
  tokenLabelToCategory,
} from "./token/category-map.js";

export { SCHEMA_VERSION } from "./vault/schema.js";
export type { Vault, VaultEntry, VaultSchemaVersion } from "./vault/schema.js";
export { VaultManager } from "./vault/manager.js";
export type { AssignedToken, VaultManagerOptions } from "./vault/manager.js";

export type {
  BackendClient,
  BackendHealth,
} from "./backend/client.js";
export {
  MergeStrategy,
  SingleStrategy,
  mergeDetections,
} from "./backend/strategy.js";
export type { BackendStrategy } from "./backend/strategy.js";
export { LocalRegexBackend } from "./backend/local-regex.js";
export type { LocalRegexBackendOptions } from "./backend/local-regex.js";
export { PersonalDataBackend } from "./backend/personal-data.js";
export { OpfHttpBackend } from "./backend/opf-http.js";
export type {
  OpfHttpBackendOptions,
  OpfHttpAuth,
  FetchLike,
} from "./backend/opf-http.js";
export { RemoteHttpBackend } from "./backend/remote-http.js";
export type {
  RemoteHttpBackendOptions,
  RemoteHttpAuth,
} from "./backend/remote-http.js";
export { TieredStrategy, redactSpans } from "./backend/tiered-strategy.js";
export type {
  TieredStrategyOptions,
  OnLocalFailure,
} from "./backend/tiered-strategy.js";
export {
  maybeAutoStartBackend,
  deriveHealthUrl,
  defaultComposePathResolver,
} from "./backend/auto-start.js";
export type { AutoStartOptions } from "./backend/auto-start.js";
export {
  buildFetchTlsExtension,
  buildPinningCheckServerIdentity,
  fingerprintMatches,
  isBunRuntime,
  normalizeFingerprint,
} from "./backend/tls.js";
export type {
  BuildFetchTlsExtensionDeps,
  FetchInitExtended,
  FileReader,
  PeerCertificateLike,
  TlsRuntimeConfig,
  UndiciLike,
} from "./backend/tls.js";

export { Detector } from "./detector/index.js";
export type { DetectorOptions } from "./detector/index.js";

export { AuditEmitter, aggregateAuditCategories } from "./audit/index.js";
export type {
  AuditEmitterOptions,
  AuditEntry,
  AuditEntryInput,
  AuditEvent,
  BlockAuditData,
  BypassAuditData,
  ErrorAuditData,
  MaskAuditData,
  RestoreAuditData,
} from "./audit/index.js";

export { Restorer, scanTokens } from "./restorer/index.js";
export type {
  TokenMatch,
  RestoreResult,
  RestoreOptions,
} from "./restorer/index.js";

export {
  DEFAULT_CONFIG,
} from "./config/schema.js";
export type {
  PiiRemoverConfig,
  BackendConfig,
  BackendAuthConfig,
  BackendAuthMtlsConfig,
  BackendTlsConfig,
  DetectionConfig,
  KoreanHeuristicsConfig,
  RestorationConfig,
  RestorationMode,
  VaultConfig,
  ProxyConfig,
  ProxyStreamingConfig,
  LoggingConfig,
  AuditConfig,
  AuthType,
  PersonalDataEntry,
  PersonalDataConfig,
} from "./config/schema.js";

export {
  synthesize,
  selectSyntheticName,
  syntheticRrn,
  syntheticBizNum,
  syntheticCard,
} from "./synthetic/index.js";
export { restoreSynthetic } from "./synthetic/restore.js";
export { loadConfig, substituteEnv } from "./config/loader.js";
export type { LoadConfigOptions } from "./config/loader.js";

export { applyPolicy, FailClosedError } from "./policy/failure.js";
export type { FailurePolicy, ApplyPolicyOptions } from "./policy/failure.js";
export {
  isBypassActive,
  recordBypass,
  getBypassCount,
  resetBypassCount,
  bypassWarningMessage,
} from "./policy/bypass.js";
export type { BypassDetectOptions } from "./policy/bypass.js";

export { PIIRemover, applyTokens } from "./pii-remover.js";
export type { PIIRemoverInitOptions, MaskResult } from "./pii-remover.js";
