import { randomUUID } from "node:crypto";
import type {
  DetectionResult,
  DetectOpts,
  PIICategory,
  TrustTier,
} from "./types.js";
import type {
  BackendAuthConfig,
  BackendConfig,
  PiiRemoverConfig,
} from "./config/schema.js";
import { loadConfig } from "./config/loader.js";
import type { BackendClient } from "./backend/client.js";
import { LocalRegexBackend } from "./backend/local-regex.js";
import { OpfHttpBackend } from "./backend/opf-http.js";
import { PersonalDataBackend } from "./backend/personal-data.js";
import { CustomPatternBackend } from "./backend/custom-pattern.js";
import { synthesize } from "./synthetic/index.js";
import { restoreSynthetic } from "./synthetic/restore.js";
import { HmacTokenizer } from "./redaction/hmac.js";
import { TypeRedactor } from "./redaction/redact.js";
import { resolveTokenKey, TOKEN_EPOCH_LENGTH } from "./redaction/token-hash.js";
import { parseToken } from "./token/format.js";
import {
  RemoteHttpBackend,
  type RemoteHttpAuth,
} from "./backend/remote-http.js";
import { TieredStrategy } from "./backend/tiered-strategy.js";
import type { TlsRuntimeConfig } from "./backend/tls.js";
import {
  MergeStrategy,
  SingleStrategy,
  type BackendStrategy,
} from "./backend/strategy.js";
import { Detector } from "./detector/index.js";
import { findSecrets } from "./detector/secret-scanner.js";
import { mergeDetections } from "./backend/strategy.js";
import {
  Restorer,
  type RestoreOptions,
  type RestoreOrigin,
  type RestoreResult,
} from "./restorer/index.js";
import { type AssignedToken, VaultManager } from "./vault/manager.js";
import { applyPolicy, FailClosedError } from "./policy/failure.js";
import {
  bypassWarningMessage,
  isBypassActive,
  recordBypass,
} from "./policy/bypass.js";
import { AuditEmitter, aggregateAuditCategories } from "./audit/index.js";

export interface PIIRemoverInitOptions {
  sessionId?: string;
  config?: PiiRemoverConfig;
  configPath?: string;
  strategy?: BackendStrategy;
  /**
   * Replaces the entire config-derived backend list — local-regex, personal-data,
   * custom-pattern and the remote endpoint are all skipped when this is set.
   * Mutually exclusive with `backend.type = "tiered"`, which throws instead.
   */
  backends?: readonly BackendClient[];
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  audit?: AuditEmitter;
}

export type TokenStatus = "live" | "expired" | "foreign";

export interface MaskResult {
  text: string;
  vault_id: string;
  tokens: AssignedToken[];
  latency_ms: number;
  bypassed: boolean;
  backend_name: string;
}

export class PIIRemover {
  readonly sessionId: string;
  private readonly config: PiiRemoverConfig;
  private readonly vault: VaultManager;
  private readonly detector: Detector;
  private readonly restorer: Restorer;
  private readonly env: NodeJS.ProcessEnv;
  private readonly warn: (message: string) => void;
  private readonly backendName: string;
  private readonly fallbackBackend: LocalRegexBackend;
  private readonly audit: AuditEmitter;
  private readonly hmacTokenizer: HmacTokenizer | null;
  private readonly typeRedactor: TypeRedactor | null;
  private disposed = false;

  private constructor(args: {
    sessionId: string;
    config: PiiRemoverConfig;
    vault: VaultManager;
    detector: Detector;
    restorer: Restorer;
    env: NodeJS.ProcessEnv;
    warn: (message: string) => void;
    backendName: string;
    fallbackBackend: LocalRegexBackend;
    audit: AuditEmitter;
    hmacTokenizer: HmacTokenizer | null;
    typeRedactor: TypeRedactor | null;
  }) {
    this.sessionId = args.sessionId;
    this.config = args.config;
    this.vault = args.vault;
    this.detector = args.detector;
    this.restorer = args.restorer;
    this.env = args.env;
    this.warn = args.warn;
    this.backendName = args.backendName;
    this.fallbackBackend = args.fallbackBackend;
    this.audit = args.audit;
    this.hmacTokenizer = args.hmacTokenizer;
    this.typeRedactor = args.typeRedactor;
  }

