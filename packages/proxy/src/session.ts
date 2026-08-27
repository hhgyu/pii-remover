import {
  PIIRemover,
  AuditEmitter,
  type PiiRemoverConfig,
  type BackendClient,
  type BackendStrategy,
} from "@pii-remover/core";

import { createThinkingCache, type ThinkingCache } from "./stream/thinking-cache.js";

const DEFAULT_SESSION_ID = "proxy:default";
const SESSION_HEADER = "x-pii-session";

export interface SessionPoolOptions {
  config?: PiiRemoverConfig;
  backends?: readonly BackendClient[];
  strategy?: BackendStrategy;
  audit?: AuditEmitter;
  warn?: (msg: string) => void;
}

/**
 * Per-session state. The thinking cache is scoped exactly like the vault: a
 * signature minted for one session's masked bytes must never resolve against
 * another session's, or a replay would hand the wrong conversation's thinking
 * to upstream.
 */
export interface ProxySession {
  remover: PIIRemover;
  thinkingCache: ThinkingCache;
}

export class ProxySessionPool {
  private readonly sessions = new Map<string, Promise<ProxySession>>();

  constructor(private readonly opts: SessionPoolOptions) {}

  async get(headers: Headers): Promise<ProxySession & { sessionId: string }> {
    const sessionId = readSessionHeader(headers) ?? DEFAULT_SESSION_ID;
    let pending = this.sessions.get(sessionId);
    if (!pending) {
      pending = this.create(sessionId);
      this.sessions.set(sessionId, pending);
    }
    const session = await pending;
    return { ...session, sessionId };
  }

  private async create(sessionId: string): Promise<ProxySession> {
    const initOpts: Parameters<typeof PIIRemover.init>[0] = {
      sessionId,
    };
    if (this.opts.config) initOpts.config = this.opts.config;
    if (this.opts.warn) initOpts.warn = this.opts.warn;
    if (this.opts.strategy) initOpts.strategy = this.opts.strategy;
    else if (this.opts.backends && this.opts.backends.length > 0)
      initOpts.backends = this.opts.backends;
    if (this.opts.audit) initOpts.audit = this.opts.audit;
    const remover = await PIIRemover.init(initOpts);
    return { remover, thinkingCache: createThinkingCache() };
  }

  async disposeAll(): Promise<void> {
    const sessions = await Promise.all(this.sessions.values());
    for (const session of sessions) {
      session.thinkingCache.clear();
      try {
        session.remover.dispose();
      } catch (_err) {
        void _err;
      }
    }
    this.sessions.clear();
  }

  size(): number {
    return this.sessions.size;
  }
}

function readSessionHeader(headers: Headers): string | null {
  const value = headers.get(SESSION_HEADER);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 128) return null;
  return `proxy:${trimmed}`;
}

export { DEFAULT_SESSION_ID, SESSION_HEADER };
