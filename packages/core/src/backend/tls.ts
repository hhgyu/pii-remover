import { readFileSync } from "node:fs";

/**
 * TLS runtime config for the remote HTTP backend.
 *
 * Shape mirrors `BackendTlsConfig` (config/schema.ts) plus an optional
 * mTLS extension. Reads cert/key/ca files synchronously at backend
 * **init time** (fail-closed per ADR-0006).
 *
 * Runtime support matrix:
 *  - Bun  1.3+ : native via `fetch(url, { tls })` (BunFetchRequestInitTLS).
 *  - Node 18+  : via `dispatcher: new undici.Agent({ connect: { ... } })`.
 *                Standard CA verification and `NODE_EXTRA_CA_CERTS` env var
 *                work without this helper; pinning + mTLS require undici.
 */
export interface TlsRuntimeConfig {
  verify: boolean;
  ca_bundle_path: string | null;
  pinning: { enabled: boolean; sha256_fingerprint: string | null };
  mtls?: {
    cert_path: string;
    key_path: string;
    passphrase_env?: string;
  };
}

/**
 * `RequestInit` extension for Bun (`tls`) and undici (`dispatcher`).
 * `dispatcher` is omitted from the base then widened so consumers do not
 * need a hard dep on `undici-types`; `tls` is added for Bun. Intersection
 * rather than `as any` cast to satisfy the no-any policy.
 */
export type FetchInitExtended = Omit<RequestInit, "dispatcher"> & {
  tls?: Record<string, unknown>;
  dispatcher?: unknown;
};

export interface PeerCertificateLike {
  fingerprint256?: string;
}

export interface UndiciLike {
  Agent: new (opts: { connect?: Record<string, unknown> }) => unknown;
}

export type FileReader = (path: string) => Buffer;

export interface BuildFetchTlsExtensionDeps {
  readFile?: FileReader;
  isBun?: () => boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * Lazy undici loader. Default: dynamic `import('undici')`. Invoked
   * only on the Node path AND only when the config requires features
   * the default fetch cannot satisfy (mTLS / pinning / custom CA /
   * `verify=false`).
   */
  loadUndici?: () => Promise<UndiciLike>;
}

export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Normalize a SHA-256 fingerprint for strict-equality pinning compare.
 * Accepts colon-separated (`AA:BB:...`) or concatenated (`AABB...`)
 * forms, any case, with surrounding whitespace.
 */
export function normalizeFingerprint(s: string): string {
  return s.replace(/:/g, "").replace(/\s/g, "").toLowerCase();
}

export function fingerprintMatches(expected: string, actual: string): boolean {
  const a = normalizeFingerprint(expected);
  const b = normalizeFingerprint(actual);
  if (a.length === 0 || b.length === 0) return false;
  return a === b;
}

/**
 * Build a `checkServerIdentity` callback that enforces SHA-256 pinning.
 *
 * Returns `undefined` when the cert is pinned, an `Error` otherwise.
 * MUST NOT throw — Bun/Node both expect the return-Error convention.
 */
export function buildPinningCheckServerIdentity(
  expectedFingerprint: string
): (host: string, cert: PeerCertificateLike) => Error | undefined {
  return (_hostname, cert) => {
    const actual = cert?.fingerprint256;
    if (typeof actual !== "string" || actual.length === 0) {
      return new Error(
        "TLS pinning: server certificate has no SHA-256 fingerprint"
      );
    }
    if (!fingerprintMatches(expectedFingerprint, actual)) {
      return new Error(
        "TLS pinning: server certificate fingerprint mismatch"
      );
    }
    return undefined;
  };
}

interface ResolvedMtls {
  cert: Buffer;
  key: Buffer;
  passphrase?: string;
}

/**
 * Resolve mTLS material at init time. Throws on missing cert/key
 * (fail-closed). Passphrase is loaded from env and held in-memory only;
 * callers MUST NOT log or serialize the returned `ResolvedMtls`.
 */
function resolveMtls(
  cfg: NonNullable<TlsRuntimeConfig["mtls"]>,
  readFile: FileReader,
  env: NodeJS.ProcessEnv
): ResolvedMtls {
  let cert: Buffer;
  try {
    cert = readFile(cfg.cert_path);
  } catch (e) {
    throw new Error(
      `TLS mTLS: cert file not readable at '${cfg.cert_path}' (fail-closed at init per ADR-0006). ${describeReadError(e)}`
    );
  }
  let key: Buffer;
  try {
    key = readFile(cfg.key_path);
  } catch (e) {
    throw new Error(
      `TLS mTLS: key file not readable at '${cfg.key_path}' (fail-closed at init per ADR-0006). ${describeReadError(e)}`
    );
  }
  const out: ResolvedMtls = { cert, key };
  if (cfg.passphrase_env) {
    const p = env[cfg.passphrase_env];
    if (typeof p === "string" && p.length > 0) {
      out.passphrase = p;
    }
  }
  return out;
}

