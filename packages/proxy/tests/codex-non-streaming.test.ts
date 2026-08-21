import { describe, expect, test } from "bun:test";
import {
  LocalRegexBackend,
  PIIRemover,
  SingleStrategy,
} from "@pii-remover/core";
import {
  restoreCodexResponsesResponse,
  transformCodexResponsesRequest,
} from "../src/providers/codex.js";

async function makeRemover() {
  return PIIRemover.init({
    sessionId: `codex-${Math.random().toString(36).slice(2)}`,
    strategy: new SingleStrategy(new LocalRegexBackend()),
    warn: () => {},
  });
}

describe("transformCodexResponsesRequest", () => {
  test("string input is masked", async () => {
    const remover = await makeRemover();
    const out = await transformCodexResponsesRequest(
      {
        model: "gpt-test",
        input: "Email me at carol@example.com please.",
      },
      remover
    );
    expect(out.rejection).toBeUndefined();
    expect(typeof out.body.input).toBe("string");
    expect(out.body.input as string).toMatch(/{{OPF:EMAIL:[a-z0-9]{16}}}/);
    expect(out.body.input as string).not.toContain("carol@example.com");
  });

  test("instructions string is masked", async () => {
    const remover = await makeRemover();
    const out = await transformCodexResponsesRequest(
      {
        model: "gpt-test",
        instructions: "Contact admin@example.com when done.",
        input: [],
      },
      remover
    );
    expect(out.body.instructions).toMatch(/{{OPF:EMAIL:[a-z0-9]{16}}}/);
    expect(out.body.instructions).not.toContain("admin@example.com");
  });

  test("input items with input_text content are masked", async () => {
    const remover = await makeRemover();
    const out = await transformCodexResponsesRequest(
      {
        model: "gpt-test",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Card 5555-5555-5555-4444 used." },
              { type: "input_image", image_url: "https://example.com/x.png" },
            ],
          },
        ],
      },
      remover
    );
    expect(out.rejection).toBeUndefined();
    const items = out.body.input as Array<{
      content?: Array<{ type: string; text?: string }>;
    }>;
    const textPart = items[0]!.content![0]!;
    const imagePart = items[0]!.content![1]!;
    expect(textPart.text).toMatch(/{{OPF:CARD:[a-z0-9]{16}}}/);
    expect(textPart.text).not.toContain("5555-5555-5555-4444");
    expect(imagePart.type).toBe("input_image");
  });

  test("non-message items (function_call etc.) pass through untouched", async () => {
    const remover = await makeRemover();
    const out = await transformCodexResponsesRequest(
      {
        model: "gpt-test",
        input: [
          {
            type: "function_call",
            name: "search",
            arguments: '{"q":"safe query"}',
          },
        ],
      },
      remover
    );
    const items = out.body.input as Array<{ arguments?: string }>;
    expect(items[0]!.arguments).toBe('{"q":"safe query"}');
  });
});

describe("restoreCodexResponsesResponse", () => {
  test("restores text content in output[].content[]", async () => {
    const remover = await makeRemover();
    const masked = await remover.mask("Contact bob@example.com please.");
    const tokenizedText = masked.text;

    const restored = await restoreCodexResponsesResponse(
      {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: tokenizedText }],
          },
        ],
      },
      remover
    );
    const text = restored.output![0]!.content![0]!.text!;
    expect(text).toContain("bob@example.com");
    expect(text).not.toContain("{{OPF:EMAIL:");
  });

  test("restores top-level output_text", async () => {
    const remover = await makeRemover();
    const masked = await remover.mask("Card 5555-5555-5555-4444.");
    const restored = await restoreCodexResponsesResponse(
      { output_text: masked.text },
      remover
    );
    expect(restored.output_text).toContain("5555-5555-5555-4444");
    expect(restored.output_text).not.toContain("{{OPF:CARD:");
  });

  test("function_call.arguments JSON walk restores nested strings", async () => {
    const remover = await makeRemover();
    const masked = await remover.mask("admin@example.com");
    const argsJson = JSON.stringify({ to: masked.text });
    const restored = await restoreCodexResponsesResponse(
      {
        output: [
          {
            type: "function_call",
            name: "send",
            arguments: argsJson,
          },
        ],
      },
      remover
    );
    const restoredArgs = JSON.parse(restored.output![0]!.arguments!) as {
      to: string;
    };
    expect(restoredArgs.to).toBe("admin@example.com");
  });

  test("round-trip: mask request → echo back tokens → restore", async () => {
    const remover = await makeRemover();
    const masked = await transformCodexResponsesRequest(
      {
        model: "gpt-test",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Reach me at user@example.com today.",
              },
            ],
          },
        ],
      },
      remover
    );
    const items = masked.body.input as Array<{
      content?: Array<{ type: string; text?: string }>;
    }>;
    const maskedText = items[0]!.content![0]!.text!;
    expect(maskedText).toMatch(/{{OPF:EMAIL:[a-z0-9]{16}}}/);

    const restored = await restoreCodexResponsesResponse(
      {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: `OK echoing ${maskedText}` },
            ],
          },
        ],
      },
      remover
    );
    const restoredText = restored.output![0]!.content![0]!.text!;
    expect(restoredText).toContain("user@example.com");
  });
});
