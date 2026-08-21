import {
  MAX_TOKEN_LENGTH,
  TOKEN_DELIMITER,
  TOKEN_PREFIX,
  TOKEN_SUFFIX,
  TOKEN_HASH_LENGTH,
} from "@pii-remover/core";

export interface StreamBufferOptions {
  bufferWindow?: number;
  flushOnClose?: boolean;
}

export interface StreamBuffer {
  push(chunk: string): string;
  flush(): string;
  size(): number;
}

// Must stay >= MAX_TOKEN_LENGTH, else the lookback misses an in-progress
// token's `{{OPF:` start and the tail is released raw. Doubled for headroom.
export const DEFAULT_BUFFER_WINDOW = MAX_TOKEN_LENGTH * 2;

function escapeRegex(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

const PREFIX_REGEX_SOURCE = escapeRegex(TOKEN_PREFIX);
const DELIMITER_REGEX_SOURCE = escapeRegex(TOKEN_DELIMITER);
const SUFFIX_REGEX_SOURCE = escapeRegex(TOKEN_SUFFIX);

// Every proper prefix of the closing suffix, longest first. Alternation is
// order-sensitive: a shorter branch first would match "}" and release the
// second brace raw.
const PARTIAL_SUFFIX_GROUP = Array.from(TOKEN_SUFFIX)
  .map((_, i) => escapeRegex(TOKEN_SUFFIX.slice(0, TOKEN_SUFFIX.length - i)))
  .join("|");

// The bound is inclusive: a buffer ending at exactly the COMPLETE prefix
// ("{{OPF:") must also be held back. The other alternative in
// UNSAFE_TOKEN_TAIL_REGEX needs at least one category character after the
// prefix, so stopping at length-1 left a gap where only the trailing "_" was
// held and "__OPF" was released — splitting the token across two restore calls
// and delivering it to the user raw.
function buildUnsafePrefixGroup(): string {
  const parts: string[] = [];
  for (let i = 1; i <= TOKEN_PREFIX.length; i++) {
    parts.push(escapeRegex(TOKEN_PREFIX.slice(0, i)));
  }
  return parts.join("|");
}

export const COMPLETE_TOKEN_AT_END_REGEX = new RegExp(
  `${PREFIX_REGEX_SOURCE}[A-Z][A-Z0-9_]*${DELIMITER_REGEX_SOURCE}[a-z0-9]{${TOKEN_HASH_LENGTH}}${SUFFIX_REGEX_SOURCE}$`,
  "i"
);

// Incomplete token tail held back until the rest of the stream arrives:
// the prefix may be partial, or category/delimiter/hash may still be in
// progress (hash up to TOKEN_HASH_LENGTH chars, then a partial closing "}}").
export const UNSAFE_TOKEN_TAIL_REGEX = new RegExp(
  `(?:${buildUnsafePrefixGroup()}|${PREFIX_REGEX_SOURCE}[A-Z][A-Z0-9_]*` +
    `(?:${DELIMITER_REGEX_SOURCE}?[a-z0-9]{0,${TOKEN_HASH_LENGTH}}(?:${PARTIAL_SUFFIX_GROUP})?)?)$`,
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
