# PII Remover Architecture

> OpenCode / Claude Code용 PII 자동 마스킹·복원 플러그인의 시스템 설계 문서.
> 본 문서는 핵심 설계 결정 (A~E, Q1~Q7)을 정리한 **설계 확정본**이다. 변경은 ADR로 관리한다.

---

## 0. 한 줄 요약

LLM(OpenCode·Claude Code 등)에 PII가 평문으로 전송되지 않도록 **사용자 입력은 마스킹**, **어시스턴트 응답은 원본 복원**하는 도구. 핵심 엔진은 `openai/privacy-filter`(Apache-2.0), 가역 토큰화 패턴은 `deformatic/...-Reversible-Tokenization`을 차용한다. 호스트 통합은 **plugin/hook + 로컬 LLM 프록시** 이원 구조.

---

## 1. 목표 / 비목표

### 1.1 목표 (v1)
- OpenCode와 Claude Code에서 LLM 호출 전/후로 PII를 자동 마스킹/복원
- 영문 PII 8 카테고리(OPF 기본) + 한국 PII(주민번호, 사업자번호, 010 전화, 카드번호, 이메일) 정규식 마스킹
- 가역 토큰화로 어시스턴트 응답의 자연스러운 원본 복원
- Detection 백엔드를 로컬 Docker / 원격 HTTP 양쪽 모두 지원
- fail-closed 기본, 명시적 bypass 지원

### 1.2 비목표 (v1)
- 한국 이름 NER (v2)
- 응답 SSE 스트리밍 라이브 변환 (MVP는 non-streaming, 이후 추가)
- TLS pinning / mTLS 강제 (opt-in)
- 멀티 테넌트 vault, 영속 vault 디스크 저장
- 자체 NER 모델 학습/파인튜닝

---

## 2. 핵심 결정 사항

### 2.1 결정 A~E
| ID | 결정 | 근거 |
|---|---|---|
| A | 공용 core 라이브러리 먼저 (host-agnostic) | 두 호스트가 같은 로직 공유 |
| B | Detection 백엔드: 자체 빌드 Docker(로컬) + 원격 HTTP 양쪽 지원 | 사내 PII 서버 시나리오 |
| C | 한국 PII: 한국 이름 NER까지 필요 (v1은 휴리스틱, v2 KLUE-NER) | 한국 사용자 페르소나 |
| D | TLS pinning / Bearer 토큰 등 부가 보안은 **opt-in** | UX 비강제 |
| E | OpenCode + Claude Code 양 호스트 지원 | 사용자 워크플로 다양성 |

### 2.2 주요 설계 결정 (Q1~Q7)
| ID | 결정 | 근거(요약) |
|---|---|---|
| Q1 | **TypeScript 단일 core**, Bun 컴파일 바이너리로 Claude Code hook 호출 | OpenCode TS 강제 + Python 콜드스타트 회피 |
| Q2 | **세션 스코프 인메모리 vault**, deformatic `opf.reversible.v1` 스키마 채택 | 평문 디스크 공격면 0 |
| Q3 | **로컬 LLM 프록시가 응답 복원의 유일한 견고한 답** | Claude Code 응답 변환 hook 부재 |
| Q4 | 토큰 형식 `__OPF_<TYPE>_<INDEX>__` (예: `__OPF_PERSON_1__`) | identifier-safe, 번역/마크다운/코드 견고 |
| Q5 | v1 한국 NER은 휴리스틱(상위 100 성씨 + 음절 패턴), v2 KLUE-NER Docker sidecar | MVP scope 적정화 |
| Q6 | **fail-closed default** + `PII_REMOVER_BYPASS=1` 명시 우회 | 보안 보증 깨짐 방지 |
| Q7 | MVP는 single backend, 인터페이스는 tiered 허용 / 4-tier 신뢰표 / secret env-only | PII 네트워크 노출 최소화 |

---

## 3. 시스템 아키텍처

### 3.1 전체 구조 (텍스트 다이어그램)

```
                                +-----------------------+
                                |   Detection Backend    |
                                |   (Docker sidecar      |
                                |    또는 원격 HTTP)      |
                                |    POST /redact         |
                                +-----------▲-----------+
                                            │ HTTP
                                            │
+-----------------+   ┌────────────────────────────────────┐
| User Terminal   │   │  TS Core Library (@pii-remover/core)│
| (OpenCode/CC)   │   │                                    │
+-------┬---------+   │   ┌──────────┐  ┌──────────┐       │
        │ stdin/      │   │ Detector │  │ HttpClient│      │
        │ stdout     │   │  (regex  │  │ (Backend │       │
        │             │   │  + remote)│  │ Strategy) │      │
        ▼             │   └──────────┘  └──────────┘       │
+-----------------+   │   ┌──────────┐  ┌──────────┐       │
| Host Integration │   │   Vault   │  │ Restorer │       │
|  Layer         │◀──┤   │(in-mem)  │  │ (fuzzy   │       │
| - OpenCode      │   │   │ + dedup   │  │  regex)  │       │
|   plugin (TS)   │   │   └──────────┘  └──────────┘       │
| - Claude Code   │   │                                    │
|   hook (sh)     │   └────────────────────────────────────┘
| - LLM Proxy     │              ▲
+-------┬---------+              │ in-process / spawn
        │                        │
        ▼                        │
+-----------------+              │
| LLM Provider    │◀─────────────┘
| (Anthropic API,│        ANTHROPIC_BASE_URL=http://localhost:8000/anthropic/v1
|  OpenAI, etc.)  │        OPENAI_API_BASE   =http://localhost:8000/openai/v1
+-----------------+        (path prefix로 프로바이더 라우팅)
```

