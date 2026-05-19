import {
  PIIRemover,
  AuditEmitter,
  type PiiRemoverConfig,
  type BackendClient,
  type BackendStrategy,
} from "@pii-remover/core";

const DEFAULT_SESSION_ID = "proxy:default";
const SESSION_HEADER = "x-pii-session";

export interface SessionPoolOptions {
  config?: PiiRemoverConfig;
  backends?: readonly BackendClient[];
  strategy?: BackendStrategy;
  audit?: AuditEmitter;
  warn?: (msg: string) => void;
}

export class ProxySessionPool {
  private readonly cache = new Map<string, Promise<PIIRemover>>();

  constructor(private readonly opts: SessionPoolOptions) {}

  async get(headers: Headers): Promise<{ remover: PIIRemover; sessionId: string }> {
    const sessionId = readSessionHeader(headers) ?? DEFAULT_SESSION_ID;
    let pending = this.cache.get(sessionId);
    if (!pending) {
      pending = this.create(sessionId);
      this.cache.set(sessionId, pending);
    }
    const remover = await pending;
    return { remover, sessionId };
  }

  private async create(sessionId: string): Promise<PIIRemover> {
    const initOpts: Parameters<typeof PIIRemover.init>[0] = {
      sessionId,
    };
    if (this.opts.config) initOpts.config = this.opts.config;
    if (this.opts.warn) initOpts.warn = this.opts.warn;
    if (this.opts.strategy) initOpts.strategy = this.opts.strategy;
    else if (this.opts.backends && this.opts.backends.length > 0)
      initOpts.backends = this.opts.backends;
    if (this.opts.audit) initOpts.audit = this.opts.audit;
    return PIIRemover.init(initOpts);
  }

  async disposeAll(): Promise<void> {
    const removers = await Promise.all(this.cache.values());
    for (const r of removers) {
      try {
        r.dispose();
      } catch (_err) {
        void _err;
      }
    }
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
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
