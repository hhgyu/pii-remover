import { describe, expect, test } from "bun:test";
import {
  LocalRegexBackend,
  PIIRemover,
  SingleStrategy,
  type BackendClient,
  type BackendHealth,
  type DetectionResult,
  type DetectOpts,
} from "@pii-remover/core";

import { createPluginHooks } from "../src/hooks.js";

function silentWarn(): (msg: string) => void {
  return () => {};
}

async function makeRemover(): Promise<PIIRemover> {
  return PIIRemover.init({
    sessionId: `restore-${Math.random().toString(36).slice(2)}`,
    backends: [new LocalRegexBackend()],
    warn: silentWarn(),
  });
}

async function maskString(remover: PIIRemover, text: string): Promise<string> {
  const r = await remover.mask(text);
  return r.text;
}

const TOKEN_RE = /__OPF_EMAIL__[a-z0-9]{16}__/;
const FAKE_TOKEN = "__OPF_FAKE__ffffffffffffffff__";

describe("createPluginHooks — restore via tool.execute.after (ADR-0011 stable hook)", () => {
  test("restores email tokens emitted from tool.output", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });

    const masked = await maskString(
      remover,
      "Contact alice@example.com about the report."
    );
    expect(masked).toMatch(TOKEN_RE);

    const output = { output: `Read file: ${masked}`, title: "ok", metadata: {} };
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "s", callID: "c", args: {} },
    output);
    expect(output.output).toContain("alice@example.com");
    expect(output.output).not.toContain("__OPF_EMAIL_");
  });

  test("restores tokens in tool output.title", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });

    const masked = await maskString(remover, "user@example.com");
    const token = masked.match(TOKEN_RE)![0];
    const output = {
      output: "completed",
      title: `Result for ${token}`,
      metadata: {},
    };
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "s", callID: "c", args: {} },
    output);
    expect(output.title).toBe("Result for user@example.com");
  });

  test("leaves token-free non-string output structurally unchanged", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });

    const output = {
      output: { nested: 42 } as unknown as string,
      title: "",
      metadata: null,
    };
    await hooks["tool.execute.after"]!({ tool: "ls", sessionID: "s", callID: "c", args: {} },
    output);
    expect(output.output as unknown).toEqual({ nested: 42 });
  });

  test("restores tokens inside object-shaped MCP tool output", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });

    const masked = await maskString(remover, "Email alice@example.com now.");
    expect(masked).toMatch(TOKEN_RE);

    const output = {
      output: {
        content: [{ type: "text", text: masked }],
        structuredContent: { summary: masked },
      } as unknown as string,
      title: "ok",
      metadata: {},
    };
    await hooks["tool.execute.after"]!({ tool: "mcp_server_search", sessionID: "s", callID: "c", args: {} },
    output);
    const restored = output.output as unknown as {
      content: Array<{ text: string }>;
      structuredContent: { summary: string };
    };
    expect(restored.content[0]!.text).toContain("alice@example.com");
    expect(restored.content[0]!.text).not.toContain("__OPF_EMAIL_");
    expect(restored.structuredContent.summary).toContain("alice@example.com");
  });

  test("restores tokens inside tool output.metadata", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });

    const masked = await maskString(remover, "Reach dev@example.com here.");
    expect(masked).toMatch(TOKEN_RE);

    const output = {
      output: "done",
      title: "ok",
      metadata: { result: { note: masked } } as unknown,
    };
    await hooks["tool.execute.after"]!({ tool: "mcp_server_fetch", sessionID: "s", callID: "c", args: {} },
    output);
    const meta = output.metadata as { result: { note: string } };
    expect(meta.result.note).toContain("dev@example.com");
    expect(meta.result.note).not.toContain("__OPF_EMAIL_");
  });

  test("hallucinated tokens stay as-is (vault miss)", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });

    const output = {
      output: `ghost ${FAKE_TOKEN} never seen`,
      title: "x",
      metadata: {},
    };
    await hooks["tool.execute.after"]!({ tool: "echo", sessionID: "s", callID: "c", args: {} },
    output);
    expect(output.output).toBe(`ghost ${FAKE_TOKEN} never seen`);
  });

  test("still restores after session.idle (idle no longer disposes the vault)", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const masked = await maskString(remover, "user@example.com");
    const token = masked.match(TOKEN_RE)![0];

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s" } },
    });

    const output = { output: token, title: "x", metadata: {} };
    await hooks["tool.execute.after"]!({ tool: "after-idle", sessionID: "s", callID: "c", args: {} },
    output);
    expect(output.output).toBe("user@example.com");
  });
});

describe("createPluginHooks — restore via experimental.text.complete (ADR-0011 experimental)", () => {
  test("registered by default", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    expect(typeof hooks["experimental.text.complete"]).toBe("function");
  });

  test("opt-out via experimental: false", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, {
      warn: silentWarn(),
      experimental: false,
    });
    expect(hooks["experimental.text.complete"]).toBeUndefined();
  });

  test("restores assistant response tokens", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });

    const masked = await maskString(
      remover,
      "Reach me at dev@example.com please."
    );
    expect(masked).toMatch(TOKEN_RE);

    const output = { text: `Got it. I will email ${masked.match(TOKEN_RE)?.[0]}.` };
    await hooks["experimental.text.complete"]!(
      { sessionID: "s", messageID: "m", partID: "p" },
      output
    );
    expect(output.text).toContain("dev@example.com");
    expect(output.text).not.toContain("__OPF_EMAIL_");
  });

  test("handles LLM case-folding (lenient match)", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const masked = await maskString(remover, "test@example.com");
    const token = masked.match(TOKEN_RE)![0].toLowerCase();

    const output = { text: `see ${token} for details` };
    await hooks["experimental.text.complete"]!(
      { sessionID: "s", messageID: "m", partID: "p" },
      output
    );
    expect(output.text).toContain("test@example.com");
  });

  test("non-string text untouched", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });

    const output = { text: 42 as unknown as string };
    await hooks["experimental.text.complete"]!(
      { sessionID: "s", messageID: "m", partID: "p" },
      output
    );
    expect(output.text as unknown).toBe(42);
  });
});