### 3.2 컴포넌트 책임

| 컴포넌트 | 패키지 | 책임 |
|---|---|---|
| **TS Core** | `@pii-remover/core` | Detector, Vault, Restorer, BackendClient, BackendStrategy. 모든 호스트 통합이 의존. |
| **OpenCode Plugin** | `@pii-remover/opencode-plugin` | core를 in-process로 import. `tool.execute.before` 등에서 텍스트 변환. |
| **Multi-host Hook CLI** | `@pii-remover/cli` | Bun 컴파일 바이너리. Claude Code + Codex `UserPromptSubmit` stdin/stdout JSON I/O (ADR-0012, ADR-0013) + multi-host installer. |
| **Local LLM Proxy** | `@pii-remover/proxy` | HTTP 서버. Anthropic/OpenAI API 호환 endpoint를 노출, 요청 마스킹·응답 복원. |
| **Detection Backend** | `@pii-remover/backend` (자체 빌드 Docker, `ghcr.io/<our-org>/pii-remover-backend`) | OPF 모델(text) + (Phase 6) Tesseract OCR + Pillow 마스킹 (image). `POST /redact`, `POST /redact/image` API ([ADR-0008](./ADR/0008-detection-backend-self-built-docker.md), [ADR-0009](./ADR/0009-vision-multimodal-v2.md)). |
| **Vision Client** | `@pii-remover/vision` (TS, 얇은 HTTP 클라이언트, 의존성 0) | Phase 6. 이미지 base64 → 백엔드로 위임, `redacted_image` 응답 받아 LLM에 전달. OCR/마스킹 로직은 백엔드에 있음 ([ADR-0009](./ADR/0009-vision-multimodal-v2.md)). |

---

## 4. 데이터 흐름

### 4.1 마스킹 (사용자 입력 → LLM)

```
사용자 입력 텍스트
   │
   ▼
[1] Detector.detect(text)
   ├─ 로컬 정규식 (주민번호/카드/전화/이메일/한국성씨휴리스틱)
   └─ BackendClient.detect(text) ─→ HTTP POST /redact (OPF 모델)
   │
   ▼ DetectionResult { detections: [{start, end, category, text}, ...] }
   │
[2] Vault.assign(detections)
   ├─ 같은 (category, canonical_text) → 같은 token 재사용
   ├─ 새 entity → 다음 인덱스 할당
   └─ vault entries 업데이트
   │
   ▼ TokenizedSpan[] { ...DetectionResult, token: "__OPF_PERSON_1__" }
   │
[3] applyTokens(text, tokenizedSpans)
   │
   ▼
마스킹된 텍스트 (LLM으로 전송)
```

### 4.2 복원 (LLM 응답 → 사용자)

```
LLM 응답 텍스트 (토큰 포함)
   │
   ▼
[1] Restorer.scan(text) → TokenMatch[]
   ├─ 엄격 정규식: /__OPF_([A-Z]+)_(\d+)__/g
   └─ 관대 정규식 (fallback): /\b__OPF_[A-Z]+_\d+(?:__)?\b/gi
       ├─ 대소문자 변형 허용
       └─ suffix `__` 누락 허용 (경고 로깅)
   │
   ▼
[2] Vault.lookup(token) → 원본 텍스트
   │
   ▼
[3] applyReplacements(text, matches)
   │
   ▼
복원된 텍스트 (사용자에게 표시)
```

### 4.3 응답 복원의 호스트별 실현

| 호스트 | 실현 방식 | 비고 |
|---|---|---|
| OpenCode | (a) `message.part.updated` hook으로 변환 시도 → 가능하면 plugin 내부에서 처리 | 검증 필요 |
| OpenCode | (b) (a)가 안 되면 Local LLM Proxy 경로로 fallback | 양 호스트 통일 |
| Claude Code | **Local LLM Proxy 필수** (`ANTHROPIC_BASE_URL=http://localhost:<port>`) | hook으로 응답 변환 불가 |

---

## 5. 토큰 형식 명세

