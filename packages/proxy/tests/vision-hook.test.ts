import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  PIIRemover,
  type PiiRemoverConfig,
} from "@pii-remover/core";

function localOnlyConfig(): PiiRemoverConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
  };
}

import { transformAnthropicRequest } from "../src/providers/anthropic.js";
import { transformOpenAIRequest } from "../src/providers/openai.js";
import type {
  AnthropicRequestBody,
  OpenAIRequestBody,
} from "../src/providers/types.js";

async function makeRemover(): Promise<PIIRemover> {
  return PIIRemover.init({ env: {}, config: localOnlyConfig() });
}

// The transform injects a system message carrying the placeholder note, so
// positional indexing into `messages` no longer identifies the user turn.
function userContent(messages: readonly { role: string; content: unknown }[]) {
  const found = messages.find((m) => m.role === "user");
  if (!found) throw new Error("no user message in transformed body");
  return found.content;
}

describe("Anthropic image redactor hook", () => {
  test("calls imageRedactor on base64 image source", async () => {
    const remover = await makeRemover();
    const seen: string[] = [];
    const body: AnthropicRequestBody = {
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "ORIGINAL_B64",
              },
            },
            { type: "text", text: "describe" },
          ],
        },
      ],
    };
    const { body: out } = await transformAnthropicRequest(body, remover, {
      imageRedactor: async (b64) => {
        seen.push(b64);
        return "REDACTED_B64";
      },
    });
    expect(seen).toEqual(["ORIGINAL_B64"]);
    const block = (out.messages[0]!.content as Array<{ source?: { data?: string } }>)[0]!;
    expect(block.source?.data).toBe("REDACTED_B64");
    remover.dispose();
  });

  test("passes through when imageRedactor is not provided", async () => {
    const remover = await makeRemover();
    const body: AnthropicRequestBody = {
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "KEEP_AS_IS",
              },
            },
          ],
        },
      ],
    };
    const { body: out } = await transformAnthropicRequest(body, remover);
    const block = (out.messages[0]!.content as Array<{ source?: { data?: string } }>)[0]!;
    expect(block.source?.data).toBe("KEEP_AS_IS");
    remover.dispose();
  });

  test("passes through url source unchanged", async () => {
    const remover = await makeRemover();
    const body: AnthropicRequestBody = {
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: "https://example.com/x.png" },
            },
          ],
        },
      ],
    };
    let called = 0;
    const { body: out } = await transformAnthropicRequest(body, remover, {
      imageRedactor: async (b64) => {
        called++;
        return b64;
      },
    });
    expect(called).toBe(0);
    expect((out.messages[0]!.content as unknown[])[0]).toEqual(body.messages[0]!.content![0]!);
    remover.dispose();
  });

  test("swallows imageRedactor errors (best-effort: pass through)", async () => {
    const remover = await makeRemover();
    const body: AnthropicRequestBody = {
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "X" },
            },
          ],
        },
      ],
    };
    const { body: out } = await transformAnthropicRequest(body, remover, {
      imageRedactor: async () => {
        throw new Error("backend down");
      },
    });
    const block = (out.messages[0]!.content as Array<{ source?: { data?: string } }>)[0]!;
    expect(block.source?.data).toBe("X");
    remover.dispose();
  });
});

describe("OpenAI image_url redactor hook", () => {
  test("rewrites data: URI through imageRedactor", async () => {
    const remover = await makeRemover();
    const seen: string[] = [];
    const body: OpenAIRequestBody = {
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what's in this?" },
            {
              type: "image_url",
              image_url: {
                url: "data:image/png;base64,SEED_B64",
                detail: "auto",
              },
            },
          ],
        },
      ],
    };
    const { body: out } = await transformOpenAIRequest(body, remover, {
      imageRedactor: async (b64) => {
        seen.push(b64);
        return "MASKED_B64";
      },
    });
    expect(seen).toEqual(["SEED_B64"]);
    const part = (userContent(out.messages) as Array<{ image_url?: { url?: string } }>)[1]!;
    expect(part.image_url?.url).toBe("data:image/png;base64,MASKED_B64");
    remover.dispose();
  });

  test("passes through https:// URLs unchanged", async () => {
    const remover = await makeRemover();
    let called = 0;
    const body: OpenAIRequestBody = {
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.com/p.png" },
            },
          ],
        },
      ],
    };
    const { body: out } = await transformOpenAIRequest(body, remover, {
      imageRedactor: async () => {
        called++;
        return "X";
      },
    });
    expect(called).toBe(0);
    const part = (userContent(out.messages) as Array<{ image_url?: { url?: string } }>)[0]!;
    expect(part.image_url?.url).toBe("https://example.com/p.png");
    remover.dispose();
  });
});
