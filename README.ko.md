# PII Remover

> AI 코딩 도구가 LLM에 보내는 프롬프트에서 **개인정보(PII)를 자동 마스킹**하고, 응답에서 다시 **원본으로 복원**하는 로컬 보안 레이어. **Claude Code · OpenCode · OpenAI Codex CLI** 세 호스트 모두 지원.

**Languages**: [English](./README.md) · **한국어**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![Tests](https://img.shields.io/badge/tests-659%20pass-brightgreen.svg)](#tests)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](packages/core)

```
┌────────┐   plaintext PII   ┌────────────┐   masked tokens   ┌──────────┐
│  사용자 │ ─────────────▶ │  PII Remover│ ─────────────▶ │   LLM    │
└────────┘                  └────────────┘                  └──────────┘
                                  │                              │
                                  │  vault: {{OPF:PERSON:…}}     │
                                  ▼                              │
                             ┌─────────┐                         │
                             │  복원   │ ◀───── tokens ──────────┘
                             └─────────┘
                                  │
                                  ▼
                            사용자 화면 (원본 PII)
```

## 주요 기능

- **양방향 라운드트립**: 사용자 입력 → 마스킹 → LLM → 응답에서 토큰 복원 → 원본 PII로 사용자에게 표시
- **OPF 8 카테고리 + 한국 PII 3 카테고리** (총 11): 영문 NER (OpenAI Privacy Filter 모델) + 한국 정규식+체크섬 (주민등록번호, 사업자등록번호, 신용카드 LUHN) + 한국 이름 휴리스틱·KLUE-NER
- **3개 호스트 통합**:
  - **Claude Code** — `UserPromptSubmit` hook + `ANTHROPIC_BASE_URL` 프록시
  - **OpenCode** — `tool.execute.before/after` + `experimental.text.complete` + `experimental.chat.messages.transform` (LLM 경계 재마스킹) 플러그인 (in-process)
  - **OpenAI Codex CLI** — `UserPromptSubmit` hook + `openai_base_url` Responses API 프록시
- **SSE 스트리밍 라이브 변환**: 토큰 boundary buffering으로 LLM이 토큰을 split 응답해도 안전 복원
- **Interactive UI 복원**: display 도구(`question`, `todowrite` 및 MCP `*_question` / `*_todowrite` 변형)는 UI 렌더링 전에 args의 PII 토큰을 원본으로 복원 — LLM 경계 재마스킹이 외부 API로 raw PII 송신은 여전히 차단 ([ADR-0015](./docs/ADR/0015-display-tool-restoration.md))
- **Vision/multimodal**: 이미지 OCR → 영역 마스킹 (Phase 6, Tesseract 백엔드)
- **Fail-closed 기본**: 프록시 미구성 시 PII 포함 프롬프트 차단 (명시적 `PII_REMOVER_BYPASS=1`로만 우회)
- **로컬 우선**: 자체 Docker 백엔드 권장, 원격 백엔드는 4-Tier 신뢰 모델에 따라 opt-in
- **Audit 로깅** (opt-in): 구조화 JSONL로 mask/restore/bypass/block 이벤트를 카테고리 건수와 함께 기록 — PII 원문은 절대 기록 안 함. 런타임에 `PII_REMOVER_AUDIT=true/false`로 토글 (config 오버라이드).

## Quick Start

### 1) 백엔드 가동 (PII 검출 서버)

```bash
cd packages/backend
docker compose up --build   # 초회 ~5-10분 (모델 weights 다운로드)
```

### 2) 호스트 통합 설치

**Claude Code**:
```bash
npx @pii-remover/cli install --target claude-code --proxy
docker compose -f packages/backend/docker-compose.yml up -d
```

`--proxy`가 `~/.claude/settings.json`의 `env.ANTHROPIC_BASE_URL`을 써넣고, Claude Code는
세션 시작 시 `env` 키를 전부 프로세스 환경으로 내보냅니다 — 매 실행마다 `export` 할 필요가
없습니다. 이미 설정된 base URL(사내 게이트웨이 등)은 덮어쓰지 않고 경고만 냅니다.

**OpenCode** (단일 plugin 라인이면 끝):
```jsonc
// opencode.json
{
  "plugin": ["@pii-remover/opencode-plugin@latest"]
}
```

**OpenAI Codex CLI**:
```bash
npx @pii-remover/cli install --target codex --proxy
docker compose -f packages/backend/docker-compose.yml up -d
echo 'export PII_REMOVER_PROXY_TRUST=1' >> ~/.zshrc   # 1회만, 아래 설명 참고
```

`--proxy`가 `~/.codex/config.toml`에 `openai_base_url = "http://localhost:8000/codex/v1"`을
써넣어 라우팅은 영구 적용됩니다. hook의 fail-closed 게이트는 별개로, "프록시가 구성됐는지"를
**프로세스 환경변수**로 판단하는데 Codex에는 base URL을 노출하는 환경변수가 없습니다
([`detectProxy`](./packages/cli/src/protocol/proxy-detection.ts)). 그래서
`PII_REMOVER_PROXY_TRUST=1`은 셸 프로파일에 넣어둬야 합니다 — 최초 1회이고, 실행마다 다시
export 하는 게 아닙니다.

자세한 설치 가이드는 [`INSTALL.md`](./INSTALL.md).

## 패키지 구조

워크스페이스 monorepo (Bun + TypeScript):

| 패키지 | 역할 |
|---|---|
| [`@pii-remover/core`](./packages/core) | Host-agnostic 코어: detector, vault, restorer, backend strategy |
| [`@pii-remover/cli`](./packages/cli) | Multi-host CLI: `UserPromptSubmit` hook (Claude Code + Codex) + installer |
| [`@pii-remover/opencode-plugin`](./packages/opencode-plugin) | OpenCode plugin (in-process tool/message hooks) |
| [`@pii-remover/proxy`](./packages/proxy) | Local LLM proxy: Anthropic / OpenAI Chat / Codex Responses API 라우팅 |
| [`@pii-remover/vision`](./packages/vision) | 이미지 OCR PII 마스킹 클라이언트 (Phase 6) |
| `packages/backend` | Python FastAPI 백엔드 (OPF + KLUE NER + Tesseract OCR Docker 이미지) |

## 아키텍처

```
┌──────────────────────────────────────────────────────────────────┐
│  Host Integration Layer                                          │
│  ┌──────────────┐  ┌─────────────────────┐  ┌──────────────┐    │
│  │ Claude Code  │  │   OpenCode plugin    │  │ Codex CLI    │    │
│  │ + hook       │  │ (in-process)         │  │ + hook       │    │
│  └──────┬───────┘  └──────┬──────────────┘  └──────┬───────┘    │
│         │                 │                        │            │
│         │     ┌───────────┴──────────┐             │            │
│         └────▶│   @pii-remover/cli   │◀────────────┘            │
│               │   hook 바이너리        │                          │
│               └───────────┬──────────┘                          │
│                           │                                     │
│  ┌────────────────────────▼────────────────────────┐           │
│  │  @pii-remover/proxy (Anthropic + OpenAI + Codex)│           │
│  │  - request mask  - response restore  - SSE 변환  │           │
│  └────────────────────────┬────────────────────────┘           │
└───────────────────────────┼────────────────────────────────────┘
                            │
                            ▼
            ┌────────────────────────────┐
            │   @pii-remover/core        │
            │   Detector / Vault / Restorer
            └────────────┬───────────────┘
                         │
                         ▼ HTTP /redact
            ┌────────────────────────────┐
            │   Detection backend         │
            │   (OPF + KLUE NER + OCR)    │
            └────────────────────────────┘
```

자세한 설계는 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## 보안 모델

- **Hook은 prompt를 교체할 수 없음** (Claude Code/Codex 모두 source-verified). 마스킹은 항상 proxy가 수행. Hook은 detection + fail-closed gate.
- **Vault는 인메모리 세션 스코프**: 프로세스 메모리 only, 디스크 영속 없음.
- **토큰 형식 `{{OPF:<CATEGORY>:<HASH>}}`** ([ADR-0022](./docs/ADR/0022-markdown-inert-token-delimiters.md)): `{`, `}`는 CommonMark가 claim하지 않아 마크다운 왕복에서 원형이 보존된다. 이전 `__OPF_…__`는 그 자체로 bold 스팬이라 모델이 렌더링하며 내부 구분자를 삭제했다.
- **4-Tier 백엔드 신뢰 모델**: localhost (default) → self-hosted+TLS → vendor+DPA → public SaaS (비추천). 자세히는 [`docs/TRUST_TIERS.md`](./docs/TRUST_TIERS.md).
- **Fail-closed default**: PII 감지 실패 시 LLM 호출 차단. `PII_REMOVER_BYPASS=1`만 우회.
- **Audit 로깅** (기본 비활성화): 구조화 JSONL로 `mask` / `restore` / `bypass` / `block` / `error` 이벤트를 ISO 타임스탬프, 카테고리 건수(`{ private_email: 2, rrn: 1 }`), vault ID, 백엔드 이름, latency, provider와 함께 기록 — **PII 원문은 절대 저장 안 함**. config(`audit.enabled: true` + `audit.log_path`)로 활성화하거나 `PII_REMOVER_AUDIT=true/false`로 런타임 토글.
- **Compaction 대응**: 호스트가 대화 히스토리를 압축할 때, compaction 요약 내의 PII 토큰은 `[REDACTED]`로 치환 (fail-closed strip). 시스템 프롬프트에서도 LLM에게 압축 시 `__OPF_*__` 토큰을 그대로 보존하라고 지시 — 이중 방어.

## 검출 카테고리

| 카테고리 | 예 | 검출 방식 |
|---|---|---|
| `private_person` | 김철수, John Doe | OPF NER + 한국 성씨 휴리스틱 + KLUE-NER (v2) |
| `private_email` | user@example.com | OPF + regex |
| `private_phone` | 010-1234-5678 | OPF + 한국 010/011/016-9 regex |
| `private_address` | 서울특별시 ... | OPF |
| `account_number` | 계좌/ID 번호 | OPF |
| `private_date` | DOB | OPF |
| `private_url` | 자격증명이 담긴 URL, 사내망 주소, 테넌트 워크스페이스 — 공개 저장소·문서 링크는 마스킹하지 **않음** ([정책](./packages/backend/README.md#which-urls-count-as-pii)) | OPF |
| `secret` | API 키 (AWS, OpenAI, Anthropic, Google, Stripe, GitLab, SendGrid, DigitalOcean, Twilio, Shopify, Postman, Databricks, PyPI, Mailgun, Discord, Telegram, Slack), GitHub 토큰 (PAT/OAuth/fine-grained/refresh), PEM 개인키, JWT, npm 토큰, 비밀번호 포함 연결문자열 | OPF + regex |
| `rrn` | 주민등록번호 | 가중치 `[2,3,4,5,6,7,8,9,2,3,4,5]` 체크섬 |
| `biz_num` | 사업자등록번호 | 가중치 `[1,3,7,1,3,7,1,3,5]` 체크섬 |
| `card` | 신용카드 | LUHN |

한국 PII 알고리즘 상세: [`docs/KOREAN_PII.md`](./docs/KOREAN_PII.md).

## Tests

```bash
bun test
# 659 pass / 0 fail / 1 skip (44 files, 3945 expect calls)
```

| 검증 항목 | 통과 |
|---|---|
| 영문 PII 라운드트립 정확도 ≥ 95% (50건) | ✅ |
| 한국 PII 라운드트립 정확도 ≥ 98% (100건) | ✅ |
| SSE 토큰 split fuzz (delta 1~3자) | ✅ (22건) |
| TLS pinning fingerprint match/mismatch | ✅ |
| Tiered redaction 한국 PII 원격 누출 0건 | ✅ |
| 인증 헤더 stdout/stderr 미노출 | ✅ |
| `UserPromptSubmit` hook 결정 매트릭스 (Claude/Codex) | ✅ |

## Build

```bash
bun install
bun run build         # 5 패키지 모두 tsc
bun run typecheck     # tsc --noEmit
```

CLI 단일 바이너리:
```bash
cd packages/cli
bun run compile:linux-x64
bun run compile:darwin-arm64
bun run compile:darwin-x64
bun run compile:windows-x64
```

## 문서

- [INSTALL.md](./INSTALL.md) — 설치 가이드
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — 시스템 설계, 데이터 흐름, 보안 모델
- [docs/ROADMAP.md](./docs/ROADMAP.md) — Phase별 마일스톤
- [docs/KOREAN_PII.md](./docs/KOREAN_PII.md) — 한국 PII 검출 알고리즘 상세
- [docs/TRUST_TIERS.md](./docs/TRUST_TIERS.md) — 4-Tier 신뢰 모델 운영 가이드
- [docs/ADR/](./docs/ADR/) — Architecture Decision Records (15건)

## Audit 로깅

PII 처리 이벤트(mask/restore/bypass/block/error)를 JSONL 파일로 기록 — **PII 원문은 절대 저장하지 않음**. 기본 비활성화.

```jsonc
// .pii-remover.json
{
  "audit": {
    "enabled": true,
    "log_path": "/var/log/pii-remover/audit.jsonl"
  }
}
```

런타임 토글 (config보다 우선):
```bash
PII_REMOVER_AUDIT=true  docker compose -f packages/backend/docker-compose.yml up -d   # 강제 켜기
PII_REMOVER_AUDIT=false docker compose -f packages/backend/docker-compose.yml up -d   # 강제 끄기
```

출력 예:
```json
{"timestamp":"2025-05-17T12:00:00.000Z","event":"mask","vault_id":"a1b2","session_id":"session_x","categories":{"private_email":2,"rrn":1},"backend_name":"local-regex","latency_ms":3.2,"policy_result":"masked","provider":"anthropic"}
```

## License

Apache-2.0
