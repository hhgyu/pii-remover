# ADR-0005: Backend Strategy 인터페이스 + 4-Tier 신뢰 모델

- **Status**: Accepted
- **Date**: 2026-05-12
- **Related**: [ARCHITECTURE.md §7, §9](../ARCHITECTURE.md), [ADR-0008](./0008-detection-backend-self-built-docker.md)

---

## Context

요구사항: **Detection 백엔드는 로컬뿐 아니라 원격 HTTP endpoint도 지원**해야 한다. 이는 단순한 endpoint URL 변경이 아니라:

1. **인터페이스 추상화**: localhost / 원격 / multi-fallback / tiered를 모두 수용할 단일 추상화 필요.
2. **신뢰 모델 정의**: PII를 LLM에 안 보내려는 도구인데, 원격 백엔드로 PII가 또 다른 외부 서버로 전송됨. "안전한 원격 백엔드"의 명확한 기준이 없으면 도구 목적 자체가 무력화될 수 있음.
3. **보안 옵션 노출**: TLS pinning, Bearer, mTLS 등. **opt-in**으로 명시 — 강제 아님.

### 핵심 위험
- 공개 3rd-party SaaS PII redaction API를 사용하면 → PII가 SaaS 벤더로 평문 전송 → LLM 회피와 동일 문제 재발.
- 다중 백엔드 fallback 시 → 최약 링크가 전체 보안 결정.
- 평문 HTTP 사용 시 → 네트워크 도청.

### 검토 옵션

**Topology 옵션** (Q7-a)
| 옵션 | 설명 |
|---|---|
| (a) Single | 런타임 endpoint URL만 바꿈. 가장 단순. |
| (b) Multi-fallback | remote 1차 → local 2차. PII가 더 많은 곳에 노출됨 (안티패턴). |
| (c) Tiered | 한국 정규식은 항상 로컬, ML 추론만 원격으로 분리. PII 네트워크 노출 최소화. |

**Backend Strategy 인터페이스 형태**
- 평면 vs 중첩 config
- 환경변수 vs 설정 파일 분리

---

## Decision

### 1. Topology: **MVP는 (a) Single, 인터페이스는 (c) Tiered 허용**

- v1 출시: `backend.type: "single"` 만 구현
- 인터페이스부터 `BackendStrategy` 추상화 도입 — 코드 변경 없이 v2에서 tiered 활성화 가능
- (b) Multi-fallback은 **거부** — 보안 안티패턴

### 2. BackendClient + BackendStrategy 인터페이스

```typescript
export type TrustTier = 'local' | 'self_hosted' | 'vendor' | 'public'

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

기본 구현체:
- `LocalRegexBackend` (always-on, `trust_tier='local'`): 한국 정규식 + 영문 이메일/카드/URL/날짜
- `OpfHttpBackend` (`trust_tier` 설정 가능): OPF HTTP API 호환 (`POST /redact`), 자체 빌드 백엔드 ([ADR-0008](./0008-detection-backend-self-built-docker.md)) 또는 호환 서버
- `MergeStrategy`: 여러 BackendClient 결과 union (overlap은 longer-span 우선)
- `TieredStrategy` (v2+): 로컬 regex 우선 → 남은 텍스트만 원격

### 3. 4-Tier 신뢰표 (README/문서화 의무)

| Tier | 백엔드 유형 | 권고 |
|---|---|---|
| 🟢 1 | localhost Docker (`http://localhost:8000`) | 신뢰. **default** |
| 🟢 2 | 사내 자체호스팅 + TLS | 신뢰. Bearer 토큰 권고 |
| 🟡 3 | 벤더 호스팅 + 계약(DPA/BAA) | 주의. 5조건 검증 |
| 🔴 4 | 공개 3rd-party SaaS API | **사용 비추천** — PII 외부 유출 |

### 4. "안전한 원격 백엔드" 5조건

1. **소유권**: 자체 호스팅 OR 계약상 데이터 처리 합의(DPA/BAA) 있음
2. **전송 암호화**: TLS 1.2+ 필수, 평문 HTTP 거부
3. **로깅 정책**: 백엔드가 request body를 영구 저장 안 함 (문서로 확인)
4. **데이터 거주**: 지리적 위치 알 수 있음 (GDPR/PIPA 준수)
5. **인증**: 최소 Bearer 토큰 — 익명 endpoint 거부

### 5. 보안 옵션 (모두 opt-in)

- `backend.tls.pinning.{enabled, sha256_fingerprint}` — 서버 인증서 고정
- `backend.auth.type: "bearer"` + `token_env: "VAR_NAME"`
- `backend.auth.type: "mtls"` + 클라이언트 인증서 경로
- 응답 무결성 (HMAC) — v2

