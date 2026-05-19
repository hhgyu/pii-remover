import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LocalRegexBackend, PIIRemover } from "@pii-remover/core";
import {
  restoreOpenAIResponse,
  transformOpenAIRequest,
} from "../src/providers/openai.js";
import { startProxy, type ProxyServer, type FetchLike } from "../src/server.js";

const OPENAI_PATH = "/openai/v1/chat/completions";

async function makeRemover() {
  return PIIRemover.init({
    sessionId: `openai-${Math.random().toString(36).slice(2)}`,
    backends: [new LocalRegexBackend()],
    warn: () => {},
  });
}

describe("transformOpenAIRequest — non-streaming masking", () => {
  test("string content message is masked", async () => {
    const remover = await makeRemover();
    const out = await transformOpenAIRequest(
      {
        model: "gpt-test",
        messages: [
          { role: "user", content: "Ping carol@example.com tomorrow please." },
        ],
      },
      remover
    );
    expect(out.rejection).toBeUndefined();
    const masked = (out.body.messages[0]!.content as string);
    expect(masked).toContain("__OPF_EMAIL_1__");
  });

  test("array content: text masked, image_url passthrough", async () => {
    const remover = await makeRemover();
    const out = await transformOpenAIRequest(
      {
        model: "gpt-test",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Card 5555-5555-5555-4444 attached." },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AAA" },
              },
            ],
          },
        ],
      },
      remover
    );
    const parts = out.body.messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(parts[0]!.text).toContain("__OPF_CARD_1__");
    expect(parts[1]!.type).toBe("image_url");
  });

  test("stream:true is accepted in Phase 3B (was rejected in 3A)", async () => {
    const remover = await makeRemover();
    const out = await transformOpenAIRequest(
      {
        model: "gpt-test",
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

describe("restoreOpenAIResponse — content + tool_calls restoration", () => {
  test("restores string content in choices", async () => {
    const remover = await makeRemover();
    await remover.mask("alice@example.com");
    const restored = await restoreOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Will message __OPF_EMAIL_1__.",
            },
          },
        ],
      },
      remover
    );
    expect(restored.choices?.[0]!.message?.content).toBe(
      "Will message alice@example.com."
    );
  });

  test("restores tool_calls.function.arguments JSON", async () => {
    const remover = await makeRemover();
    await remover.mask("alice@example.com");

    const argsRaw = JSON.stringify({
      to: "__OPF_EMAIL_1__",
      subject: "report",
      body: "send to __OPF_EMAIL_1__ now",
    });
    const restored = await restoreOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "send_email", arguments: argsRaw },
                },
              ],
            },
          },
        ],
      },
      remover
    );
    const calls = restored.choices?.[0]!.message!.tool_calls;
    expect(calls).toBeDefined();
    const args = JSON.parse(calls![0]!.function.arguments);
    expect(args.to).toBe("alice@example.com");
    expect(args.body).toBe("send to alice@example.com now");
  });

  test("array content with text parts gets restored", async () => {
    const remover = await makeRemover();
    await remover.mask("dev@example.com");
    const restored = await restoreOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "I'll page __OPF_EMAIL_1__." },
              ],
            },
          },
        ],
      },
      remover
    );
    const parts = restored.choices?.[0]!.message!.content as Array<{ text: string }>;
    expect(parts[0]!.text).toBe("I'll page dev@example.com.");
  });
});

describe("startProxy — OpenAI round-trip via mock upstream", () => {
  let proxy: ProxyServer;
  let lastBody: unknown = null;

  beforeAll(async () => {
    const fakeUpstream: FetchLike = async (_url, init) => {
      lastBody = null;
      const rawBody = init?.body;
      try {
        if (rawBody instanceof ArrayBuffer) {
          lastBody = JSON.parse(new TextDecoder().decode(rawBody));
        } else if (typeof rawBody === "string") {
          lastBody = JSON.parse(rawBody);
        }
      } catch {
        lastBody = null;
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Got it, paging __OPF_EMAIL_1__.",
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
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

  test("OpenAI chat/completions round-trip", async () => {
    const res = await fetch(`${proxy.url}${OPENAI_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-test",
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "Page dev@example.com please." }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]!.message.content).toBe(
      "Got it, paging dev@example.com."
    );
    const upstreamMessages = (lastBody as { messages: Array<{ content: string }> })
      .messages;
    expect(upstreamMessages[0]!.content).toContain("__OPF_EMAIL_1__");
  });

  test("embeddings passthrough does not double-handle JSON", async () => {
    const res = await fetch(`${proxy.url}/openai/v1/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-test",
      },
      body: JSON.stringify({ model: "text-embed", input: "hello" }),
    });
    expect(res.status).toBe(200);
  });
});