describe("createPluginHooks — round-trip integration", () => {
  test("full mask → tool echo → restore round-trip preserves Korean PII", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });

    const original = "연락처 010-1234-5678 이고 이메일 user@example.com";
    const maskedInput = await maskString(remover, original);
    expect(maskedInput).toContain("__OPF_PHONE_");
    expect(maskedInput).toContain("__OPF_EMAIL_");
    expect(maskedInput).not.toContain("010-1234-5678");
    expect(maskedInput).not.toContain("user@example.com");

    const output = { output: maskedInput, title: "echo", metadata: {} };
    await hooks["tool.execute.after"]!({ tool: "echo", sessionID: "s", callID: "c", args: {} },
    output);
    expect(output.output).toContain("010-1234-5678");
    expect(output.output).toContain("user@example.com");
    expect(output.output).not.toContain("__OPF_");
  });

  test("text.complete still restores after session.idle", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const masked = await maskString(remover, "alice@example.com");
    const token = masked.match(TOKEN_RE)![0];

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s" } },
    });

    const textOutput = { text: token };
    await hooks["experimental.text.complete"]!(
      { sessionID: "s", messageID: "m", partID: "p" },
      textOutput
    );
    expect(textOutput.text).toBe("alice@example.com");
  });
});

describe("createPluginHooks — display-tool round-trip (security invariant)", () => {
  test("mask → display restore → re-mask across LLM turns (no raw PII to LLM)", async () => {
    const remover = await makeRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });

    const userText = "김철수님 010-1234-5678 정보 사용해서 진행할까요?";

    const userMessages = {
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: userText }] },
      ],
    };
    await hooks["experimental.chat.messages.transform"]!({}, userMessages);
    const maskedUserText =
      (userMessages.messages[0]?.parts?.[0] as { text?: string })?.text ?? "";
    expect(maskedUserText).not.toContain("김철수");
    expect(maskedUserText).not.toContain("010-1234-5678");
    expect(maskedUserText).toContain("__OPF_PERSON_");
    expect(maskedUserText).toContain("__OPF_PHONE_");

    const llmToolCallArgs = {
      questions: [
        {
          question: maskedUserText,
          header: "확인",
          options: [
            { label: "예", description: "위 정보로 진행" },
            { label: "아니오", description: "다른 정보 입력" },
          ],
        },
      ],
    };
    const beforeOutput = { args: llmToolCallArgs };
    await hooks["tool.execute.before"]!(
      { tool: "question", sessionID: "s", callID: "c1" },
      beforeOutput
    );
    const displayedQuestion = (beforeOutput.args as {
      questions: Array<{ question: string }>;
    }).questions[0]?.question;
    expect(displayedQuestion).toContain("김철수");
    expect(displayedQuestion).toContain("010-1234-5678");
    expect(displayedQuestion).not.toContain("__OPF_PERSON_");

    const nextTurnHistory = {
      messages: [
        { info: { role: "user" }, parts: [{ type: "text", text: maskedUserText }] },
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              callID: "c1_long_callID_xxxxxxx",
              tool: "question",
              state: {
                status: "completed",
                input: beforeOutput.args,
                output: "user selected: 예",
                title: "Question for 김철수",
              },
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]!({}, nextTurnHistory);

    const userMsgText =
      (nextTurnHistory.messages[0]?.parts?.[0] as { text?: string })?.text ?? "";
    expect(userMsgText).not.toContain("김철수");
    expect(userMsgText).not.toContain("010-1234-5678");

    const toolPart = nextTurnHistory.messages[1]?.parts?.[0] as
      | undefined
      | {
          state?: {
            input?: { questions: Array<{ question: string }> };
            output?: string;
            title?: string;
          };
        };
    expect(toolPart?.state?.input?.questions?.[0]?.question).not.toContain(
      "김철수"
    );
    expect(toolPart?.state?.input?.questions?.[0]?.question).not.toContain(
      "010-1234-5678"
    );
    expect(toolPart?.state?.input?.questions?.[0]?.question).toContain(
      "__OPF_PERSON_"
    );
    expect(toolPart?.state?.title).not.toContain("김철수");
    expect(toolPart?.state?.title).toContain("__OPF_PERSON_");

    remover.dispose();
  });
});

describe("createPluginHooks — health-probe contract preserved", () => {
  test("custom backend with empty result still allows hooks to register", async () => {
    const emptyBackend: BackendClient = {
      name: "empty",
      trust_tier: "local",
      async detect(_t: string, _o: DetectOpts): Promise<DetectionResult> {
        return { detections: [], backend_name: "empty", latency_ms: 0 };
      },
      async healthCheck(): Promise<BackendHealth> {
        return { ok: true, latency_ms: 0 };
      },
    };
    const remover = await PIIRemover.init({
      sessionId: "health",
      strategy: new SingleStrategy(emptyBackend),
      warn: silentWarn(),
    });
    const hooks = createPluginHooks(remover, { warn: silentWarn() });

    expect(typeof hooks["tool.execute.after"]).toBe("function");
    expect(typeof hooks["experimental.text.complete"]).toBe("function");
  });
});