### 6. Secret 처리 원칙

- **config 파일에 secret 평문 절대 금지**
- 모든 secret은 환경변수 이름으로만 참조 (예: `token_env: "PII_API_TOKEN"`)
- 환경변수 미설정 시 즉시 fail-closed (시작도 안 함)

---

## Consequences

### 긍정적
- **점진 마이그레이션**: v1은 단순, v2에서 tiered 활성화 시 코드 변경 최소.
- **명확한 신뢰 정책**: 4-Tier 표가 사용자에게 "이 백엔드 써도 되는가?" 빠른 판단 도구 제공.
- **secret 누수 방지**: env-only 강제로 config 파일이 실수로 git에 올라가도 토큰 유출 없음.
- **호환성**: gh0stkey API 형식을 표준으로 채택 → 다른 OPF wrapper와도 호환.

### 부정적
- **Single backend로 출발하므로 PII 네트워크 노출 최소화 이득이 v1 동안은 0** (Tiered는 v2).
- **신뢰 모델 강제 안 함**: 사용자가 🔴 Tier 4 (공개 SaaS)를 설정해도 도구는 동작. 경고만 로깅. → 보안 정책의 문서화 의존성.
- **TLS pinning 등 보안 옵션 미사용 default**: opt-in 원칙이라 default가 약함. 외부 노출 시나리오 사용자가 신경 써야 함.

### 위험 / 미해결 사항
- **Multi-fallback 누락**: 일부 사용자가 "원격 다운 시 로컬로 자동 폴백" 원할 수 있음. 거부 이유(보안)를 명확히 문서화 + Q6 fail-closed/hybrid 모드로 일부 대체 가능함을 안내.
- **trust_tier 자기보고**: 백엔드 자기가 `trust_tier`를 보고함 → 악성 백엔드가 거짓말 가능. v1은 trust_tier를 **클라이언트 설정에서 명시**(사용자가 선언)하도록 함, 백엔드 자기보고 무시.

---

## Alternatives Considered

### Multi-fallback (b) 채택
- **거부 이유**: PII가 fallback 체인의 모든 백엔드에 노출 → 보안 약화. 또한 fallback이 자주 발동하면 사용자가 "백엔드 신뢰성 문제 인지" 못함. fail-closed가 명확한 신호.

### Tiered (c) v1부터 구현
- **연기 이유**: 한국 정규식 + 영문 ML 분리 로직, span overlap 해결, vault 일관성 추가 복잡도. v1 critical path가 아님. v2 ADR로.

### 백엔드 자기보고 trust_tier 신뢰
- **거부 이유**: 악성 백엔드가 자신을 `local`로 보고할 수 있음. 클라이언트가 명시한 tier가 ground truth.

### 모든 보안 옵션을 default-on
- **거부 이유**: 사용자 UX 비강제 원칙. TLS pinning 강제 시 self-signed cert 환경에서 동작 실패 → 사용자 짜증. opt-in이 best practice.

### Secret을 config 파일에 직접 저장 허용
- **거부 이유**: git 실수 커밋 위험. 보안 인시던트의 가장 흔한 원인. env-only 강제로 회피.

---

## Implementation Notes

### 패키지 구조
```
packages/core/src/backend/
├── client.ts           # BackendClient interface
├── strategy.ts         # BackendStrategy + MergeStrategy + TieredStrategy
├── local-regex.ts      # LocalRegexBackend (always-on)
├── opf-http.ts         # OpfHttpBackend (OPF HTTP API)
└── tls/
    ├── pinning.ts      # SHA-256 fingerprint 검증
    └── mtls.ts         # 클라이언트 인증서 로드
```

### 설정 예시
```jsonc
{
  "backend": {
    "type": "single",
    "endpoint": "http://localhost:8000/redact",
    "trust_tier": "local",
    "auth": { "type": "none" },
    "tls": { "verify": true, "pinning": { "enabled": false } },
    "timeout_ms": 2000,
    "retries": 1
  }
}
```

### 검증 시점
- 프록시 시작 시 `BackendClient.healthCheck()` 호출
- 실패 시 `failure_policy`에 따라 fail-closed/hybrid (ADR-0006)

---

## References

- ADR-0006: failure_policy와의 연관
- ADR-0008: 자체 OPF Docker 이미지 빌드 (gh0stkey API 호환)
- ARCHITECTURE.md §7 (Backend Client interface), §9 (보안 모델)
- [`../TRUST_TIERS.md`](../TRUST_TIERS.md) — 4-Tier 신뢰표 운영 가이드 (Phase 5 구현 후 작성)