  static async init(
    opts: PIIRemoverInitOptions = {}
  ): Promise<PIIRemover> {
    const config =
      opts.config ?? (await loadConfig({ env: opts.env, configPath: opts.configPath }));
    const env = opts.env ?? process.env;
    const sessionId = opts.sessionId ?? `session_${randomUUID()}`;
    const warn = opts.warn ?? ((msg: string) => process.stderr.write(`${msg}\n`));

    const tokenKeyOpts: Parameters<typeof resolveTokenKey>[0] = { env };
    if (config.restoration.token_key?.secret_env) {
      tokenKeyOpts.envName = config.restoration.token_key.secret_env;
    }
    if (config.restoration.token_key?.key_path) {
      tokenKeyOpts.keyPath = config.restoration.token_key.key_path;
    }
    const tokenKeyResolution = resolveTokenKey(tokenKeyOpts);
    if (tokenKeyResolution.warning) warn(tokenKeyResolution.warning);

    const vaultOpts: ConstructorParameters<typeof VaultManager>[0] = {
      onWarn: warn,
      tokenKey: tokenKeyResolution.key,
    };
    if (config.restoration.mode === "synthetic") {
      vaultOpts.syntheticGenerator = synthesize;
    }
    const vault = new VaultManager(vaultOpts);
    const built = opts.strategy
      ? { strategy: opts.strategy, name: "custom" }
      : buildDefaultStrategy(config, opts.backends, warn);
    const detector = new Detector({
      strategy: built.strategy,
      defaultCategories: config.detection.enabled_categories,
    });
    const restorer = new Restorer(vault, { warn });
    const fallbackBackend = buildLocalRegexBackend(config);
    const auditEnvValue = env[config.audit.audit_env];
    const auditEnvOverride =
      typeof auditEnvValue === "string" && auditEnvValue.length > 0
        ? auditEnvValue.toLowerCase() === "true" || auditEnvValue === "1"
        : undefined;
    const audit =
      opts.audit ??
      new AuditEmitter({
        enabled: auditEnvOverride ?? config.audit.enabled,
        logPath: config.audit.log_path,
      });

    const hmacTokenizer = buildHmacTokenizer(config, env);
    const typeRedactor = buildTypeRedactor(config);

    return new PIIRemover({
      sessionId,
      config,
      vault,
      detector,
      restorer,
      env,
      warn,
      backendName: built.name,
      fallbackBackend,
      audit,
      hmacTokenizer,
      typeRedactor,
    });
  }