/**
 * Extract only the syscall `code` (e.g. `ENOENT`) from an unknown error,
 * never the message body — keeps absolute cert/key paths and any
 * embedded credentials out of upstream log surfaces.
 */
function describeReadError(e: unknown): string {
  if (e && typeof e === "object" && "code" in e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return `code=${code}`;
  }
  return "code=unknown";
}

function resolveCa(
  path: string,
  readFile: FileReader
): Buffer {
  try {
    return readFile(path);
  } catch (e) {
    throw new Error(
      `TLS: CA bundle not readable at '${path}' (fail-closed at init per ADR-0006). ${describeReadError(e)}`
    );
  }
}

/**
 * Build a `RequestInit` extension that applies the given TLS config.
 *
 * Returns `null` when `cfg` is `undefined` or has nothing to enforce
 * (default `verify: true`, no pinning, no mTLS, no custom CA) — the
 * caller may then use plain `fetch` without modification.
 *
 * Async because the Node path lazy-loads `undici` (`await import`).
 * Bun path is effectively sync.
 */
export async function buildFetchTlsExtension(
  cfg: TlsRuntimeConfig | undefined,
  deps: BuildFetchTlsExtensionDeps = {}
): Promise<FetchInitExtended | null> {
  if (!cfg) return null;

  const readFile = deps.readFile ?? defaultReadFile;
  const isBun = deps.isBun ?? isBunRuntime;
  const env = deps.env ?? process.env;

  const needsCustomCa = cfg.ca_bundle_path !== null;
  const needsPinning =
    cfg.pinning.enabled && typeof cfg.pinning.sha256_fingerprint === "string";
  const needsMtls = cfg.mtls !== undefined && cfg.mtls !== null;
  const needsInsecure = cfg.verify === false;

  if (!needsCustomCa && !needsPinning && !needsMtls && !needsInsecure) {
    return null;
  }

  const ca = needsCustomCa ? resolveCa(cfg.ca_bundle_path as string, readFile) : null;
  const mtls = needsMtls
    ? resolveMtls(cfg.mtls as NonNullable<TlsRuntimeConfig["mtls"]>, readFile, env)
    : null;
  const pinFn =
    needsPinning && cfg.pinning.sha256_fingerprint
      ? buildPinningCheckServerIdentity(cfg.pinning.sha256_fingerprint)
      : null;

  if (isBun()) {
    const tls: Record<string, unknown> = { rejectUnauthorized: cfg.verify };
    if (ca) tls.ca = ca;
    if (mtls) {
      tls.cert = mtls.cert;
      tls.key = mtls.key;
      if (mtls.passphrase !== undefined) tls.passphrase = mtls.passphrase;
    }
    if (pinFn) tls.checkServerIdentity = pinFn;
    return { tls };
  }

  const loadUndici = deps.loadUndici ?? defaultUndiciLoader;
  let undici: UndiciLike;
  try {
    undici = await loadUndici();
  } catch (e) {
    throw new Error(
      `TLS: undici Agent is required for non-default TLS in Node runtime ` +
        `but 'undici' module is not importable. Install undici, use Bun, ` +
        `or remove pinning/mtls/custom CA from backend config. ` +
        `(cause code: ${describeReadError(e)})`
    );
  }
  const connect: Record<string, unknown> = { rejectUnauthorized: cfg.verify };
  if (ca) connect.ca = ca;
  if (mtls) {
    connect.cert = mtls.cert;
    connect.key = mtls.key;
    if (mtls.passphrase !== undefined) connect.passphrase = mtls.passphrase;
  }
  if (pinFn) connect.checkServerIdentity = pinFn;

  const agent = new undici.Agent({ connect });
  return { dispatcher: agent };
}

function defaultReadFile(path: string): Buffer {
  return readFileSync(path);
}

async function defaultUndiciLoader(): Promise<UndiciLike> {
  const importDynamic = new Function(
    "specifier",
    "return import(specifier)"
  ) as (specifier: string) => Promise<unknown>;
  const mod = (await importDynamic("undici")) as UndiciLike;
  if (typeof mod.Agent !== "function") {
    throw new Error("undici module did not export Agent");
  }
  return mod;
}
