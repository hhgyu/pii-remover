import { describe, expect, test } from "bun:test";
import {
  PIIRemover,
  SingleStrategy,
  LocalRegexBackend,
  DEFAULT_CONFIG,
  type BackendClient,
  type BackendHealth,
  type DetectOpts,
  type DetectionResult,
} from "@pii-remover/core";

import {
  PiiRemoverPlugin,
  configurePiiRemoverPlugin,
  createPluginHooks,
} from "../src/hooks.js";

function silentWarn(): (msg: string) => void {
  return () => {};
}

function fakeBackend(detections: DetectionResult["detections"] = []): BackendClient {
  return {
    name: "fake-test",
    trust_tier: "local",
    async detect(_t: string, _o: DetectOpts): Promise<DetectionResult> {
      return {
        detections: [...detections],
        backend_name: "fake-test",
        latency_ms: 0,
      };
    },
    async healthCheck(): Promise<BackendHealth> {
      return { ok: true, latency_ms: 0 };
    },
  };
}

async function buildRemover(opts: {
  sessionId?: string;
  failure?: typeof DEFAULT_CONFIG.failure_policy;
  bypass?: string;
} = {}) {
  return PIIRemover.init({
    sessionId: opts.sessionId ?? "test-session",
    config: {
      ...DEFAULT_CONFIG,
      ...(opts.failure ? { failure_policy: opts.failure } : {}),
    },
    env: opts.bypass ? { PII_REMOVER_BYPASS: opts.bypass } : {},
    warn: silentWarn(),
    strategy: new SingleStrategy(new LocalRegexBackend()),
  });
}

describe("createPluginHooks — tool.execute.before", () => {
  test("masks string fields in tool args via the underlying remover", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = { args: { content: "contact alice@example.com please" } };
    await hooks["tool.execute.before"]!({ tool: "write", sessionID: "s", callID: "c1" },
    output);
    const args = output.args as { content: string };
    expect(args.content).toBe("contact __OPF_EMAIL_1__ please");
    remover.dispose();
  });

  test("does NOT mask path-shaped fields", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      args: {
        file_path: "/home/alice/work/repo/main.ts",
        content: "contact alice@example.com please",
      },
    };
    await hooks["tool.execute.before"]!({ tool: "write", sessionID: "s", callID: "c1" },
    output);
    const args = output.args as { file_path: string; content: string };
    expect(args.file_path).toBe("/home/alice/work/repo/main.ts");
    expect(args.content).toBe("contact __OPF_EMAIL_1__ please");
    remover.dispose();
  });

  test("walks nested arrays/objects", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      args: {
        messages: [
          { role: "user", text: "email alice@example.com please" },
          { role: "user", text: "or bob@example.com" },
        ],
      },
    };
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "s", callID: "c1" },
    output);
    const msgs = (output.args as { messages: { text: string }[] }).messages;
    expect(msgs[0]!.text).toBe("email __OPF_EMAIL_1__ please");
    expect(msgs[1]!.text).toBe("or __OPF_EMAIL_2__");
    remover.dispose();
  });

  test("no-op when args is null/undefined", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output: { args: unknown } = { args: null };
    await hooks["tool.execute.before"]!({ tool: "x", sessionID: "s", callID: "c" },
    output);
    expect(output.args).toBeNull();
    output.args = undefined;
    await hooks["tool.execute.before"]!({ tool: "x", sessionID: "s", callID: "c" },
    output);
    expect(output.args).toBeUndefined();
    remover.dispose();
  });

  test("passthrough when bypass env is set", async () => {
    const remover = await buildRemover({ bypass: "1" });
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = { args: { content: "alice@example.com bypassed" } };
    await hooks["tool.execute.before"]!({ tool: "write", sessionID: "s", callID: "c" },
    output);
    expect((output.args as { content: string }).content).toBe(
      "alice@example.com bypassed"
    );
    remover.dispose();
  });
});

