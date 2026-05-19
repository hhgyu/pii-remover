import { DEFAULT_CONFIG, type PiiRemoverConfig } from "@pii-remover/core";

export interface ResolvedProxyConfig {
  port: number;
  host: string;
  upstream: {
    anthropic: string;
    openai: string;
    codex: string;
  };
  streaming_enabled: boolean;
  buffer_window: number;
  flush_on_close: boolean;
}

export const DEFAULT_PROXY_BIND_HOST = "127.0.0.1";
export const DEFAULT_PROXY_PORT = 8765;
export const DEFAULT_ANTHROPIC_UPSTREAM = "https://api.anthropic.com";
export const DEFAULT_OPENAI_UPSTREAM = "https://api.openai.com";
export const DEFAULT_CODEX_UPSTREAM = "https://api.openai.com";

export function resolveProxyConfig(
  base?: PiiRemoverConfig,
  override?: Partial<{
    port: number;
    host: string;
    upstream: { anthropic?: string; openai?: string; codex?: string };
  }>
): ResolvedProxyConfig {
  const cfg = base ?? DEFAULT_CONFIG;
  const proxy = cfg.proxy ?? {
    enabled: false,
    port: DEFAULT_PROXY_PORT,
    upstream: {
      anthropic: DEFAULT_ANTHROPIC_UPSTREAM,
      openai: DEFAULT_OPENAI_UPSTREAM,
      codex: DEFAULT_CODEX_UPSTREAM,
    },
    streaming: { enabled: true, buffer_window: 64, flush_on_close: true },
  };

  const upstreamCfg = proxy.upstream ?? {};
  const streamingCfg = proxy.streaming ?? {
    enabled: true,
    buffer_window: 64,
    flush_on_close: true,
  };

  return {
    port: override?.port ?? proxy.port ?? DEFAULT_PROXY_PORT,
    host: override?.host ?? DEFAULT_PROXY_BIND_HOST,
    upstream: {
      anthropic:
        override?.upstream?.anthropic ??
        upstreamCfg.anthropic ??
        DEFAULT_ANTHROPIC_UPSTREAM,
      openai:
        override?.upstream?.openai ??
        upstreamCfg.openai ??
        DEFAULT_OPENAI_UPSTREAM,
      codex:
        override?.upstream?.codex ??
        upstreamCfg.codex ??
        DEFAULT_CODEX_UPSTREAM,
    },
    streaming_enabled: streamingCfg.enabled,
    buffer_window: streamingCfg.buffer_window,
    flush_on_close: streamingCfg.flush_on_close,
  };
}

export function normalizeUpstreamBase(raw: string): string {
  return raw.replace(/\/+$/, "");
}
