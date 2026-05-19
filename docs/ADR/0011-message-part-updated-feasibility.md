# ADR-0011: OpenCode response restoration via `experimental.text.complete` + `tool.execute.after`

- **Status**: Accepted
- **Date**: 2026-05-12
- **Related**: [ADR-0004](./0004-local-llm-proxy-streaming.md), [ADR-0009](./0009-vision-multimodal-v2.md), [ARCHITECTURE.md §12.1](../ARCHITECTURE.md), Wave 2-B (Restorer 본격 구현)

---

## Context

ADR-0004와 ARCHITECTURE.md §12.1을 작성할 때, OpenCode plugin에 `message.part.updated`라는 hook이 있다고 가정했다. Phase 2 직전에 이 가정이 **사실이 아님**을 발견.

### 검증 출처
[`packages/plugin/src/index.ts`](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/plugin/src/index.ts) 의 공식 `Hooks` interface 직접 검사. 전체 hook 목록:

| Hook | Output param? | Phase 2 활용 가능성 |
|---|---|---|
| `event` | ❌ 없음 (`Promise<void>` only) | **관찰 전용 — 응답 변환 불가** |
| `config` | ❌ | 설정 정도만 |
| `auth`, `provider` | ❌ | OAuth/provider 설정 |
| `chat.message` | ✅ `{ message, parts }` | 변환 가능, 다만 stream 시작 전 |
| `chat.params` | ✅ `{ temperature, ... options }` | LLM 파라미터만 |
| `chat.headers` | ✅ `{ headers }` | HTTP 헤더만 |
| `permission.ask` | ✅ `{ status }` | 권한 결정 |
| `command.execute.before` | ✅ `{ parts }` | 커맨드 변환 |
| `tool.execute.before` | ✅ `{ args }` | **Phase 1 사용 중** |
| `tool.execute.after` | ✅ `{ title, output, metadata }` | **NEW: 도구 결과 복원** |
| `shell.env` | ✅ `{ env }` | 환경변수 |
| `experimental.chat.messages.transform` | ✅ `{ messages: [...] }` | 메시지 전체 변환 (실험적) |
| `experimental.chat.system.transform` | ✅ `{ system: [...] }` | 시스템 프롬프트 변환 |
| `experimental.session.compacting` | ✅ `{ context, prompt? }` | 압축 컨텍스트 |
| `experimental.compaction.autocontinue` | ✅ `{ enabled }` | 자동 연속 |
| **`experimental.text.complete`** | ✅ `{ text }` | **NEW: 어시스턴트 응답 텍스트 변환 (실험적)** |
| `tool.definition` | ✅ `{ description, parameters }` | 도구 정의 변환 |

### 결론 (단정)
- `message.part.updated`는 **존재하지 않는 hook**. ARCHITECTURE.md §12.1과 ADR-0004의 해당 언급은 부정확.
- `event` hook은 **OBSERVATION_ONLY** — output 인자가 없어 어떤 변환도 불가능.
- 어시스턴트 응답 텍스트 변환은 **`experimental.text.complete`로 가능** (실험적 안정성).
- 도구 결과(`tool.execute.after`의 `output.output`)에 등장하는 토큰 복원은 **안정 hook으로 가능**.

---

## Decision

### 1. **두 단계 응답 복원**: `tool.execute.after` (안정) + `experimental.text.complete` (실험적)

- **`tool.execute.after`**: 도구 결과(`output.output` 문자열)에 마스킹 토큰이 등장하면 `PIIRemover.restore()`로 원본 복원. **안정 API**, 항상 등록.
- **`experimental.text.complete`**: 어시스턴트의 최종 응답 텍스트(`output.text`)에 마스킹 토큰이 등장하면 복원. **실험적 API**, 사용자가 `experimental: false`로 비활성화 가능.

### 2. `event` hook으로는 응답 변환 시도하지 않음
관찰 전용으로만 사용 (vault dispose, 진단 로깅).

### 3. Phase 3 (Local LLM Proxy) 의존성 — **일부 완화, 여전히 권장**

| 시나리오 | OpenCode plugin만으로 충분? | Phase 3 proxy 필요? |
|---|---|---|
| OpenCode 사용자, 응답 텍스트 복원 | ✅ `experimental.text.complete` | ❌ optional (안정성 향상용) |
| OpenCode 사용자, 도구 결과 복원 | ✅ `tool.execute.after` | ❌ optional |
| Claude Code 사용자 | ❌ (Phase 4 hook 한계) | ✅ **필수** |
| Streaming live 변환 (SSE 토큰 단위) | ❌ plugin은 텍스트 완성 후 처리 | ✅ proxy가 더 적합 |
| 양 호스트 통일된 보안 보장 | ❌ | ✅ 권장 |

→ Phase 3 proxy는 여전히 ROADMAP 대로 진행. Phase 2에서 OpenCode 사용자가 텍스트 라운드트립 즉시 체험 가능한 것이 boost.

### 4. ARCHITECTURE.md §12.1 정정
잘못된 `message.part.updated` 언급을 `experimental.text.complete` + `tool.execute.after`로 교체. ADR-0004의 OpenCode 응답 복원 시나리오도 동기화.

---

## Consequences

### 긍정적
- **Phase 2 출시 시 OpenCode 사용자는 plugin만으로도 라운드트립 동작**. 이전 가정은 "Phase 3 proxy 없으면 응답에 토큰 그대로" — 이제 OpenCode 한정으로 즉시 양방향.
- **`tool.execute.after`는 안정 API**: 도구 결과(예: Read tool이 마스킹된 파일 내용 반환) 복원이 견고하게 동작.
- 사용자 옵트아웃 가능: `experimental.text.complete`가 실험적이라 안정성 우려 있으면 옵션으로 비활성화.