  async mask(
    text: string,
    opts: { request_id?: string; provider?: string } = {}
  ): Promise<MaskResult> {
    this.assertNotDisposed();
    const t0 = performance.now();
    const bypass = isBypassActive({
      env: this.env,
      envName: this.config.bypass_env,
    });
    const vault = this.vault.getOrCreate(this.sessionId);
    if (bypass) {
      if (recordBypass() === 1) {
        this.warn(bypassWarningMessage({ envName: this.config.bypass_env }));
      }
      const latencyMs = performance.now() - t0;
      this.audit.bypassEvent({
        vault_id: vault.vault_id,
        session_id: this.sessionId,
        request_id: opts.request_id,
        backend_name: this.backendName,
        latency_ms: latencyMs,
        provider: opts.provider,
      });
      return {
        text,
        vault_id: vault.vault_id,
        tokens: [],
        latency_ms: latencyMs,
        bypassed: true,
        backend_name: this.backendName,
      };
    }

    const requestId = opts.request_id ?? `req_${randomUUID()}`;
    let detection: DetectionResult;
    try {
      detection = await applyPolicy<DetectionResult>({
        policy: this.config.failure_policy,
        bypass: false,
        bypassEnv: this.config.bypass_env,
        backendName: this.backendName,
        primary: () => this.detector.detect(text, { request_id: requestId }),
        fallback: () =>
          this.fallbackBackend.detect(text, {
            request_id: requestId,
            categories: [...this.config.detection.enabled_categories],
          }),
        passthrough: () => ({
          detections: [],
          backend_name: "passthrough",
          latency_ms: 0,
        }),
        onError: (err, mode) => {
          const reason = err instanceof Error ? err.message : String(err);
          this.warn(
            `[WARN] PII detection failed (mode=${mode}, backend=${this.backendName}): ${reason}`
          );
        },
      });
    } catch (err) {
      if (err instanceof FailClosedError) {
        this.audit.blockEvent({
          vault_id: vault.vault_id,
          session_id: this.sessionId,
          request_id: requestId,
          backend_name: this.backendName,
          latency_ms: performance.now() - t0,
          error: err.message,
          provider: opts.provider,
        });
      }
      throw err;
    }

    if (
      detection.backend_name !== "passthrough" &&
      this.config.detection.enabled_categories.includes("secret")
    ) {
      const secrets = findSecrets(text, {
        generic: this.config.detection.generic_secret_scan === true,
      });
      if (secrets.length > 0) {
        detection.detections = mergeDetections([
          ...secrets,
          ...detection.detections,
        ]);
      }
    }

    const tokens = this.vault.assign(this.sessionId, detection.detections);
    const masked = applyTokens(text, tokens, {
      resolveReplacement: (t) => this.resolveReplacement(t),
    });
    const latencyMs = performance.now() - t0;
    this.audit.maskEvent({
      vault_id: vault.vault_id,
      session_id: this.sessionId,
      request_id: requestId,
      categories: aggregateAuditCategories(tokens),
      backend_name: detection.backend_name,
      latency_ms: latencyMs,
      minted_count: new Set(tokens.map((t) => t.token)).size,
      text_length: text.length,
      masked_char_count: tokens.reduce((n, t) => n + (t.end - t.start), 0),
      provider: opts.provider,
    });
    return {
      text: masked,
      vault_id: vault.vault_id,
      tokens,
      latency_ms: latencyMs,
      bypassed: false,
      backend_name: detection.backend_name,
    };
  }

  private resolveReplacement(t: AssignedToken): string {
    const category = t.category as PIICategory;
    if (this.typeRedactor) {
      const redacted = this.typeRedactor.redact(category, t.text);
      if (redacted !== null) return redacted;
    }
    if (this.hmacTokenizer) {
      return this.hmacTokenizer.tokenize(category, t.text);
    }
    if (
      this.config.restoration.mode === "synthetic" &&
      t.syntheticValue !== undefined
    ) {
      return t.syntheticValue;
    }
    return t.token;
  }

  restore(
    text: string,
    opts: RestoreOptions & { request_id?: string; provider?: string } = {}
  ): RestoreResult {
    this.assertNotDisposed();
    const { request_id: requestId, provider, ...restorerOpts } = opts;
    const vault = this.vault.getOrCreate(this.sessionId);
    let workingText = text;
    let syntheticRestored = 0;
    if (this.config.restoration.mode === "synthetic") {
      const entries = this.vault.entries(this.sessionId);
      const pre = restoreSynthetic(workingText, entries);
      workingText = pre.text;
      syntheticRestored = pre.restoredCount;
    }
    const result = this.restorer.restore(workingText, this.sessionId, restorerOpts);
    result.restoredCount += syntheticRestored;

    // Streaming transports call restore() once per SSE delta, most of which
    // carry no token at all. Emitting for those inflates the event count and
    // makes the proxy's denominator incomparable with the plugin's, which
    // short-circuits token-free text before it ever reaches restore().
    const observed =
      result.restoredCount + result.unknownTokenCount + result.pathSkipCount;
    if (observed > 0) {
      this.audit.restoreEvent({
        vault_id: vault.vault_id,
        session_id: this.sessionId,
        request_id: requestId,
        restored_count: result.restoredCount,
        unknown_token_count: result.unknownTokenCount,
        partial_match_count: result.partialMatchCount,
        lenient_restored_count: result.lenientRestoredCount,
        path_skip_count: result.pathSkipCount,
        residual_token_count: result.residualTokenCount,
        repaired_count: result.repairedCount,
        ...attributeForeign(result.foreignCount, restorerOpts.origin ?? "model"),
        dead_token_count: result.deadTokenCount,
        ambiguous_count: result.ambiguousCount,
        provider,
      });
    }
    return result;
  }

  hasToken(token: string): boolean {
    return this.vault.lookup(this.sessionId, token) !== null;
  }

