# ADR-0006: fail-closed default + opt-in bypass

- **Status**: Accepted
- **Date**: 2026-05-12
- **Related**: [ARCHITECTURE.md §10](../ARCHITECTURE.md#10-장애-모드-정책), [ADR-0005](./0005-backend-strategy-trust-tiers.md)

---

## Context

PII 마스킹 파이프라인이 실패할 수 있는 시점은 여러 곳이다:

- Detection 백엔드(OPF Docker) 다운/타임아웃
- 원격 백엔드 네트워크 오류
- 정규식 catastrophic backtracking
- Vault 메모리 누수/할당 실패
- 설정 파일 파싱 오류
- 환경변수 미설정 (Bearer 토큰 없음 등)

**실패 시 어떻게 행동할지가 도구의 보안 보증을 정의한다.** 옵션:

| 모드 | 동작 | 장점 | 단점 |
|---|---|---|---|
| **fail-open** | 원본 그대로 LLM 전송 | 개발자 작업 안 막힘 | **PII 유출** — 도구 목적 무력화 |
| **fail-closed** | LLM 호출 차단 | 안전 보증 유지 | 개발자 짜증, 작업 막힘 |
| **hybrid** | Regex만으로 fallback | 부분 안전 | 일부 PII 잡음, 일부 누출 |

### 추가 고려사항
- **개발자 도구 vs 엔터프라이즈 보안 도구**: 도구가 사용자 작업을 막으면 사용자는 결국 도구를 끄거나 우회. 영구 비활성화 = 도구 무력화.
- **개발자가 실패 원인 파악 가능한가**: fail-closed는 명확한 에러 메시지가 필수. "그냥 안 됨"은 짜증의 원인.
- **원격 백엔드 vs 로컬 백엔드의 실패는 같은 의미인가**: 원격 실패는 네트워크/MITM 의심도 포함 → 더 보수적 권고.

---

## Decision

### 1. **fail-closed를 default**로 채택

- 마스킹 파이프라인 실패 시 LLM 호출 차단
- 사용자에게 **명확한 에러 메시지** 표시:
  - 어디서 실패했나 (백엔드 다운? 정규식 오류? config 파싱?)
  - bypass 방법 안내

### 2. 3-Tier Failure Policy (사용자 선택)

| 모드 | Detector 실패 시 | Regex fallback | LLM 호출 |
|---|---|---|---|
| `closed` (**default**) | 차단 | 사용 안 함 | 막힘. 에러 + bypass 가이드 |
| `hybrid` | regex로 전환 | 사용 | 한국 PII만이라도 마스킹된 채 호출, 경고 로깅 |
| `open` | 통과 | n/a | 원본 전송 (디버그 전용, 위험 명시) |

### 3. Bypass 메커니즘 (opt-in)

- 환경변수: `PII_REMOVER_BYPASS=1`
- 일회성 CLI 플래그: `--no-pii`
- 영구 설정: `failure_policy: "open"` (위험)

bypass 사용 시:
- stderr에 명확한 경고: `"⚠ PII REDACTION BYPASSED — your PII may be sent to the LLM"`
- 로컬 로깅 (선택적, 사용자가 옵션으로 끌 수 있음)

### 4. 원격 백엔드 실패의 추가 보수성

- 동일 fail-closed default
- 단 bypass 경고는 **더 강하게**:
  > "원격 redaction이 죽었으니 PII가 LLM에 평문으로 갑니다 — 진짜로 계속?"
- 재시도: 1회 max, timeout 2초 (지수 백오프 없음 — 대화형 도구 UX)

### 5. Bypass 빈도 모니터링

- 로컬 카운터 (텔레메트리 X)
- 일정 빈도 초과 시 사용자 경고: "bypass를 자주 쓰고 있어요. config 점검을 권합니다."

---

## Consequences

### 긍정적
- **보안 보증 유지**: 도구가 "조용히 깨짐" 방지. audit 시 책임 회피 불가 ("켰는데 꺼져있던" 케이스 없음).
- **사용자 신호**: 실패가 즉시 보임 → 백엔드 장애/설정 오류 빠르게 인지.
- **opt-in bypass**: 정말 급할 때 명시적으로 우회 가능. 강제 차단 아님.

### 부정적
- **개발자 짜증**: 백엔드가 자주 다운되면 사용자가 결국 `PII_REMOVER_BYPASS=1` 영구 export → 도구 무력화.
  - **완화**: hybrid 모드 권장 (regex만이라도 동작), bypass 빈도 모니터링.
- **명확한 에러 메시지 작성 부담**: 모든 실패 경로마다 사용자가 이해할 수 있는 메시지 필요. 개발 비용 ↑.

### 위험 / 미해결 사항
- **opt-in 보안 원칙과의 긴장**: "보안 옵션은 강제하지 않음(opt-in)" 원칙과 fail-closed의 사실상 강제 동작 사이 충돌. 해석: "PII 마스킹 자체"는 핵심 기능, opt-in 원칙은 TLS/Bearer 같은 **부가 보안**에만 적용.
- **개발 환경에서 짜증**: 로컬 OPF Docker 가동 안 한 상태에서 시작 시 매번 차단. → `hybrid` 모드 권장을 README에 강조.

---

## Alternatives Considered

### fail-open default
- **거부 이유**: 도구의 존재 이유 자체가 PII 차단. fail-open default는 보안 보증을 조용히 깸. audit 시 "PII 마스킹 켰는데 종종 꺼져있었음" → 책임 회피 불가능.

### hybrid를 default
- **거부 이유**: 한국 정규식이 잡는 PII는 일부 (주민/전화/카드/이메일). 영문 이름/주소 등은 OPF 모델 의존. hybrid default는 "사용자가 알아채지 못하게 부분 보안만 보장" → fail-open과 유사한 위험. closed default + hybrid opt-in이 명시적.

### Bypass 메커니즘 미제공
- **거부 이유**: bypass 없으면 사용자가 결국 도구 자체를 disable. 명시적 bypass + 빈도 모니터링이 "도구 켜둔 상태로 가끔 우회"를 가능하게 함 → 평균 보호 수준 ↑.

### Bypass 시 텔레메트리 전송
- **거부 이유**: 개발자 도구의 텔레메트리는 신뢰 손상. 로컬 로깅만 + 사용자가 직접 점검.

---

## Implementation Notes

### 패키지 구조
```
packages/core/src/policy/
├── failure.ts         # FailurePolicy enum + applyPolicy()
└── bypass.ts          # bypass 환경변수/플래그 감지 + 경고 출력
```

### 에러 메시지 템플릿
```
✗ PII Remover: backend health check failed

  Backend: http://localhost:8000/redact (LocalDocker)
  Error:   connection refused
  Policy:  closed (default)

  Options:
    1. Start the backend:    docker compose up opf-backend
    2. Switch to hybrid:     export PII_REMOVER_POLICY=hybrid
    3. Bypass once:          PII_REMOVER_BYPASS=1 <your command>
    4. Permanently disable:  set failure_policy: "open" in config (NOT RECOMMENDED)
```

### 단위 테스트 시나리오
- 백엔드 timeout → closed 모드: 차단 + 에러
- 백엔드 timeout → hybrid 모드: regex만 동작, 경고 로깅
- 백엔드 timeout → open 모드: 원본 통과, stderr 경고
- bypass env 설정 시: 모드 무시하고 원본 통과
- bypass 사용 빈도 카운터 증가

---

## References

- ADR-0005: backend trust tier (원격 실패 시 더 보수적 권고 근거)
- ARCHITECTURE.md §10: 장애 모드 정책 전체
