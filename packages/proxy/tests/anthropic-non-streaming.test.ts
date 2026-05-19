import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  LocalRegexBackend,
  PIIRemover,
} from "@pii-remover/core";
import {
  restoreAnthropicResponse,
  transformAnthropicRequest,
} from "../src/providers/anthropic.js";
import { startProxy, type ProxyServer, type FetchLike } from "../src/server.js";

const ANTHROPIC_PATH = "/anthropic/v1/messages";

async function makeRemover() {
  return PIIRemover.init({
    sessionId: `anthropic-${Math.random().toString(36).slice(2)}`,
    backends: [new LocalRegexBackend()],
    warn: () => {},
  });
}

describe("transformAnthropicRequest — non-streaming masking", () => {
  test("string content message is masked end-to-end", async () => {
    const remover = await makeRemover();
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        messages: [
          { role: "user", content: "Email me at alice@example.com please." },
        ],
      },
      remover
    );
    expect(out.rejection).toBeUndefined();
    const masked = (out.body.messages[0]!.content as string);
    expect(masked).toContain("__OPF_EMAIL_1__");
    expect(masked).not.toContain("alice@example.com");
  });

  test("content blocks: text masked, image passthrough", async () => {
    const remover = await makeRemover();
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Card 4242 4242 4242 4242 here." },
              { type: "image", source: { type: "base64", data: "AAA" } },
            ],
          },
        ],
      },
      remover
    );
    const blocks = out.body.messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(blocks[0]!.text).toContain("__OPF_CARD_1__");
    expect(blocks[0]!.text).not.toContain("4242 4242");
    expect(blocks[1]!.type).toBe("image");
  });

  test("system as string is masked", async () => {
    const remover = await makeRemover();
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        system: "Operator: ops@example.com handles escalations.",
        messages: [{ role: "user", content: "hi" }],
      },
      remover
    );
    expect(typeof out.body.system).toBe("string");
    expect((out.body.system as string)).toContain("__OPF_EMAIL_1__");
  });

  test("system as array is masked element-by-element", async () => {
    const remover = await makeRemover();
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        system: [
          { type: "text", text: "first contact admin@example.com" },
          { type: "text", text: "no PII here" },
        ],
        messages: [{ role: "user", content: "hi" }],
      },
      remover
    );
    const sysArr = out.body.system as Array<{ text: string }>;
    expect(sysArr[0]!.text).toContain("__OPF_EMAIL_1__");
    expect(sysArr[1]!.text).toBe("no PII here");
  });

  test("stream:true is accepted in Phase 3B (was rejected in 3A)", async () => {
    const remover = await makeRemover();
    const out = await transformAnthropicRequest(
      {
        model: "claude-test",
        stream: true,
        messages: [{ role: "user", content: "Reach me at d@example.com" }],
      },
      remover
    );
    expect(out.rejection).toBeUndefined();
    expect(out.body.stream).toBe(true);
    const masked = out.body.messages[0]!.content as string;
    expect(masked).toContain("__OPF_EMAIL_1__");
  });
});

describe("restoreAnthropicResponse — token restoration", () => {
  test("restores text blocks in content array", async () => {
    const remover = await makeRemover();
    await remover.mask("Reach me at bob@example.com");
    const restored = await restoreAnthropicResponse(
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "I'll email __OPF_EMAIL_1__ tomorrow." }],
      },
      remover
    );
    expect(restored.content?.[0]!.text).toBe(
      "I'll email bob@example.com tomorrow."
    );
  });

  test("restores tool_use.input nested fields", async () => {
    const remover = await makeRemover();
    await remover.mask("김철수");
    await remover.mask("alice@example.com");
    const restored = await restoreAnthropicResponse(
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "question",
            input: {
              questions: [
                {
                  question: "__OPF_PERSON_1__님의 이메일을 확인할까요?",
                  header: "확인",
                  options: [
                    { label: "예", description: "__OPF_EMAIL_1__로 발송" },
                  ],
                },
              ],
            },
          } as unknown as { type: string; text?: string },
        ],
      },
      remover
    );
    const block = restored.content?.[0] as {
      type: string;
      input?: {
        questions: Array<{
          question: string;
          options: Array<{ description: string }>;
        }>;
      };
    };
    expect(block.type).toBe("tool_use");
    expect(block.input?.questions[0]?.question).toContain("김철수");
    expect(block.input?.questions[0]?.question).not.toContain("__OPF_PERSON_");
    expect(block.input?.questions[0]?.options[0]?.description).toContain("alice@example.com");
    expect(block.input?.questions[0]?.options[0]?.description).not.toContain("__OPF_EMAIL_");
  });

  test("passes through unknown block types unchanged", async () => {
    const remover = await makeRemover();
    const restored = await restoreAnthropicResponse(
      {
        type: "message",
        role: "assistant",
        content: [{ type: "thinking", thinking: "some thoughts" } as unknown as { type: string; text?: string }],
      },
      remover
    );
    expect((restored.content?.[0] as { thinking?: string }).thinking).toBe("some thoughts");
  });
});

describe("startProxy — Anthropic round-trip via mock upstream", () => {
  let proxy: ProxyServer;
  let upstreamCalls = 0;
  let lastUpstreamHeaders: Headers | null = null;
  let lastUpstreamBody: unknown = null;

  beforeAll(async () => {
    upstreamCalls = 0;
    lastUpstreamHeaders = null;
    lastUpstreamBody = null;
    const fakeUpstream: FetchLike = async (_url, init) => {
      upstreamCalls++;
      lastUpstreamHeaders = new Headers(
        (init?.headers as Record<string, string>) ?? {}
      );
      lastUpstreamBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Got it, will email __OPF_EMAIL_1__." }],
          model: "claude-test",
          stop_reason: "end_turn",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    };
    proxy = await startProxy({
      port: 0,
      backends: [new LocalRegexBackend()],
      fetch_impl: fakeUpstream,
    });
  });

  afterAll(async () => {
    await proxy.stop();
  });

  test("masks request and restores response", async () => {
    const res = await fetch(`${proxy.url}${ANTHROPIC_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
      },
      body: JSON.stringify({
        model: "claude-test",
        messages: [
          { role: "user", content: "Send report to alice@example.com please." },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(body.content[0]!.text).toBe(
      "Got it, will email alice@example.com."
    );
    expect(upstreamCalls).toBe(1);
    const upstreamMessages = (lastUpstreamBody as { messages: Array<{ content: string }> })
      .messages;
    expect(upstreamMessages[0]!.content).toContain("__OPF_EMAIL_1__");
    expect(lastUpstreamHeaders?.get("authorization")).toBe("Bearer test-key");
  });

  test("health endpoint works", async () => {
    const res = await fetch(`${proxy.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; providers: string[] };
    expect(body.ok).toBe(true);
    expect(body.providers).toContain("anthropic");
    expect(body.providers).toContain("openai");
  });

  test("unknown path returns 404", async () => {
    const res = await fetch(`${proxy.url}/random/path`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
