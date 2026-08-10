import { describe, expect, test } from "bun:test";
import { PIIRemover } from "@pii-remover/core";

import { runHookCommand } from "../src/commands/hook.js";

describe("님 honorific regression (handoff Q from 2026-05-12)", () => {
  test("핵심 사실: '김철수님'에서 detection span은 '김철수'만, '님'은 보존된다 — 마스킹은 round-trip으로 동일 텍스트를 복원한다", async () => {
    const remover = await PIIRemover.init({ env: {} });
    const original = "안녕 김철수님 반갑습니다";
    const masked = await remover.mask(original);
    expect(masked.text).toContain("님 반갑습니다");
    expect(masked.text).not.toContain("김철수");
    const personToken = masked.tokens.find(
      (t) => t.category === "private_person"
    );
    expect(personToken?.text).toBe("김철수");
    const restored = remover.restore(masked.text);
    expect(restored.text).toBe(original);
    remover.dispose();
  });

  test("LLM이 응답에서 OPF PERSON 토큰 뒤의 님을 콤마로 바꾼 응답을 복원하면 '김철수,'가 되며 이는 LLM 변형 결과로 인한 것 — 우리 도구의 버그가 아님", async () => {
    const remover = await PIIRemover.init({ env: {} });
    const masked = await remover.mask("안녕 김철수님 반갑습니다");
    const personToken = masked.tokens.find(
      (t) => t.category === "private_person"
    );
    expect(personToken).toBeDefined();
    const llmResponse = `안녕 ${personToken!.token}, 반갑습니다`;
    const restored = remover.restore(llmResponse);
    expect(restored.text).toBe("안녕 김철수, 반갑습니다");
    remover.dispose();
  });

  test("hook command — 김철수님 prompt + proxy 미구성 -> block, 김철수가 reason에 노출되지 않음(토큰만)", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const r = await runHookCommand({
      stdin: () =>
        Promise.resolve(
          JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            session_id: "s",
            transcript_path: "",
            cwd: "",
            permission_mode: "default",
            prompt: "안녕 김철수님 반갑습니다",
          })
        ),
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: {},
      initPiiRemover: (opts) => PIIRemover.init(opts ?? {}),
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe("block");
    const parsed = JSON.parse(out.join("").trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("__OPF_PERSON_");
    expect(parsed.reason).not.toContain("김철수");
  });

  test("hook command — 김철수님 prompt + proxy 구성됨 -> allow_warn, additionalContext에 마스킹된 prompt가 들어가고 '김철수'는 노출되지 않음", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const r = await runHookCommand({
      stdin: () =>
        Promise.resolve(
          JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            session_id: "s",
            transcript_path: "",
            cwd: "",
            permission_mode: "default",
            prompt: "안녕 김철수님 반갑습니다",
          })
        ),
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: { ANTHROPIC_BASE_URL: "http://localhost:8765/anthropic/v1" },
      initPiiRemover: (opts) => PIIRemover.init(opts ?? {}),
    });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe("allow_warn");
    const parsed = JSON.parse(out.join("").trim());
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("__OPF_PERSON_");
    expect(ctx).toContain("님 반갑습니다");
    expect(ctx).not.toContain("김철수");
  });
});