### 5.1 형식
```
__OPF_<CATEGORY>_<INDEX>__
```
- `<CATEGORY>`: 대문자, OPF 8 카테고리 + 한국 확장 (예: `PERSON`, `EMAIL`, `PHONE`, `ADDRESS`, `ACCOUNT`, `DATE`, `URL`, `SECRET`, `RRN`, `BIZNUM`, `CARD`)
- `<INDEX>`: 양의 정수, vault 내 1부터 증가

### 5.2 OPF 카테고리 → 토큰 카테고리 매핑

| OPF | 토큰 카테고리 |
|---|---|
| `private_person` | `PERSON` |
| `private_email` | `EMAIL` |
| `private_phone` | `PHONE` |
| `private_address` | `ADDRESS` |
| `account_number` | `ACCOUNT` |
| `private_date` | `DATE` |
| `private_url` | `URL` |
| `secret` | `SECRET` |
| (한국 확장) 주민번호 | `RRN` |
| (한국 확장) 사업자번호 | `BIZNUM` |
| (한국 확장) 신용카드 | `CARD` |

### 5.3 복원 정규식 (TS)

```typescript
// 엄격 매칭 (1차)
const STRICT = /__OPF_([A-Z]+)_(\d+)__/g
// 관대 매칭 (2차 fallback)
const LENIENT = /\b__OPF_([A-Z]+)_(\d+)(?:__)?\b/gi
```

### 5.4 토큰 형식 선정 근거
- `<PRIVATE_PERSON_1>` 거부: HTML/JSX 충돌, 마크다운 태그로 해석/제거 위험
- `⟦PERSON_1⟧` 거부: 터미널/copy-paste 깨짐
- `XXX-PERSON-001-XXX` 거부: 대시-공백 변환 빈번
- **`__OPF_X_N__` 채택**: Python `__dunder__` 패턴 닮아 LLM이 "변수명/식별자"로 인식 → 번역/대소문자 변형 거의 없음, 코드 생성 시 변수로 박혀도 문법 유효

---

## 6. Vault 명세

### 6.1 스키마 (`opf.reversible.v1` 확장)

```typescript
interface VaultEntry {
  label: string            // OPF 카테고리 또는 한국 확장 (소문자)
  text: string             // 원본 텍스트 (surface form)
  canonical_text: string   // 정규화된 텍스트 (whitespace 등 정리)
  index: number            // 1-base
}

interface Vault {
  schema_version: "opf.reversible.v1"
  vault_id: string                          // UUID v4 (세션 단위)
  entries: Record<string, VaultEntry>       // token → entry
  created_at: number                        // unix ms
}
```

### 6.2 동작 규칙
- **같은 label + canonical_text**: 같은 토큰 재사용 (dedup)
- **다른 label + 같은 text**: 다른 토큰 family (예: `PERSON_1` vs `SECRET_1`)
- **다른 canonical_text + 같은 label**: 다음 인덱스 (`PERSON_2`)
- **overlapping spans**: 에러 throw (호출자가 sort + 충돌 해결)

### 6.3 보존 / 격리
- **저장**: 프로세스 메모리 only (`Map<sessionId, Vault>`)
- **TTL**: 세션 종료까지 (OpenCode `session.idle` 또는 Claude Code 프록시 세션 끝)
- **세션 격리**: 세션 A의 `PERSON_1`과 세션 B의 `PERSON_1`은 무관 (vault_id로 구분)
- **재구축**: 세션 재개 시 채팅 히스토리 재마스킹으로 idempotent 재구축

### 6.4 부분 매치 (Partial Match Suffix Trie)
- 어시스턴트가 "철수"만 언급 (원본 "김철수" 마스킹)된 경우
- vault 내부에 surface form의 suffix index 별도 유지 권고
- v1에서는 단순 substring scan, v2에서 trie 도입

---

## 7. Backend Client 인터페이스

### 7.1 Interface (function signature)

```typescript
export type PIICategory =
  | 'account_number' | 'private_address' | 'private_email'
  | 'private_person' | 'private_phone'  | 'private_url'
  | 'private_date'   | 'secret'
  // 한국 확장 (regex 전용, OPF는 안 줌)
  | 'rrn' | 'biz_num' | 'card'

export type TrustTier = 'local' | 'self_hosted' | 'vendor' | 'public'

export interface DetectOpts {
  categories?: PIICategory[]
  timeout_ms?: number
  request_id: string  // 트레이싱용, PII 미포함
}

export interface Detection {
  start: number
  end: number
  category: PIICategory
  confidence: number
  text: string  // 원본 substring (vault 저장용)
}

export interface DetectionResult {
  detections: Detection[]
  backend_name: string
  latency_ms: number
}

export interface BackendClient {
  readonly name: string
  readonly trust_tier: TrustTier
  detect(text: string, opts: DetectOpts): Promise<DetectionResult>
  healthCheck(): Promise<{ ok: boolean; latency_ms: number; version?: string }>
}

export interface BackendStrategy {
  resolve(text: string, opts: DetectOpts): Promise<DetectionResult>
}
```

