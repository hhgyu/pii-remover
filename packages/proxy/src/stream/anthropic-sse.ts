import type { PIIRemover } from "@pii-remover/core";

import { ThinkingStreamAccumulator } from "./anthropic-thinking.js";
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
import type { ThinkingCache } from "./thinking-cache.js";

export interface AnthropicSseTransformerOptions {
  bufferWindow?: number;
  flushOnClose?: boolean;
  requestId?: string;
  provider?: string;
  /** Session store that remembers the signed upstream thinking bytes so the
   *  next request can replay them verbatim. Omit to leave thinking untouched. */
  thinkingCache?: ThinkingCache;
}

export class AnthropicSseTransformer {
  private readonly parser = new SseLineParser();
  private readonly buffers = new Map<number, StreamBuffer>();
  private readonly toolInputAccumulators = new Map<number, string>();
  private readonly thinking: ThinkingStreamAccumulator;
  private readonly bufferWindow: number;
  private readonly flushOnClose: boolean;
  private readonly scope: StreamRestoreScope;
  private closed = false;

  constructor(remover: PIIRemover, opts: AnthropicSseTransformerOptions = {}) {
    this.bufferWindow = opts.bufferWindow ?? 64;
    this.flushOnClose = opts.flushOnClose ?? true;
    this.scope = createStreamRestoreScope(remover, {
      ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    });
    this.thinking = new ThinkingStreamAccumulator({
      scope: this.scope,
      bufferWindow: this.bufferWindow,
      ...(opts.thinkingCache !== undefined ? { cache: opts.thinkingCache } : {}),
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
      for (const [idx, accum] of this.toolInputAccumulators.entries()) {
        if (accum.length > 0) {
          const restored = this.scope.json(accum);
          out += serializeSseEvent({
            event: "content_block_delta",
            data: JSON.stringify({
              type: "content_block_delta",
              index: idx,
              delta: { type: "input_json_delta", partial_json: restored },
            }),
            raw: "",
          });
        }
      }
      for (const [idx, buf] of this.buffers.entries()) {
        const remaining = buf.flush();
        if (remaining.length > 0) {
          out += serializeSseEvent({
            event: "content_block_delta",
            data: JSON.stringify({
              type: "content_block_delta",
              index: idx,
              delta: {
                type: "text_delta",
                text: this.scope.text(remaining),
              },
            }),
            raw: "",
          });
        }
      }
      for (const tail of this.thinking.drain()) {
        out += thinkingDeltaEvent(tail.index, tail.text);
      }
    }
    this.toolInputAccumulators.clear();
    this.buffers.clear();
    this.thinking.clear();
    return out;
  }

  private handleEvent(ev: SseEvent): string {
    if (ev.event === "content_block_delta") {
      return this.handleDelta(ev);
    }
    if (ev.event === "content_block_stop") {
      return this.handleStop(ev);
    }
    return serializeSseEvent(ev);
  }

  private handleDelta(ev: SseEvent): string {
    let payload: unknown;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return serializeSseEvent(ev);
    }
    const obj = payload as {
      type?: string;
      index?: number;
      delta?: {
        type?: string;
        text?: string;
        partial_json?: string;
        thinking?: string;
        signature?: string;
      };
    };
    if (!obj) return serializeSseEvent(ev);
    const blockIndex = typeof obj.index === "number" ? obj.index : 0;

    if (obj.delta?.type === "input_json_delta") {
      const chunk = typeof obj.delta.partial_json === "string" ? obj.delta.partial_json : "";
      this.toolInputAccumulators.set(
        blockIndex,
        (this.toolInputAccumulators.get(blockIndex) ?? "") + chunk
      );
      return "";
    }

    if (obj.delta?.type === "thinking_delta") {
      const chunk = typeof obj.delta.thinking === "string" ? obj.delta.thinking : "";
      const restored = this.thinking.pushThinking(blockIndex, chunk);
      if (restored.length === 0) return "";
      const out: unknown = { ...obj, delta: { ...obj.delta, thinking: restored } };
      return serializeSseEvent({ event: ev.event, data: JSON.stringify(out), raw: "" });
    }

    if (obj.delta?.type === "signature_delta") {
      const chunk = typeof obj.delta.signature === "string" ? obj.delta.signature : "";
      this.thinking.pushSignature(blockIndex, chunk);
      return serializeSseEvent(ev);
    }

    if (obj.delta?.type !== "text_delta") {
      return serializeSseEvent(ev);
    }
    const buf = this.getBuffer(blockIndex);
    const incoming = typeof obj.delta?.text === "string" ? obj.delta.text : "";
    const safe = buf.push(incoming);
    if (safe.length === 0) {
      return "";
    }
    const restored = this.scope.text(safe);
    const out: unknown = {
      ...obj,
      delta: { ...obj.delta, text: restored },
    };
    return serializeSseEvent({
      event: ev.event,
      data: JSON.stringify(out),
      raw: "",
    });
  }

  private handleStop(ev: SseEvent): string {
    let blockIndex = 0;
    try {
      const obj = JSON.parse(ev.data) as { index?: number };
      if (typeof obj.index === "number") blockIndex = obj.index;
    } catch {
      blockIndex = 0;
    }
    let out = "";

    const accum = this.toolInputAccumulators.get(blockIndex);
    if (accum !== undefined) {
      this.toolInputAccumulators.delete(blockIndex);
      const restored = this.scope.json(accum);
      if (restored !== accum) {
        out += serializeSseEvent({
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: restored },
          }),
          raw: "",
        });
      } else if (accum.length > 0) {
        out += serializeSseEvent({
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: accum },
          }),
          raw: "",
        });
      }
    }

    const buf = this.buffers.get(blockIndex);
    if (buf) {
      const remaining = buf.flush();
      if (remaining.length > 0) {
        const restored = this.scope.text(remaining);
        out += serializeSseEvent({
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text: restored },
          }),
          raw: "",
        });
      }
      this.buffers.delete(blockIndex);
    }

    const thinkingTail = this.thinking.stop(blockIndex);
    if (thinkingTail.length > 0) {
      out += thinkingDeltaEvent(blockIndex, thinkingTail);
    }

    out += serializeSseEvent(ev);
    return out;
  }

  private getBuffer(index: number): StreamBuffer {
    let buf = this.buffers.get(index);
    if (!buf) {
      buf = createStreamBuffer({ bufferWindow: this.bufferWindow });
      this.buffers.set(index, buf);
    }
    return buf;
  }
}

function thinkingDeltaEvent(index: number, thinking: string): string {
  return serializeSseEvent({
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking },
    }),
    raw: "",
  });
}