### 부정적
- `experimental.*` hook은 향후 API 변경 가능성 높음 — OpenCode 메이저 버전 업데이트 시 plugin 깨질 위험. **완화**: peer dep semver pin + 새 OpenCode 버전 출시 시 회귀 테스트.
- ARCHITECTURE.md §12.1, ADR-0004, ADR-0009의 OpenCode 관련 응답 변환 언급 모두 갱신 필요.
- `experimental.text.complete`가 **partID 단위로 호출**되는지 **메시지 종료 시점에 한 번**인지 source상 명확하지 않음 → 우리 plugin은 idempotent 복원(이미 복원된 텍스트에 추가 토큰 없으면 no-op) 보장하여 양쪽 모두 안전.

### 위험 / 미해결 사항
- **streaming(SSE) 단위 변환**: `experimental.text.complete`가 최종 텍스트만 받는지, 점진적으로 받는지 미확정. 점진적이면 토큰 boundary buffering(ADR-0004 §12.3.3) 필요 — 그 알고리즘이 proxy에 이미 있으므로 v1.x에서 plugin으로 portable 가능.
- **`message.part.updated`처럼 사라질 hook**: 우리는 실제 source 검증을 거쳤지만, 다른 미발견 가정이 더 있을 수 있음. **회귀 방지**: 모든 hook 등록 위치에 OpenCode minor 버전 명시 + CI에서 `@opencode-ai/plugin` 타입 import 후 cross-check.
- **카테고리 토큰을 LLM이 보존 못 한 경우**: Wave 2-B 의 lenient regex가 대소문자/suffix 누락 처리하지만, 토큰을 한국어로 번역(예: `__OPF_PERSON_1__` → `[개인_인물_1]`)하면 매치 실패. proxy의 system prompt injection이 더 견고 — Phase 3에서 보강.

---

## Alternatives Considered

### `event` hook으로 응답 변환 시도
- **거부 이유**: `Hooks.event`는 `(input: { event: Event }) => Promise<void>` 시그니처. **output 인자 없음** → 변환 불가능. 관찰만.

### `chat.message` hook 사용
- **거부 이유**: 메시지 도착 직전 호출. **사용자 입력 변환에는 적합**하지만 (Phase 1의 `tool.execute.before`와 역할 겹침), 어시스턴트 응답은 아직 생성 전이라 복원 대상 없음.

### `experimental.chat.messages.transform`만 사용
- **연기 이유**: 전체 메시지 배열 변환이 가능하나, 입력+출력 모두 포함되어 의도치 않은 마스킹 토큰 재마스킹 위험. `tool.execute.after` + `experimental.text.complete` 조합이 단순하고 책임 분리 명확.

### Phase 3 proxy 전부 우선
- **부분 채택**: proxy는 ROADMAP대로 진행. 단 OpenCode 한정으로 Phase 2에서 즉시 작동하는 plugin-level 복원은 사용자 가치 큼 — 양쪽 함께 가는 게 정답.

### `message.part.updated`를 OpenCode upstream에 PR 요청
- **거부 이유**: 우리 v1 일정 영향. 이미 `experimental.text.complete`가 동등 기능 제공.

---

## Implementation Notes

### `tool.execute.after` 등록 (안정)
```typescript
async "tool.execute.after"(input, output) {
  if (typeof output.output !== "string") return;
  const restored = remover.restore(output.output);
  output.output = restored.text;
  // 부분 매치/환각 토큰은 warn 콜백으로 로깅 (PIIRemover.restore 내장)
}
```

### `experimental.text.complete` 등록 (실험적, opt-out)
```typescript
async "experimental.text.complete"(input, output) {
  if (typeof output.text !== "string") return;
  const restored = remover.restore(output.text);
  output.text = restored.text;
}
```

### 옵션
- `PiiRemoverPluginOptions.experimental` (기본 `true`)
  - `true`면 `experimental.text.complete` 등록
  - `false`면 stable hook(`tool.execute.after`)만 등록 — 사용자가 실험적 API 회피

### Idempotency
- Wave 2-B 의 `Restorer.restore()`는 vault에 없는 토큰을 원본 보존하므로, 이미 복원된 텍스트에 다시 호출해도 변경 없음. partial-match에서 우연히 다시 매치되더라도 vault에 없으면 그대로 통과.

### Hook 우선순위 (OpenCode 보장은 명시 없음, 등록 순서로 안정 동작)
1. `tool.execute.before` — 도구 args 마스킹 (Phase 1)
2. `tool.execute.after` — 도구 output 복원 (Phase 2 NEW)
3. `experimental.text.complete` — 어시스턴트 응답 복원 (Phase 2 NEW, 실험적)
4. `event` — vault dispose (Phase 1)

---

## References

- OpenCode plugin Hooks interface 공식 정의 (source 직접 검증, 2026-05-12 시점):
  `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/plugin/src/index.ts`
- ADR-0004: Local LLM Proxy (양 호스트 통일 솔루션, 여전히 권장)
- ADR-0009: Vision passthrough (관련 hook 결정 패턴 참조)
- ARCHITECTURE.md §12.1 (정정 대상)
- Wave 2-B `PIIRemover.restore()` (`packages/core/src/pii-remover.ts`, `packages/core/src/restorer/index.ts`)
