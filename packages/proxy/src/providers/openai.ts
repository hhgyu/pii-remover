import type { PIIRemover } from "@pii-remover/core";
import {
  OPF_PLACEHOLDER_SYSTEM_NOTE,
  appendPlaceholderNote,
} from "@pii-remover/core";
import type { ImageRedactor } from "./anthropic.js";
import type {
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIRequestBody,
  OpenAIResponseBody,
} from "./types.js";

export interface OpenAITransformOptions {
  imageRedactor?: ImageRedactor;
  provider?: string;
  /** Shared across the mask event and every restore event of one HTTP request
   *  so the audit stream can join them. */
  requestId?: string;
}

export interface OpenAITransformResult {
  body: OpenAIRequestBody;
  rejection?: { status: number; body: { error: string; message: string } };
}

export async function transformOpenAIRequest(
  raw: OpenAIRequestBody,
  remover: PIIRemover,
  opts: OpenAITransformOptions = {}
): Promise<OpenAITransformResult> {
  const messages = await maskMessages(raw.messages, remover, opts);
  return { body: { ...raw, messages: withPlaceholderNote(messages) } };
}

/**
 * Append the placeholder note to the last system message, or insert one right
 * after it. Keeping it adjacent to the existing system run means the cacheable
 * prefix only shifts once, when the feature is first enabled.
 */
function withPlaceholderNote(messages: OpenAIMessage[]): OpenAIMessage[] {
  let lastSystem = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "system") lastSystem = i;
  }
  const existing = lastSystem >= 0 ? messages[lastSystem] : undefined;
  if (existing && typeof existing.content === "string") {
    if (existing.content.includes(OPF_PLACEHOLDER_SYSTEM_NOTE)) return messages;
    const next = [...messages];
    next[lastSystem] = {
      ...existing,
      content: appendPlaceholderNote(existing.content),
    };
    return next;
  }
  const note: OpenAIMessage = {
    role: "system",
    content: OPF_PLACEHOLDER_SYSTEM_NOTE,
  };
  const at = lastSystem + 1;
  return [...messages.slice(0, at), note, ...messages.slice(at)];
}

export async function restoreOpenAIResponse(
  body: OpenAIResponseBody,
  remover: PIIRemover,
  opts: OpenAITransformOptions = {}
): Promise<OpenAIResponseBody> {
  if (!Array.isArray(body.choices)) return body;
  const choices = body.choices.map((c) => {
    const msg = c.message;
    if (!msg) return c;
    const restored: OpenAIMessage = { ...msg };
    if (typeof msg.content === "string") {
      restored.content = restoreWithProvider(remover, msg.content, opts).text;
    } else if (Array.isArray(msg.content)) {
      restored.content = restorePartsArray(msg.content, remover, opts);
    }
    if (Array.isArray(msg.tool_calls)) {
      restored.tool_calls = msg.tool_calls.map((tc) => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: restoreToolArguments(tc.function.arguments, remover, opts),
        },
      }));
    }
    return { ...c, message: restored };
  });
  return { ...body, choices };
}

async function maskMessages(
  msgs: OpenAIMessage[] | undefined,
  remover: PIIRemover,
  opts: OpenAITransformOptions
): Promise<OpenAIMessage[]> {
  if (!Array.isArray(msgs)) return [];
  const out: OpenAIMessage[] = [];
  for (const m of msgs) {
    if (typeof m.content === "string") {
      const masked = await maskWithProvider(remover, m.content, opts);
      out.push({ ...m, content: masked.text });
      continue;
    }
    if (Array.isArray(m.content)) {
      const parts = await maskContentParts(m.content, remover, opts);
      out.push({ ...m, content: parts });
      continue;
    }
    out.push(m);
  }
  return out;
}

async function maskContentParts(
  parts: OpenAIContentPart[],
  remover: PIIRemover,
  opts: OpenAITransformOptions
): Promise<OpenAIContentPart[]> {
  const out: OpenAIContentPart[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") {
      out.push(p);
      continue;
    }
    if (p.type === "text" && typeof (p as { text?: unknown }).text === "string") {
      const masked = await maskWithProvider(
        remover,
        (p as { text: string }).text,
        opts
      );
      out.push({ ...p, text: masked.text });
      continue;
    }
    if (p.type === "image_url" && opts.imageRedactor) {
      const replaced = await maybeRedactOpenAIImage(p, opts.imageRedactor);
      out.push(replaced);
      continue;
    }
    out.push(p);
  }
  return out;
}

const DATA_URI_RE = /^data:(image\/[A-Za-z0-9.+\-]+);base64,([\s\S]+)$/;

async function maybeRedactOpenAIImage(
  part: OpenAIContentPart,
  redactor: ImageRedactor
): Promise<OpenAIContentPart> {
  const iu = (part as { image_url?: unknown }).image_url;
  if (!iu || typeof iu !== "object") return part;
  const obj = iu as { url?: unknown };
  if (typeof obj.url !== "string") return part;
  const m = DATA_URI_RE.exec(obj.url);
  if (!m) return part;
  const mime = m[1];
  const b64 = m[2];
  try {
    const redacted = await redactor(b64!);
    return {
      ...(part as object),
      image_url: { ...obj, url: `data:${mime};base64,${redacted}` },
    } as OpenAIContentPart;
  } catch {
    return part;
  }
}

function restorePartsArray(
  parts: OpenAIContentPart[],
  remover: PIIRemover,
  opts: OpenAITransformOptions
): OpenAIContentPart[] {
  return parts.map((p) => {
    if (
      p &&
      typeof p === "object" &&
      p.type === "text" &&
      typeof (p as { text?: unknown }).text === "string"
    ) {
      const restored = restoreWithProvider(
        remover,
        (p as { text: string }).text,
        opts
      ).text;
      return { ...p, text: restored };
    }
    return p;
  });
}

function restoreToolArguments(
  raw: string,
  remover: PIIRemover,
  opts: OpenAITransformOptions
): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return restoreWithProvider(remover, raw, opts).text;
  }
  const walked = walkRestore(parsed, remover, opts);
  return JSON.stringify(walked);
}

function walkRestore(
  value: unknown,
  remover: PIIRemover,
  opts: OpenAITransformOptions
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

function maskWithProvider(
  remover: PIIRemover,
  text: string,
  opts: OpenAITransformOptions
): Promise<Awaited<ReturnType<PIIRemover["mask"]>>> {
  return remover.mask(text, {
    request_id: opts.requestId,
    provider: opts.provider,
  });
}

function restoreWithProvider(
  remover: PIIRemover,
  text: string,
  opts: OpenAITransformOptions
): ReturnType<PIIRemover["restore"]> {
  return remover.restore(text, {
    request_id: opts.requestId,
    provider: opts.provider,
  });
}
