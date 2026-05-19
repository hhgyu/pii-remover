export interface SseEvent {
  event?: string;
  data: string;
  raw: string;
}

export class SseLineParser {
  private buf = "";

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const events: SseEvent[] = [];
    let idx: number;
    while ((idx = nextEventEnd(this.buf)) !== -1) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx);
      this.buf = this.buf.replace(/^(?:\r?\n)+/, "");
      const parsed = parseEventBlock(block);
      if (parsed) events.push(parsed);
    }
    return events;
  }

  flush(): SseEvent[] {
    if (this.buf.length === 0) return [];
    const parsed = parseEventBlock(this.buf);
    this.buf = "";
    return parsed ? [parsed] : [];
  }

  size(): number {
    return this.buf.length;
  }
}

function nextEventEnd(buf: string): number {
  const nn = buf.indexOf("\n\n");
  const rnn = buf.indexOf("\r\n\r\n");
  if (nn === -1 && rnn === -1) return -1;
  if (nn === -1) return rnn + 4;
  if (rnn === -1) return nn + 2;
  return Math.min(nn + 2, rnn + 4);
}

function parseEventBlock(block: string): SseEvent | null {
  const lines = block.split(/\r?\n/);
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
      continue;
    }
  }
  if (dataLines.length === 0 && event === undefined) return null;
  const data = dataLines.join("\n");
  return { event, data, raw: block };
}

export function serializeSseEvent(ev: SseEvent): string {
  const parts: string[] = [];
  if (ev.event) parts.push(`event: ${ev.event}`);
  if (ev.data.length > 0) {
    for (const line of ev.data.split("\n")) parts.push(`data: ${line}`);
  }
  parts.push("");
  parts.push("");
  return parts.join("\n");
}
