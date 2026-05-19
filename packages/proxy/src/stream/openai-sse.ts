import type { PIIRemover } from "@pii-remover/core";

import { createStreamBuffer, type StreamBuffer } from "./buffer.js";
import {
  SseLineParser,
  serializeSseEvent,
  type SseEvent,
} from "./sse-parser.js";

export interface OpenAISseTransformerOptions {
  bufferWindow?: number;
  flushOnClose?: boolean;
}

export class OpenAISseTransformer {
  private readonly parser = new SseLineParser();
  private readonly contentBuffers = new Map<number, StreamBuffer>();
  private readonly toolArgAccumulators = new Map<string, string>();
  private readonly bufferWindow: number;
  private readonly flushOnClose: boolean;
  private closed = false;

  constructor(
    private readonly remover: PIIRemover,
    opts: OpenAISseTransformerOptions = {}
  ) {
    this.bufferWindow = opts.bufferWindow ?? 64;
    this.flushOnClose = opts.flushOnClose ?? true;
  }

  push(chunk: string): string {
    if (this.closed) return "";
    const events = this.parser.push(chunk);
    let out = "";
    for (const ev of events) out += this.handleEvent(ev);
    return out;
  }

  flush(): string {
    if (this.closed) return "";
    this.closed = true;
    let out = "";
    const trailing = this.parser.flush();
    for (const ev of trailing) out += this.handleEvent(ev);
    if (this.flushOnClose) {
      for (const [choiceIdx, buf] of this.contentBuffers.entries()) {
        const remaining = buf.flush();
        if (remaining.length > 0) {
          out += serializeSseEvent({
            data: JSON.stringify({
              choices: [
                {
                  index: choiceIdx,
                  delta: { content: this.remover.restore(remaining).text },
                },
              ],
            }),
            raw: "",
          });
        }
      }
      const pendingByChoice = new Map<number, Array<{ index: number; args: string }>>();
      for (const [key, accum] of this.toolArgAccumulators.entries()) {
        const [choiceStr, tcStr] = key.split(":");
        const choiceIdx = Number(choiceStr);
        const tcIdx = Number(tcStr);
        if (!pendingByChoice.has(choiceIdx)) pendingByChoice.set(choiceIdx, []);
        pendingByChoice.get(choiceIdx)!.push({ index: tcIdx, args: accum });
      }
      for (const [choiceIdx, tcs] of pendingByChoice.entries()) {
        const toolCalls = tcs.map(({ index, args }) => ({
          index,
          function: { arguments: restoreJsonArguments(args, this.remover) },
        }));
        out += serializeSseEvent({
          data: JSON.stringify({
            choices: [{ index: choiceIdx, delta: { tool_calls: toolCalls } }],
          }),
          raw: "",
        });
      }
    }
    this.contentBuffers.clear();
    this.toolArgAccumulators.clear();
    return out;
  }

  private handleEvent(ev: SseEvent): string {
    if (ev.data === "[DONE]") {
      return serializeSseEvent(ev);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return serializeSseEvent(ev);
    }
    const obj = payload as {
      choices?: Array<{
        index?: number;
        delta?: {
          content?: unknown;
          tool_calls?: Array<{
            index?: number;
            function?: { arguments?: unknown };
            [k: string]: unknown;
          }>;
        };
        [k: string]: unknown;
      }>;
    };
    if (!Array.isArray(obj.choices)) return serializeSseEvent(ev);

    let mutated = false;
    let allHeld = true;
    const nextChoices = obj.choices.map((c) => {
      const choiceIdx = typeof c.index === "number" ? c.index : 0;

      if (Array.isArray(c.delta?.tool_calls)) {
        allHeld = false;
        for (const tc of c.delta!.tool_calls!) {
          const tcIdx = typeof tc.index === "number" ? tc.index : 0;
          const chunk = tc.function?.arguments;
          if (typeof chunk === "string") {
            const key = `${choiceIdx}:${tcIdx}`;
            this.toolArgAccumulators.set(
              key,
              (this.toolArgAccumulators.get(key) ?? "") + chunk
            );
          }
        }
        return { ...c, delta: { ...c.delta, tool_calls: [] } };
      }

      const content = c.delta?.content;
      if (typeof content !== "string") {
        allHeld = false;
        return c;
      }
      const buf = this.getContentBuffer(choiceIdx);
      const safe = buf.push(content);
      if (safe.length === 0) {
        return { ...c, delta: { ...c.delta, content: "" } };
      }
      allHeld = false;
      mutated = true;
      const restored = this.remover.restore(safe).text;
      return { ...c, delta: { ...c.delta, content: restored } };
    });

    if (allHeld && obj.choices.length > 0) return "";
    if (!mutated) return serializeSseEvent(ev);

    return serializeSseEvent({
      data: JSON.stringify({ ...obj, choices: nextChoices }),
      raw: "",
    });
  }

  private getContentBuffer(index: number): StreamBuffer {
    let buf = this.contentBuffers.get(index);
    if (!buf) {
      buf = createStreamBuffer({ bufferWindow: this.bufferWindow });
      this.contentBuffers.set(index, buf);
    }
    return buf;
  }
}

function restoreJsonArguments(raw: string, remover: PIIRemover): string {
  if (raw.length === 0) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return remover.restore(raw).text;
  }
  return JSON.stringify(walkRestore(parsed, remover));
}

function walkRestore(value: unknown, remover: PIIRemover): unknown {
  if (typeof value === "string") return remover.restore(value).text;
  if (Array.isArray(value)) return value.map((v) => walkRestore(v, remover));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walkRestore(v, remover);
    }
    return out;
  }
  return value;
}