describe("createPluginHooks — tool.execute.before with display tools", () => {
  test("display tool `question` restores tokens in args (UI sees original PII)", async () => {
    const remover = await buildRemover();
    const masked = await remover.mask(
      "김철수님 010-1234-5678 정보로 진행할까요?"
    );
    expect(masked.text).toContain("__OPF_PERSON_");
    expect(masked.text).toContain("__OPF_PHONE_");

    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      args: {
        questions: [
          {
            question: masked.text,
            header: "확인",
            options: [{ label: "예", description: masked.text }],
          },
        ],
      },
    };
    await hooks["tool.execute.before"]!(
      { tool: "question", sessionID: "test-session", callID: "c1" },
      output
    );
    const q = (output.args as {
      questions: Array<{
        question: string;
        options: Array<{ description: string }>;
      }>;
    }).questions[0];
    expect(q?.question).toContain("김철수");
    expect(q?.question).toContain("010-1234-5678");
    expect(q?.question).not.toContain("__OPF_PERSON_");
    expect(q?.options?.[0]?.description).toContain("김철수");
    remover.dispose();
  });

  test("MCP-prefixed `omo_question` restores tokens (suffix match)", async () => {
    const remover = await buildRemover();
    const masked = await remover.mask("연락처 alice@example.com 입니다");
    expect(masked.text).toContain("__OPF_EMAIL_");

    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = { args: { question: masked.text } };
    await hooks["tool.execute.before"]!(
      { tool: "omo_question", sessionID: "test-session", callID: "c1" },
      output
    );
    expect((output.args as { question: string }).question).toContain(
      "alice@example.com"
    );
    expect((output.args as { question: string }).question).not.toContain(
      "__OPF_EMAIL_"
    );
    remover.dispose();
  });

  test("`todowrite` restores by default (built-in display tool)", async () => {
    const remover = await buildRemover();
    const masked = await remover.mask(
      "alice@example.com 에게 회신할 것 - 010-1234-5678 확인"
    );
    expect(masked.text).toContain("__OPF_EMAIL_");

    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      args: { todos: [{ content: masked.text, status: "pending", priority: "high" }] },
    };
    await hooks["tool.execute.before"]!(
      { tool: "todowrite", sessionID: "test-session", callID: "c1" },
      output
    );
    const t = (output.args as {
      todos: Array<{ content: string; status: string; priority: string }>;
    }).todos[0];
    expect(t?.content).toContain("alice@example.com");
    expect(t?.content).toContain("010-1234-5678");
    expect(t?.content).not.toContain("__OPF_EMAIL_");
    expect(t?.content).not.toContain("__OPF_PHONE_");
    remover.dispose();
  });

  test("`todowrite` CAN be opted out via displayTools.excludeNames", async () => {
    const remover = await buildRemover();
    const masked = await remover.mask("alice@example.com 회신");
    expect(masked.text).toContain("__OPF_EMAIL_");

    const hooks = createPluginHooks(remover, {
      warn: silentWarn(),
      displayTools: { excludeNames: ["todowrite"] },
    });
    const output = {
      args: { todos: [{ content: masked.text, status: "pending", priority: "high" }] },
    };
    await hooks["tool.execute.before"]!(
      { tool: "todowrite", sessionID: "test-session", callID: "c1" },
      output
    );
    const t = (output.args as {
      todos: Array<{ content: string }>;
    }).todos[0];
    expect(t?.content).toContain("__OPF_EMAIL_");
    expect(t?.content).not.toContain("alice@example.com");
    remover.dispose();
  });

  test("MCP `omo_todowrite` matches (suffix)", async () => {
    const remover = await buildRemover();
    const masked = await remover.mask("alice@example.com 회신");
    expect(masked.text).toContain("__OPF_EMAIL_");

    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = { args: { todos: [{ content: masked.text }] } };
    await hooks["tool.execute.before"]!(
      { tool: "omo_todowrite", sessionID: "test-session", callID: "c1" },
      output
    );
    const t = (output.args as { todos: Array<{ content: string }> }).todos[0];
    expect(t?.content).toContain("alice@example.com");
    remover.dispose();
  });

  test("non-display tool `write` still masks (regression — existing behavior)", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = { args: { content: "contact alice@example.com please" } };
    await hooks["tool.execute.before"]!(
      { tool: "write", sessionID: "s", callID: "c1" },
      output
    );
    expect((output.args as { content: string }).content).toContain(
      "__OPF_EMAIL_"
    );
    expect((output.args as { content: string }).content).not.toContain(
      "alice@example.com"
    );
    remover.dispose();
  });

  test("`questionnaire` (substring match) is NOT a display tool", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = { args: { content: "contact alice@example.com please" } };
    await hooks["tool.execute.before"]!(
      { tool: "questionnaire", sessionID: "s", callID: "c1" },
      output
    );
    expect((output.args as { content: string }).content).toContain(
      "__OPF_EMAIL_"
    );
    remover.dispose();
  });

  test("upper-case MCP variant `Server_QUESTION` matches (case-insensitive)", async () => {
    const remover = await buildRemover();
    const masked = await remover.mask("연락처 alice@example.com 입니다");
    expect(masked.text).toContain("__OPF_EMAIL_");
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = { args: { question: masked.text } };
    await hooks["tool.execute.before"]!(
      { tool: "Server_QUESTION", sessionID: "test-session", callID: "c1" },
      output
    );
    expect((output.args as { question: string }).question).toContain(
      "alice@example.com"
    );
    expect((output.args as { question: string }).question).not.toContain(
      "__OPF_EMAIL_"
    );
    remover.dispose();
  });

  test("experimental:false MASKS display-tool args (boundary mask off → safe default)", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, {
      warn: silentWarn(),
      experimental: false,
    });
    const output = { args: { question: "Contact alice@example.com please" } };
    await hooks["tool.execute.before"]!(
      { tool: "question", sessionID: "test-session", callID: "c1" },
      output
    );
    expect((output.args as { question: string }).question).toContain(
      "__OPF_EMAIL_"
    );
    expect((output.args as { question: string }).question).not.toContain(
      "alice@example.com"
    );
    remover.dispose();
  });

  test("experimental:false + allowWithoutBoundaryMask:true RESTORES display-tool args (proxy responsibility)", async () => {
    const remover = await buildRemover();
    const masked = await remover.mask("Contact alice@example.com please");
    expect(masked.text).toContain("__OPF_EMAIL_");
    const hooks = createPluginHooks(remover, {
      warn: silentWarn(),
      experimental: false,
      displayTools: { allowWithoutBoundaryMask: true },
    });
    const output = { args: { question: masked.text } };
    await hooks["tool.execute.before"]!(
      { tool: "question", sessionID: "test-session", callID: "c1" },
      output
    );
    expect((output.args as { question: string }).question).toContain(
      "alice@example.com"
    );
    expect((output.args as { question: string }).question).not.toContain(
      "__OPF_EMAIL_"
    );
    remover.dispose();
  });

  test("experimental:false emits init-time warning about display-tool behavior", async () => {
    const remover = await buildRemover();
    const warnings: string[] = [];
    createPluginHooks(remover, {
      warn: (m: string) => warnings.push(m),
      experimental: false,
    });
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const w = warnings.find((m) => m.includes("experimental:false"));
    expect(w).toBeDefined();
    expect(w!).toContain("Display-tool args will be MASKED");
    expect(w!).toContain("allowWithoutBoundaryMask:true");
    remover.dispose();
  });

  test("bypass + display tool: args pass through unchanged (bypass dominates)", async () => {
    const remover = await buildRemover({ bypass: "1" });
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const original = "Contact alice@example.com please";
    const output = { args: { question: original } };
    await hooks["tool.execute.before"]!(
      { tool: "question", sessionID: "test-session", callID: "c1" },
      output
    );
    expect((output.args as { question: string }).question).toBe(original);
    remover.dispose();
  });
});

