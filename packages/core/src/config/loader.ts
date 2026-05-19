import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type PiiRemoverConfig } from "./schema.js";

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function substituteEnv(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env
): unknown {
  if (typeof input === "string") {
    return input.replace(ENV_REF, (_full, name: string, def?: string) => {
      const v = env[name];
      if (typeof v === "string" && v.length > 0) return v;
      return def ?? "";
    });
  }
  if (Array.isArray(input)) {
    return input.map((x) => substituteEnv(x, env));
  }
  if (input !== null && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = substituteEnv(v, env);
    }
    return out;
  }
  return input;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function deepMerge<T>(base: T, overrides: unknown): T {
  if (overrides === undefined || overrides === null) return base;
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return overrides as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    const cur = out[k];
    if (isPlainObject(cur) && isPlainObject(v)) {
      out[k] = deepMerge(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export async function loadConfig(
  opts: LoadConfigOptions = {}
): Promise<PiiRemoverConfig> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const candidates: string[] = [];
  if (opts.configPath) candidates.push(opts.configPath);
  candidates.push(join(cwd, ".opencode", "pii-remover.json"));
  candidates.push(join(cwd, ".codex", "pii-remover.json"));
  candidates.push(join(cwd, ".pii-remover.json"));
  candidates.push(
    join(homedir(), ".config", "opencode", "pii-remover.json")
  );
  candidates.push(join(homedir(), ".codex", "pii-remover.json"));
  candidates.push(join(homedir(), ".config", "pii-remover", "config.json"));

  let overrides: unknown = undefined;
  for (const p of candidates) {
    if (existsSync(p)) {
      const raw = await readFile(p, "utf8");
      overrides = JSON.parse(raw);
      break;
    }
  }
  const substituted = substituteEnv(overrides, env);
  return deepMerge(DEFAULT_CONFIG, substituted);
}
