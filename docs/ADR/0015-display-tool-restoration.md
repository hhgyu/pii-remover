# ADR-0015: Display-tool args 복원 + comprehensive LLM-boundary masking

- **Status**: Accepted
- **Date**: 2026-05-17
- **Related**: [ADR-0011](./0011-message-part-updated-feasibility.md) (응답 복원 hook), [ADR-0002](./0002-token-format-opf-underscore.md) (토큰 형식), [ADR-0006](./0006-fail-closed-default.md) (fail-closed)

---

## Context

ADR-0011 채택 직후, **interactive tool args가 사용자에게 표시될 때 복원이 안 되는 버그**가 보고됨.

### 재현 시나리오 (사용자 보고)

1. 사용자: "철수의 010-1234-5678 어떻게 처리할까요?"
2. plugin이 `experimental.chat.messages.transform`에서 user 메시지 마스킹 → LLM은 `__OPF_PERSON_27__의 __OPF_PHONE_3__ ...`만 봄
3. LLM이 `mcp_question` 도구 호출 — args에 마스킹된 토큰 그대로 (정상 — LLM은 마스킹된 텍스트만 봤으니까)
4. OpenCode가 args를 사용자에게 question UI로 렌더링
5. **버그**: 사용자가 `__OPF_PERSON_27__가 어떻게 처리할까요?`라는 토큰 그대로 봄

### 원인 분석

`tool.execute.before` hook이 args를 **마스킹**만 함 (이미 마스킹된 텍스트라 no-op). 사용자에게 표시되기 전에 **복원**하는 경로가 없음. ADR-0011의 응답 복원(`experimental.text.complete`, `tool.execute.after`)은 **결과**만 다루지 **입력 args**는 다루지 않음.

OpenCode source 검증 (sst/opencode dev branch, 2026-05-17):

- `tool.execute.before` 호출 위치: [`session/prompt.ts:577-584`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/session/prompt.ts)
  ```typescript
  yield* plugin.trigger("tool.execute.before",
    { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
    { args })
  const result = yield* item.execute(args, ctx)
  ```
  같은 `args` reference가 tool 실행 + 후속 `ToolPart.state.input` 영속화에 모두 사용됨.

- `experimental.chat.messages.transform` 호출 위치: [`session/prompt.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/session/prompt.ts) (`yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })`). LLM 송신 직전 호출되는 **최종 변환 지점**.

- `Part` discriminated union ([`session/message-v2.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/session/message-v2.ts)):
  `text | reasoning | tool | subtask | file | agent | step-start | step-finish | snapshot | patch | retry | compaction`. Tool part 구조: `{ type: "tool", callID, tool, state: { status, input, output, title, metadata } }`.

- 빌트인 도구 ID: `question` (`tool/question.ts:14`), `todowrite` (`tool/todo.ts:25`). MCP 도구 ID 포맷: `sanitize(clientName) + "_" + sanitize(mcpTool.name)`, `sanitize = s => s.replace(/[^a-zA-Z0-9_-]/g, "_")` ([`mcp/index.ts:683`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/mcp/index.ts)).

### 충돌하는 invariant 2개

1. **UX**: display tools(`question` 등)의 args는 사용자에게 보이므로 복원돼야 함
2. **Security**: LLM에 raw PII 송신 금지

같은 `args` reference가 (a) tool 실행, (b) UI 렌더링, (c) 대화 히스토리(`ToolPart.state.input`) 모두에 쓰임 → 단순히 `tool.execute.before`에서 복원만 하면 다음 턴에 LLM이 raw PII 봄.

---

## Decision

### 1. Display-tool 복원 + LLM-boundary 종합 마스킹

#### A. Display-tool 화이트리스트 (`src/display-tools.ts`)

`tool.execute.before`에서 **display tool인 경우에만** args 복원. 그 외 도구는 기존대로 마스킹.

- **기본 정확 매칭**: `["question", "todowrite"]` (소문자, case-insensitive 비교). OpenCode의 빌트인 interactive tool 두 종 모두 args가 사용자에게 직접 렌더링됨.
- **MCP suffix 매칭**: `["_question", "_todowrite"]` (case-insensitive). `omo_question`, `server_Todowrite` 등 매칭. `questionnaire`(substring 일치하지만 delimited suffix 아님)는 제외.
- **사용자 오버라이드**: `displayTools.extraNames`, `extraSuffixes`, `excludeNames` 제공.

#### B. `tool.execute.before` 분기

```typescript
if (isDisplayTool(input.tool, displayToolConfig)) {
  output.args = await restoreTextFields(output.args, restoreFieldText);
} else {
  output.args = await maskTextFields(output.args, maskText, options.maskOptions ?? {});
}
```

#### C. `experimental.chat.messages.transform` 종합 마스킹 (LLM-boundary invariant 강화)

기존: user role + text part만 마스킹.
신규: **모든 role + 모든 text-bearing part type** 마스킹.