### 7.2 기본 제공 구현체
- `LocalRegexBackend` (always-on, trust_tier='local'): 한국 정규식 + 영문 이메일/카드/URL/날짜
- `OpfHttpBackend` (trust_tier 설정): OPF HTTP API 호환 (`POST /redact`) — gh0stkey가 정의한 사실상 표준을 채택, 우리는 [자체 이미지](./ADR/0008-detection-backend-self-built-docker.md)로 publish
- `MergeStrategy`: 여러 BackendClient 결과를 union (overlap은 longer-span 우선)
- `TieredStrategy` (v2+): 로컬 regex 우선 적용 → 남은 텍스트만 원격 ML

### 7.3 secret 처리 원칙
- **config 파일에 secret 평문 절대 금지**
- 모든 secret은 환경변수 이름으로만 참조 (예: `token_env: "PII_API_TOKEN"`)
- 환경변수 미설정 시 즉시 fail-closed (시작도 안 함)

---

## 8. 설정 스키마

### 8.1 위치 우선순위
1. `${CWD}/.pii-remover.json` (프로젝트)
2. `~/.config/pii-remover/config.json` (사용자)
3. 내장 기본값

### 8.2 스키마 (JSON)

```jsonc
{
  "$schema": "https://pii-remover.dev/schema/v1.json",

  "backend": {
    "type": "single",           // "single" | "tiered" (v2)
    "endpoint": "http://localhost:8000/redact",
    "trust_tier": "local",      // local | self_hosted | vendor | public
    "auth": {
      "type": "none",           // "none" | "bearer" | "api_key" | "mtls"
      "token_env": "PII_API_TOKEN",   // 환경변수 이름 (값 X)
      "header_name": "Authorization"  // optional, 기본 Authorization Bearer
    },
    "tls": {
      "verify": true,
      "ca_bundle_path": null,
      "pinning": {
        "enabled": false,
        "sha256_fingerprint": null
      }
    },
    "timeout_ms": 2000,
    "retries": 1
  },

  "detection": {
    "enabled_categories": [
      "private_person", "private_email", "private_phone",
      "private_address", "account_number", "private_date",
      "private_url", "secret",
      "rrn", "biz_num", "card"
    ],
    "korean_heuristics": {
      "enabled": true,
      "surname_list_path": null,    // null이면 내장 100개 사용
      "stopwords_path": null         // "박스" "정말" 등 차단
    }
  },

  "restoration": {
    "token_format": "__OPF_{CATEGORY}_{INDEX}__",
    "lenient_match": true,           // 대소문자/suffix 누락 허용
    "warn_on_partial": true
  },

  "vault": {
    "scope": "session",              // v1: session only
    "persist": false                  // v1: false only
  },

  "failure_policy": "closed",        // "closed" | "hybrid" | "open"
  "bypass_env": "PII_REMOVER_BYPASS",

  "proxy": {
    "enabled": false,                 // Claude Code 사용 시 true
    "port": 8765,                     // 기본 8765, 0 = 자동 할당
    "upstream": {
      "anthropic": "https://api.anthropic.com",
      "openai": "https://api.openai.com"
      // 향후 추가: "google", "groq", "azure_openai" 등
    },
    "streaming": {
      "enabled": true,                // v1부터 SSE 라이브 변환 default
      "buffer_window": 64,            // 잠재 토큰 boundary 보존 윈도우 (chars)
      "flush_on_close": true          // 스트림 종료 시 holding 버퍼 강제 flush
    }
  },

  "logging": {
    "level": "info",                  // debug | info | warn | error
    "redact_logs": true,              // 로그 자체에서도 PII 마스킹
    "log_path": null
  }
}
```

### 8.3 환경변수 substitution
- 값 내부에서 `${VAR}` 또는 `${VAR:-default}` 패턴 허용
- secret은 `auth.token_env` 같은 명시 env-name 필드로만

---

## 9. 보안 모델

### 9.1 4-Tier 신뢰표 (README에 박을 것)

| Tier | 백엔드 유형 | 권고 |
|---|---|---|
| 🟢 1 | localhost Docker (`http://localhost:8000`) | 신뢰. default |
| 🟢 2 | 사내 자체호스팅 + TLS | 신뢰. Bearer 토큰 권고 |
| 🟡 3 | 벤더 호스팅 + 계약(DPA/BAA) | 주의. 5조건 검증 (§9.2) |
| 🔴 4 | 공개 3rd-party SaaS API | **사용 비추천** — PII가 외부로 유출되어 도구 목적 자체 무력화 |

