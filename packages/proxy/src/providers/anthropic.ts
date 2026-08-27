import type { PIIRemover } from "@pii-remover/core";
import {
  OPF_PLACEHOLDER_SYSTEM_NOTE,
  appendPlaceholderNote,
} from "@pii-remover/core";
import type { ThinkingCache } from "../stream/thinking-cache.js";
import {
  replayThinking,
  restoreThinkingBlock,
  THINKING_REPLAY_REJECTION,
} from "./thinking-replay.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequestBody,
  AnthropicResponseBody,
} from "./types.js";

export { isAnthropicThinkingBlock } from "./thinking-replay.js";

export type ImageRedactor = (base64: string) => Promise<string>;

export interface AnthropicTransformOptions {
  imageRedactor?: ImageRedactor;
  provider?: string;
  /** Shared across the mask event and every restore event of one HTTP request
   *  so the audit stream can join them. */
  requestId?: string;
  /** Session store of the masked thinking bytes Anthropic signed, keyed by
   *  signature. Present: thinking is restored for display on the way out and
   *  swapped back to the signed bytes on the way in. Absent: thinking is left
   *  alone end-to-end, which is the only other safe option. */
  thinkingCache?: ThinkingCache;
}

export interface AnthropicTransformResult {
  /** Masked request to forward. Meaningless when `rejection` is set — the
   *  caller answers with the rejection and forwards nothing. */
  body: AnthropicRequestBody;
  rejection?: { status: number; body: { error: string; message: string } };
}

export async function transformAnthropicRequest(
  raw: AnthropicRequestBody,
  remover: PIIRemover,
  opts: AnthropicTransformOptions = {}
): Promise<AnthropicTransformResult> {
  const replay = replayThinking(raw.messages, opts.thinkingCache);
  // Refused here rather than sent on: a turn missing one of its thinking blocks
  // draws an opaque 400 from upstream, and the restored text the client replayed
  // is the user's plaintext PII.
  if (replay.kind === "unresolvable") {
    return { body: raw, rejection: THINKING_REPLAY_REJECTION };
  }
  const messages = await maskMessages(replay.messages, remover, opts);
  const system = await maskSystem(raw.system, remover, opts);
  const out: AnthropicRequestBody = { ...raw, messages };
  out.system = withPlaceholderNote(system);
  return { body: out };
}

function withPlaceholderNote(
  system: AnthropicRequestBody["system"]
): AnthropicRequestBody["system"] {
  if (!Array.isArray(system)) return appendPlaceholderNote(system);
  const alreadyPresent = system.some(
    (block) => block.text === OPF_PLACEHOLDER_SYSTEM_NOTE
  );
  return alreadyPresent
    ? system
    : [...system, { type: "text", text: OPF_PLACEHOLDER_SYSTEM_NOTE }];
}

export async function restoreAnthropicResponse(
  body: AnthropicResponseBody,
  remover: PIIRemover,
  opts: AnthropicTransformOptions = {}
): Promise<AnthropicResponseBody> {
  if (!Array.isArray(body.content)) return body;
  const restoredContent = body.content.map((block) => {
    if (!block || typeof block !== "object") return block;
    if (block.type === "text" && typeof block.text === "string") {
      return { ...block, text: restoreWithProvider(remover, block.text, opts).text };
    }
    if (block.type === "tool_use") {
      const input = (block as { input?: unknown }).input;
      if (input !== undefined && input !== null) {
        return { ...block, input: walkRestore(input, remover, opts) };
      }
    }
    if (block.type === "thinking") {
      return restoreThinkingBlock(
        block,
        opts.thinkingCache,
        (text) => restoreWithProvider(remover, text, opts).text
      );
    }
    return block;
  });
  return { ...body, content: restoredContent };
}

function walkRestore(
  value: unknown,
  remover: PIIRemover,
  opts: AnthropicTransformOptions
): unknown {
  if (typeof value === "string") {
    return restoreWithProvider(remover, value, opts).text;
  }
  if (Array.isArray(value)) return value.map((v) => walkRestore(v, remover, opts));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walkRestore(v, remover, opts);
    }
    return out;
  }
  return value;
}

async function maskMessages(
  msgs: AnthropicMessage[],
  remover: PIIRemover,
  opts: AnthropicTransformOptions
): Promise<AnthropicMessage[]> {
  const out: AnthropicMessage[] = [];
  for (const m of msgs) {
    if (typeof m.content === "string") {
      const masked = await maskWithProvider(remover, m.content, opts);
      out.push({ ...m, content: masked.text });
      continue;
    }
    if (Array.isArray(m.content)) {
      const blocks = await maskContentBlocks(m.content, remover, opts);
      out.push({ ...m, content: blocks });
      continue;
    }
    out.push(m);
  }
  return out;
}

async function maskContentBlocks(
  blocks: AnthropicContentBlock[],
  remover: PIIRemover,
  opts: AnthropicTransformOptions
): Promise<AnthropicContentBlock[]> {
  const out: AnthropicContentBlock[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") {
      out.push(b);
      continue;
    }
    if (b.type === "text" && typeof (b as { text?: unknown }).text === "string") {
      const masked = await maskWithProvider(
        remover,
        (b as { text: string }).text,
        opts
      );
      out.push({ ...b, text: masked.text });
      continue;
    }
    if (b.type === "image" && opts.imageRedactor) {
      const replaced = await maybeRedactAnthropicImage(b, opts.imageRedactor);
      out.push(replaced);
      continue;
    }
    out.push(b);
  }
  return out;
}

async function maybeRedactAnthropicImage(
  block: AnthropicContentBlock,
  redactor: ImageRedactor
): Promise<AnthropicContentBlock> {
  const src = (block as { source?: unknown }).source;
  if (!src || typeof src !== "object") return block;
  const source = src as { type?: unknown; data?: unknown; media_type?: unknown };
  if (source.type !== "base64" || typeof source.data !== "string") return block;
  try {
    const redacted = await redactor(source.data);
    return {
      ...(block as object),
      source: { ...source, data: redacted },
    } as AnthropicContentBlock;
  } catch {
    return block;
  }
}

async function maskSystem(
  system: AnthropicRequestBody["system"],
  remover: PIIRemover,
  opts: AnthropicTransformOptions
): Promise<AnthropicRequestBody["system"]> {
  if (system === undefined) return undefined;
  if (typeof system === "string") {
    const masked = await maskWithProvider(remover, system, opts);
    return masked.text;
  }
  if (Array.isArray(system)) {
    const out: Array<{ type: string; text?: string }> = [];
    for (const s of system) {
      if (s && typeof s === "object" && typeof s.text === "string") {
        const masked = await maskWithProvider(remover, s.text, opts);
        out.push({ ...s, text: masked.text });
      } else {
        out.push(s);
      }
    }
    return out;
  }
  return system;
}

function maskWithProvider(
  remover: PIIRemover,
  text: string,
  opts: AnthropicTransformOptions
): Promise<Awaited<ReturnType<PIIRemover["mask"]>>> {
  return remover.mask(text, {
    request_id: opts.requestId,
    provider: opts.provider,
  });
}

function restoreWithProvider(
  remover: PIIRemover,
  text: string,
  opts: AnthropicTransformOptions
): ReturnType<PIIRemover["restore"]> {
  return remover.restore(text, {
    request_id: opts.requestId,
    provider: opts.provider,
  });
}
