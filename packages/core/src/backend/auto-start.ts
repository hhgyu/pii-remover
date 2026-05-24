import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FailClosedError } from "../policy/failure.js";

/**
 * Backend auto-start: optionally spawn `docker compose up -d` for the
 * detection backend, then poll `/health` until the model is loaded.
 *
 * Opt-in (`backend.auto_start: true`), fail-closed on every failure path:
 * Docker not installed, daemon down, compose file missing, health probe
 * timeout — all raise `FailClosedError` so the caller's `failure_policy`
 * gate decides what to do.
 *
 * The compose file is resolved by walking parent directories from this
 * module's location looking for `packages/backend/docker-compose.yml`
 * (monorepo dev / `bun --filter` runs) or `packages/backend/docker-compose.gpu.yml`
 * (when `compose_file: "gpu"`). Absolute paths bypass the search.
 */
export interface AutoStartOptions {
  endpoint: string;
  enabled: boolean;
  composeFile: "cpu" | "gpu" | string;
  startTimeoutMs: number;
  warn: (msg: string) => void;
  bypassEnv: string;
  fetchImpl?: (
    input: string | URL,
    init?: RequestInit
  ) => Promise<Response>;
  spawnImpl?: typeof spawn;
  composePathResolver?: (selector: string) => string | null;
}

const HEALTH_POLL_INTERVAL_MS = 1000;
const HEALTH_PROBE_TIMEOUT_MS = 1500;

const inFlightAutoStart = new Map<string, Promise<void>>();

/**
 * Reset the in-flight map. Intended **only** for use in tests between
 * test cases so that each case starts with a clean slate.
 */
export function _resetAutoStartDedup(): void {
  inFlightAutoStart.clear();
}

export async function maybeAutoStartBackend(opts: AutoStartOptions): Promise<void> {
  if (!opts.enabled) return;

  const healthUrl = deriveHealthUrl(opts.endpoint);
  const fetchImpl = opts.fetchImpl ?? fetch;

  const existing = inFlightAutoStart.get(healthUrl);
  if (existing) {
    opts.warn(
      `[pii-remover] auto-start already in progress for ${healthUrl}; waiting`
    );
    await existing;
    return;
  }

  const work = (async () => {
    if (await isHealthy(healthUrl, fetchImpl, HEALTH_PROBE_TIMEOUT_MS)) {
      opts.warn(
        `[pii-remover] backend already healthy at ${healthUrl}; auto-start skipped`
      );
      return;
    }

    if (await isContainerUp(healthUrl, fetchImpl, HEALTH_PROBE_TIMEOUT_MS)) {
      opts.warn(
        `[pii-remover] backend container up (model unloaded/idle) at ${healthUrl}; auto-start skipped`
      );
      return;
    }

    const resolver = opts.composePathResolver ?? defaultComposePathResolver;
    const composePath = resolver(opts.composeFile);
    if (composePath === null) {
      throw new FailClosedError(
        `PII Remover: backend.auto_start=true but compose file '${opts.composeFile}' ` +
          `could not be resolved (set backend.compose_file to an absolute path)`,
        { backend: "auto-start", bypass_env: opts.bypassEnv }
      );
    }

    opts.warn(
      `[pii-remover] auto-starting backend via 'docker compose -f ${composePath} up -d'`
    );

    try {
      await runComposeUp(composePath, opts.spawnImpl ?? spawn);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new FailClosedError(
        `PII Remover: backend auto-start failed: ${reason}`,
        { backend: "auto-start", cause: err, bypass_env: opts.bypassEnv }
      );
    }

    const deadline = Date.now() + Math.max(1000, opts.startTimeoutMs);
    while (Date.now() < deadline) {
      if (await isHealthy(healthUrl, fetchImpl, HEALTH_PROBE_TIMEOUT_MS)) {
        opts.warn(`[pii-remover] backend healthy at ${healthUrl}`);
        return;
      }
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }

    throw new FailClosedError(
      `PII Remover: backend did not become healthy at ${healthUrl} within ` +
        `${opts.startTimeoutMs}ms after 'docker compose up -d'`,
      { backend: "auto-start", bypass_env: opts.bypassEnv }
    );
  })();

  inFlightAutoStart.set(healthUrl, work);

  try {
    await work;
  } finally {
    inFlightAutoStart.delete(healthUrl);
  }
}

export function deriveHealthUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  if (trimmed.endsWith("/redact")) {
    return `${trimmed.slice(0, -"/redact".length)}/health`;
  }
  return `${trimmed}/health`;
}

async function isHealthy(
  url: string,
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  timeoutMs: number
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: ctrl.signal });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: unknown; model_loaded?: unknown };
    return Boolean(data?.ok) && data?.model_loaded === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function isContainerUp(
  url: string,
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  timeoutMs: number
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: ctrl.signal });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: unknown };
    return Boolean(data?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function runComposeUp(
  composePath: string,
  spawnImpl: typeof spawn
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const args = ["compose", "-f", composePath, "up", "-d"];
    const spawnOpts: SpawnOptionsWithoutStdio = {
      cwd: dirname(composePath),
      windowsHide: true,
    };
    let child;
    try {
      child = spawnImpl("docker", args, spawnOpts);
    } catch (err) {
      reject(err);
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolvePromise();
      } else {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        reject(
          new Error(
            `'docker compose up -d' exited with code ${code ?? "null"}: ${tail || "<no stderr>"}`
          )
        );
      }
    });
  });
}

export function defaultComposePathResolver(selector: string): string | null {
  if (isAbsolute(selector) && existsSync(selector)) {
    return selector;
  }
  const filename =
    selector === "gpu" ? "docker-compose.gpu.yml" : "docker-compose.yml";
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "packages", "backend", filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
