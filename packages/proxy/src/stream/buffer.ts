import { TOKEN_PREFIX, TOKEN_HASH_LENGTH } from "@pii-remover/core";

export interface StreamBufferOptions {
  bufferWindow?: number;
  flushOnClose?: boolean;
}

export interface StreamBuffer {
  push(chunk: string): string;
  flush(): string;
  size(): number;
}

const DEFAULT_BUFFER_WINDOW = 64;

const PREFIX_REGEX_SOURCE = Array.from(TOKEN_PREFIX)
  .map((c) => c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
  .join("");

function buildUnsafePrefixGroup(): string {
  const parts: string[] = [];
  for (let i = 1; i < TOKEN_PREFIX.length; i++) {
    const slice = TOKEN_PREFIX.slice(0, i)
      .split("")
      .map((c) => c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
      .join("");
    parts.push(slice);
  }
  return parts.join("|");
}

export const COMPLETE_TOKEN_AT_END_REGEX = new RegExp(
  `${PREFIX_REGEX_SOURCE}[A-Z][A-Z0-9_]*?__[a-z0-9]{${TOKEN_HASH_LENGTH}}__$`,
  "i"
);

// Incomplete token tail held back until the rest of the stream arrives:
// the prefix may be partial, or category/delimiter/hash may still be in
// progress (hash up to TOKEN_HASH_LENGTH chars, then trailing "__").
export const UNSAFE_TOKEN_TAIL_REGEX = new RegExp(
  `(?:${buildUnsafePrefixGroup()}|${PREFIX_REGEX_SOURCE}[A-Z][A-Z0-9_]*?(?:_?_?[a-z0-9]{0,${TOKEN_HASH_LENGTH}}_?_?)?)$`,
  "i"
);

export function findUnsafeBoundary(buffer: string, windowSize = DEFAULT_BUFFER_WINDOW): number {
  if (buffer.length === 0) return 0;
  const tailStart = Math.max(0, buffer.length - windowSize);
  const tail = buffer.slice(tailStart);

  if (COMPLETE_TOKEN_AT_END_REGEX.test(tail)) return buffer.length;

  const match = UNSAFE_TOKEN_TAIL_REGEX.exec(tail);
  if (!match) return buffer.length;
  return tailStart + match.index;
}

class StreamBufferImpl implements StreamBuffer {
  private buf = "";
  private readonly windowSize: number;

  constructor(opts: StreamBufferOptions = {}) {
    this.windowSize = opts.bufferWindow ?? DEFAULT_BUFFER_WINDOW;
  }

  push(chunk: string): string {
    if (chunk.length === 0) return "";
    this.buf += chunk;
    const unsafeStart = findUnsafeBoundary(this.buf, this.windowSize);
    if (unsafeStart === 0) return "";
    const safe = this.buf.slice(0, unsafeStart);
    this.buf = this.buf.slice(unsafeStart);
    return safe;
  }

  flush(): string {
    const remaining = this.buf;
    this.buf = "";
    return remaining;
  }

  size(): number {
    return this.buf.length;
  }
}

export function createStreamBuffer(opts: StreamBufferOptions = {}): StreamBuffer {
  return new StreamBufferImpl(opts);
}
