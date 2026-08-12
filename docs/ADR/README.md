# Architecture Decision Records (ADR)

이 디렉토리는 `pii-remover` 프로젝트의 중요한 아키텍처 결정을 추적한다. 각 ADR은 **결정 시점의 컨텍스트, 대안, 선택, 결과**를 불변 기록으로 남긴다.

## 작성 원칙

- **결정이 바뀌면 새 ADR을 작성한다**. 기존 ADR을 수정하지 않고 `Superseded by ADR-XXXX` 표시.
- **번호는 한 번 부여되면 재사용하지 않는다**.
- **포맷**: Title / Status / Date / Context / Decision / Consequences / Alternatives Considered / References.
- **Status**: `Proposed` → `Accepted` → (가능시) `Deprecated` 또는 `Superseded by ADR-XXXX`.

## Index

| #    | Title | Status | Date |
|------|---|---|---|
| 0001 | [TypeScript 단일 core 언어](./0001-typescript-single-core.md) | Accepted | 2026-05-12 |
| 0002 | [토큰 형식 `__OPF_<CATEGORY>_<INDEX>__`](./0002-token-format-opf-underscore.md) | Superseded by 0020 | 2026-05-12 |
| 0003 | [Vault: 세션 스코프 인메모리, `opf.reversible.v1`](./0003-vault-session-in-memory.md) | Accepted | 2026-05-12 |
| 0004 | [로컬 LLM 프록시 + path prefix 라우팅 + SSE 스트리밍 v1](./0004-local-llm-proxy-streaming.md) | Accepted | 2026-05-12 |
| 0005 | [Backend Strategy 인터페이스 + 4-Tier 신뢰 모델](./0005-backend-strategy-trust-tiers.md) | Accepted | 2026-05-12 |
| 0006 | [fail-closed default + opt-in bypass](./0006-fail-closed-default.md) | Accepted | 2026-05-12 |
| 0007 | [한국 PII — v1 정규식+휴리스틱, v2 KLUE-NER](./0007-korean-pii-strategy.md) | Accepted | 2026-05-12 |
| 0008 | [Detection 백엔드 — 자체 Docker 이미지 빌드 (gh0stkey API 호환)](./0008-detection-backend-self-built-docker.md) | Accepted | 2026-05-12 |
| 0009 | [Vision/multimodal PII 마스킹 (becoolme 패턴, v1 Phase 6)](./0009-vision-multimodal-v2.md) | Accepted | 2026-05-12 |
| 0010 | [PII 카테고리 — OPF 8 + 한국 확장 3 = 총 11](./0010-pii-categories-opf-plus-korean.md) | Accepted | 2026-05-12 |
| 0011 | [OpenCode 응답 복원 — `experimental.text.complete` + `tool.execute.after`](./0011-message-part-updated-feasibility.md) | Accepted | 2026-05-12 |
| 0012 | [Claude Code UserPromptSubmit hook — detection-only + fail-closed gate](./0012-claude-code-hook-protocol.md) | Accepted | 2026-05-12 |
| 0013 | [OpenAI Codex CLI UserPromptSubmit hook — detection-only (Claude Code 호환)](./0013-codex-hook-protocol.md) | Accepted | 2026-05-13 |
| 0014 | [Local LLM Proxy — Codex Responses API 라우팅 (`/codex/v1/responses`)](./0014-codex-proxy-routing.md) | Accepted | 2026-05-13 |
| 0015 | [Display-tool args 복원 + comprehensive LLM-boundary masking](./0015-display-tool-restoration.md) | Accepted | 2026-05-17 |
| 0016 | [MCP Server 노출 — `@pii-remover/mcp-server`](./0016-mcp-server-package.md) | Accepted | 2026-05-19 |
| 0017 | [Personal Data Library — 사용자 정의 PII 사전 등록](./0017-personal-data-library.md) | Accepted | 2026-05-19 |
| 0018 | [Synthetic Substitution 모드 — 토큰 대신 그럴듯한 가짜 값](./0018-synthetic-substitution.md) | Accepted | 2026-05-19 |
| 0019 | [Backend auto-start (opt-in) + idle model unload (default-on)](./0019-backend-auto-start-and-idle-unload.md) | Accepted | 2026-05-20 |
| 0020 | [결정론적 해시 토큰 `__OPF_<CATEGORY>__<HASH>__`](./0020-deterministic-hash-token.md) | Accepted | 2026-06-12 |
| 0021 | [토큰 epoch 접두 + vault 경계 복구](./0021-token-epoch-and-bounded-repair.md) | Accepted | 2026-08-10 |

