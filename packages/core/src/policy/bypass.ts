const TRUTHY: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

export interface BypassDetectOptions {
  envName?: string;
  env?: NodeJS.ProcessEnv;
}

let bypassCounter = 0;

export function isBypassActive(opts: BypassDetectOptions = {}): boolean {
  const env = opts.env ?? process.env;
  const name = opts.envName ?? "PII_REMOVER_BYPASS";
  const v = env[name];
  if (typeof v !== "string" || v.length === 0) return false;
  return TRUTHY.has(v.toLowerCase());
}

export function recordBypass(): number {
  return ++bypassCounter;
}

export function getBypassCount(): number {
  return bypassCounter;
}

export function resetBypassCount(): void {
  bypassCounter = 0;
}

export function bypassWarningMessage(
  opts: { envName?: string; remote?: boolean } = {}
): string {
  const env = opts.envName ?? "PII_REMOVER_BYPASS";
  const head = opts.remote
    ? "PII REDACTION BYPASSED (remote backend down) — your PII may be sent to the LLM in plaintext"
    : "PII REDACTION BYPASSED — your PII may be sent to the LLM in plaintext";
  return `[WARN] ${head} (env: ${env})`;
}