| Part type | 마스킹 대상 |
|---|---|
| `text` / `reasoning` | `text` 필드 |
| `tool` | `state.input` (recursive, `maskTextFields`), `state.output`, `state.title` |
| `subtask` | `prompt`, `description` |
| `file` | `source.text.value` |
| `agent` | `source.value` |
| `step-start`, `step-finish`, `snapshot`, `patch`, `retry`, `compaction` | (구조 제어 part — 통과) |
| **그 외 (unknown)** | **fail-closed**: `maskTextFieldsStrict`로 재귀 마스킹 (min-length 0, path-name skip 안 함) |

미래 OpenCode가 새 part type을 추가해도 (e.g., `note`, `attachment`) 자동으로 마스킹돼 LLM에 누출 방지.

#### D. Boundary-grade strict masker (`maskTextFieldsStrict`)

기존 `maskTextFields`의 정책(min-length-8, `_path`/`_id` 등 휴리스틱 skip)은 tool 운영 안정성용으로 보안 경계에 부적합. Strict 버전은:
- min-length 0
- skip-list 최소 (`type`/`id`/`callID`/`tool`/`sessionID`/`messageID`/`partID`만 보존 — 구조 ID는 PII 아님)
- 휴리스틱 비활성화

### 2. 보안 약속 범위 명시

pii-remover의 **핵심 보안 invariant**: "raw PII가 외부 LLM API로 송신되지 않는다." 이 invariant는 `experimental.chat.messages.transform`이 LLM 송신 직전 전체 메시지 트리를 재마스킹하여 보장.

**범위 외**: 사용자 머신 로컬 디스크 영속화는 보호 대상 아님.
- OpenCode 세션 로그 (`ToolPart.state.input` 등) — 사용자 자신의 머신
- `todowrite`의 별도 SQLite todo 테이블 — 사용자 자신의 머신
- Vault는 여전히 in-memory only (별도 invariant)

`tool.execute.before`의 display-tool 복원은 args reference를 mutate하므로 그 reference가 영속화 경로로 들어갈 수 있음. UX(사용자가 raw PII를 보는 것)를 위해 수용 — 외부 송신 invariant는 boundary mask로 별도 보장됨.

### 3. Split mode 동작

`mode="mask"` (mask-only plugin entry)에서도 display-tool 복원 활성화. 같은 singleton `PIIRemover` 인스턴스 + 같은 vault를 mask/restore 플러그인이 공유하므로 동작 가능. README에 문서화.

### 4. `experimental: false` 가드

`experimental: false`는 `experimental.chat.messages.transform`을 비활성화함 → LLM 경계 마스킹 없음. 이 상태에서 `tool.execute.before`가 display-tool args를 복원하면 다음 턴에 raw PII가 그대로 LLM에 송신됨.

**기본 동작** (secure default): `experimental: false` && `displayTools.allowWithoutBoundaryMask !== true`인 경우, display-tool args도 일반 도구처럼 **마스킹**됨 (UX는 깨지지만 보안 보존). 플러그인 init 시 1회 경고 emit.

**Override**: `displayTools.allowWithoutBoundaryMask: true`로 사용자가 명시 opt-in 시 복원 동작. 대안 경계 마스크(예: Phase 3 local proxy의 catch-all 마스킹)가 있다는 사용자 확인.

### 5. `tool.state.input`은 strict masker 사용

`chat.messages.transform`에서 assistant tool part의 `state.input`은 LLM-generated 또는 display-tool에 의해 복원된 데이터일 수 있음. `maskTextFields`의 기본 정책(min-length-8, `_path`/`_name`/`_id` 휴리스틱 skip)을 그대로 쓰면 `user_name: "김철수"`, `contact_id: "alice@example.com"` 같은 필드가 skip되어 LLM에 누출됨. 따라서 `state.input`은 `maskTextFieldsStrict`(skip 없음, min-length 0)로 마스킹.

---

## Consequences

### 긍정적

- **UX 복원**: `mcp_question` 같은 interactive tool에서 사용자가 원본 PII 그대로 봄.
- **LLM-boundary invariant 강화**: 모든 role, 모든 part 타입, unknown 타입 fail-closed → 미래 OpenCode 변경에 robust.
- **MCP 호환**: 사용자 MCP 서버 prefix(`omo_question` 등)도 자동 매칭.
- **Security 보존**: LLM은 어떤 경우에도 raw PII 안 봄 (`chat.messages.transform`이 catch-all).
- **84 new tests** (workspace 506 → 590 pass): regression + edge case 모두 커버.

### 부정적

- **로컬 영속화**: display tool args가 OpenCode 세션 로그 + (todowrite의 경우) SQLite todo 테이블에 raw PII로 저장됨. 핵심 invariant(외부 LLM 송신 차단)는 유지되지만 로컬 영속화는 발생. 약속 범위 외임을 README/ADR에 명시.
- **기존 테스트 변경**: `plugin.test.ts`의 "does not modify non-user messages"는 **invariant 변경**에 따라 의미 반전됨 (이제 assistant 메시지도 마스킹). 동일 코드 위치의 새 테스트로 대체.
- **Backend 호출 증가**: `chat.messages.transform`이 모든 메시지 모든 part 순회하므로 detection backend 호출 빈도 증가. `LocalRegexBackend`는 충분히 빠름 (정규식 only, < 1ms), `OpfHttpBackend`는 캐시/배치 필요시 별도 개선.