  /**
   * Why a token cannot be used, without consulting the repair index (O(1)).
   *
   * `expired` means this key minted it but the in-memory vault no longer holds
   * it — a resumed session. `foreign` means this key never minted it, so the
   * model most likely invented it. Hosts surface the difference to the user;
   * the two need different fixes.
   */
  tokenStatus(token: string): TokenStatus {
    if (this.vault.lookup(this.sessionId, token)) return "live";
    const parsed = parseToken(token);
    if (!parsed) return "foreign";
    return parsed.hash.slice(0, TOKEN_EPOCH_LENGTH) === this.vault.epoch()
      ? "expired"
      : "foreign";
  }

  vaultId(): string {
    return this.vault.getOrCreate(this.sessionId).vault_id;
  }

  vaultSize(): number {
    return this.vault.size(this.sessionId);
  }

  dispose(): void {
    this.vault.dispose(this.sessionId);
    this.disposed = true;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(
        `PIIRemover(session=${this.sessionId}): instance has been disposed`
      );
    }
  }
}

function attributeForeign(
  count: number,
  origin: RestoreOrigin
): { hallucinated_count: number } | { unminted_token_count: number } {
  return origin === "model"
    ? { hallucinated_count: count }
    : { unminted_token_count: count };
}

export interface ApplyTokensOptions {
  mode?: "token" | "synthetic";
  resolveReplacement?: (token: AssignedToken) => string;
}

export function applyTokens(
  text: string,
  tokens: readonly AssignedToken[],
  modeOrOptions: "token" | "synthetic" | ApplyTokensOptions = "token",
): string {
  if (tokens.length === 0) return text;
  const options: ApplyTokensOptions =
    typeof modeOrOptions === "string"
      ? { mode: modeOrOptions }
      : modeOrOptions;
  const mode = options.mode ?? "token";
  const sorted = [...tokens].sort((a, b) => b.start - a.start);
  let out = text;
  for (const t of sorted) {
    let replacement: string;
    if (options.resolveReplacement) {
      replacement = options.resolveReplacement(t);
    } else if (mode === "synthetic" && t.syntheticValue !== undefined) {
      replacement = t.syntheticValue;
    } else {
      replacement = t.token;
    }
    out = out.slice(0, t.start) + replacement + out.slice(t.end);
  }
  return out;
}

interface BuiltStrategy {
  strategy: BackendStrategy;
  name: string;
}

function buildDefaultStrategy(
  config: PiiRemoverConfig,
  extraBackends?: readonly BackendClient[],
  warn?: (message: string) => void
): BuiltStrategy {
  if (config.backend.type === "tiered") {
    return buildTieredStrategy(config, extraBackends);
  }
  const backends: BackendClient[] = [];
  if (extraBackends && extraBackends.length > 0) {
    warnOnDiscardedBackendConfig(config, warn);
    backends.push(...extraBackends);
  } else {
    backends.push(buildLocalRegexBackend(config));
    const personalBackend = buildPersonalDataBackend(config);
    if (personalBackend) backends.push(personalBackend);
    const customBackend = buildCustomPatternBackend(config);
    if (customBackend) backends.push(customBackend);
    if (config.backend.endpoint) {
      backends.push(buildRemoteBackend(config.backend));
    }
  }
  const name = backends.map((b) => b.name).join("+");
  const strategy: BackendStrategy =
    backends.length === 1
      ? new SingleStrategy(backends[0]!)
      : new MergeStrategy(backends);
  return { strategy, name };
}

function warnOnDiscardedBackendConfig(
  config: PiiRemoverConfig,
  warn?: (message: string) => void
): void {
  if (!warn) return;
  const discarded: string[] = [];
  if (config.backend.endpoint) discarded.push("backend.endpoint");
  if (buildPersonalDataBackend(config)) discarded.push("personal_data");
  if (buildCustomPatternBackend(config)) discarded.push("detection.custom_patterns");
  if (discarded.length === 0) return;
  warn(
    `PII Remover: init({ backends }) replaces the config-derived backend list, so ${discarded.join(", ")} ${discarded.length === 1 ? "is" : "are"} not in effect`
  );
}

