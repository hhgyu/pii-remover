# ADR-0016: MCP Server 노출 — `@pii-remover/mcp-server`

- **Status**: Accepted
- **Date**: 2026-05-19
- **Related**: [ADR-0001](./0001-typescript-single-core.md) (TS 단일 core), [ADR-0003](./0003-vault-session-in-memory.md) (vault 인메모리), [ADR-0004](./0004-local-llm-proxy-streaming.md) (proxy 패턴), [ADR-0006](./0006-fail-closed-default.md) (fail-closed), [ADR-0011](./0011-message-part-updated-feasibility.md) (OpenCode hooks)

---

## Context

### 시장 카테고리 확장 기회

현재 `pii-remover`는 3대 AI 코딩 도구(Claude Code · OpenCode · Codex CLI)에 host-specific 통합 코드(hook / plugin / proxy)로 들어간다. 새 host를 추가하려면 매번 호스트별 통합 코드를 짜야 한다.

**Model Context Protocol (MCP)** 은 이 문제를 한 번에 해결할 수 있는 표준이다. 한 번 MCP server를 구현하면:

| MCP-compatible 클라이언트 | 본 프로젝트 현 상태 | MCP server 후 |
|---|---|---|
| **Claude Desktop** | 미지원 | 자동 지원 |
| **Cursor** | 미지원 | 자동 지원 |
| **Cline** (VS Code) | 미지원 | 자동 지원 |
| **Cody** | 미지원 | 자동 지원 |
| **OpenCode** (이미 native plugin) | ✅ in-process plugin | + MCP 옵션 |
| **Continue** / **Aider** / **Codex** | 미지원 / partial | 점진적 지원 |

### 경쟁 분석

**CloakLLM** (`cloakllm/CloakLLM`)이 같은 카테고리의 OSS 도구 중 유일하게 MCP server를 보유한다. 7개 tool 노출:
- `sanitize`, `sanitize_batch`, `desanitize`, `desanitize_batch`, `analyze`, `analyze_batch`, `analyze_context_risk`

본 프로젝트는 CloakLLM 대비 한국어 PII + AI 코딩 CLI 통합이라는 우위가 있으나, **MCP 진입은 아직** — 시장 표준 통합 포인트를 놓치고 있음.

### 기술 제약

- `@pii-remover/core`의 `PIIRemover.mask/restore/dispose` API가 이미 host-agnostic. MCP server는 **얇은 wrapper**가 된다.
- MCP TS SDK는 Node.js / Bun / Deno 모두 지원 — 본 프로젝트의 Bun-first 정책과 충돌 없음.
- MCP spec 2025-11-25 기준: transport는 **stdio** + **Streamable HTTP** 두 가지. SSE는 legacy.
- MCP protocol은 자체 session id (`MCP-Session-Id`)를 가지나 stdio 모드에서는 process == session으로 implicit.

### 본 ADR이 답해야 할 질문

1. 어느 SDK 버전을 사용할 것인가? (v1 stable vs v2 alpha)
2. 어느 transport를 v1부터 지원할 것인가?
3. 어느 MCP tool들을 노출할 것인가? (minimal vs CloakLLM 호환)
4. Vault/session lifecycle을 MCP-session에 묶을 것인가, 독립 `vault_id`로 노출할 것인가?
5. Tool output schema는 어떻게 정의할 것인가?
6. Logging은 어떻게 — stdio mode에서 stdout 금지 제약 하에?
7. Error semantics — tool-level `isError` vs protocol-level JSON-RPC error?
8. 런타임 정책 — Bun-only인가 Node 호환인가?

---

## Decision

### 1. SDK 버전 — `@modelcontextprotocol/sdk` v1.x (stable)

