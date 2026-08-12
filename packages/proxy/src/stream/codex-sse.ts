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

export interface CodexSseTransformerOptions {
  bufferWindow?: number;
  flushOnClose?: boolean;
  requestId?: string;
  provider?: string;
}

const TEXT_DELTA_EVENT = "response.output_text.delta";
const TEXT_DONE_EVENT = "response.output_text.done";
const FUNC_ARGS_DELTA_EVENT = "response.function_call_arguments.delta";
const FUNC_ARGS_DONE_EVENT = "response.function_call_arguments.done";

interface DeltaPayload {
  output_index?: number;
  delta?: unknown;
  [key: string]: unknown;
}

export class CodexSseTransformer {
  private readonly parser = new SseLineParser();
  private readonly textBuffers = new Map<number, StreamBuffer>();
  private readonly funcArgAccumulators = new Map<number, string>();
  private readonly bufferWindow: number;
  private readonly flushOnClose: boolean;
  private readonly scope: StreamRestoreScope;
  private closed = false;

  constructor(remover: PIIRemover, opts: CodexSseTransformerOptions = {}) {
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
      for (const [outputIdx, buf] of this.textBuffers.entries()) {
        const remaining = buf.flush();
        if (remaining.length > 0) {
          const restored = this.scope.text(remaining);
          out += serializeSseEvent({
            event: TEXT_DELTA_EVENT,
            data: JSON.stringify({
              type: TEXT_DELTA_EVENT,
              output_index: outputIdx,
              delta: restored,
            }),
            raw: "",
          });
        }
      }
      for (const [outputIdx, accum] of this.funcArgAccumulators.entries()) {
        if (accum.length > 0) {
          const restored = this.scope.json(accum);
          out += serializeSseEvent({
            event: FUNC_ARGS_DELTA_EVENT,
            data: JSON.stringify({
              type: FUNC_ARGS_DELTA_EVENT,
              output_index: outputIdx,
              delta: restored,
            }),
            raw: "",
          });
        }
      }
    }
    this.textBuffers.clear();
    this.funcArgAccumulators.clear();
    return out;
  }

  private handleEvent(ev: SseEvent): string {
    if (ev.event === FUNC_ARGS_DELTA_EVENT || ev.event === FUNC_ARGS_DONE_EVENT) {
      return this.handleFuncArgsDelta(ev);
    }
    if (ev.event !== TEXT_DELTA_EVENT) {
      return serializeSseEvent(ev);
    }
    let payload: DeltaPayload;
    try {
      payload = JSON.parse(ev.data) as DeltaPayload;
    } catch {
      return serializeSseEvent(ev);
    }
    if (typeof payload.delta !== "string") {
      return serializeSseEvent(ev);
    }
    const outputIdx =
      typeof payload.output_index === "number" ? payload.output_index : 0;
    const buf = this.getBuffer(outputIdx);
    const safe = buf.push(payload.delta);
    if (safe.length === 0) {
      return "";
    }
    const restored = this.scope.text(safe);
    const nextPayload: DeltaPayload = { ...payload, delta: restored };
    return serializeSseEvent({
      event: ev.event,
      data: JSON.stringify(nextPayload),
      raw: "",
    });
  }

  private handleFuncArgsDelta(ev: SseEvent): string {
    let payload: DeltaPayload;
    try {
      payload = JSON.parse(ev.data) as DeltaPayload;
    } catch {
      return serializeSseEvent(ev);
    }
    const outputIdx =
      typeof payload.output_index === "number" ? payload.output_index : 0;

    if (ev.event === FUNC_ARGS_DONE_EVENT) {
      const accum = this.funcArgAccumulators.get(outputIdx) ?? "";
      this.funcArgAccumulators.delete(outputIdx);
      const restored = this.scope.json(accum);
      const donePayload: DeltaPayload = { ...payload, delta: restored };
      return serializeSseEvent({ event: ev.event, data: JSON.stringify(donePayload), raw: "" });
    }

    const chunk = typeof payload.delta === "string" ? payload.delta : "";
    this.funcArgAccumulators.set(outputIdx, (this.funcArgAccumulators.get(outputIdx) ?? "") + chunk);
    return "";
  }

  private getBuffer(index: number): StreamBuffer {
    let buf = this.textBuffers.get(index);
    if (!buf) {
      buf = createStreamBuffer({ bufferWindow: this.bufferWindow });
      this.textBuffers.set(index, buf);
    }
    return buf;
  }
}

export { TEXT_DELTA_EVENT as CODEX_TEXT_DELTA_EVENT };
export { TEXT_DONE_EVENT as CODEX_TEXT_DONE_EVENT };
