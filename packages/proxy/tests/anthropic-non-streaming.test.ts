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
const TOKEN_RE = /__OPF_[A-Z_]+__[a-z0-9]{16}__/;

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
    expect(masked).toMatch(/__OPF_EMAIL__[a-z0-9]{16}__/);
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
    expect(blocks[0]!.text).toMatch(/__OPF_CARD__[a-z0-9]{16}__/);
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
    expect((out.body.system as string)).toMatch(/__OPF_EMAIL__[a-z0-9]{16}__/);
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
    expect(sysArr[0]!.text).toMatch(/__OPF_EMAIL__[a-z0-9]{16}__/);
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
    expect(masked).toMatch(/__OPF_EMAIL__[a-z0-9]{16}__/);
  });
});

describe("restoreAnthropicResponse — token restoration", () => {
  test("restores text blocks in content array", async () => {
    const remover = await makeRemover();
    const masked = await remover.mask("Reach me at bob@example.com");
    const token = masked.tokens[0]!.token;
    const restored = await restoreAnthropicResponse(
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: `I'll email ${token} tomorrow.` }],
      },
      remover
    );
    expect(restored.content?.[0]!.text).toBe(
      "I'll email bob@example.com tomorrow."
    );
  });

  test("restores tool_use.input nested fields", async () => {
    const remover = await makeRemover();
    const person = (await remover.mask("김철수")).tokens[0]!.token;
    const email = (await remover.mask("alice@example.com")).tokens[0]!.token;
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
                  question: `${person}님의 이메일을 확인할까요?`,
                  header: "확인",
                  options: [
                    { label: "예", description: `${email}로 발송` },
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
  let lastUpstreamUrl: string | null = null;

  beforeAll(async () => {
    upstreamCalls = 0;
    lastUpstreamHeaders = null;
    lastUpstreamBody = null;
    lastUpstreamUrl = null;
    const fakeUpstream: FetchLike = async (url, init) => {
      upstreamCalls++;
      lastUpstreamUrl = String(url);
      lastUpstreamHeaders = new Headers(
        (init?.headers as Record<string, string>) ?? {}
      );
      lastUpstreamBody = init?.body ? JSON.parse(init.body as string) : null;
      if (lastUpstreamUrl.includes("/api/oauth/profile")) {
        return new Response(
          JSON.stringify({ organization: { organization_type: "claude_max" } }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      const upstreamText = ((lastUpstreamBody as { messages?: Array<{ content?: string }> })
        .messages?.[0]?.content ?? "");
      const token = upstreamText.match(TOKEN_RE)?.[0] ?? "__OPF_EMAIL__ffffffffffffffff__";
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `Got it, will email ${token}.` }],
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
    expect(upstreamMessages[0]!.content).toMatch(/__OPF_EMAIL__[a-z0-9]{16}__/);
    expect(lastUpstreamHeaders?.get("authorization")).toBe("Bearer test-key");
  });

  test("forwards the client query string to upstream", async () => {
    const res = await fetch(`${proxy.url}${ANTHROPIC_PATH}?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(lastUpstreamUrl).toContain("/v1/messages?beta=true");
  });

  test("relays GET /anthropic/api/oauth/profile without masking", async () => {
    const res = await fetch(`${proxy.url}/anthropic/api/oauth/profile`, {
      headers: { authorization: "Bearer test-key" },
    });
    expect(res.status).toBe(200);
    expect(lastUpstreamUrl).toContain("/api/oauth/profile");
    expect(lastUpstreamHeaders?.get("authorization")).toBe("Bearer test-key");
    const body = (await res.json()) as {
      organization?: { organization_type?: string };
    };
    expect(body.organization?.organization_type).toBe("claude_max");
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
