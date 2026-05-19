# ADR-0012 — Claude Code UserPromptSubmit hook: detection-only + fail-closed gate, masking delegated to proxy

- **Status**: Accepted
- **Date**: 2026-05-12
- **Supersedes**: (none)
- **Related**: [ADR-0004](./0004-local-llm-proxy-streaming.md), [ADR-0011](./0011-message-part-updated-feasibility.md), [ADR-0006](./0006-fail-closed-default.md)

## Context

Phase 4 목표는 Claude Code에서의 양방향 PII 마스킹/복원이다. 초기 계획은 `UserPromptSubmit` hook이 사용자 입력을 받아 마스킹된 텍스트로 **교체**한 뒤 Claude에게 전달하고, 응답은 ANTHROPIC_BASE_URL 프록시가 복원하는 구조였다.

ADR-0011처럼 같은 실수(존재하지 않는 hook 가정)를 피하기 위해 Claude Code 공식 문서 + GitHub anthropics/claude-code 리포지토리 source verification 수행 (2026-05-12).

### 확인된 사실 (source-verified)

[`docs.anthropic.com/en/docs/claude-code/hooks`](https://docs.anthropic.com/en/docs/claude-code/hooks) 및 GitHub issue [#37559](https://github.com/anthropics/claude-code/issues/37559)에서 다음이 확인됨:

1. **UserPromptSubmit hook stdin JSON**:
   ```json
   {
     "session_id": "abc123",
     "transcript_path": "/Users/.../<uuid>.jsonl",
     "cwd": "/Users/...",
     "permission_mode": "default",
     "hook_event_name": "UserPromptSubmit",
     "prompt": "사용자가 입력한 원본 텍스트"
   }
   ```

2. **stdout JSON에서 prompt를 교체하는 키는 존재하지 않는다**.
   - `updatedPrompt` 필드 없음.
   - `replacementPrompt` 필드 없음.
   - stdout 본문 자체를 새 prompt로 치환하는 동작도 없음.
   - 가능한 결과는 두 가지뿐:
     - **`additionalContext`**: 원본 prompt **옆에** 별도 컨텍스트 추가 (원본 prompt는 그대로 Claude에 전달됨 → PII가 노출됨).
     - **`decision: "block"`**: prompt 처리 자체를 차단하고 컨텍스트에서 삭제 (사용자에게 `reason` 표시).

3. **Exit code 규약**:
   - `0`: 성공 (stdout JSON 파싱하여 `additionalContext` 또는 `decision: "block"` 처리).
   - `1` / `64+`: 비차단 에러, "hook error" 표시 후 prompt 진행.
   - `2`: 차단 에러. UserPromptSubmit에서는 prompt 처리 차단 + 컨텍스트에서 prompt 삭제. stderr가 사용자에게 표시됨.

4. **설정 파일 우선순위**:
   - `~/.claude/settings.json` (사용자 전역, 비공유)
   - `.claude/settings.json` (프로젝트, 리포에 커밋 가능)
   - `.claude/settings.local.json` (프로젝트, .gitignore)

5. **Hook 등록 형식**:
   ```json
   {
     "hooks": {
       "UserPromptSubmit": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "/abs/path/to/pii-remover hook",
               "timeout": 30
             }
           ]
         }
       ]
     }
   }
   ```
   `UserPromptSubmit`은 `matcher` 필드를 지원하지 않고 항상 모든 prompt에서 실행됨.

6. **기본 timeout**: `type: "command"` 기본 600초. `timeout` 키로 hook별 override.

## Decision

**Hook은 "마스킹"을 수행하지 않는다. Hook은 detection + fail-closed gate만 담당한다. 실제 마스킹/복원은 `@pii-remover/proxy`가 `ANTHROPIC_BASE_URL` 가로채기로 수행한다.**

### Phase 4 동작 흐름

```
사용자 입력
   ↓
~/.claude/settings.json의 UserPromptSubmit hook 호출
   ↓
pii-remover hook (이 패키지)
   ├─ stdin JSON 파싱
   ├─ Detector로 PII 탐지
   ├─ Decision:
   │   ├─ PII 없음                  → exit 0 + 빈 stdout (allow)
   │   ├─ PII 있음 + proxy 미구성   → exit 0 + {"decision":"block","reason":"..."} (fail-closed)
   │   └─ PII 있음 + proxy 구성됨   → exit 0 + {"hookSpecificOutput":{"additionalContext":"..."}} (warn)
   └─ 실패 (예외/timeout 등)         → exit 2 + stderr 안내 (fail-closed)
   ↓
[Claude Code]
   ↓ (prompt가 통과한 경우)
ANTHROPIC_BASE_URL → http://localhost:8765/anthropic/v1
   ↓
@pii-remover/proxy: 실제 PII 마스킹 + 응답 복원
   ↓
사용자 화면
```

### "proxy 구성됨" 판단

Hook 프로세스의 `process.env.ANTHROPIC_BASE_URL`를 검사. 다음 중 하나면 "구성됨":

- `http://localhost:<port>/anthropic/v1`
- `http://127.0.0.1:<port>/anthropic/v1`
- `http://[::1]:<port>/anthropic/v1`
- 환경변수 `PII_REMOVER_PROXY_TRUST=1`이 명시되어 있으면(사용자 신뢰 선언) `ANTHROPIC_BASE_URL`이 무엇이든 "구성됨"으로 간주.

판단 코드: `packages/cli/src/protocol/proxy-detection.ts` (원래 `packages/claude-hook/`, v0.1.x에서 rename).

### "fail-closed" exit code 선택

- `decision: "block"` + exit 0: stdout JSON으로 차단. **권장**. 구조화된 reason을 사용자에게 표시할 수 있음.
- exit 2 + stderr: stderr 텍스트로 차단. **fallback**. JSON 파싱 자체가 실패하는 catastrophic 케이스에만 사용.

## Consequences

### Positive

- **명시적 보안 모델**: hook은 "prompt가 LLM에 도달하기 전에 PII 검출 + 사용자 경고 + 차단" 단일 책임만 수행 → 디버깅 용이.
- **proxy와의 책임 분리**: 마스킹은 proxy의 단일 진실 공급원(single source of truth). hook과 proxy가 다른 결과를 내는 race condition 없음.
- **ADR-0011과 일관성**: OpenCode `message.part.updated` 부재 발견 시와 동일한 source-verified 접근. 추측이 아닌 사실 기반 설계.
- **fail-closed 보강**: 사용자가 proxy를 켜는 것을 잊어도 hook이 PII 누출을 사전 차단.

### Negative

- **사용자 셋업 2단계 필수**: ① `pii-remover install --target claude-code` ② `ANTHROPIC_BASE_URL=http://localhost:8765/anthropic/v1` + proxy 가동. README/installer가 두 단계 모두 안내해야 함.
- **prompt 그 자체로는 변환 불가**: 사용자가 "PII가 마스킹된 prompt를 보고 싶다"고 요청해도 hook 단계에서는 불가능. proxy 로그를 참조하도록 안내.
- **proxy 미구성 시 UX 마찰**: PII 포함 prompt가 차단되면 사용자가 다시 입력하거나 PII를 제거해야 함. `reason`을 충분히 친절하게 작성 필요.

### 위험 / 미해결 사항

- **Hook과 proxy의 PII 분류 불일치**: 둘 다 같은 `@pii-remover/core` Detector를 사용해 같은 결과를 내야 함. config 파일 공유 필수. README에 강조.
- **사용자가 `PII_REMOVER_PROXY_TRUST=1`을 무분별하게 설정**: proxy가 실제 동작하지 않아도 hook이 통과시킴. 환경변수 이름에 "TRUST"를 포함시켜 의미를 명확히. README에 보안 경고.
- **Hook의 PII 탐지가 사용자가 명시한 카테고리에서만 동작**: config의 `detection.enabled_categories`와 일치해야. 이 파일은 같은 lookup chain(`.opencode/pii-remover.json` → `~/.config/pii-remover/config.json` → DEFAULT_CONFIG)을 따른다.

## Alternatives Considered

### (a) hook stdout에 `updatedPrompt`를 넣어 마스킹 prompt로 교체
- **거부 이유**: 그런 키는 존재하지 않음 (source 확인 완료). 시도 시 hook은 동작은 하지만 stdout은 무시되고 원본 PII가 LLM에 그대로 전달됨 → 보안 회귀.

### (b) `additionalContext`에 마스킹된 prompt를 넣고 "원본 무시하고 이것만 보세요"라고 LLM에 지시
- **거부 이유**: 원본 prompt가 여전히 컨텍스트에 포함되어 LLM에 PII가 노출됨. ADR-0006(fail-closed) 위반. system prompt self-correct(ADR-0004 alternative c)와 동일한 보안 모델 파괴.

### (c) exit 2 + stderr만 사용 (JSON 미사용)
- **거부 이유**: stderr는 사용자에게 그대로 표시되지만 구조화된 `decision`/`reason` 분리가 어렵고, JSON parsing에 실패한 case와 의도적 차단 case를 구별하기 어려움. (a)에 가까운 패턴이 더 명확함.

### (d) Hook 없이 proxy만 사용
- **부분 채택**: 마스킹은 proxy만으로 충분. 그러나 사용자가 proxy를 켜는 것을 잊은 경우(또는 ANTHROPIC_BASE_URL이 잘못 설정된 경우) PII가 직접 LLM에 노출. Hook은 이 fail-closed 보강을 위한 안전망.

### (e) Hook이 직접 마스킹 후 stdout으로 새 prompt 출력
- **거부 이유**: Claude Code 문서 + 코드 모두 stdout 본문을 새 prompt로 치환하는 동작을 지원하지 않음. (a)와 동일.

## References

- [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) (확인일 2026-05-12)
- [Hooks guide](https://docs.anthropic.com/en/docs/claude-code/hooks-guide) (확인일 2026-05-12)
- GitHub issue [#37559](https://github.com/anthropics/claude-code/issues/37559) — prompt hooks limitation
- GitHub issue [#31114](https://github.com/anthropics/claude-code/issues/31114) — mid-turn UserPromptSubmit regression
- GitHub issue [#26474](https://github.com/anthropics/claude-code/issues/26474) — agent hook type bug → command 권장
- [ADR-0004](./0004-local-llm-proxy-streaming.md) §Alternatives — proxy가 single source of truth
- [ADR-0011](./0011-message-part-updated-feasibility.md) — source-verification의 중요성
