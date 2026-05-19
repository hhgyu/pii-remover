# ADR-0013 — OpenAI Codex CLI `UserPromptSubmit` hook: detection-only + fail-closed gate, masking delegated to proxy

- **Status**: Accepted
- **Date**: 2026-05-13
- **Supersedes**: (none)
- **Related**: [ADR-0004](./0004-local-llm-proxy-streaming.md), [ADR-0006](./0006-fail-closed-default.md), [ADR-0012](./0012-claude-code-hook-protocol.md), [ADR-0014](./0014-codex-proxy-routing.md)

## Context

ADR-0012가 Claude Code의 `UserPromptSubmit` hook을 source-verified로 분석한 결과: hook은 **prompt를 교체하지 못한다**. PII Remover는 hook을 detection-only로 사용하고, 실제 마스킹은 `@pii-remover/proxy`가 담당한다.

OpenAI Codex CLI(`openai/codex`, commit `27e67a8c2a98e0efef9e15282fb2719c09501ee4`)도 같은 패턴의 `UserPromptSubmit` hook을 제공한다. librarian source-verification(2026-05-13) 결과 **Claude Code hook과 stdin/stdout JSON 스키마가 거의 동일**하다 — 같은 `pii-remover hook` 명령을 그대로 재사용할 수 있다.

### 확인된 사실 (source-verified)

`openai/codex` 리포지토리에서 확인:

