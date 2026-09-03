/**
 * Pin the host's token secret into `packages/backend/.env` so a plain
 * `docker compose up` gives the container the same key the host hook holds.
 *
 * Without it the container resolves a key of its own on the container
 * filesystem: it is never the host's key, so every token the proxy mints is
 * unrestorable host-side, and it dies with the container. The auto-start path
 * (`backend.auto_start: true`) injects the same variable directly into the
 * spawned `docker compose`; this script is the manual-compose equivalent.
 *
 * Idempotent — an existing non-empty `PII_REMOVER_TOKEN_KEY` line is left
 * alone, and the secret itself comes from the same env -> `~/.config/
 * pii-remover/key` -> generate chain the runtime uses.
 *
 * Usage: bun scripts/ensure-backend-env.ts
 * Writes: packages/backend/.env (gitignored)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultKeyPath,
  resolveTokenSecret,
  TOKEN_KEY_ENV_NAME,
} from "../packages/core/src/redaction/token-hash.js";

const ENV_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "packages",
  "backend",
  ".env"
);

function readEnvFile(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function existingKeyLine(contents: string): string | null {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const [name, ...rest] = trimmed.split("=");
    if (name?.trim() !== TOKEN_KEY_ENV_NAME) continue;
    const value = rest.join("=").trim();
    if (value.length > 0) return value;
  }
  return null;
}

function appendKeyLine(contents: string, secret: string): string {
  const body = contents.length === 0 || contents.endsWith("\n")
    ? contents
    : `${contents}\n`;
  return `${body}${TOKEN_KEY_ENV_NAME}=${secret}\n`;
}

const contents = readEnvFile(ENV_PATH);
if (existingKeyLine(contents) !== null) {
  console.log(`${TOKEN_KEY_ENV_NAME} already set in ${ENV_PATH} — unchanged.`);
  process.exit(0);
}

const resolution = resolveTokenSecret();
if (resolution.warning) console.warn(resolution.warning);

writeFileSync(ENV_PATH, appendKeyLine(contents, resolution.secret), {
  encoding: "utf8",
  mode: 0o600,
});

const origin =
  resolution.source === "env"
    ? `the ${TOKEN_KEY_ENV_NAME} environment variable`
    : resolution.source === "file"
      ? defaultKeyPath()
      : `a newly generated key at ${defaultKeyPath()}`;

console.log(`${TOKEN_KEY_ENV_NAME} written to ${ENV_PATH} (from ${origin}).`);
console.log(
  "The container and the host hook now derive the same token key. " +
    "Keep this file out of version control."
);