function buildLocalRegexBackend(config: PiiRemoverConfig): LocalRegexBackend {
  return new LocalRegexBackend({
    enabledCategories: config.detection.enabled_categories,
    detect_us_ssn: config.detection.detect_us_ssn === true,
  });
}

function buildPersonalDataBackend(
  config: PiiRemoverConfig,
): PersonalDataBackend | null {
  const pd = config.personal_data;
  if (!pd || pd.enabled === false) return null;
  if (!pd.entries || pd.entries.length === 0) return null;
  return new PersonalDataBackend(pd.entries);
}

function buildCustomPatternBackend(
  config: PiiRemoverConfig,
): CustomPatternBackend | null {
  const patterns = config.detection.custom_patterns;
  if (!patterns || patterns.length === 0) return null;
  const backend = new CustomPatternBackend(patterns);
  return backend.size() > 0 ? backend : null;
}

function buildHmacTokenizer(
  config: PiiRemoverConfig,
  env: NodeJS.ProcessEnv,
): HmacTokenizer | null {
  if (config.restoration.mode !== "hmac") return null;
  const hmac = config.restoration.hmac;
  if (!hmac || !hmac.secret_env) {
    throw new Error(
      "PII Remover: restoration.mode='hmac' requires restoration.hmac.secret_env (fail-closed)",
    );
  }
  const secret = env[hmac.secret_env];
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(
      `PII Remover: restoration.hmac.secret_env '${hmac.secret_env}' is not set (fail-closed)`,
    );
  }
  return new HmacTokenizer(secret, hmac.token_length);
}

function buildTypeRedactor(config: PiiRemoverConfig): TypeRedactor | null {
  const overrides = config.restoration.type_overrides;
  if (!overrides || overrides.length === 0) return null;
  return new TypeRedactor(overrides);
}

function buildTieredStrategy(
  config: PiiRemoverConfig,
  extraBackends: readonly BackendClient[] | undefined
): BuiltStrategy {
  if (extraBackends && extraBackends.length > 0) {
    throw new Error(
      "PII Remover: backend.type='tiered' does not currently support additional backends via PIIRemoverInitOptions.backends"
    );
  }
  if (!config.backend.endpoint || config.backend.endpoint.length === 0) {
    throw new Error(
      "PII Remover: backend.type='tiered' requires a non-empty backend.endpoint (fail-closed per ADR-0006)"
    );
  }
  const local = buildLocalRegexBackend(config);
  const remote = buildRemoteBackend(config.backend);
  const personalBackend = buildPersonalDataBackend(config);
  const customBackend = buildCustomPatternBackend(config);
  const localOnly: BackendClient[] = [local];
  if (personalBackend) localOnly.push(personalBackend);
  if (customBackend) localOnly.push(customBackend);
  const localStrategy: BackendClient =
    localOnly.length > 1 ? new MergedBackend(localOnly) : local;
  const strategy = new TieredStrategy({ local: localStrategy, remote });
  const localName = localOnly.map((b) => b.name).join("+");
  return {
    strategy,
    name: `tiered(local=${localName}+remote=${remote.name})`,
  };
}

class MergedBackend implements BackendClient {
  readonly name: string;
  readonly trust_tier: TrustTier;
  constructor(private readonly backends: readonly BackendClient[]) {
    this.name = backends.map((b) => b.name).join("+");
    this.trust_tier = "local";
  }
  async detect(text: string, opts: DetectOpts): Promise<DetectionResult> {
    const merged = new MergeStrategy(this.backends);
    return merged.resolve(text, opts);
  }
  async healthCheck() {
    const results = await Promise.all(this.backends.map((b) => b.healthCheck()));
    return {
      ok: results.every((r) => r.ok),
      latency_ms: Math.max(...results.map((r) => r.latency_ms)),
    };
  }
}