1. **stdin JSON 스키마**:
   - 입력 스키마: [`codex-rs/hooks/schema/generated/user-prompt-submit.command.input.schema.json`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/hooks/schema/generated/user-prompt-submit.command.input.schema.json#L12-L56)
   - 필드: `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `prompt`
   - Claude Code와 차이: `turn_id`, `model` 추가. 둘 다 `pii-remover hook`이 무시해도 안전(현재 코드도 알 수 없는 필드를 무시).

2. **stdout JSON 스키마 — prompt 교체 필드 없음**:
   - 출력 스키마: [`codex-rs/hooks/schema/generated/user-prompt-submit.command.output.schema.json`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/hooks/schema/generated/user-prompt-submit.command.output.schema.json#L41-L79)
   - 허용 필드: `continue`, `stopReason`, `suppressOutput`, `systemMessage`, `decision:"block"`, `reason`, `hookSpecificOutput.additionalContext`
   - Claude Code와 동일하게 `additionalContext`는 추가만, `decision:"block"`는 차단.
   - 출처 코드: [`codex-rs/hooks/src/engine/output_parser.rs#L240-L261`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/hooks/src/engine/output_parser.rs#L240-L261)

3. **Exit code 규약**:
   - `0`: stdout JSON 해석
   - `2`: stderr 비어있지 않은 문자열을 block reason으로 사용
   - 출처: [`codex-rs/hooks/src/events/user_prompt_submit.rs#L147-L235`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/hooks/src/events/user_prompt_submit.rs#L147-L235)

4. **설정 파일 — TOML**:
   - 위치: `~/.codex/config.toml` (사용자 전역) 또는 `.codex/config.toml`(프로젝트)
   - 형식:
     ```toml
     [[hooks.UserPromptSubmit]]
       [[hooks.UserPromptSubmit.hooks]]
       type = "command"
       command = "/abs/path/to/pii-remover hook"
       timeout = 30
     ```
   - 출처: [`codex-rs/config/src/config_toml.rs#L89-L90`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/config/src/config_toml.rs#L89-L90), [`hook_config.rs#L32-L49`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/config/src/hook_config.rs#L32-L49)
   - `UserPromptSubmit`은 `matcher`를 무시함: [`common.rs#L98-L110`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/hooks/src/events/common.rs#L98-L110)

5. **차이점 정리 (Claude Code vs Codex)**:

   | 항목 | Claude Code | Codex |
   |---|---|---|
   | hook 명령 등록 형식 | `~/.claude/settings.json` (JSON) | `~/.codex/config.toml` (TOML) |
   | stdin 필드 | session_id, transcript_path, cwd, permission_mode, hook_event_name, prompt | + `turn_id`, `model` |
   | stdout 필드 | additionalContext / decision:block / reason | 동일 (+ `continue`, `stopReason`, `suppressOutput`, `systemMessage`) |
   | exit 0 의미 | stdout JSON 해석 | 동일 |
   | exit 2 의미 | stderr를 block reason으로 | 동일 |
   | base URL override | `ANTHROPIC_BASE_URL` 환경변수 | `openai_base_url` / `chatgpt_base_url` config 키 (env 아님) |

## Decision

**`pii-remover hook` 명령을 Codex hook으로 그대로 재사용한다.** 새 패키지나 새 명령은 만들지 않고, 같은 바이너리를 `~/.codex/config.toml`에 등록한다.

추가로 `pii-remover install --target codex` 서브커맨드를 도입해 TOML 편집을 자동화한다.

### Phase 4.5 동작 흐름

```
사용자 입력
   ↓
~/.codex/config.toml [[hooks.UserPromptSubmit]] 호출
   ↓
pii-remover hook (Claude Code hook과 동일 바이너리)
   ├─ stdin JSON 파싱 (Codex가 추가 필드를 보내도 무시)
   ├─ Detector로 PII 탐지
   ├─ Decision:
   │   ├─ PII 없음                       → exit 0 + 빈 stdout (allow)
   │   ├─ PII 있음 + proxy 미구성        → exit 0 + {"decision":"block","reason":"..."} (fail-closed)
   │   └─ PII 있음 + proxy 구성됨        → exit 0 + {"hookSpecificOutput":{"additionalContext":"..."}} (warn)
   └─ 실패 (예외/timeout 등)              → exit 2 + stderr 안내 (fail-closed)
   ↓
[Codex CLI]
   ↓ (prompt가 통과한 경우)
~/.codex/config.toml: openai_base_url = "http://localhost:8765/codex/v1"
   ↓
@pii-remover/proxy: 실제 PII 마스킹 + Responses API SSE 응답 복원 (ADR-0014)
   ↓
사용자 화면
```

### "proxy 구성됨" 판단 — Codex 전용

Codex는 환경변수 base URL override가 없다(librarian 검증 완료). 따라서 hook 프로세스가 proxy 구성을 자동으로 알 방법이 제한적이다. 두 가지 방안:

1. **`PII_REMOVER_PROXY_TRUST=1`** (기존 환경변수 재사용): 사용자가 명시 선언. **권장**.
2. **`OPENAI_BASE_URL` 환경변수**: Codex 자체는 이 env를 무시하지만, hook이 "proxy가 켜져 있을 의도"의 신호로 검사.

판단 로직은 `proxy-detection.ts`를 그대로 사용한다 — 그 함수가 이미 `PII_REMOVER_PROXY_TRUST=1`을 처리한다.

### `install --target codex` 동작

1. `~/.codex/config.toml`(global) 또는 `<project>/.codex/config.toml`(project) 읽기. 없으면 생성.
2. `[[hooks.UserPromptSubmit]]` 블록 안에 `[[hooks.UserPromptSubmit.hooks]]` 엔트리 추가 (idempotent — 같은 `command` 있으면 skip).
3. `.pii-remover.json` 작성 (다른 target과 동일).

TOML 편집은 외부 의존성 없이 직접 작성(수술적 패치): 기존 블록 보존, 중복 방지, 그 외 키 비파괴.

## Consequences

### Positive

- **새 패키지 불필요**: `@pii-remover/cli` 한 패키지가 Claude Code + Codex 둘 다 지원 → 사용자 셋업/유지보수 단순화.
- **프로토콜 호환**: librarian source-verified. hook stdin/stdout 핸들러 코드 재사용.
- **fail-closed 일관성**: Claude Code와 동일한 보안 모델. proxy 미구성 시 PII 차단.
- **추가 의존성 없음**: TOML 편집은 수술적 패치로 의존성 0.

### Negative

- **TOML 편집 위험**: 사용자가 손으로 편집한 복잡한 TOML 구조를 깨뜨릴 수 있음 → 보수적 정규식 + idempotent 검증 + dry-run flag로 완화. 시작 단계에서는 단순 케이스만 지원, 복잡한 케이스는 사용자에게 안내.
- **base URL env 부재**: Codex는 `openai_base_url`을 config.toml에서만 받음. install 시 이 키도 함께 설정하도록 안내.
- **`turn_id` / `model` 무시**: 현재 로직에 영향 없지만, 미래에 model-aware 정책이 생기면 활용 가능 — 지금은 안전한 ignore.

### 위험 / 미해결 사항

- **Codex hook이 matcher를 무시**: `UserPromptSubmit`는 항상 모든 prompt에서 실행 — 의도된 동작이며 PII 검출에는 도움.
- **`hook_event_name` 검사**: 현재 `parseHookInput`은 `"UserPromptSubmit"` 정확 일치만 허용. Codex도 같은 문자열 사용 → 검증 없이 호환.
- **`turn_id`로 인한 vault 관리**: hook은 매 turn마다 호출되지만 vault는 proxy가 관리. hook에서는 vault 영향 없음.

## Alternatives Considered

### (a) `@pii-remover/codex-hook` 별도 패키지 신설
- **거부 이유**: 프로토콜이 거의 동일해 코드 90% 중복. 두 패키지 동기화 부담. install 명령만 다르면 충분.

### (b) `~/.codex/config.toml` 대신 `.codex/hooks.json` 사용
- **거부 이유**: `hooks.json`은 legacy/external_agent_config 경로. config.toml이 공식 권장 경로([`config_toml.rs#L382-L383`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/config/src/config_toml.rs#L382-L383)).

### (c) `pii-remover hook --target codex` 플래그로 동작 분기
- **거부 이유**: 프로토콜이 동일하므로 분기 불필요. install만 분기.

### (d) TOML 파서 라이브러리(`smol-toml` 등) 추가
- **부분 채택 가능**: 미래에 복잡한 TOML 케이스가 늘면 채택. v1은 의존성 0 원칙 유지(번들 크기, 보안 표면 최소화).

## References

- source-verified (2026-05-13)
- `openai/codex` HEAD `27e67a8c2a98e0efef9e15282fb2719c09501ee4`
- [ADR-0012](./0012-claude-code-hook-protocol.md) — Claude Code hook 분석 (이 ADR과 쌍)
- [ADR-0014](./0014-codex-proxy-routing.md) — Codex Responses API proxy 라우팅
- [ADR-0004](./0004-local-llm-proxy-streaming.md) — proxy single source of truth
