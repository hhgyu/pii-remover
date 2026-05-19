import type { PIIRemover } from "@pii-remover/core";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequestBody,
  AnthropicResponseBody,
} from "./types.js";

export type ImageRedactor = (base64: string) => Promise<string>;

export interface AnthropicTransformOptions {
  imageRedactor?: ImageRedactor;
  provider?: string;
}

export interface AnthropicTransformResult {
  body: AnthropicRequestBody;
  rejection?: { status: number; body: { error: string; message: string } };
}

export async function transformAnthropicRequest(
  raw: AnthropicRequestBody,
  remover: PIIRemover,
  opts: AnthropicTransformOptions = {}
): Promise<AnthropicTransformResult> {
  const messages = await maskMessages(raw.messages, remover, opts);
  const system = await maskSystem(raw.system, remover, opts);
  const out: AnthropicRequestBody = { ...raw, messages };
  if (system !== undefined) out.system = system;
  return { body: out };
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
      return { ...block, text: restoreWithProvider(remover, block.text, opts.provider).text };
    }
    if (block.type === "tool_use") {
      const input = (block as { input?: unknown }).input;
      if (input !== undefined && input !== null) {
        return { ...block, input: walkRestore(input, remover, opts) };
      }
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
    return restoreWithProvider(remover, value, opts.provider).text;
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
  msgs: AnthropicMessage[] | undefined,
  remover: PIIRemover,
  opts: AnthropicTransformOptions
): Promise<AnthropicMessage[]> {
  if (!Array.isArray(msgs)) return [];
  const out: AnthropicMessage[] = [];
  for (const m of msgs) {
    if (typeof m.content === "string") {
      const masked = await maskWithProvider(remover, m.content, opts.provider);
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
        opts.provider
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
    const masked = await maskWithProvider(remover, system, opts.provider);
    return masked.text;
  }
  if (Array.isArray(system)) {
    const out: Array<{ type: string; text?: string }> = [];
    for (const s of system) {
      if (s && typeof s === "object" && typeof s.text === "string") {
        const masked = await maskWithProvider(remover, s.text, opts.provider);
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
  provider: string | undefined
): Promise<Awaited<ReturnType<PIIRemover["mask"]>>> {
  const opts: { request_id?: string } & { provider?: string } = { provider };
  return remover.mask(text, opts);
}

function restoreWithProvider(
  remover: PIIRemover,
  text: string,
  provider: string | undefined
): ReturnType<PIIRemover["restore"]> {
  const opts: Parameters<PIIRemover["restore"]>[1] & { provider?: string } = {
    provider,
  };
  return remover.restore(text, opts);
}