- 패키지: `@modelcontextprotocol/sdk` (v1.29.0 현재 stable on npm)
- v2 split packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`)는 alpha — production 사용 비권장 (repo README 명시)
- v1 → v2 마이그레이션 시점은 v2 stable 도달 후 별도 ADR로 갱신

**근거**: production 안정성. v1은 `McpServer` 클래스 + `registerTool()` + `connect(transport)` 단순 API. Standard Schema (Zod) 입력/출력 지원. 추후 v2 stable 도달 시 마이그레이션 부담 작음 (API 표면 거의 동일).

### 2. Transport — stdio default + Streamable HTTP opt-in, SSE 비지원

| Transport | v1 지원 | 기본 동작 | 활성화 |
|---|---|---|---|
| **stdio** | ✅ default | 항상 활성 | `pii-remover-mcp` 실행 |
| **Streamable HTTP** | ✅ opt-in | 비활성 | `pii-remover-mcp --transport http --port 8766` |
| **SSE (legacy)** | ❌ 미지원 | — | spec deprecated, 신규 서버 의무 X |

**근거**: 
- stdio: Claude Desktop / Cursor / Cline / Codex 모두 stdio를 기본 지원. 단일 transport로 시장 커버리지 90%+.
- Streamable HTTP: 원격 호스팅 / 컨테이너 시나리오 + 향후 멀티 클라이언트 공유 vault 시나리오 대비. **v1부터 옵션으로 제공**하되 기본은 비활성.
- SSE: spec에서 Streamable HTTP에 의해 대체됨. 신규 구현 의무 없음. 사용자가 명시 요청 시 v1.x에서 별도 ADR로 추가.

### 3. Tool surface — 5개 (CloakLLM 호환 + Korean-aware)

| Tool | 입력 | 출력 | 비고 |
|---|---|---|---|
| `sanitize` | `{ text: string, vault_id?: string }` | `{ text, vault_id, token_count, categories, latency_ms, backend_name }` | 마스킹. vault_id 없으면 신규 생성, 있으면 기존 vault에 append. |
| `sanitize_batch` | `{ texts: string[], vault_id?: string }` | `{ results: SanitizeResult[], vault_id }` | 동일 vault에 여러 텍스트 일괄. 토큰 dedup 보존. |
| `desanitize` | `{ text: string, vault_id: string }` | `{ text, restored_count, unknown_token_count, partial_match_count }` | 복원. vault_id 필수 (없으면 isError). |
| `desanitize_batch` | `{ texts: string[], vault_id: string }` | `{ results: DesanitizeResult[] }` | 일괄 복원. |
| `analyze` | `{ text: string }` | `{ detections: Detection[], backend_name, latency_ms }` | vault에 저장 안 함 — 진단 전용. |

**Out of scope (v2 후보)**:
- `analyze_context_risk` (CloakLLM): re-identification 위험 점수화. 본 프로젝트 `ContextAnalyzer` 미구현 — Phase 11+에서.
- `dispose_vault`: client가 명시적 정리 원할 시. 현재 LRU + TTL로 자동 정리 ([§4](#4-vaultsession-lifecycle--opaque-vault_id)). 사용자 요청 빈도 확인 후 추가.
- `health`: MCP `notifications/initialized` + tool description으로 충분. 추가 tool 불필요.

**근거**: CloakLLM의 4개 핵심 (sanitize/desanitize × single/batch) + analyze 하나 = 시장 호환성 확보. context_risk는 본 프로젝트 미구현 기능이라 v1에서 제외.

### 4. Vault/session lifecycle — opaque `vault_id`

#### 4.1 모델

`vault_id`는 server-generated opaque string. MCP-Session-Id와 **독립**.

- `sanitize` 호출 시 `vault_id` 미제공 → 서버가 신규 `PIIRemover` 인스턴스 생성, 새 sessionId 부여, `vault_id` 반환
- `sanitize` 호출 시 기존 `vault_id` 제공 → 동일 vault에 append, 같은 PII는 같은 token 재사용 (dedup 보존)
- `desanitize`는 `vault_id` 필수 — 없으면 `isError: true`
- 서버 내부 풀: `Map<vault_id, PIIRemover>` (in-memory only, ADR-0003 일관)

#### 4.2 라이프사이클 정책

| 이벤트 | 동작 |
|---|---|
| `sanitize` (vault_id 없음) | 신규 PIIRemover 생성, vault_id 반환 |
| `sanitize` / `desanitize` (vault_id 있음, 풀에 존재) | 풀에서 lookup, last_access 갱신 |
| `sanitize` / `desanitize` (vault_id 있음, 풀에 없음 / TTL 만료) | `isError: true` + `error_code: "vault_not_found"` |
| 풀 LRU 한계 도달 (default 100 vault) | 가장 오래된 vault dispose |
| TTL 만료 (default 1시간 미사용) | 백그라운드 sweeper로 dispose |
| MCP-Session 종료 (`onsessionclosed`, Streamable HTTP only) | 해당 session이 사용한 vault만 dispose |
| 서버 프로세스 종료 | 모든 vault dispose (in-memory 자동) |

#### 4.3 MCP-Session-Id와의 관계

- stdio: 1 process = 1 implicit session. 모든 tool call이 같은 client. vault_id로 다중 vault 격리.
- Streamable HTTP: `sessionIdGenerator` 활성화. MCP session 종료 시 그 session이 만든 vault만 정리 (cross-session vault 공유 미지원).

**근거**:
- CloakLLM이 같은 패턴 (TokenMap session-scoped, never persisted)
- `vault_id` 명시 노출 = client가 multi-turn 대화에서 같은 vault 재사용 가능 → "철수" 마스킹 후 다음 prompt에서 또 마스킹 시 같은 토큰
- MCP-Session-Id에 직접 묶지 않은 이유: stdio mode에서 session 개념이 implicit + Streamable HTTP에서 short-lived stateless 클라이언트 시나리오에서 매번 새 vault 만들면 dedup 깨짐. opaque vault_id가 transport-agnostic.

### 5. Output schema — `structuredContent` 사용

MCP SDK v1은 tool 결과로 `content` (사람용 텍스트) + `structuredContent` (machine-readable) 양쪽 지원. 본 서버는 **둘 다** 반환:

```typescript
return {
  content: [{ type: "text", text: `Masked ${tokens.length} entities.` }],
  structuredContent: {
    text: maskedText,
    vault_id: vault.id,
    token_count: tokens.length,
    categories: { private_email: 2, rrn: 1 },
    latency_ms: 3.2,
    backend_name: "local-regex+opf-http",
  },
};
```

**`structuredContent`는 schema-validated** (Zod). 클라이언트가 typed 응답 받음. `content`는 사람이 보는 간단 요약 (PII 미포함).

### 6. Logging — MCP `notifications/message` 채널만

- **stdout 금지** (stdio mode): JSON-RPC 채널이라 로그 섞이면 transport 깨짐
- **stderr는 부팅 에러 / 패닉 only**: 운영 로그는 stderr 안 씀
- **MCP `logging` capability 선언** + `server.sendLoggingMessage(...)` 사용
- 클라이언트가 log level 설정 가능 (`logging/setLevel`)
- **PII plaintext 절대 미로깅** (`@pii-remover/core` audit emitter와 동일 invariant)

**로그 내용**: backend_name, vault_id, latency, category counts, error class. **never**: 원본 text, 마스킹된 text, vault entry value.

**audit log (별도 파일)**: `@pii-remover/core`의 `AuditEmitter`를 그대로 사용 — `audit.enabled: true` + `audit.log_path` 설정 시 JSONL 출력. MCP server에 별도 audit 로직 추가 안 함.

### 7. Error semantics

| 상황 | 응답 |
|---|---|
| 입력 schema 위반 (text가 number 등) | JSON-RPC error `-32602` (Invalid params) — SDK가 자동 처리 |
| `vault_id` 미존재 / 만료 | tool 결과 `isError: true` + `content: [{ type: "text", text: "vault not found: ..." }]` + `structuredContent: { error_code: "vault_not_found" }` |
| `PIIRemover.mask()` 가 `FailClosedError` throw | tool 결과 `isError: true` + `error_code: "detection_failed"` + bypass 가이드 메시지 |
| Backend 타임아웃 / 네트워크 오류 | failure_policy에 따름. `closed` (default)면 `isError: true`. `hybrid`면 regex fallback 결과 반환 (성공) |
| Server internal panic | JSON-RPC error `-32603` (Internal error) — SDK 자동 처리 |

**근거**:
- semantic error (vault 없음, detection 실패) → LLM이 retry/사용자 안내 가능하도록 `isError: true` + structured `error_code`
- protocol error (schema 위반) → JSON-RPC 표준 코드 — LLM이 retry 시도 안 함
- `PIIRemover.FailClosedError`는 의도된 정상 동작이므로 tool-level error로 노출 (ADR-0006 fail-closed 일관)

### 8. 런타임 — Bun-first, Node 18+ 호환

- 빌드: Bun 1.0+ (기존 packages와 동일)
- 단일 바이너리 배포 (Bun compile) for 4 platforms: linux-x64, darwin-arm64, darwin-x64, windows-x64 (CLI 패키지와 동일 패턴)
- npm 배포: dist/ ESM + Node 18+ 호환
- MCP SDK 자체가 Node.js / Bun / Deno 모두 지원 (repo README 확인)

**배포 채널**:
- `npm install -g @pii-remover/mcp-server` → `pii-remover-mcp` 명령어
- 단일 바이너리: GitHub Releases (CLI와 동일)
- Docker 이미지 (Streamable HTTP 시나리오): 별도 — 사용자 요청 시 v1.x

---

## Consequences

### 긍정적

- **시장 진입**: Claude Desktop / Cursor / Cline / Cody 등 MCP-compatible 클라이언트 자동 커버. 호스트별 통합 코드 없이 한 패키지로 N개 클라이언트.
- **차별점 강화**: 한국어 PII + OPF native + AI coding 통합에 더해 **MCP 표준 호환**. CloakLLM과 동등 surface (5 tools) + 본 프로젝트 한국어 우위.
- **Core 변경 0**: 기존 `@pii-remover/core` API 그대로 매핑. Risk surface 최소.
- **사용자 셋업 단순**: `npx @pii-remover/mcp-server` 한 줄 + 클라이언트 config `command`/`args` 추가.
- **Streamable HTTP 옵션**: 향후 sandbox / 컨테이너 / 멀티 client 시나리오 대비.

### 부정적

- **신규 패키지 1개 추가**: 모노레포 빌드 시간 +α, 의존성 관리 부담 (+`@modelcontextprotocol/sdk`).
- **MCP-Session vs vault_id 2단 추상화**: 사용자가 두 개념 차이 이해 필요. README에 명확히 문서화.
- **SDK v1 → v2 마이그레이션 부담**: v2 stable 도달 시 별도 작업. 추정 1~2일 (API 표면 거의 동일).
- **Stream-aware tool 미지원 (v1)**: tool 응답 자체는 batch (long-running tool의 progressive 출력은 v2 spec). `sanitize`는 short-lived이라 무관.

### 위험 / 미해결

- **MCP spec 변경 위험**: 2025-11-25 spec 기준 작성. 향후 transport/session 모델 변경 시 마이그레이션. SDK upstream이 흡수해줄 가능성 높음.
- **클라이언트별 transport 호환성 차이**: Cursor가 Streamable HTTP 일부 미지원하는 등의 케이스 발생 가능 — stdio default라 영향 최소.
- **Multi-tenant vault 격리 미지원 (v1)**: 한 서버 프로세스가 N개 vault 풀링하지만 client identity 분리 안 함. Streamable HTTP에서 한 client가 다른 client의 vault_id를 알면 lookup 가능 (in-memory만이라 디스크 누출은 없음). **v1에서는 single-tenant 가정**, README에 명시. multi-tenant는 v2 ADR.
- **Bun compile 단일 바이너리 + MCP SDK 동작 검증 필요**: Bun이 MCP SDK 모든 native dependency를 compile할 수 있는지 첫 빌드에서 확인. 실패 시 npm 배포만 v1, 단일 바이너리는 v1.x 후속.

---

## Alternatives Considered

### A1. MCP server 미구현 (status quo)

거부 이유: 시장 카테고리 확장 기회 상실. Claude Desktop / Cursor / Cline 시장 진입 불가. CloakLLM이 이 슬롯 선점 중.

### A2. SDK v2 alpha 사용

거부 이유: v2는 pre-alpha (repo README 명시). production 사용 권고 안 함. v1 → v2 마이그레이션 부담은 추후 1~2일로 작음 (API 거의 동일).

### A3. Streamable HTTP만 지원 (stdio 미지원)

거부 이유: Claude Desktop / Cursor / Cline / Codex 모두 stdio default. stdio 미지원 시 시장 90% 잃음. Streamable HTTP는 원격 시나리오 보조용.

### A4. MCP-Session-Id == vault_id 1:1 매핑

거부 이유:
- stdio mode에서 MCP session은 1 process = 1 session. vault_id를 session에 묶으면 multi-vault 격리 불가 (사용자가 여러 컨텍스트 동시 작업하는 경우).
- Streamable HTTP에서 short-lived stateless client가 매 요청 새 session → 매번 vault 새로 만듦 → multi-turn dedup 깨짐.
- CloakLLM도 token_map_id를 protocol session과 분리.

### A5. Tool 1개로 sanitize+desanitize 합치기 (`process` tool, mode 인자)

거부 이유:
- MCP tool은 명사형 액션이 LLM 발견성 ↑ (filesystem server 패턴).
- input/output schema가 mode별로 달라져 type 안전성 잃음.
- 시장 호환성 (CloakLLM 7 tools) 일관성 잃음.

### A6. 풀 LRU 대신 명시적 `dispose_vault` tool 강제

거부 이유:
- Client가 dispose 호출 안 하면 메모리 누수 → fail-closed 위반.
- LRU + TTL이 안전 default. `dispose_vault`는 v2에서 옵션으로 추가 가능.

### A7. CloakLLM `analyze_context_risk` v1부터 구현

거부 이유:
- 본 프로젝트에 `ContextAnalyzer` 미구현 — 새 기능 + MCP server 동시 구현은 scope creep.
- Phase 11 또는 v2 백로그로 분리. v1은 기존 core 기능 노출에 집중.

---

## Implementation Notes

### 새 패키지 — `packages/mcp-server/`

```
packages/mcp-server/
├── package.json           # @pii-remover/mcp-server
├── tsconfig.json          # typecheck
├── tsconfig.build.json    # build → dist/
├── bin/
│   └── pii-remover-mcp.ts # Bun compile entry
├── src/
│   ├── index.ts           # public exports
│   ├── server.ts          # McpServer 생성 + tool 등록
│   ├── vault-pool.ts      # Map<vault_id, PIIRemover> + LRU + TTL
│   ├── tools/
│   │   ├── sanitize.ts
│   │   ├── sanitize-batch.ts
│   │   ├── desanitize.ts
│   │   ├── desanitize-batch.ts
│   │   └── analyze.ts
│   ├── transport/
│   │   ├── stdio.ts       # default
│   │   └── streamable-http.ts  # opt-in, port 8766 default
│   ├── logging.ts         # MCP notifications/message wrapper
│   ├── errors.ts          # error_code enum + isError 래핑
│   └── cli.ts             # 인자 파싱 (--transport stdio|http, --port, --config)
└── tests/
    ├── vault-pool.test.ts
    ├── tools-sanitize.test.ts
    ├── tools-desanitize.test.ts
    ├── tools-analyze.test.ts
    ├── tools-batch.test.ts
    ├── lifecycle.test.ts  # LRU + TTL + onsessionclosed
    ├── errors.test.ts      # vault_not_found, fail_closed
    └── transport-stdio.test.ts