describe("createPluginHooks — event hook (session.idle)", () => {
  test("disposes remover when session.idle event is received", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "test-session" } },
    });
    await expect(remover.mask("anything alice@example.com")).rejects.toThrow(
      /disposed/
    );
  });

  test("does not dispose on unrelated events", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    await hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "test-session" },
      },
    });
    const r = await remover.mask("contact alice@example.com");
    expect(r.text).toContain("__OPF_EMAIL_1__");
    remover.dispose();
  });

  test("event hook is idempotent on repeated session.idle", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "test-session" } },
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "test-session" } },
    });
    await expect(remover.mask("x alice@example.com")).rejects.toThrow(/disposed/);
  });

  test("after dispose, tool.execute.before becomes a no-op", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s" } },
    });
    const output = { args: { content: "alice@example.com here" } };
    await hooks["tool.execute.before"]!({ tool: "write", sessionID: "s", callID: "c" },
    output);
    expect((output.args as { content: string }).content).toBe(
      "alice@example.com here"
    );
  });
});

describe("createPluginHooks — experimental.chat.messages.transform (comprehensive)", () => {
  test("masks user text parts before model dispatch", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "user" },
          parts: [
            {
              type: "text",
              text: "안녕하세요 김철수의 전화번호 010-1234-5678을 확인해주세요",
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const text = output.messages[0]?.parts?.[0]?.text ?? "";
    expect(text).not.toContain("김철수");
    expect(text).not.toContain("010-1234-5678");
    expect(text).toContain("__OPF_PERSON_");
    expect(text).toContain("__OPF_PHONE_");
    remover.dispose();
  });

  test("masks assistant text parts (LLM-boundary invariant)", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            { type: "text", text: "안녕하세요 김철수의 010-1234-5678 입니다" },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const text = output.messages[0]?.parts?.[0]?.text ?? "";
    expect(text).not.toContain("김철수");
    expect(text).not.toContain("010-1234-5678");
    expect(text).toContain("__OPF_PERSON_");
    remover.dispose();
  });

  test("masks reasoning parts", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "reasoning",
              text: "사용자가 alice@example.com을 언급했으므로 답변에서 사용",
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const text = output.messages[0]?.parts?.[0]?.text ?? "";
    expect(text).not.toContain("alice@example.com");
    expect(text).toContain("__OPF_EMAIL_");
    remover.dispose();
  });

  test("masks assistant tool part state.input recursively", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              state: {
                status: "completed",
                input: {
                  questions: [
                    {
                      question:
                        "김철수님의 010-1234-5678 정보로 진행할까요?",
                      header: "정보 확인",
                      options: [
                        {
                          label: "예",
                          description:
                            "김철수님의 010-1234-5678을 사용합니다",
                        },
                      ],
                    },
                  ],
                },
                output: "선택된 답변: 김철수 010-1234-5678",
                title: "김철수님 확인",
              },
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const part = output.messages[0]?.parts?.[0] as
      | undefined
      | {
          state?: {
            input?: {
              questions: Array<{
                question: string;
                header: string;
                options: Array<{ label: string; description: string }>;
              }>;
            };
            output?: string;
            title?: string;
          };
        };
    const q = part?.state?.input?.questions?.[0];
    expect(q?.question).not.toContain("김철수");
    expect(q?.question).not.toContain("010-1234-5678");
    expect(q?.question).toContain("__OPF_PERSON_");
    expect(q?.question).toContain("__OPF_PHONE_");
    expect(q?.options?.[0]?.description).not.toContain("김철수");
    expect(q?.options?.[0]?.description).toContain("__OPF_PERSON_");
    expect(part?.state?.output).not.toContain("김철수");
    expect(part?.state?.output).toContain("__OPF_PERSON_");
    expect(part?.state?.title).not.toContain("김철수");
    remover.dispose();
  });

  test("masks subtask part prompt + description", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "subtask",
              prompt:
                "김철수님 010-1234-5678 관련 작업 분석 후 보고서 작성",
              description:
                "alice@example.com 메일로 결과 송부 후 후속 조치 진행",
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const part = output.messages[0]?.parts?.[0] as
      | undefined
      | { prompt?: string; description?: string };
    expect(part?.prompt).not.toContain("김철수");
    expect(part?.prompt).toContain("__OPF_PERSON_");
    expect(part?.description).not.toContain("alice@example.com");
    expect(part?.description).toContain("__OPF_EMAIL_");
    remover.dispose();
  });

  test("masks file part source.text.value", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "user" },
          parts: [
            {
              type: "file",
              source: {
                text: {
                  value:
                    "Contact alice@example.com or call 010-1234-5678 for details.",
                },
              },
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const part = output.messages[0]?.parts?.[0] as
      | undefined
      | { source?: { text?: { value?: string } } };
    const value = part?.source?.text?.value ?? "";
    expect(value).not.toContain("alice@example.com");
    expect(value).not.toContain("010-1234-5678");
    expect(value).toContain("__OPF_EMAIL_");
    expect(value).toContain("__OPF_PHONE_");
    remover.dispose();
  });

  test("masks agent part source.value", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "user" },
          parts: [
            {
              type: "agent",
              source: { value: "agent context: alice@example.com is the lead" },
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const part = output.messages[0]?.parts?.[0] as
      | undefined
      | { source?: { value?: string } };
    expect(part?.source?.value).not.toContain("alice@example.com");
    expect(part?.source?.value).toContain("__OPF_EMAIL_");
    remover.dispose();
  });

  test("fail-closed: unknown part type recursively masks all string fields", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "note",
              comment:
                "alice@example.com 에게 전달, 010-1234-5678 으로 회신 부탁",
              nested: {
                detail: "김철수님 010-1234-5678 contact",
              },
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const part = output.messages[0]?.parts?.[0] as
      | undefined
      | {
          type?: string;
          comment?: string;
          nested?: { detail?: string };
        };
    expect(part?.type).toBe("note");
    expect(part?.comment).not.toContain("alice@example.com");
    expect(part?.comment).toContain("__OPF_EMAIL_");
    expect(part?.nested?.detail).not.toContain("김철수");
    expect(part?.nested?.detail).toContain("__OPF_PERSON_");
    remover.dispose();
  });

  test("structural fields (type, callID, tool name) remain untouched", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              callID: "call_abc123_long_enough_to_pass_min_length",
              tool: "some_tool_name_long_enough_too",
              state: { status: "completed", output: "ok contact alice@example.com" },
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const part = output.messages[0]?.parts?.[0] as
      | undefined
      | {
          type?: string;
          callID?: string;
          tool?: string;
          state?: { status?: string; output?: string };
        };
    expect(part?.type).toBe("tool");
    expect(part?.callID).toBe("call_abc123_long_enough_to_pass_min_length");
    expect(part?.tool).toBe("some_tool_name_long_enough_too");
    expect(part?.state?.status).toBe("completed");
    expect(part?.state?.output).not.toContain("alice@example.com");
    expect(part?.state?.output).toContain("__OPF_EMAIL_");
    remover.dispose();
  });

  test("object-shaped tool.state.output (MCP structuredContent) is masked", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              state: {
                status: "completed",
                output: {
                  content: [
                    { type: "text", text: "contact alice@example.com soon" },
                  ],
                  structuredContent: { email: "alice@example.com here too" },
                },
              },
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const state = (output.messages[0]?.parts?.[0] as {
      state?: {
        output?: {
          content: Array<{ text: string }>;
          structuredContent: { email: string };
        };
      };
    }).state;
    expect(state?.output?.content[0]?.text).not.toContain("alice@example.com");
    expect(state?.output?.content[0]?.text).toContain("__OPF_EMAIL_");
    expect(state?.output?.structuredContent.email).not.toContain(
      "alice@example.com"
    );
    expect(state?.output?.structuredContent.email).toContain("__OPF_EMAIL_");
    remover.dispose();
  });

  test("object-shaped tool.state.metadata is masked", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              state: {
                status: "completed",
                output: "done",
                metadata: { note: "ssn-ish contact dev@example.com record" },
              },
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const meta = (output.messages[0]?.parts?.[0] as {
      state?: { metadata?: { note: string } };
    }).state?.metadata;
    expect(meta?.note).not.toContain("dev@example.com");
    expect(meta?.note).toContain("__OPF_EMAIL_");
    remover.dispose();
  });

  test("tool.state.input path/name/id-shaped keys are preserved (non-strict)", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              state: {
                status: "completed",
                input: {
                  user_name: "김철수님 long string for detection",
                  contact_id: "alice@example.com long enough string",
                  profile_url: "alice@example.com long form here",
                  unrelated: "010-1234-5678 longer field text",
                },
              },
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const inp = (output.messages[0]?.parts?.[0] as {
      state?: {
        input?: {
          user_name?: string;
          contact_id?: string;
          profile_url?: string;
          unrelated?: string;
        };
      };
    })?.state?.input;
    // Fields ending in _name, _id, _url are skipped by heuristic so the LLM
    // sees real values (prevents token-index confusion in paths).
    expect(inp?.user_name).toBe("김철수님 long string for detection");
    expect(inp?.contact_id).toBe("alice@example.com long enough string");
    expect(inp?.profile_url).toBe("alice@example.com long form here");
    // Non-path fields are still masked.
    expect(inp?.unrelated).not.toContain("010-1234-5678");
    expect(inp?.unrelated).toContain("__OPF_PHONE_");
    remover.dispose();
  });

  test("tool.state.input handles null/undefined/missing state safely", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            { type: "tool" },
            { type: "tool", state: null },
            { type: "tool", state: undefined },
            { type: "tool", state: { input: null } },
            { type: "tool", state: { input: undefined } },
          ],
        },
      ],
    };
    await expect(
      hooks["experimental.chat.messages.transform"]?.({}, output as never)
    ).resolves.toBeUndefined();
    remover.dispose();
  });

  test("tool.state.input with primitive string value still gets masked", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              state: {
                status: "completed",
                input: "raw alice@example.com long input string",
              },
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const inp = (output.messages[0]?.parts?.[0] as { state?: { input?: unknown } })
      ?.state?.input;
    expect(typeof inp).toBe("string");
    expect(inp as string).not.toContain("alice@example.com");
    expect(inp as string).toContain("__OPF_EMAIL_");
    remover.dispose();
  });

  test("skips control parts (step-start, step-finish, snapshot, patch, retry)", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            { type: "step-start" },
            { type: "step-finish" },
            { type: "snapshot" },
            { type: "patch" },
            { type: "retry" },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const parts = output.messages[0]?.parts ?? [];
    for (const p of parts) {
      expect(Object.keys(p).length).toBe(1);
      expect(p.type).toMatch(
        /^(step-start|step-finish|snapshot|patch|retry)$/
      );
    }
    remover.dispose();
  });

  test("strips PII tokens from compaction parts", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = {
      messages: [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "compaction",
              text: "User shared __OPF_EMAIL_1__ and __OPF_PERSON_2__ for the project.",
            },
          ],
        },
      ],
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    const part = output.messages[0]?.parts?.[0];
    expect(part?.type).toBe("compaction");
    expect(part?.text).toBe("User shared [REDACTED] and [REDACTED] for the project.");
    remover.dispose();
  });

  test("empty messages array is safe", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = { messages: [] };
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    expect(output.messages).toEqual([]);
    remover.dispose();
  });
});