### 9.2 "안전한 원격 백엔드" 5조건
1. **소유권**: 자체 호스팅 OR 계약상 데이터 처리 합의(DPA/BAA) 있음
2. **전송 암호화**: TLS 1.2+ 필수, 평문 HTTP 거부
3. **로깅 정책**: 백엔드가 request body를 영구 저장 안 함 (문서로 확인)
4. **데이터 거주**: 지리적 위치 알 수 있음 (GDPR/PIPA 준수)
5. **인증**: 최소 Bearer 토큰 — 익명 endpoint 거부

### 9.3 Opt-in 보안 옵션
- TLS pinning (`backend.tls.pinning.enabled`)
- Bearer 토큰 (`backend.auth.type: "bearer"`)
- mTLS (`backend.auth.type: "mtls"`)
- 응답 무결성 (HMAC) — v2
- 4-Tier 신뢰표 운영: [TRUST_TIERS.md](./TRUST_TIERS.md) 참조.

### 9.4 위협 모델
| 위협 | 완화 |
|---|---|
| LLM에 PII 평문 노출 | 본 도구의 목적. 마스킹 단계 차단 |
| 백엔드 서버 침해로 PII 유출 | 4-Tier 신뢰표, 자체호스팅 권고 |
| Vault 메모리 덤프 | 인메모리 only, 디스크 영속 X |
| 로그 파일에 PII 누출 | `logging.redact_logs: true` default |
| Bypass flag 영구 설정 → 도구 무력화 | bypass 사용 빈도 로컬 로깅, 사용자 경고 |
| 프록시 인증 헤더 유출 | `Authorization` pass-through, 로깅 금지 |

---

## 10. 장애 모드 정책

### 10.1 3-Tier Failure Policy

| 모드 | Detector 실패 시 | Regex fallback | LLM 호출 |
|---|---|---|---|
| `closed` (**default**) | 차단 | 사용 안 함 | 막힘. 사용자에게 명확한 에러 + bypass 가이드 |
| `hybrid` | regex로 전환 | 사용 | 한국 PII만이라도 마스킹된 채 LLM 호출, 경고 로깅 |
| `open` | 통과 | n/a | 원본 전송 (디버그 전용, 위험 명시) |

### 10.2 사용자 우회
- 환경변수: `PII_REMOVER_BYPASS=1`
- 일회성: `--no-pii` CLI 플래그 (호스트별 통합)
- 영구: `failure_policy: "open"` 설정 (위험)

### 10.3 원격 백엔드 실패 처리
- 타임아웃: `backend.timeout_ms` (기본 2000)
- 재시도: `backend.retries` (기본 1, 지수 백오프 없음)
- 실패 시 동작: `failure_policy`에 따름
- `hybrid` 모드: 로컬 regex로 자동 폴백
- 원격 fail 시 bypass 경고는 로컬 fail보다 더 강하게 ("원격 redaction이 죽었으니 PII가 LLM에 평문으로 갑니다 — 진짜로 계속?")

---

## 11. 한국 PII 처리

### 11.1 정규식 패턴 (v1)

| 카테고리 | 패턴 | 검증 |
|---|---|---|
| `rrn` (주민번호) | `\b\d{6}-?[1-4]\d{6}\b` | 13자리 체크섬 (가중치 [2,3,4,5,6,7,8,9,2,3,4,5], (11 - sum%11) % 10) |
| `biz_num` (사업자) | `\b\d{3}-?\d{2}-?\d{5}\b` | 10자리 체크섬 (가중치 [1,3,7,1,3,7,1,3,5]) |
| `card` (신용카드) | `\b(?:\d{4}[- ]?){3}\d{4}\b` | LUHN 알고리즘 |
| `phone` | `\b01[016-9]-?\d{3,4}-?\d{4}\b` | 별도 검증 없음 |
| `email` | RFC 5322 단순화 정규식 | TLD 화이트리스트 옵션 |

### 11.2 한국 이름 휴리스틱 (v1)
- 상위 100개 성씨 리스트 내장 (김/이/박/최/정/강/조/윤/장/임 등)
- 패턴: `^(성씨)[가-힣]{1,2}$` (2~3음절)
- **차단 리스트(stopwords)**: 박스, 정말, 최선, 김치, 이거 등 — false positive 빈출 단어
- 정확도 목표: 흔한 한국 이름의 ~85-90% 잡음, false positive < 5%
- 신뢰 카테고리: `private_person` (OPF 카테고리 재사용)

### 11.3 한국 이름 NER (v2)
- KLUE-NER 또는 KoBERT-NER 모델
- Docker sidecar에 OPF와 함께 패키징
- 휴리스틱과 결과 union (longer-span 우선, 동일 길이는 휴리스틱 우선)

---

## 12. 호스트 통합

### 12.1 OpenCode Plugin

OpenCode `Hooks` interface 직접 검증 결과(ADR-0011), 사용 가능한 hook 매핑:

