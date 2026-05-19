# ADR-0003: Vault — 세션 스코프 인메모리, `opf.reversible.v1` 스키마 채택

- **Status**: Accepted
- **Date**: 2026-05-12
- **Related**: [ARCHITECTURE.md §6](../ARCHITECTURE.md#6-vault-명세), [ADR-0002](./0002-token-format-opf-underscore.md)

---

## Context

가역 토큰화는 **vault**(토큰 ↔ 원본 매핑 저장소)에 의존한다. vault 설계는 **보안, 정확성, 동시성, 운영성** 네 측면 모두에 영향을 준다. 잘못 설계하면:

- **보안**: vault 평문 디스크 저장 → PII 영구 노출
- **정확성**: 같은 사람을 두 번 다른 토큰으로 → LLM이 "두 명"으로 오해
- **동시성**: 여러 세션이 같은 vault 공유 → 인덱스 충돌
- **운영성**: vault 영속화 → 백업/암호화/TTL/만료 복잡도 폭증

### 사용자 페르소나 (단순화 근거)
- 개발자 1인이 자기 노트북에서 CLI 사용
- 세션 수명 ~ 한 작업 컨텍스트 (수십 분 ~ 몇 시간)
- 멀티테넌트/팀 공유 시나리오 없음 (v1 기준)

### 검토 옵션

| 차원 | 옵션 |
|---|---|
| 저장 매체 | 인메모리 only / 디스크 평문 JSON / 디스크 암호화 / 외부 KMS |
| 저장 범위 | 글로벌(프로세스 1개) / 세션별 / 사용자별 |
| 영속성 | 휘발성 / 세션 종료까지 / TTL 기반 / 영구 |
| 스키마 | deformatic의 `opf.reversible.v1` / 자체 정의 |

`deformatic` README의 명시적 경고:
> "this is not anonymization. It is recoverable pseudonymization. The tokenized text is useful only if the vault is protected like source PII."
> "A production deployment should not store vaults as plaintext JSON."

---

## Decision

### 1. 저장 매체: **프로세스 메모리 only** (v1)
- `Map<sessionId, Vault>` 형태로 RAM 보관
- 디스크 영속 완전 금지 (config `vault.persist: true` 옵션 자체를 v1에서 미구현)

### 2. 저장 범위: **세션 스코프**
- 호스트별 세션 식별자:
  - OpenCode: `ctx.project.id` 또는 `session.created` 이벤트의 세션 ID
  - Claude Code hook: 세션 단위 식별 어려움 → 단일 vault per process 사용
  - Proxy: client connection 단위 vault (또는 명시적 `X-PII-Session` 헤더)

### 3. 영속성: **세션 종료 시 dispose**
- `session.idle` 또는 proxy connection close 시 즉시 메모리 해제
- 세션 재개 시: 채팅 히스토리를 다시 detector에 통과시켜 **idempotent하게 재구축**

### 4. 스키마: **`opf.reversible.v1` 채택 + 확장**
deformatic 스키마를 그대로 따르되 세션 메타 필드 추가:

```typescript
interface VaultEntry {
  label: string            // OPF 카테고리 또는 한국 확장 (소문자)
  text: string             // 원본 surface form
  canonical_text: string   // 정규화 (whitespace 정리)
  index: number            // 1-base
}

interface Vault {
  schema_version: "opf.reversible.v1"
  vault_id: string                          // UUID v4 (세션 단위)
  entries: Record<string, VaultEntry>       // token → entry
  created_at: number                        // unix ms
}
```

### 5. 인덱스 할당 규칙 (deformatic 패턴 채택)
- 같은 `(label, canonical_text)` → 같은 토큰 재사용 (dedup)
- 다른 `label` + 같은 `text` → 다른 토큰 family
- 다른 `canonical_text` + 같은 `label` → 다음 인덱스
- overlapping spans → ValueError throw (호출자가 sort/충돌 해결)

---

## Consequences

### 긍정적
- **공격면 0**: 디스크에 PII 평문 없음. 메모리 덤프만이 유일한 노출 경로.
- **동시성 자동 회피**: 세션마다 독립 인스턴스 → 세션 A의 `PERSON_1`과 세션 B의 `PERSON_1`이 다른 원본을 가져도 무관 (`vault_id`로 구분).
- **TTL 자동**: 세션 수명에 자연 종속, 별도 정책 불필요.
- **스키마 호환성**: deformatic 코드/스키마와 호환되어 향후 Python OPF 백엔드와 데이터 교환 가능.
- **재구축 가능**: 세션 크래시 후 재개해도 채팅 히스토리 재마스킹으로 동일 매핑 복원 (regex/canonical_text가 결정적이므로).

### 부정적
- **세션 크래시 시 일시적 손실**: 어시스턴트가 이전 턴 토큰을 다음 턴에 다시 언급할 때 vault 없으면 복원 불가 → 재마스킹으로 완화 (idempotent).
- **장기 세션 메모리 누수 위험**: 한 세션이 며칠 동안 살아 있으면 vault entries 증가 → 최대 entry 수 제한(예: 10,000) 또는 LRU 도입 검토.
- **multi-process 환경 미지원**: 같은 프로젝트를 두 터미널에서 동시 작업 시 vault 격리됨 → 사용자가 같은 PII를 두 번 마스킹할 수 있음 (다른 인덱스 부여). 일관성이 깨지지만 보안은 유지.

### 위험 / 미해결 사항
- **부분 매치 (suffix match)**: vault에 "김철수" → `PERSON_1` 등록 후, 어시스턴트가 "철수"만 언급. v1은 surface form 정확 매치만 → "철수" 복원 안 됨. v2에서 suffix trie 도입 검토.
- **vault entry 순서 의존성**: same surface form이 다른 contexts(예: "John" 다른 의미)에서 등장 시 첫 등장이 인덱스 결정 → 모호성. canonical_text + label로 충돌 회피하지만 동의어 처리 한계.

---

## Alternatives Considered

### 디스크 평문 JSON (deformatic CLI 옵션)
- **거부 이유**: deformatic README도 "production: 평문 금지" 경고. 개발자 노트북도 분실/도난/멀웨어 위험 존재. v1 사용자 페르소나가 "내 노트북에서 혼자 사용"이라도 평문 PII는 OS 백업/iCloud/타임머신 등으로 의도치 않게 클라우드 동기화 위험.

### 디스크 암호화 (KMS / OS keychain)
- **연기 이유**: 추가 복잡도 (KMS 통합, 키 로테이션, 권한 정책). v1 사용자 페르소나에 과잉. 세션 재개 fast-path가 필요해지면 v2 ADR로 재결정.

### 글로벌 vault (프로세스 단일)
- **거부 이유**: 멀티 세션 동시 사용 시 인덱스 충돌. 세션 A의 "철수"와 세션 B의 "영희"가 둘 다 `PERSON_1`이 되거나, 한쪽이 다음 인덱스로 밀리면 의미 혼동.

### 자체 스키마 (deformatic 무시)
- **거부 이유**: `opf.reversible.v1`은 이미 8 카테고리 + canonical_text + collision rules가 잘 정의되어 있음. 차별화 이득 없이 호환성만 손실.

### 외부 vault 서비스 (HashiCorp Vault / AWS Secrets Manager)
- **거부 이유**: 개발자 1인용 CLI 도구에 외부 서비스 의존 추가 = 진입장벽. 엔터프라이즈 배포 시 ADR-XXXX로 별도 결정.

---

## Implementation Notes

- 패키지: `packages/core/src/vault/`
  - `schema.ts`: `Vault`, `VaultEntry` 타입 + `SCHEMA_VERSION` 상수
  - `manager.ts`: `VaultManager` 클래스 — `Map<sessionId, Vault>`, `assign()`, `restore()`, `dispose()`
- 메모리 한도: vault entries 수 > 10,000 시 경고 로깅, > 100,000 시 fail-closed로 차단
- 직렬화: `Vault.toJSON()`은 디버깅 전용. 절대 디스크 쓰지 않음 (옵션 자체 없음)
- 동시성: JavaScript single-thread라 race condition 거의 없음. Bun이 다중 worker 도입 시 `AsyncLocalStorage` 검토

---

## References
- deformatic 스키마: https://github.com/deformatic/OPENAI-Privacy-Filter-Reversible-Tokenization (`OUTPUT_SCHEMAS.md`)

- ADR-0002: 토큰 형식 명세 (vault와 짝)