```

### 의존성 추가

```jsonc
// packages/mcp-server/package.json
{
  "dependencies": {
    "@pii-remover/core": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.23.0"
  }
}
```

### Tool 등록 패턴 (예시 — sanitize)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SanitizeInput = z.object({
  text: z.string().describe("Text to sanitize. PII will be replaced with __OPF_<CATEGORY>_<INDEX>__ tokens."),
  vault_id: z.string().optional().describe("Existing vault ID to append to. Omit to create a new vault."),
});

const SanitizeOutput = z.object({
  text: z.string(),
  vault_id: z.string(),
  token_count: z.number().int().nonnegative(),
  categories: z.record(z.string(), z.number().int().nonnegative()),
  latency_ms: z.number().nonnegative(),
  backend_name: z.string(),
});

server.registerTool(
  "sanitize",
  {
    title: "Sanitize PII",
    description: "Detect PII (English NER via OpenAI Privacy Filter + Korean regex with checksums) and replace with reversible tokens. Returns a vault_id to use for desanitize.",
    inputSchema: SanitizeInput,
    outputSchema: SanitizeOutput,
    annotations: {
      readOnlyHint: false,  // creates vault state
      destructiveHint: false,
      idempotentHint: false, // multiple calls add to vault
    },
  },
  async ({ text, vault_id }) => {
    const remover = await vaultPool.getOrCreate(vault_id);
    try {
      const result = await remover.mask(text);
      return {
        content: [{ type: "text", text: `Masked ${result.tokens.length} entities.` }],
        structuredContent: {
          text: result.text,
          vault_id: result.vault_id,
          token_count: result.tokens.length,
          categories: aggregateCategories(result.tokens),
          latency_ms: result.latency_ms,
          backend_name: result.backend_name,
        },
      };
    } catch (err) {
      return wrapFailClosed(err);
    }
  },
);
```