| Phase | Hook | 책임 |
|---|---|---|
| 1 | `tool.execute.before` | 도구 인자 마스킹 (안정) |
| 1 | `event` (관찰 전용, `session.idle` 필터) | vault dispose |
| 2 | `tool.execute.after` | 도구 결과 복원 (안정) — file contents, shell stdout 등 |
| 2 | `experimental.text.complete` | 어시스턴트 응답 텍스트 복원 (실험적, opt-out 가능) |

`message.part.updated`는 **존재하지 않음** — 이전 ARCHITECTURE 작성 시점의 가정 오류. 응답 텍스트 변환은 `experimental.text.complete`로 처리.

```typescript
// @pii-remover/opencode-plugin이 자동 등록하는 hook (사용자 코드 X)
export const PiiRemoverPlugin = async (ctx) => {
  const pii = await PIIRemover.init({ sessionId: ctx.project.id })
  return {
    "tool.execute.before": async (input, output) => {
      output.args = await maskTextFields(output.args, t => pii.mask(t))
    },
    "tool.execute.after": async (input, output) => {
      if (typeof output.output === "string") {
        output.output = pii.restore(output.output).text
      }
    },
    "experimental.text.complete": async (input, output) => {
      if (typeof output.text === "string") {
        output.text = pii.restore(output.text).text
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.idle") pii.dispose()
    },
  }
}
```

`experimental.*` hook은 OpenCode 메이저 버전 업데이트 시 깨질 가능성 — `experimental: false` 옵션으로 비활성 가능. Phase 3 Local LLM Proxy(ADR-0004)는 여전히 더 견고한 fallback (streaming + Claude Code).

### 12.2 Claude Code Hook

```jsonc
// ~/.claude/settings.json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "pii-remover",
          "args": ["mask"],
          "timeout": 5
        }]
      }
    ]
  }
}
```

응답 복원은 hook으로 불가능 → §12.3 프록시 사용.

### 12.3 Local LLM Proxy

#### 12.3.1 사용자 환경변수 (단일 포트, path 기반 라우팅)

```bash
export ANTHROPIC_BASE_URL=http://localhost:8000/anthropic/v1
export OPENAI_API_BASE=http://localhost:8000/openai/v1

# 프록시는 백엔드와 같은 프로세스에서 서빙됨 (Python 포팅, 단일 포트 8000)
docker compose -f packages/backend/docker-compose.yml up -d
```

**path prefix → 업스트림 매핑**:

| 클라이언트가 보내는 path | 프록시가 라우팅하는 업스트림 |
|---|---|
| `POST /anthropic/v1/messages` | `https://api.anthropic.com/v1/messages` |
| `POST /openai/v1/chat/completions` | `https://api.openai.com/v1/chat/completions` |
| `POST /openai/v1/embeddings` | `https://api.openai.com/v1/embeddings` |
| (향후) `POST /google/v1/...` | `https://generativelanguage.googleapis.com/...` |
| (향후) `POST /groq/v1/chat/completions` | `https://api.groq.com/openai/v1/chat/completions` |

**라우팅 규칙**:
- path 1차 segment(`/anthropic`, `/openai`)로 프로바이더 식별
- 1차 segment 제거 후 나머지 path를 업스트림에 그대로 전달
- 업스트림 URL은 `proxy.upstream.<provider>` 설정에서 override 가능 (azure openai 같은 비표준 호스트 대응)

#### 12.3.2 처리 흐름
1. 클라이언트 요청 본문 파싱 (Anthropic vs OpenAI 형식은 path prefix로 구분)
2. user message 텍스트 추출 → `PIIRemover.mask()` → vault 갱신
3. 마스킹된 본문으로 업스트림 호출 (`Authorization` 헤더 pass-through)
4. 업스트림 응답 본문 파싱 → assistant 텍스트 추출 → `PIIRemover.restore()`
5. 복원된 본문을 클라이언트에 반환

#### 12.3.3 SSE 스트리밍 (v1 필수)

**원칙**: 클라이언트가 `stream: true`로 요청하면 프록시는 SSE 이벤트를 받는 즉시 변환하여 즉시 forward. UX 손실 없음. 토큰 boundary buffering으로 split된 PII 토큰을 안전하게 처리.

##### 처리 대상 이벤트
| 프로바이더 | SSE 이벤트 | 변환 필드 |
|---|---|---|
| Anthropic | `event: content_block_delta` | `data.delta.text` |
| Anthropic | `event: message_delta` (중간 정리) | passthrough |
| OpenAI | `data: { choices:[{ delta:{ content }}]}` | `choices[i].delta.content` |
| OpenAI | tool_calls delta | `choices[i].delta.tool_calls[].function.arguments` (JSON 내부 마스킹) |

##### 토큰 Boundary Buffering 알고리즘
우리 토큰 형식 `__OPF_<CAT>_<IDX>__`는 최대 ~24자(`__OPF_` + `PRIVATE_PERSON` 등 + `_<숫자>` + `__`).
**핵심 문제**: LLM이 토큰을 두 delta로 쪼개 보낼 수 있음 (`__OPF_PER` + `SON_1__`). 잘린 채로 emit하면 복원 불가.

