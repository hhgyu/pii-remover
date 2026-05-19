# ADR-0004: 로컬 LLM 프록시 + path prefix 라우팅 + SSE 스트리밍 v1 필수

- **Status**: Accepted
- **Date**: 2026-05-12
- **Related**: [ARCHITECTURE.md §12.3](../ARCHITECTURE.md#123-local-llm-proxy), [ROADMAP.md Phase 3](../ROADMAP.md#phase-3--local-llm-proxy-스트리밍-라이브-변환-포함)

---

## Context

이 프로젝트의 가장 큰 architectural 결정. **호스트(OpenCode/Claude Code) hook 시스템만으로는 어시스턴트 응답 복원이 불가능**하다는 발견에서 출발했다.

### 호스트 hook 능력 (조사 결과)
| 능력 | OpenCode plugin | Claude Code hook |
|---|---|---|
| 사용자 프롬프트 변환 | ⚠ 명시 hook 없음 | ✅ `UserPromptSubmit` |
| 도구 입력 변환 | ✅ `tool.execute.before` | ✅ `PreToolUse` |
| **어시스턴트 응답 텍스트 변환** | ⚠ `message.part.updated` 변환 가능 여부 불확실 | ❌ **존재하지 않음** |
| 응답 후처리(Stop 등) | n/a | ❌ Stop은 종료 신호만 |

→ Claude Code에서 응답 복원할 hook 자체가 부재. OpenCode도 검증 필요. **양 호스트의 통일된 견고한 해법이 필요**.

### 검토 우회 방법
| 방법 | 견고성 | 보안 | 호스트 호환 |
|---|---|---|---|
| (a) 로컬 LLM 프록시 (`ANTHROPIC_BASE_URL=localhost`) | 높음 | 보존 | 양쪽 |
| (b) MCP 서버 후처리 | **불가능** (client-init RPC) | n/a | n/a |
| (c) System prompt self-correct | 매우 낮음 | **깨짐** — vault 노출 | 양쪽 |

### 추가 결정 사항 (사용자)
1. **단일 포트, path prefix 기반 라우팅**: `http://localhost:8765/anthropic/v1`, `http://localhost:8765/openai/v1`
2. **SSE 스트리밍 라이브 변환**: 개발자 도구는 토큰별 응답이 자연스러움. `stream:false` 강제는 UX 파괴.

---

## Decision

### 1. 로컬 LLM 프록시를 v1 필수 컴포넌트로 채택
- 패키지: `@pii-remover/proxy`
- Bun HTTP 서버, 단일 포트(기본 **8765**)
- Anthropic + OpenAI API 호환 endpoint 제공
- 마스킹/복원이 필요한 워크플로(특히 Claude Code)에서 사용자가 환경변수 2개로 활성화:
  ```bash
  export ANTHROPIC_BASE_URL=http://localhost:8765/anthropic/v1
  export OPENAI_API_BASE=http://localhost:8765/openai/v1
  ```

### 2. Path prefix 라우팅
| 클라이언트가 보내는 path | 프록시 라우팅 → 업스트림 |
|---|---|
| `POST /anthropic/v1/messages` | `https://api.anthropic.com/v1/messages` |
| `POST /openai/v1/chat/completions` | `https://api.openai.com/v1/chat/completions` |
| `POST /openai/v1/embeddings` | `https://api.openai.com/v1/embeddings` |
| (v1.x) `POST /google/v1/...` | `https://generativelanguage.googleapis.com/...` |
| (v1.x) `POST /groq/v1/...` | `https://api.groq.com/openai/v1/...` |

규칙: path 1차 segment(`/anthropic`, `/openai`)로 프로바이더 식별 → strip 후 나머지를 업스트림에 그대로 전달.

### 3. SSE 스트리밍 라이브 변환을 v1 필수로 채택
- non-streaming + streaming **양쪽 v1부터 지원**
- ARCHITECTURE.md §12.3.3의 **토큰 boundary buffering** 알고리즘 적용
- 클라이언트가 `stream: true`로 요청해도 사용자 체감 지연 없이 동작 (~20자 정도의 buffer window만)

#### 핵심 알고리즘
```text
ringBuffer = ""
for each SSE delta:
  ringBuffer += delta.text
  unsafeStart = findUnsafeBoundary(ringBuffer)   # `__OPF_...` prefix 보존
  safe = ringBuffer.slice(0, unsafeStart)
  if safe: emit(Restorer.scan(safe, vault))
  ringBuffer = ringBuffer.slice(unsafeStart)

on stream end:
  emit(Restorer.scan(ringBuffer, vault, lenient=true))
```

---

## Consequences

### 긍정적
- **양 호스트 통일 솔루션**: OpenCode `message.part.updated`가 변환 불가하더라도 프록시로 동작 보장.
- **확장성**: path prefix 라우팅으로 새 프로바이더(Google, Groq, Azure OpenAI) 추가가 코드 한 파일.
- **멀티 프로바이더 vault 공유**: 한 프록시 인스턴스가 Anthropic + OpenAI 호출 모두 핸들링 → 같은 PII가 두 LLM에서 동일 토큰 사용 (일관성).
- **방화벽/포트 관리 단순**: 단일 포트(8765)만 노출.
- **스트리밍 UX 보존**: 토큰별 응답이 그대로 보임 → 개발자 친화적.
- **인증 헤더 pass-through**: API 키를 프록시가 저장하지 않음. 사용자 신뢰 부담 ↓.

### 부정적
- **프로젝트 scope 확장**: 원래 "plugin/hook 프로젝트"가 "plugin + 로컬 HTTP 프록시"로 → 작업량 2~3배.
- **사용자 셋업 복잡도**: 환경변수 2개 설정 + 프록시 daemon 가동 필요. 자동화(`pii-remover install`) 필수.
- **API 형식 따라가기 부담**: Anthropic/OpenAI가 API 변경 시 프록시도 동시 업데이트. 특히 SSE 이벤트 형식 변경에 민감.
- **TLS 미지원 (localhost)**: 클라이언트가 localhost를 HTTPS로 요구하지 않으므로 평문 HTTP. 외부 노출 시 위험 — **127.0.0.1 바인딩 강제**.
- **스트리밍 구현 복잡도**: `findUnsafeBoundary()` 알고리즘 + fuzz 테스트 (delta 1~3자 쪼개기) 필수.

### 위험 / 미해결 사항
- **토큰 split 처리 버그 = PII 노출**: SSE 토큰 boundary buffering이 실패하면 마스킹된 토큰이 부분 노출 → 실질적 PII 누출. **delta 1~3자씩 쪼개는 fuzz 테스트 20건 이상 필수** (Phase 3 exit criteria).
- **LLM이 토큰 미완료 후 stream 종료**: `flush_on_close: true`로 lenient 매치 후 emit, 실패 시 원본 그대로 + 경고 로깅.
- **Anthropic vision content_block(이미지 입력) 통과**: v1 변환 없이 passthrough, 이미지 내 PII는 마스킹 안 됨 (v2 OCR + 마스킹).
- **Authorization 헤더 로깅 위험**: 명시적 로깅 금지 + 단위 테스트로 회귀 방지.

---

## Alternatives Considered

### (b) MCP 서버 후처리
- **거부 이유**: MCP는 client-initiated RPC 구조. 어시스턴트가 응답을 emit한 후 자동으로 호출되는 hook 메커니즘이 아님. 사용자가 명시적으로 "review my response" 같은 도구를 호출해야 동작 → 자동화 불가.

### (c) System prompt self-correct
- **거부 이유**: LLM에게 "이 토큰을 원본으로 복원해서 응답해줘"라고 지시하려면 vault를 system prompt에 넣어야 함 → **PII가 LLM에 노출되어 도구 목적 자체 무력화**. 보안 모델 파괴.

### Plugin/hook만으로 부분 동작 (응답에 토큰 그대로 노출)
- **부분 채택** (Phase 1 MVP): 마스킹만 동작, 사용자 화면에 `__OPF_PERSON_1__` 그대로 표시. 디버깅용. Phase 3에서 프록시로 완성.

### `stream: false` 강제 (v2에 스트리밍 미루기)
- **거부 이유 (사용자 요구)**: 개발자 도구는 토큰별 응답이 자연스러움. non-streaming 강제는 UX 크게 깨짐. 또한 Claude Code/OpenCode 모두 스트리밍이 default → 강제 우회 자체가 호스트 호환성 깨뜨림.

### 다중 포트 (Anthropic용 / OpenAI용 별도 포트)
- **거부 이유**: 사용자 환경변수 더 많이 설정, 방화벽 정책 복잡화, vault 격리되어 다중 프로바이더 일관성 손실. 단일 포트 + path prefix가 모든 면에서 우월.

### HTTPS 지원 (localhost 인증서)
- **연기 이유**: 127.0.0.1 바인딩이면 평문도 충분. mkcert/self-signed cert 통합은 복잡도 폭증. 외부 노출 시나리오가 생기면 ADR-XXXX로 별도 결정.

---

## Implementation Notes

### 패키지 구조
```
packages/proxy/
├── src/
│   ├── server.ts          # Bun HTTP 서버 (단일 포트 8765, 127.0.0.1 강제)
│   ├── router.ts          # path prefix → provider 라우팅
│   ├── providers/
│   │   ├── anthropic.ts   # /v1/messages 요청/응답 변환
│   │   └── openai.ts      # /v1/chat/completions 요청/응답 변환
│   ├── stream/
│   │   ├── buffer.ts      # ringBuffer + findUnsafeBoundary()
│   │   └── anthropic-sse.ts  # event: content_block_delta 파싱
│   │   └── openai-sse.ts     # data: {choices:[{delta:...}]} 파싱
│   └── cli.ts             # pii-remover proxy start/stop/status
└── package.json
```

### `findUnsafeBoundary()` 정규식
```typescript
const UNSAFE_TAIL = /(?:_|__|__O|__OP|__OPF|__OPF_[A-Z_]*\d*_?_?)$/
function findUnsafeBoundary(buffer: string, windowSize = 64): number {
  const tail = buffer.slice(-windowSize)
  const match = UNSAFE_TAIL.exec(tail)
  if (!match) return buffer.length
  return buffer.length - windowSize + match.index
}
```

### Phase 3 Exit Criteria (재명시)
- non-streaming 라운드트립 100건 ≥ 98%
- streaming 라운드트립 100건 ≥ 98%
- **토큰 split fuzz 테스트 20건 100%** (delta를 1~3자씩 쪼개도 복원 깨지지 않음)
- 인증 헤더 로깅 안 됨 (단위 테스트)
- 클라이언트 끊김 시 upstream abort + vault 유지

### 모니터링
- 환각 토큰(vault에 없는 매치): 발생 빈도 카운터
- 부분 매치(lenient regex): 발생 빈도 + 첫 케이스 sample
- stream flush 시 미완료 토큰: 빈도 카운터

---

## References
- Q3 결론: "Claude Code 응답 변환 hook 부재 — 프록시가 유일한 답"
- Claude Code hooks reference: https://docs.anthropic.com/en/docs/claude-code/hooks
- Anthropic Messages API SSE 명세: https://docs.anthropic.com/en/api/messages-streaming
- OpenAI Streaming API: https://platform.openai.com/docs/api-reference/streaming
- ADR-0002: 토큰 형식 (boundary buffering이 의존)
- ADR-0003: Vault 스키마 (응답 복원이 vault 참조)
