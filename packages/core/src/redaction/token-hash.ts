import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HKDF_SALT = "pii-remover-token-hash-v2";
const HKDF_INFO = "deterministic-token-index";
const DERIVED_KEY_LENGTH = 32;

export const TOKEN_HASH_LENGTH = 16;

export function deriveTokenKey(secret: string): Buffer {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("deriveTokenKey: secret must be a non-empty string");
  }
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from(HKDF_SALT, "utf8"),
      Buffer.from(HKDF_INFO, "utf8"),
      DERIVED_KEY_LENGTH,
    ),
  );
}

/**
 * Deterministic token hash: HMAC-SHA256 over "<CATEGORY>\0<canonical_text>",
 * encoded as lowercase base36 and fixed to TOKEN_HASH_LENGTH chars.
 * Same (category, canonicalText, key) always yields the same hash.
 */
export function tokenHash(
  key: Buffer,
  category: string,
  canonicalText: string,
): string {
  const digest = createHmac("sha256", key)
    .update(`${category}\u0000${canonicalText}`, "utf8")
    .digest();
  let n = 0n;
  for (const byte of digest) n = (n << 8n) | BigInt(byte);
  let out = n.toString(36);
  if (out.length >= TOKEN_HASH_LENGTH) {
    return out.slice(0, TOKEN_HASH_LENGTH);
  }
  return out.padStart(TOKEN_HASH_LENGTH, "0");
}

export interface TokenKeyResolution {
  key: Buffer;
  source: "env" | "file" | "generated" | "ephemeral";
  warning?: string;
}

export interface ResolveTokenKeyOptions {
  env?: NodeJS.ProcessEnv;
  envName?: string;
  keyPath?: string;
}

const DEFAULT_ENV_NAME = "PII_REMOVER_TOKEN_KEY";

export function defaultKeyPath(): string {
  return join(homedir(), ".config", "pii-remover", "key");
}

/**
 * Resolve the token-hash key, in priority order:
 *   1. env var (envName)
 *   2. key file (keyPath, default ~/.config/pii-remover/key)
 *   3. generate + persist a new key file
 *   4. ephemeral random key (when persistence fails) — process-local, safe but
 *      loses cross-process determinism.
 */
export function resolveTokenKey(
  opts: ResolveTokenKeyOptions = {},
): TokenKeyResolution {
  const env = opts.env ?? process.env;
  const envName = opts.envName ?? DEFAULT_ENV_NAME;
  const keyPath = opts.keyPath ?? defaultKeyPath();

  const envValue = env[envName];
  if (typeof envValue === "string" && envValue.length > 0) {
    return { key: deriveTokenKey(envValue), source: "env" };
  }

  try {
    if (existsSync(keyPath)) {
      const raw = readFileSync(keyPath, "utf8").trim();
      if (raw.length > 0) {
        return { key: deriveTokenKey(raw), source: "file" };
      }
    }
  } catch {
    // fall through to generation
  }

  const generated = randomBytes(32).toString("hex");
  try {
    mkdirSync(join(keyPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, generated, { encoding: "utf8", mode: 0o600 });
    return { key: deriveTokenKey(generated), source: "generated" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      key: deriveTokenKey(generated),
      source: "ephemeral",
      warning:
        `[pii-remover] could not persist token key to ${keyPath} (${reason}); ` +
        "using a process-local ephemeral key — tokens are NOT consistent across restarts. " +
        `Set ${envName} or fix the key path for deterministic tokens.`,
    };
  }
}