### Vault Pool 핵심 동작

```typescript
class VaultPool {
  private readonly pool = new Map<string, { remover: PIIRemover; lastAccess: number }>();
  private readonly maxSize = 100;
  private readonly ttlMs = 60 * 60 * 1000;  // 1 hour

  async getOrCreate(vault_id?: string): Promise<PIIRemover> {
    if (vault_id) {
      const entry = this.pool.get(vault_id);
      if (!entry) throw new VaultNotFoundError(vault_id);
      if (Date.now() - entry.lastAccess > this.ttlMs) {
        entry.remover.dispose();
        this.pool.delete(vault_id);
        throw new VaultNotFoundError(vault_id);
      }
      entry.lastAccess = Date.now();
      return entry.remover;
    }
    if (this.pool.size >= this.maxSize) this.evictOldest();
    const remover = await PIIRemover.init();
    this.pool.set(remover.sessionId, { remover, lastAccess: Date.now() });
    return remover;
  }

  // sweeper, evictOldest, onsessionclosed handler ...
}
```

### Logging 패턴

```typescript
// 절대 console.log() / process.stdout.write() 금지 in stdio mode
// MCP capability declared in server init
server.sendLoggingMessage({
  level: "info",
  data: {
    event: "vault_created",
    vault_id: result.vault_id,
    backend_name: result.backend_name,
    latency_ms: result.latency_ms,
    // NEVER: text, masked_text, vault entry values
  },
});
```

