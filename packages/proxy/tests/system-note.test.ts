/**
 * Lever L3 (docs/QUALITY-MEASUREMENT-PLAN.md §7): the placeholder instruction
 * used to reach the model only on the OpenCode path. The proxy carries Claude
 * Code and Codex, so those two hosts were asking the model to preserve tokens
 * it had never been told about.
 *
 * These assertions compare against the exported constant, never against its
 * wording — rewording the note must not break the contract that it is injected
 * exactly once.
 */

import { describe, expect, test } from "bun:test";
import {
  LocalRegexBackend,
  OPF_PLACEHOLDER_SYSTEM_NOTE,
  PIIRemover,
  SingleStrategy,
} from "@pii-remover/core";

import { transformAnthropicRequest } from "../src/providers/anthropic.js";
import { transformCodexResponsesRequest } from "../src/providers/codex.js";
import { transformOpenAIRequest } from "../src/providers/openai.js";

async function makeRemover(label: string): Promise<PIIRemover> {
  return PIIRemover.init({
    sessionId: `note-${label}`,
    strategy: new SingleStrategy(new LocalRegexBackend()),
    env: {},
    warn: () => {},
  });
}

function countNotes(haystack: string): number {
  return haystack.split(OPF_PLACEHOLDER_SYSTEM_NOTE).length - 1;
}

describe("anthropic — placeholder note reaches the system prompt", () => {
  test("a request with no system prompt gains one", async () => {
    const remover = await makeRemover("anthropic-empty");

    const out = await transformAnthropicRequest(
      { model: "claude", messages: [{ role: "user", content: "hi" }] },
      remover
    );

    expect(out.body.system).toBe(OPF_PLACEHOLDER_SYSTEM_NOTE);
    remover.dispose();
  });

  test("an existing string system prompt is appended to, not replaced", async () => {
    const remover = await makeRemover("anthropic-string");

    const out = await transformAnthropicRequest(
      {
        model: "claude",
        system: "You are terse.",
        messages: [{ role: "user", content: "hi" }],
      },
      remover
    );

    const system = out.body.system as string;
    expect(system.startsWith("You are terse.")).toBe(true);
    expect(countNotes(system)).toBe(1);
    remover.dispose();
  });

  test("an array system prompt gains exactly one note block", async () => {
    const remover = await makeRemover("anthropic-array");

    const out = await transformAnthropicRequest(
      {
        model: "claude",
        system: [{ type: "text", text: "You are terse." }],
        messages: [{ role: "user", content: "hi" }],
      },
      remover
    );

    const blocks = out.body.system as Array<{ text?: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.text).toBe(OPF_PLACEHOLDER_SYSTEM_NOTE);
    remover.dispose();
  });
});

describe("openai — placeholder note reaches the system prompt", () => {
  test("a request with no system message gains one before the user turn", async () => {
    const remover = await makeRemover("openai-empty");

    const out = await transformOpenAIRequest(
      { model: "gpt", messages: [{ role: "user", content: "hi" }] },
      remover
    );

    expect(out.body.messages[0]?.role).toBe("system");
    expect(out.body.messages[0]?.content).toBe(OPF_PLACEHOLDER_SYSTEM_NOTE);
    expect(out.body.messages[1]?.role).toBe("user");
    remover.dispose();
  });

  test("an existing system message is appended to, not duplicated", async () => {
    const remover = await makeRemover("openai-existing");

    const out = await transformOpenAIRequest(
      {
        model: "gpt",
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: "hi" },
        ],
      },
      remover
    );

    expect(out.body.messages).toHaveLength(2);
    expect(countNotes(out.body.messages[0]?.content as string)).toBe(1);
    remover.dispose();
  });
});

describe("codex — placeholder note reaches the instructions", () => {
  test("a request with no instructions gains them", async () => {
    const remover = await makeRemover("codex-empty");

    const out = await transformCodexResponsesRequest({ input: "hi" }, remover);

    expect(out.body.instructions).toBe(OPF_PLACEHOLDER_SYSTEM_NOTE);
    remover.dispose();
  });

  test("existing instructions are appended to exactly once", async () => {
    const remover = await makeRemover("codex-existing");

    const out = await transformCodexResponsesRequest(
      { instructions: "You are terse.", input: "hi" },
      remover
    );

    const instructions = out.body.instructions as string;
    expect(instructions.startsWith("You are terse.")).toBe(true);
    expect(countNotes(instructions)).toBe(1);
    remover.dispose();
  });
});

describe("injection is idempotent across turns", () => {
  test("transforming an already-annotated body adds no second note", async () => {
    const remover = await makeRemover("idempotent");
    const first = await transformOpenAIRequest(
      { model: "gpt", messages: [{ role: "user", content: "hi" }] },
      remover
    );

    const second = await transformOpenAIRequest(first.body, remover);

    const systemMessages = second.body.messages.filter(
      (m) => m.role === "system"
    );
    expect(systemMessages).toHaveLength(1);
    expect(countNotes(systemMessages[0]?.content as string)).toBe(1);
    remover.dispose();
  });
});