describe("createPluginHooks — experimental.chat.system.transform", () => {
  test("appends OPF placeholder guidance once", async () => {
    const remover = await buildRemover();
    const hooks = createPluginHooks(remover, { warn: silentWarn() });
    const output = { system: ["You are a helpful assistant."] };
    await hooks["experimental.chat.system.transform"]?.(
      { model: { providerID: "openai", modelID: "gpt-5.4-mini-fast" } },
      output
    );
    await hooks["experimental.chat.system.transform"]?.(
      { model: { providerID: "openai", modelID: "gpt-5.4-mini-fast" } },
      output
    );
    expect(output.system[0]).toBe("You are a helpful assistant.");
    expect(output.system.length).toBe(2);
    expect(output.system[1]).toContain("__OPF_");
    expect(output.system[1]).toContain("privacy-preserving");
    remover.dispose();
  });
});

describe("PiiRemoverPlugin — top-level factory", () => {
  test("derives sessionId from ctx.project.id", async () => {
    let derived: string | undefined;
    const captureBackend: BackendClient = {
      name: "capture",
      trust_tier: "local",
      async detect(_t: string, opts: DetectOpts): Promise<DetectionResult> {
        derived = opts.request_id;
        return { detections: [], backend_name: "capture", latency_ms: 0 };
      },
      async healthCheck(): Promise<BackendHealth> {
        return { ok: true, latency_ms: 0 };
      },
    };
    const factory = configurePiiRemoverPlugin({
      backends: [captureBackend],
      warn: silentWarn(),
      healthCheck: false,
    });
    const hooks = await factory({
      project: { id: "my-project-abc" },
      worktree: "/tmp/work",
      directory: "/tmp/work",
    });
    const output = { args: { msg: "contact alice@example.com please" } };
    await hooks["tool.execute.before"]!({ tool: "write", sessionID: "s", callID: "c" },
    output);
    expect(typeof derived).toBe("string");
    expect((output.args as { msg: string }).msg).toContain("__OPF_EMAIL_");
  });

  test("returns a Hooks-shaped object with event + tool.execute.before", async () => {
    const factory = configurePiiRemoverPlugin({
      backends: [fakeBackend()],
      warn: silentWarn(),
      healthCheck: false,
    });
    const hooks = await factory({
      project: { id: "test-proj" },
      worktree: "/tmp",
      directory: "/tmp",
    });
    expect(typeof hooks.event).toBe("function");
    expect(typeof hooks["tool.execute.before"]).toBe("function");
  });

  test("runs health check by default", async () => {
    let healthCalled = 0;
    const health: BackendClient = {
      name: "health-counter",
      trust_tier: "local",
      async detect(_t: string, _o: DetectOpts): Promise<DetectionResult> {
        healthCalled++;
        return { detections: [], backend_name: "h", latency_ms: 0 };
      },
      async healthCheck(): Promise<BackendHealth> {
        return { ok: true, latency_ms: 0 };
      },
    };
    const factory = configurePiiRemoverPlugin({
      backends: [health],
      warn: silentWarn(),
    });
    await factory({
      project: { id: "p" },
      worktree: "/tmp",
      directory: "/tmp",
    });
    expect(healthCalled).toBeGreaterThanOrEqual(1);
  });
});
