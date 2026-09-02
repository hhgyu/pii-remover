import type { PIIRemover } from "@pii-remover/core";

import { createStreamBuffer, type StreamBuffer } from "./buffer.js";
import {
  createStreamRestoreScope,
  type StreamRestoreScope,
} from "./restore-scope.js";
import {
  SseLineParser,
  serializeSseEvent,
  type SseEvent,
} from "./sse-parser.js";

export interface OpenAISseTransformerOptions {
  bufferWindow?: number;
  flushOnClose?: boolean;
  requestId?: string;
  provider?: string;
}

export class OpenAISseTransformer {
  private readonly parser = new SseLineParser();
  private readonly contentBuffers = new Map<number, StreamBuffer>();
  private readonly toolArgAccumulators = new Map<string, string>();
  private readonly bufferWindow: number;
  private readonly flushOnClose: boolean;
  private readonly scope: StreamRestoreScope;
  private closed = false;

  constructor(remover: PIIRemover, opts: OpenAISseTransformerOptions = {}) {
    this.bufferWindow = opts.bufferWindow ?? 64;
    this.flushOnClose = opts.flushOnClose ?? true;
    this.scope = createStreamRestoreScope(remover, {
      ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    });
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
                  delta: { content: this.scope.text(remaining) },
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
          function: { arguments: this.scope.json(args) },
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
            function?: { arguments?: unknown; [k: string]: unknown };
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
        mutated = true;
        // Only the arguments fragment is withheld. `id`, `type`, `index` and
        // `function.name` arrive once, on the first delta, and are what the
        // client dispatches on — dropping them strands the tool call.
        const heldToolCalls = c.delta!.tool_calls!.map((tc) => {
          const tcIdx = typeof tc.index === "number" ? tc.index : 0;
          const chunk = tc.function?.arguments;
          if (typeof chunk !== "string") return tc;
          const key = `${choiceIdx}:${tcIdx}`;
          this.toolArgAccumulators.set(
            key,
            (this.toolArgAccumulators.get(key) ?? "") + chunk
          );
          return { ...tc, function: { ...tc.function, arguments: "" } };
        });
        return { ...c, delta: { ...c.delta, tool_calls: heldToolCalls } };
      }

      const content = c.delta?.content;
      if (typeof content !== "string") {
        allHeld = false;
        return c;
      }
      const buf = this.getContentBuffer(choiceIdx);
      const safe = buf.push(content);
      if (safe.length === 0) {
        mutated = true;
        return { ...c, delta: { ...c.delta, content: "" } };
      }
      allHeld = false;
      mutated = true;
      const restored = this.scope.text(safe);
      return { ...c, delta: { ...c.delta, content: restored } };
    });

    if (allHeld && obj.choices.length > 0) return "";
    // Every branch above that rewrites a choice must have set `mutated`, or
    // this line re-emits the upstream event and the sanitized copy is dropped —
    // putting the live token back on the wire.
    if (!mutated) return serializeSseEvent(ev);

    return serializeSseEvent({
      event: ev.event,
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

