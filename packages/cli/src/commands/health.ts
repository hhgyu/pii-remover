import { DEFAULT_PROXY_PORT } from "../constants.js";
import { detectProxy } from "../protocol/proxy-detection.js";

export type FetchLike = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

export interface HealthCommandIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  fetchFn?: FetchLike;
  url?: string;
  port?: number;
}

export interface HealthCommandResult {
  exitCode: 0 | 1 | 2;
  body: string;
}

export async function runHealthCommand(
  io: HealthCommandIo
): Promise<HealthCommandResult> {
  const env = io.env ?? process.env;
  const fetchFn = io.fetchFn ?? fetch;

  const proxy = detectProxy(env as Record<string, string | undefined>);
  if (!io.url && !proxy.configured && !io.port) {
    io.stderr(
      [
        `pii-remover health: ANTHROPIC_BASE_URL not set and no --url/--port given.`,
        `Defaulting to http://127.0.0.1:${DEFAULT_PROXY_PORT}/health (set ANTHROPIC_BASE_URL or pass --url to override).`,
        "",
      ].join("\n")
    );
  }

  const url = resolveHealthUrl(io, proxy.inspected_url);
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (err) {
    const msg = `pii-remover health: cannot reach ${url}: ${(err as Error).message}`;
    io.stderr(`${msg}\n`);
    return { exitCode: 2, body: msg };
  }
  const body = await res.text();
  io.stdout(`${body}\n`);
  return { exitCode: res.ok ? 0 : 1, body };
}

function resolveHealthUrl(
  io: HealthCommandIo,
  proxyUrl: string | undefined
): string {
  if (io.url) return appendHealth(io.url);
  if (io.port) return `http://127.0.0.1:${io.port}/health`;
  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      return `${u.protocol}//${u.host}/health`;
    } catch {
      /* fall through */
    }
  }
  return `http://127.0.0.1:${DEFAULT_PROXY_PORT}/health`;
}

function appendHealth(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return `${trimmed}/health`;
}