```text
상태:  ringBuffer (최대 64자, proxy.streaming.buffer_window)

for each SSE delta:
  text = delta.text
  ringBuffer += text

  # 잠재 토큰 prefix 후보 위치 찾기
  unsafeStart = findUnsafeBoundary(ringBuffer)
    # = 마지막 `__OPF_` 또는 그 부분 prefix(`__`, `__O`, ...) 시작 위치
    # 없으면 ringBuffer.length

  safe = ringBuffer.slice(0, unsafeStart)
  hold = ringBuffer.slice(unsafeStart)

  if safe.length > 0:
    restored = Restorer.scan(safe, vault)  # 완전한 토큰 모두 복원
    emit(restored)                          # 클라이언트에 즉시 forward
    ringBuffer = hold
  else:
    # 전체가 잠재 토큰 prefix → 다음 delta까지 holding

on stream end (event: message_stop / [DONE]):
  if proxy.streaming.flush_on_close:
    restored = Restorer.scan(ringBuffer, vault)  # lenient mode
    emit(restored)
  ringBuffer = ""
```

##### `findUnsafeBoundary()` 구현
- 뒤에서부터 최대 `buffer_window`(64자) 스캔
- 정규식: `/__OPF_[A-Z_]*_?\d*_?_?$/` (불완전 토큰의 모든 부분 prefix)
- 매치되면 매치 시작 인덱스 반환
- 추가: 단일 `_`, `__` 만 있어도 next delta가 `_OPF_...` 이어질 가능성 보존

##### 엣지 케이스
| 케이스 | 처리 |
|---|---|
| delta가 토큰 끝(`__OPF_X_1__`)에서 정확히 끝남 | safe로 처리, 즉시 복원 |
| delta가 토큰 prefix(`__OPF_PERS`)에서 끝남 | hold, 다음 delta 대기 |
| delta가 토큰 prefix만 (`__OPF_`) 단독 | hold |
| LLM이 토큰을 끝내지 않고 stream 종료 | `flush_on_close`로 lenient regex 복원 시도, 실패 시 원본 그대로 emit (경고 로깅) |
| 클라이언트 연결 끊김 | upstream 응답 즉시 abort, vault는 유지 (재연결 시 같은 세션 활용) |
| Anthropic `usage` 이벤트 등 메타 | 변환 없이 passthrough |

##### 성능 목표
- 추가 지연 per delta: ≤ 1ms (in-memory regex)
- 추가 지연 per stream end: ≤ 5ms (flush)
- 클라이언트가 토큰 등장 후 첫 화면 표시까지 추가 지연: ≤ buffer_window 만큼의 토큰만 늦게 → 사실상 ~20자 늦게 (체감 없음)

##### v2 강화 항목 (백로그)
- 다중 vault session 동시 처리 (현재는 프록시 단일 vault)
- Anthropic vision content_block(이미지) 통과 검증
- OpenAI `function_call` legacy 형식 지원

#### 12.3.4 멀티 프로바이더의 장점
- 단일 포트(8765)만 열면 모든 LLM 클라이언트 커버 (방화벽/포트 관리 단순)
- 프로바이더 추가 시 path 라우팅 한 줄 + 변환 로직 한 파일만 추가
- 클라이언트별로 다른 환경변수 쓰지만 vault는 동일 인스턴스 공유 (한 프로젝트가 Anthropic + OpenAI 혼용 시 같은 PII 매핑 유지)

---

## 13. 디렉토리 구조

