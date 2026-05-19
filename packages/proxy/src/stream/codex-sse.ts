import type { PIIRemover } from "@pii-remover/core";

import { createStreamBuffer, type StreamBuffer } from "./buffer.js";
import {
  SseLineParser,
  serializeSseEvent,
  type SseEvent,
} from "./sse-parser.js";

export interface CodexSseTransformerOptions {
  bufferWindow?: number;
  flushOnClose?: boolean;
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
  private closed = false;

  constructor(
    private readonly remover: PIIRemover,
    opts: CodexSseTransformerOptions = {}
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
      for (const [outputIdx, buf] of this.textBuffers.entries()) {
        const remaining = buf.flush();
        if (remaining.length > 0) {
          const restored = this.remover.restore(remaining).text;
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
          const restored = restoreJsonArguments(accum, this.remover);
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
    const restored = this.remover.restore(safe).text;
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
      const restored = restoreJsonArguments(accum, this.remover);
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

export { TEXT_DELTA_EVENT as CODEX_TEXT_DELTA_EVENT };
export { TEXT_DONE_EVENT as CODEX_TEXT_DONE_EVENT };
