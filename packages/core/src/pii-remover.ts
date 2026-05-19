import { randomUUID } from "node:crypto";
import type { DetectionResult, DetectOpts, TrustTier } from "./types.js";
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
import { synthesize } from "./synthetic/index.js";
import { restoreSynthetic } from "./synthetic/restore.js";
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
import {
  Restorer,
  type RestoreOptions,
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
  backends?: readonly BackendClient[];
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  audit?: AuditEmitter;
}

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
  }

  static async init(
    opts: PIIRemoverInitOptions = {}
  ): Promise<PIIRemover> {
    const config =
      opts.config ?? (await loadConfig({ env: opts.env, configPath: opts.configPath }));
    const env = opts.env ?? process.env;
    const sessionId = opts.sessionId ?? `session_${randomUUID()}`;
    const warn = opts.warn ?? ((msg: string) => process.stderr.write(`${msg}\n`));

    const vaultOpts: ConstructorParameters<typeof VaultManager>[0] = {
      onWarn: warn,
    };
    if (config.restoration.mode === "synthetic") {
      vaultOpts.syntheticGenerator = synthesize;
    }
    const vault = new VaultManager(vaultOpts);
    const built = opts.strategy
      ? { strategy: opts.strategy, name: "custom" }
      : buildDefaultStrategy(config, opts.backends);
    const detector = new Detector({
      strategy: built.strategy,
      defaultCategories: config.detection.enabled_categories,
    });
    const restorer = new Restorer(vault, { warn });
    const fallbackBackend = new LocalRegexBackend({
      enabledCategories: config.detection.enabled_categories,
    });
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
      recordBypass();
      this.warn(bypassWarningMessage({ envName: this.config.bypass_env }));
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

    const tokens = this.vault.assign(this.sessionId, detection.detections);
    const masked = applyTokens(text, tokens, this.config.restoration.mode);
    const latencyMs = performance.now() - t0;
    this.audit.maskEvent({
      vault_id: vault.vault_id,
      session_id: this.sessionId,
      request_id: requestId,
      categories: aggregateAuditCategories(tokens),
      backend_name: detection.backend_name,
      latency_ms: latencyMs,
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
    this.audit.restoreEvent({
      vault_id: vault.vault_id,
      session_id: this.sessionId,
      request_id: requestId,
      restored_count: result.restoredCount,
      unknown_token_count: result.unknownTokenCount,
      partial_match_count: result.partialMatchCount,
      provider,
    });
    return result;
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

export function applyTokens(
  text: string,
  tokens: readonly AssignedToken[],
  mode: "token" | "synthetic" = "token",
): string {
  if (tokens.length === 0) return text;
  const sorted = [...tokens].sort((a, b) => b.start - a.start);
  let out = text;
  for (const t of sorted) {
    const replacement =
      mode === "synthetic" && t.syntheticValue !== undefined
        ? t.syntheticValue
        : t.token;
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
  extraBackends?: readonly BackendClient[]
): BuiltStrategy {
  if (config.backend.type === "tiered") {
    return buildTieredStrategy(config, extraBackends);
  }
  const backends: BackendClient[] = [];
  backends.push(
    new LocalRegexBackend({
      enabledCategories: config.detection.enabled_categories,
    })
  );
  const personalBackend = buildPersonalDataBackend(config);
  if (personalBackend) backends.push(personalBackend);
  if (config.backend.endpoint) {
    backends.push(buildRemoteBackend(config.backend));
  }
  if (extraBackends && extraBackends.length > 0) {
    backends.push(...extraBackends);
  }
  const name = backends.map((b) => b.name).join("+");
  const strategy: BackendStrategy =
    backends.length === 1
      ? new SingleStrategy(backends[0]!)
      : new MergeStrategy(backends);
  return { strategy, name };
}

function buildPersonalDataBackend(
  config: PiiRemoverConfig,
): PersonalDataBackend | null {
  const pd = config.personal_data;
  if (!pd || pd.enabled === false) return null;
  if (!pd.entries || pd.entries.length === 0) return null;
  return new PersonalDataBackend(pd.entries);
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
  const local = new LocalRegexBackend({
    enabledCategories: config.detection.enabled_categories,
  });
  const remote = buildRemoteBackend(config.backend);
  const personalBackend = buildPersonalDataBackend(config);
  const localStrategy: BackendClient = personalBackend
    ? new MergedBackend([local, personalBackend])
    : local;
  const strategy = new TieredStrategy({ local: localStrategy, remote });
  const localName = personalBackend
    ? `${local.name}+${personalBackend.name}`
    : local.name;
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
