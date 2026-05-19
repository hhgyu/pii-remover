import type { PIIRemover } from "@pii-remover/core";

import type {
  CodexInputContentPart,
  CodexInputItem,
  CodexOutputContentPart,
  CodexOutputItem,
  CodexResponsesRequestBody,
  CodexResponsesResponseBody,
} from "./types.js";

export interface CodexTransformResult {
  body: CodexResponsesRequestBody;
  rejection?: { status: number; body: { error: string; message: string } };
}

export interface CodexTransformOptions {
  provider?: string;
}

const MASKABLE_INPUT_TEXT_TYPES = new Set([
  "input_text",
  "text",
]);

const RESTORABLE_OUTPUT_TEXT_TYPES = new Set([
  "output_text",
  "text",
]);

export async function transformCodexResponsesRequest(
  raw: CodexResponsesRequestBody,
  remover: PIIRemover,
  opts: CodexTransformOptions = {}
): Promise<CodexTransformResult> {
  const out: CodexResponsesRequestBody = { ...raw };
  if (typeof raw.instructions === "string") {
    out.instructions = (await maskWithProvider(remover, raw.instructions, opts.provider)).text;
  }
  if (typeof raw.input === "string") {
    out.input = (await maskWithProvider(remover, raw.input, opts.provider)).text;
  } else if (Array.isArray(raw.input)) {
    out.input = await maskInputItems(raw.input, remover, opts);
  }
  return { body: out };
}

export async function restoreCodexResponsesResponse(
  body: CodexResponsesResponseBody,
  remover: PIIRemover,
  opts: CodexTransformOptions = {}
): Promise<CodexResponsesResponseBody> {
  const out: CodexResponsesResponseBody = { ...body };
  if (Array.isArray(body.output)) {
    out.output = body.output.map((item) => restoreOutputItem(item, remover, opts));
  }
  if (typeof body.output_text === "string") {
    out.output_text = restoreWithProvider(remover, body.output_text, opts.provider).text;
  }
  return out;
}

async function maskInputItems(
  items: CodexInputItem[],
  remover: PIIRemover,
  opts: CodexTransformOptions
): Promise<CodexInputItem[]> {
  const result: CodexInputItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      result.push(item);
      continue;
    }
    if (Array.isArray(item.content)) {
      const content = await maskInputContent(item.content, remover, opts);
      result.push({ ...item, content });
      continue;
    }
    if (typeof item.arguments === "string") {
      const masked = maskToolArguments(item.arguments, remover);
      result.push({ ...item, arguments: masked });
      continue;
    }
    result.push(item);
  }
  return result;
}

async function maskInputContent(
  parts: CodexInputContentPart[],
  remover: PIIRemover,
  opts: CodexTransformOptions
): Promise<CodexInputContentPart[]> {
  const out: CodexInputContentPart[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      out.push(part);
      continue;
    }
    if (
      typeof part.text === "string" &&
      MASKABLE_INPUT_TEXT_TYPES.has(part.type)
    ) {
      const masked = await maskWithProvider(remover, part.text, opts.provider);
      out.push({ ...part, text: masked.text });
      continue;
    }
    out.push(part);
  }
  return out;
}

function restoreOutputItem(
  item: CodexOutputItem,
  remover: PIIRemover,
  opts: CodexTransformOptions
): CodexOutputItem {
  if (!item || typeof item !== "object") return item;
  let next: CodexOutputItem = item;
  if (Array.isArray(item.content)) {
    const content = item.content.map((p) => restoreOutputContent(p, remover, opts));
    next = { ...next, content };
  }
  if (typeof item.arguments === "string") {
    next = {
      ...next,
      arguments: restoreToolArguments(item.arguments, remover, opts),
    };
  }
  return next;
}

function restoreOutputContent(
  part: CodexOutputContentPart,
  remover: PIIRemover,
  opts: CodexTransformOptions
): CodexOutputContentPart {
  if (!part || typeof part !== "object") return part;
  if (
    typeof part.text === "string" &&
    RESTORABLE_OUTPUT_TEXT_TYPES.has(part.type)
  ) {
    return { ...part, text: restoreWithProvider(remover, part.text, opts.provider).text };
  }
  return part;
}

function maskToolArguments(raw: string, remover: PIIRemover): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const walked = walkAsyncSyncMask(parsed, remover);
  return JSON.stringify(walked);
}

function restoreToolArguments(
  raw: string,
  remover: PIIRemover,
  opts: CodexTransformOptions
): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return restoreWithProvider(remover, raw, opts.provider).text;
  }
  const walked = walkRestore(parsed, remover, opts);
  return JSON.stringify(walked);
}

function walkAsyncSyncMask(value: unknown, _remover: PIIRemover): unknown {
  return value;
}

function walkRestore(
  value: unknown,
  remover: PIIRemover,
  opts: CodexTransformOptions
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
