# ADR-0014 — Local LLM Proxy: Codex Responses API 라우팅 (`/codex/v1/responses`)

- **Status**: Accepted
- **Date**: 2026-05-13
- **Supersedes**: (none)
- **Related**: [ADR-0004](./0004-local-llm-proxy-streaming.md), [ADR-0013](./0013-codex-hook-protocol.md)

## Context

ADR-0004는 proxy의 path-prefix 라우팅 모델을 정의: `/anthropic/v1/*` → Anthropic, `/openai/v1/*` → OpenAI Chat Completions. OpenAI Codex CLI는 **OpenAI Chat Completions가 아닌 Responses API**(`POST /v1/responses`)를 호출한다.

### 확인된 사실 (source-verified)

`openai/codex` HEAD `27e67a8c2a98e0efef9e15282fb2719c09501ee4`:

1. **호출 endpoint**: `POST {base_url}/responses`
   - 출처: [`codex-rs/codex-api/src/endpoint/responses.rs#L70-L99`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/codex-api/src/endpoint/responses.rs#L70-L99)

2. **request body — `ResponsesApiRequest`**:
   - 필드: `model`, `instructions` (string), `input` (Vec<ResponseItem>), `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `store`, `stream`, `include`, `service_tier`, `prompt_cache_key`, `text`, `client_metadata`
   - 출처: [`codex-rs/codex-api/src/common.rs#L169-L190`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/codex-api/src/common.rs#L169-L190)
   - **Chat Completions의 `messages: Message[]`와 다른 구조** — `input`은 `ResponseItem`(message/function_call/tool_use 등)의 배열.

3. **`ResponseItem` 안의 user/system 메시지 텍스트**:
   - `{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "..."}]}` 형식
   - OpenAI Responses API 공식 문서와 일치 (`input_text`, `output_text` content type)

4. **base URL override**: env 아니라 **config.toml**의 `openai_base_url` / `chatgpt_base_url`.
   - 출처: [`codex-rs/config/src/config_toml.rs#L316-L320`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/config/src/config_toml.rs#L316-L320)
   - 사용자가 `openai_base_url = "http://localhost:8765/codex/v1"`로 설정하면 proxy로 라우팅됨.

5. **인증**: `Authorization: Bearer <token>` — [`bearer_auth_provider.rs#L31-L46`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/model-provider/src/bearer_auth_provider.rs#L31-L46)

6. **Streaming**: `Accept: text/event-stream`, SSE.
   - 주요 이벤트:
     - `response.created`
     - `response.output_item.added`
     - `response.output_text.delta` — `data.delta = "..."` (텍스트 청크)
     - `response.output_text.done`
     - `response.output_item.done`
     - `response.completed`
     - `response.failed`
   - 출처: [`codex-rs/codex-api/src/sse/responses.rs#L263-L379`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/codex-api/src/sse/responses.rs#L263-L379)

## Decision

**proxy에 `/codex/v1/*` path prefix를 추가**한다. `/codex/v1/responses`는 Responses API 변환을 수행, 다른 `/codex/v1/*` 경로는 passthrough.

### Path 라우팅

| 클라이언트 path | proxy 동작 | upstream |
|---|---|---|
| `POST /codex/v1/responses` | **Responses 변환** (req mask + resp restore) | `https://api.openai.com/v1/responses` |
| `POST /codex/v1/*` (그 외) | passthrough | `https://api.openai.com/v1/*` |
| `GET /health` | 그대로 (providers 목록에 `codex` 추가) | - |

### 변환 규칙 — Request

`ResponsesApiRequest`의 다음 필드를 마스킹:

| 필드 | 처리 |
|---|---|
| `instructions: string` | `remover.mask()` |
| `input: ResponseItem[]` | 각 항목의 `content[i].text` (type=`input_text`) 마스킹 |
| `input: string` (대체 형식) | 전체 마스킹 (Responses API는 input을 string으로도 받음) |
| 그 외 | passthrough |

### 변환 규칙 — Response (non-streaming)

OpenAI Responses API 응답 body:
```jsonc
{
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [
        { "type": "output_text", "text": "..." }
      ]
    },
    {
      "type": "function_call",
      "arguments": "...",
      ...
    }
  ],
  "output_text": "...",  // convenience aggregation (some SDKs)
  ...
}
```

복원 대상:
- `output[i].content[j].text` (type=`output_text`)
- `output[i].arguments` (function_call의 JSON arg 문자열, OpenAI Chat과 같은 `walkRestore` 패턴)
- top-level `output_text` (있으면 복원)

### 변환 규칙 — Response (streaming SSE)

- `response.output_text.delta` 이벤트: `data.delta` 필드를 token-boundary buffer로 복원
- 다른 이벤트(`response.created`, `response.output_item.done`, `response.completed` 등): passthrough
- buffer는 `output_index` 단위로 분리(다중 output 시 안전)
- 종료 시 `flush()` — 기존 anthropic/openai 패턴 그대로

### 호환성

- **Anthropic / OpenAI Chat Completions 라우팅에 영향 없음**: 기존 `/anthropic/v1/messages`, `/openai/v1/chat/completions` 동작 불변.
- **Vault 공유**: 같은 proxy 인스턴스의 codex/anthropic/openai 요청은 같은 vault 사용 (한 프로젝트가 여러 호스트 혼용 시 PII 매핑 일관).

### 사용자 셋업

```toml
# ~/.codex/config.toml
openai_base_url = "http://localhost:8765/codex/v1"

[[hooks.UserPromptSubmit]]
  [[hooks.UserPromptSubmit.hooks]]
  type = "command"
  command = "/abs/path/to/pii-remover hook"
  timeout = 30
```

`pii-remover install --target codex`가 두 키 모두 자동 패치한다.

## Consequences

### Positive

- **Responses API 정확 대응**: Chat Completions과 다른 wire format을 source-verified로 정확히 매핑.
- **기존 토큰 boundary buffer 재사용**: `StreamBuffer` 그대로 사용 — 신규 코드 최소화.
- **3개 호스트 vault 공유**: Anthropic + OpenAI Chat + Codex Responses가 한 proxy 안에서 같은 vault 사용 — 멀티 호스트 사용자에게 일관성.

### Negative

- **새 provider 파일 2개 추가**: `providers/codex.ts`, `stream/codex-sse.ts`.
- **types.ts 확장**: `CodexResponsesRequestBody`, `CodexResponseItem` 등 새 타입.
- **Responses API 진화 위험**: OpenAI가 새 `ResponseItem` 타입(예: thinking 블록) 추가 시 transparent passthrough가 작동해야 함 — `type` 알 수 없는 항목은 그대로 통과.

### 위험 / 미해결 사항

- **`input`이 string인 케이스**: Responses API는 input을 단일 string으로도 받음. 두 형식 모두 처리.
- **`function_call.arguments` 변형**: streaming에서 arguments delta는 v1.x 백로그 (Chat과 동일 정책).
- **WebSocket 변환**: Codex는 WebSocket도 지원([`responses_websocket.rs`](https://github.com/openai/codex/blob/27e67a8c2a98e0efef9e15282fb2719c09501ee4/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L334-L350))하지만 v1은 HTTP/SSE만 지원. proxy URL이 `http://...`이면 Codex가 HTTP를 사용하므로 안전.

## Alternatives Considered

### (a) `/openai/v1/responses`로 기존 `/openai` prefix에 추가
- **거부 이유**: `/openai`는 Chat Completions 의미로 굳어짐. `/codex` 별도 prefix가 의미 분리에 명확.

### (b) Codex가 OpenAI Chat Completions 모드로 떨어뜨리도록 강제
- **거부 이유**: Codex는 Responses API 전용. config.toml로 강제 변경 불가.

### (c) Codex CLI 전용 별도 proxy 바이너리
- **거부 이유**: vault 공유 불가 → 멀티 호스트 사용자가 같은 PII에 대해 다른 토큰 받음.

### (d) WebSocket 변환 v1 포함
- **거부 이유**: HTTP/SSE만으로도 Codex 정상 동작. WebSocket은 자체 변환 로직 필요 → v1.x로 연기.

## References

- source-verified (2026-05-13)
- `openai/codex` HEAD `27e67a8c2a98e0efef9e15282fb2719c09501ee4`
- OpenAI Responses API 공식 문서 — `input_text` / `output_text` content type
- [ADR-0004](./0004-local-llm-proxy-streaming.md) — proxy 라우팅 + SSE 알고리즘 (재사용)
- [ADR-0013](./0013-codex-hook-protocol.md) — Codex hook (이 ADR과 쌍)