function buildRemoteBackend(cfg: BackendConfig): BackendClient {
  const useOpfWire = isOpfWireEndpoint(cfg.endpoint);
  const endpoint = stripTrailingPath(cfg.endpoint, "/redact");
  const tlsCfg = buildTlsRuntimeConfig(cfg);
  if (useOpfWire && cfg.auth.type !== "api_key" && cfg.auth.type !== "mtls" && !tlsCfg) {
    const opfOpts: ConstructorParameters<typeof OpfHttpBackend>[0] = {
      endpoint,
      trust_tier: cfg.trust_tier,
      timeout_ms: cfg.timeout_ms,
    };
    if (cfg.auth.type === "bearer") {
      opfOpts.auth = buildBearerAuth(cfg.auth.token_env);
    } else {
      opfOpts.auth = { type: "none" };
    }
    return new OpfHttpBackend(opfOpts);
  }
  const remoteOpts: ConstructorParameters<typeof RemoteHttpBackend>[0] = {
    endpoint,
    trust_tier: cfg.trust_tier,
    timeout_ms: cfg.timeout_ms,
    retries: cfg.retries,
    auth: buildRemoteAuth(cfg.auth),
  };
  if (tlsCfg) remoteOpts.tls = tlsCfg;
  return new RemoteHttpBackend(remoteOpts);
}

function buildRemoteAuth(auth: BackendAuthConfig): RemoteHttpAuth {
  switch (auth.type) {
    case "none":
      return { type: "none" };
    case "bearer": {
      const tok = loadEnvToken(auth.token_env, "bearer");
      const out: RemoteHttpAuth = { type: "bearer", token: tok };
      if (auth.header_name) out.header_name = auth.header_name;
      return out;
    }
    case "api_key": {
      const tok = loadEnvToken(auth.token_env, "api_key");
      const out: RemoteHttpAuth = { type: "api_key", token: tok };
      if (auth.header_name) out.header_name = auth.header_name;
      return out;
    }
    case "mtls":
      return { type: "mtls" };
  }
}

function buildTlsRuntimeConfig(
  cfg: BackendConfig
): TlsRuntimeConfig | undefined {
  const tlsCfg = cfg.tls;
  const auth = cfg.auth;
  const needsTlsBlock =
    tlsCfg.verify === false ||
    tlsCfg.ca_bundle_path !== null ||
    tlsCfg.pinning.enabled === true ||
    auth.type === "mtls";
  if (!needsTlsBlock) return undefined;
  const out: TlsRuntimeConfig = {
    verify: tlsCfg.verify,
    ca_bundle_path: tlsCfg.ca_bundle_path,
    pinning: {
      enabled: tlsCfg.pinning.enabled,
      sha256_fingerprint: tlsCfg.pinning.sha256_fingerprint,
    },
  };
  if (auth.type === "mtls") {
    if (!auth.mtls || !auth.mtls.cert_path || !auth.mtls.key_path) {
      throw new Error(
        "PII Remover: backend.auth.type='mtls' requires backend.auth.mtls.cert_path and backend.auth.mtls.key_path (fail-closed per ADR-0006)"
      );
    }
    out.mtls = {
      cert_path: auth.mtls.cert_path,
      key_path: auth.mtls.key_path,
    };
    if (auth.mtls.passphrase_env) {
      out.mtls.passphrase_env = auth.mtls.passphrase_env;
    }
  }
  return out;
}

function isOpfWireEndpoint(endpoint: string): boolean {
  return /(?:^|\/\/)(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(endpoint);
}

function loadEnvToken(
  tokenEnv: string | undefined,
  label: "bearer" | "api_key"
): string {
  if (!tokenEnv) {
    throw new Error(
      `PII Remover: backend.auth.type='${label}' requires backend.auth.token_env (fail-closed per ADR-0005 §7)`
    );
  }
  const tok = process.env[tokenEnv];
  if (typeof tok !== "string" || tok.length === 0) {
    throw new Error(
      `PII Remover: backend.auth.token_env '${tokenEnv}' is not set (fail-closed per ADR-0005 §7)`
    );
  }
  return tok;
}

function buildBearerAuth(
  tokenEnv: string | undefined
): { type: "bearer"; token: string } | { type: "none" } {
  if (!tokenEnv) return { type: "none" };
  const tok = process.env[tokenEnv];
  if (typeof tok !== "string" || tok.length === 0) {
    throw new Error(
      `PII Remover: backend.auth.token_env '${tokenEnv}' is not set (fail-closed per ADR-0005 §7)`
    );
  }
  return { type: "bearer", token: tok };
}

function stripTrailingPath(url: string, suffix: string): string {
  return url.endsWith(suffix) ? url.slice(0, -suffix.length) : url;
}



export { FailClosedError };