### 위험 / 미해결

- **OpenCode upstream API 변경**: `experimental.chat.messages.transform`이 안정화/제거되면 fallback 필요. 현재 ADR-0011처럼 `experimental: false`로 비활성화 가능.
- **Singleton 분리 (split mode)**: 한 프로세스가 여러 OpenCode 세션 호스팅 시 vault 공유 위험은 **pre-existing**. ADR-XXXX (백로그)로 별도 추적.
- **Display tool args 내 path/name 형식 필드는 UI에 토큰 노출 가능**: `tool.execute.before`의 display-tool restore는 `restoreTextFields`(skip-list 유지)를 씀 → display tool args에 `customer_name`, `file_path` 같은 키가 있으면 토큰이 UI에 그대로 보임. 알려진 display tools (`question`, `todowrite` schema는 path-shape 필드 없음)에선 문제 없음. 사용자 정의 display tool 추가 시 한계 인지 필요.

---

## Alternatives Considered

### A1. Display tool 복원 안 하기 (이전 안)

거부 이유: UX 깨짐. 사용자가 토큰 그대로 봄 → 의도 모름 → 정답 못 함.

### A2. UI-render-only hook 추가 요청 (OpenCode upstream)

거부 이유: v1 출시 일정 영향. 우리 plugin layer에서 해결 가능.

### A3. Proxy에서만 처리 (Claude Code 방식)

거부 이유: OpenCode는 in-process plugin이 기본. Proxy 없이도 OpenCode 사용자가 동작 받아야 함.

### A4. 모든 tool args 복원 (display tool 분기 없이)

거부 이유:
- 일반 도구(`write`, `bash`)는 args가 LLM-generated 토큰. 복원하면 실행 측에서 raw PII 사용 → file write 시 PII 그대로 디스크 기록 (사용자 의도가 PII를 LLM에 가린 것이라면 의도 위반).
- Defense-in-depth 위반: LLM이 hallucinate한 PII가 raw로 통과.

### A5. `todowrite`를 default exclude (영속화 우려로 opt-in만)

거부 이유: pii-remover의 핵심 약속은 외부 LLM 송신 차단이지 로컬 디스크 영속화 차단이 아님. `question`도 `ToolPart.state.input`으로 영속화되므로 `todowrite`만 차별 대우할 합리적 근거 없음. UX 일관성 우선해 둘 다 default 포함, `excludeNames`로 opt-out 가능.

---

## Implementation Notes

### 새 모듈/심볼

- `src/display-tools.ts`:
  - `DEFAULT_DISPLAY_TOOL_NAMES`, `DEFAULT_DISPLAY_TOOL_SUFFIXES`
  - `isDisplayTool(toolName, config)`, `resolveDisplayToolConfig(config)`
  - `DisplayToolConfig` interface
- `src/text-field-masker.ts`:
  - `restoreTextFields(args, restoreFn, options)`: walker mirror of `maskTextFields` (min-length 0)
  - `maskTextFieldsStrict(args, maskFn)`: boundary fail-closed (no skip, no min-length, structural keys only)
- `src/hooks.ts`:
  - `PiiRemoverPluginOptions.displayTools`
  - `createPluginHooks` accepts `displayTools` option
  - `tool.execute.before` branches on `isDisplayTool`
  - `experimental.chat.messages.transform` rewritten with `maskPartInPlace` dispatcher

### Idempotency

- `restoreTextFields` 호출 → vault token 없는 string은 unchanged (Restorer 동작).
- `maskTextFields` 호출 → 이미 마스킹된 token은 detection backend가 매칭 안 함 → no-op.

### Test 통계

| 카테고리 | 추가 테스트 수 |
|---|---|
| `display-tools.test.ts` | 19 (exact/suffix/case/non-match/overrides) |
| `text-field-masker.test.ts` (restore + strict) | 9 |
| `plugin.test.ts` (display tool + chat transform comprehensive) | 17 (기존 1개 의미 반전 대체) |
| `split-mode.test.ts` (display tool in mask-only mode) | 1 |
| `restore.test.ts` (full round-trip) | 1 |
| **합계** | **47 new (workspace: 506 → 590 = +84 incl. neighbouring fixtures)** |

`bun test`: 590 pass / 1 skip / 0 fail. `bun run typecheck` (5 packages): clean.

---

## References

- OpenCode source verified (sst/opencode dev branch, 2026-05-17):
  - `packages/opencode/src/session/prompt.ts` (hook trigger sites)
  - `packages/opencode/src/session/message-v2.ts` (`Part` union)
  - `packages/opencode/src/tool/question.ts` (built-in `question` ID)
  - `packages/opencode/src/tool/todo.ts` (built-in `todowrite` ID)
  - `packages/opencode/src/mcp/index.ts` (MCP tool ID format)
- ADR-0011: 응답 복원 hook 결정.
- README §Security Model: in-memory vault 약속의 정확한 범위.