### 테스트 전략

| 카테고리 | 테스트 수 추정 |
|---|---|
| Vault pool lifecycle (LRU, TTL, eviction) | 10 |
| Tools — sanitize / desanitize (basic + Korean + secret) | 15 |
| Tools — batch variants | 5 |
| Tools — analyze | 5 |
| Errors — vault_not_found / fail_closed / schema | 8 |
| Transport — stdio JSON-RPC roundtrip | 5 |
| Transport — Streamable HTTP roundtrip (smoke) | 3 |
| Logging — no PII plaintext in logs | 4 |
| **합계 예상** | **~55 new** |

### 빌드 / 배포 통합

루트 `package.json` 갱신:

```jsonc
{
  "scripts": {
    "build:plugins": "... && bun run --filter '@pii-remover/mcp-server' build",
    "typecheck": "... && bun run --filter '@pii-remover/mcp-server' typecheck"
  }
}
```

### 사용자 셋업 예시 (Claude Desktop)

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
{
  "mcpServers": {
    "pii-remover": {
      "command": "npx",
      "args": ["-y", "@pii-remover/mcp-server"]
    }
  }
}
```

Streamable HTTP 시나리오:

```jsonc
{
  "mcpServers": {
    "pii-remover-remote": {
      "url": "http://localhost:8766/mcp"
    }
  }
}
```

### 비목표 (v1)

- Custom recognizer plugin (사용자 정의 regex 추가) — 별도 ADR (Personal Data Library, Phase 9 후보)
- Synthetic substitution (가짜 이름으로 치환) — 별도 ADR (Phase 10)
- Multi-tenant client isolation (Streamable HTTP) — v2
- `analyze_context_risk` — v2 (`ContextAnalyzer` 구현 후)
- `dispose_vault` tool — 사용자 빈도 확인 후

---

## References

- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk (v1.29.0 stable)
- MCP Spec 2025-11-25: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25
- 경쟁 분석: `cloakllm/CloakLLM` MCP server (7 tools 노출 패턴)
- Filesystem reference server: `modelcontextprotocol/servers/src/filesystem` (canonical tool annotation 패턴)
- ADR-0001 (TS 단일 core), ADR-0003 (vault 인메모리), ADR-0006 (fail-closed) — invariant 일관 유지
- ROADMAP Phase 8 — 본 ADR 실행 계획