## ADR 카테고리별 그룹

### 핵심 아키텍처 (구현 시 가장 먼저 참고)
- **ADR-0001**: TypeScript 단일 core 언어
- **ADR-0004**: 로컬 LLM 프록시 + path prefix 라우팅 + SSE 스트리밍 v1
- **ADR-0011**: OpenCode 응답 복원 hook 검증 (`experimental.text.complete` + `tool.execute.after`)
- **ADR-0012**: Claude Code UserPromptSubmit hook은 detection-only — 마스킹은 proxy 위임
- **ADR-0013**: OpenAI Codex CLI hook은 Claude Code와 stdin/stdout 동일 — `@pii-remover/cli` 한 패키지가 두 호스트 모두 지원
- **ADR-0014**: Codex Responses API 라우팅 (`/codex/v1/responses`) + Responses API SSE 변환
- **ADR-0016**: MCP Server 노출 (`@pii-remover/mcp-server`) — stdio + Streamable HTTP, opaque vault_id, 5 tool surface

### 데이터 모델
- **ADR-0002**: 토큰 형식 `__OPF_<CATEGORY>_<INDEX>__` (Superseded by 0020)
- **ADR-0020**: 결정론적 해시 토큰 `__OPF_<CATEGORY>__<HASH>__` (정수 인덱스 → HMAC 해시)
- **ADR-0021**: 해시 안에 키 epoch 3자를 심어 환각/dead token 판별 + vault 키셋으로 경계 지은 편집거리-1 복구 (wire format 무변경)
- **ADR-0003**: Vault 스키마 + 세션 스코프 인메모리
- **ADR-0010**: PII 카테고리 (OPF 8 + 한국 3)
- **ADR-0018**: Synthetic Substitution 모드 — 토큰 vs 가짜 자연어 값 선택 가능

### 백엔드 & 보안
- **ADR-0005**: Backend Strategy 인터페이스 + 4-Tier 신뢰 모델
- **ADR-0006**: fail-closed default + opt-in bypass
- **ADR-0008**: Detection 백엔드 — 자체 Docker 이미지 빌드 (gh0stkey API 호환)

### 한국 PII / 범위 결정
- **ADR-0007**: 한국 PII v1 휴리스틱, v2 KLUE-NER
- **ADR-0009**: Vision/multimodal PII 마스킹 (becoolme 패턴, v1 Phase 6)
- **ADR-0017**: Personal Data Library — 사용자가 자기 이름/회사/프로젝트 코드 사전 등록 → false negative 제로

## 향후 ADR 후보 (v1.x ~ v2)

| 가상 # | Title | 트리거 시점 |
|---|---|---|
| TBD | Vault 영속 (encrypted) — 세션 재개 fast-path | 사용자 요구 시 |
| TBD | Custom recognizer 인터페이스 (Presidio 스타일) | 카테고리 확장 요청 |
| TBD | Transformers.js 백엔드 없는 임베드 모드 | Docker 의존 회피 요청 |
| TBD | 응답 무결성 HMAC (vault 변조 탐지) | 원격 백엔드 위협 분석 후 |
| ~~TBD~~ | ~~토큰 체크섬 (`__OPF_PERSON_1_a3f9__`)~~ | **기각 — ADR-0021**: vault 키셋이 체크섬보다 엄격한 경계 |
| TBD | 멀티 사용자/팀 vault | 엔터프라이즈 시나리오 |
| TBD | PDF 첨부 텍스트 추출 + 마스킹 | v1.x 빠른 win |
| TBD | 한국 주소 정규식 + 행정구역 사전 | v1.x 확장 |

## 관련 문서
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — 시스템 설계 전체
- [`../ROADMAP.md`](../ROADMAP.md) — 단계별 마일스톤
- [`../TRUST_TIERS.md`](../TRUST_TIERS.md) — 4-Tier 신뢰 모델 운영 가이드 (ADR-0005 매뉴얼)
