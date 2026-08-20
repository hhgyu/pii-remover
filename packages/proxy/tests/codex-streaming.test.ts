import { describe, expect, test } from "bun:test";
import {
  LocalRegexBackend,
  PIIRemover,
  SingleStrategy,
} from "@pii-remover/core";

import { CodexSseTransformer } from "../src/stream/codex-sse.js";

async function makeRemover() {
  return PIIRemover.init({
    sessionId: `codex-stream-${Math.random().toString(36).slice(2)}`,
    strategy: new SingleStrategy(new LocalRegexBackend()),
    warn: () => {},
  });
}

function deltaEvent(delta: string, outputIndex = 0): string {
  return [
    "event: response.output_text.delta",
    `data: ${JSON.stringify({
      type: "response.output_text.delta",
      output_index: outputIndex,
      delta,
    })}`,
    "",
    "",
  ].join("\n");
}

function passthroughEvent(name: string, data: Record<string, unknown>): string {
  return [`event: ${name}`, `data: ${JSON.stringify(data)}`, "", ""].join("\n");
}

describe("CodexSseTransformer", () => {
  test("non-token delta passes through unchanged", async () => {
    const remover = await makeRemover();
    const t = new CodexSseTransformer(remover);
    const out = t.push(deltaEvent("Hello world."));
    expect(out).toContain('"delta":"Hello world."');
    expect(t.flush()).toBe("");
  });

  test("complete token in single delta is restored", async () => {
    const remover = await makeRemover();
    const masked = await remover.mask("Email: carol@example.com");
    const t = new CodexSseTransformer(remover);
    const out = t.push(deltaEvent(masked.text));
    expect(out).toContain("carol@example.com");
    expect(out).not.toContain("__OPF_EMAIL_");
  });

  test("token split across two deltas is buffered then restored", async () => {
    const remover = await makeRemover();
    const masked = await remover.mask("contact me at alice@example.com");
    const tokenMatch = /__OPF_EMAIL__[a-z0-9]{16}__/.exec(masked.text);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![0];
    const mid = Math.floor(token.length / 2);
    const first = token.slice(0, mid);
    const second = token.slice(mid);

    const t = new CodexSseTransformer(remover);
    const out1 = t.push(deltaEvent(`Hi ${first}`));
    const out2 = t.push(deltaEvent(second));
    const combined = out1 + out2 + t.flush();
    expect(combined).toContain("alice@example.com");
    expect(combined).not.toContain("__OPF_EMAIL_");
  });

  test("non-delta events pass through (response.created, completed)", async () => {
    const remover = await makeRemover();
    const t = new CodexSseTransformer(remover);
    const out = t.push(
      passthroughEvent("response.created", { id: "resp_123" }) +
        passthroughEvent("response.completed", { id: "resp_123" })
    );
    expect(out).toContain("event: response.created");
    expect(out).toContain("event: response.completed");
    expect(out).toContain('"id":"resp_123"');
  });

  test("multi-output_index streams are buffered independently", async () => {
    const remover = await makeRemover();
    const masked0 = await remover.mask("alice@example.com");
    const masked1 = await remover.mask("bob@example.com");

    const t = new CodexSseTransformer(remover);
    const out =
      t.push(deltaEvent(masked0.text, 0)) +
      t.push(deltaEvent(masked1.text, 1));
    expect(out).toContain("alice@example.com");
    expect(out).toContain("bob@example.com");
  });

  test("flush emits remaining buffered text with lenient restore", async () => {
    const remover = await makeRemover();
    const masked = await remover.mask("Email carol@example.com");
    const tokenMatch = /__OPF_EMAIL__[a-z0-9]{16}__/.exec(masked.text);
    const token = tokenMatch![0];
    const stripped = token.slice(0, token.length - 2);

    const t = new CodexSseTransformer(remover);
    const pushed = t.push(deltaEvent(`See ${stripped}`));
    const flushed = t.flush();
    const combined = pushed + flushed;
    expect(combined.length).toBeGreaterThan(0);
  });

  test("malformed delta event JSON is forwarded unchanged", async () => {
    const remover = await makeRemover();
    const t = new CodexSseTransformer(remover);
    const malformed = "event: response.output_text.delta\ndata: not-json\n\n";
    const out = t.push(malformed);
    expect(out).toContain("not-json");
  });
});
