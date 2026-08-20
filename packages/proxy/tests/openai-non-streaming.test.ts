import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  LocalRegexBackend,
  PIIRemover,
  SingleStrategy,
} from "@pii-remover/core";
import {
  restoreOpenAIResponse,
  transformOpenAIRequest,
} from "../src/providers/openai.js";
import { startProxy, type ProxyServer, type FetchLike } from "../src/server.js";

const OPENAI_PATH = "/openai/v1/chat/completions";
const TOKEN_RE = /__OPF_[A-Z_]+__[a-z0-9]{16}__/;

async function makeRemover() {
  return PIIRemover.init({
    sessionId: `openai-${Math.random().toString(36).slice(2)}`,
    strategy: new SingleStrategy(new LocalRegexBackend()),
    warn: () => {},
  });
}

// The transform injects a system message carrying the placeholder note, so
// positional indexing into `messages` no longer identifies the user turn.
function userMessage(messages: readonly { role: string; content: unknown }[]) {
  const found = messages.find((m) => m.role === "user");
  if (!found) throw new Error("no user message in transformed body");
  return found;
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
    const masked = userMessage(out.body.messages).content as string;
    expect(masked).toMatch(/__OPF_EMAIL__[a-z0-9]{16}__/);
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
    const parts = userMessage(out.body.messages).content as Array<{
      type: string;
      text?: string;
    }>;
    expect(parts[0]!.text).toMatch(/__OPF_CARD__[a-z0-9]{16}__/);
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
    const masked = userMessage(out.body.messages).content as string;
    expect(masked).toMatch(/__OPF_EMAIL__[a-z0-9]{16}__/);
  });
});

describe("restoreOpenAIResponse — content + tool_calls restoration", () => {
  test("restores string content in choices", async () => {
    const remover = await makeRemover();
    const token = (await remover.mask("alice@example.com")).tokens[0]!.token;
    const restored = await restoreOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: `Will message ${token}.`,
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
    const token = (await remover.mask("alice@example.com")).tokens[0]!.token;

    const argsRaw = JSON.stringify({
      to: token,
      subject: "report",
      body: `send to ${token} now`,
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
    const token = (await remover.mask("dev@example.com")).tokens[0]!.token;
    const restored = await restoreOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: [
                { type: "text", text: `I'll page ${token}.` },
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
      // Scan every message: the transform prepends a system message carrying
      // the placeholder note, so the token is no longer in messages[0].
      const upstreamText = ((lastBody as { messages?: Array<{ content?: string }> })
        ?.messages ?? [])
        .map((m) => m?.content ?? "")
        .join("\n");
      const token = upstreamText.match(TOKEN_RE)?.[0] ?? "__OPF_EMAIL__ffffffffffffffff__";
      return new Response(
        JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `Got it, paging ${token}.`,
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
      strategy: new SingleStrategy(new LocalRegexBackend()),
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
    const upstreamMessages = (
      lastBody as { messages: Array<{ role: string; content: string }> }
    ).messages;
    expect(userMessage(upstreamMessages).content).toMatch(
      /__OPF_EMAIL__[a-z0-9]{16}__/
    );
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