```
pii-remover/
├── docs/
│   ├── ARCHITECTURE.md            # 이 문서
│   ├── ROADMAP.md                  # 단계별 마일스톤
│   ├── ADR/                        # Architecture Decision Records
│   └── KOREAN_PII.md               # 한국 PII 알고리즘 상세 (v1.x)
│
├── packages/
│   ├── core/                       # @pii-remover/core (TS, 모두 의존)
│   │   ├── src/
│   │   │   ├── detector/
│   │   │   │   ├── regex/         # 한국 정규식, 이메일/카드 등
│   │   │   │   ├── korean-heuristic/  # 성씨 리스트 + 패턴
│   │   │   │   └── index.ts        # detector orchestration
│   │   │   ├── backend/
│   │   │   │   ├── client.ts       # BackendClient interface
│   │   │   │   ├── opf-http.ts     # OpfHttpBackend
│   │   │   │   ├── local-regex.ts  # LocalRegexBackend
│   │   │   │   └── strategy/       # MergeStrategy, TieredStrategy
│   │   │   ├── vault/
│   │   │   │   ├── schema.ts        # opf.reversible.v1
│   │   │   │   └── manager.ts       # in-memory Map<sessionId, Vault>
│   │   │   ├── restorer/
│   │   │   │   └── index.ts         # strict + lenient regex
│   │   │   ├── token/
│   │   │   │   └── format.ts        # __OPF_X_N__ 생성/파싱
│   │   │   ├── config/
│   │   │   │   └── loader.ts        # 환경변수 substitution
│   │   │   ├── policy/
│   │   │   │   └── failure.ts       # closed/hybrid/open
│   │   │   └── index.ts             # PIIRemover public API
│   │   └── package.json
│   │
│   ├── opencode-plugin/             # @pii-remover/opencode-plugin
│   │   ├── src/index.ts
│   │   └── package.json
│   │
│   ├── cli/                          # @pii-remover/cli (멀티 호스트 CLI 바이너리; 원래 claude-hook)
│   │   ├── src/cli.ts                # mask | restore | health
│   │   ├── bin/pii-remover.ts        # bun compile entry
│   │   └── package.json
│   │
│   ├── proxy/                        # @pii-remover/proxy
│   │   ├── src/
│   │   │   ├── server.ts              # HTTP 서버 (레퍼런스 구현; 런타임은 packages/backend)
│   │   │   ├── router.ts              # path prefix → provider 라우팅
│   │   │   ├── providers/
│   │   │   │   ├── anthropic.ts       # /v1/messages 변환
│   │   │   │   └── openai.ts          # /v1/chat/completions 변환
│   │   │   └── stream/
│   │   │       ├── buffer.ts          # findUnsafeBoundary + ringBuffer
│   │   │       ├── anthropic-sse.ts   # content_block_delta 처리
│   │   │       └── openai-sse.ts      # delta.content 처리
│   │   └── package.json
│   │
│   └── shared-types/                 # @pii-remover/types (선택)
│
├── examples/
│   ├── opencode-setup.md
│   ├── claude-code-setup.md
│   └── docker-compose.yml            # 자체 빌드 OPF backend + (v2) KLUE-NER
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│       └── corpus/                    # 한국/영문 PII 100건 검증 코퍼스
│
├── .pii-remover.example.json
├── package.json                       # workspace root
└── README.md
```

---

## 14. Cross-References
- **ROADMAP**: 단계별 구현 계획 → [`ROADMAP.md`](./ROADMAP.md)
- **ADR**: 변경/대안 의사결정 → [`ADR/`](./ADR/)
  - [ADR-0001: TypeScript 단일 core 언어](./ADR/0001-typescript-single-core.md)
  - [ADR-0002: 토큰 형식 `__OPF_<CATEGORY>_<INDEX>__`](./ADR/0002-token-format-opf-underscore.md)
  - [ADR-0003: Vault — 세션 스코프 인메모리, `opf.reversible.v1`](./ADR/0003-vault-session-in-memory.md)
  - [ADR-0004: 로컬 LLM 프록시 + path prefix 라우팅 + SSE 스트리밍 v1](./ADR/0004-local-llm-proxy-streaming.md)
  - [ADR-0005: Backend Strategy 인터페이스 + 4-Tier 신뢰 모델](./ADR/0005-backend-strategy-trust-tiers.md)
  - [ADR-0006: fail-closed default + opt-in bypass](./ADR/0006-fail-closed-default.md)
  - [ADR-0007: 한국 PII — v1 정규식+휴리스틱, v2 KLUE-NER](./ADR/0007-korean-pii-strategy.md)
  - [ADR-0008: Detection 백엔드 — 자체 Docker 이미지 빌드 (gh0stkey API 호환)](./ADR/0008-detection-backend-self-built-docker.md)
  - [ADR-0009: Vision/multimodal PII 마스킹 (becoolme 패턴 채택, v1 Phase 6)](./ADR/0009-vision-multimodal-v2.md)
  - [ADR-0010: PII 카테고리 — OPF 8 + 한국 확장 3 = 총 11](./ADR/0010-pii-categories-opf-plus-korean.md)
- **참조 레포지토리**:
  - [`openai/privacy-filter`](https://github.com/openai/privacy-filter) — Apache-2.0, ground truth 모델
  - [`gh0stkey/opf-privacy-filter`](https://github.com/gh0stkey/opf-privacy-filter) — Docker HTTP API **형식 참조 only** (코드 미사용 — ADR-0008)
  - [`deformatic/OPENAI-Privacy-Filter-Reversible-Tokenization`](https://github.com/deformatic/OPENAI-Privacy-Filter-Reversible-Tokenization) — Apache-2.0, vault 패턴
  - [`becoolme/privacyfilter.app`](https://github.com/becoolme/privacyfilter.app) — MIT, 브라우저 Transformers.js 참고
- **호스트 문서**:
  - [Claude Code hooks reference](https://docs.anthropic.com/en/docs/claude-code/hooks)
  - [OpenCode plugins](https://opencode.ai/docs/plugins)
