# ADR-0010: PII 카테고리 — OPF 8 + 한국 확장 3 = 총 11

- **Status**: Accepted
- **Date**: 2026-05-12
- **Related**: [ARCHITECTURE.md §5.2, §11](../ARCHITECTURE.md), [ADR-0002](./0002-token-format-opf-underscore.md), [ADR-0007](./0007-korean-pii-strategy.md), [ADR-0008](./0008-detection-backend-self-built-docker.md)

---

## Context

PII 카테고리 taxonomy는 시스템 전반에 영향을 미친다:
- 토큰 형식(`__OPF_<CATEGORY>_<INDEX>__`)의 `<CATEGORY>` 값
- Vault 스키마의 `label` 필드
- Backend API의 응답 형식
- 사용자 config의 `enabled_categories` 옵션
- 한국 PII가 영문 OPF 카테고리에 매핑되는지, 별도 카테고리 가지는지

### OPF가 제공하는 8 카테고리
README + 모델 문서 기준:
1. `account_number`
2. `private_address`
3. `private_email`
4. `private_person`
5. `private_phone`
6. `private_url`
7. `private_date`
8. `secret`

### 한국 PII (ADR-0007에서 확정)
- 주민등록번호 (체크섬 검증 가능)
- 사업자등록번호 (체크섬 검증 가능)
- 카드번호 (LUHN — 다국 공통이지만 한국 카드 패턴 빈번)
- 전화번호 (010-XXXX-XXXX — `private_phone` 재사용 가능)
- 이메일 (RFC 5322 — `private_email` 재사용)
- 한국 이름 (휴리스틱 — `private_person` 재사용)

### 결정 포인트
1. 주민/사업자/카드는 **새 카테고리**로 분리? 아니면 `account_number`에 통합?
2. 한국 전화/이메일/이름은 OPF 카테고리 재사용? 한국 전용 카테고리?
3. 토큰 표기는 한국 카테고리에 어떻게 줄까?

---

## Decision

### 1. **OPF 8 카테고리는 그대로 채택**

매핑은 ADR-0002 토큰 형식과 정합:

| OPF 라벨 | 토큰 카테고리 | 비고 |
|---|---|---|
| `private_person` | `PERSON` | 영문 이름 + 한국 이름 (휴리스틱) 통합 |
| `private_email` | `EMAIL` | 다국 공통 |
| `private_phone` | `PHONE` | 한국 전화도 포함 |
| `private_address` | `ADDRESS` | 영문 우선, 한국 주소는 v1 미보장 |
| `account_number` | `ACCOUNT` | 일반 계좌번호 |
| `private_date` | `DATE` | 생년월일 등 |
| `private_url` | `URL` | 다국 공통 |
| `secret` | `SECRET` | API 키, 토큰, 패스워드 |

### 2. **한국 전용 카테고리 3종 추가**

체크섬으로 정확하게 분류 가능하고, 일반 `account_number`와 구분이 의미 있는 항목만 추가:

| 카테고리 | 토큰 | 검증 |
|---|---|---|
| `rrn` (주민등록번호) | `RRN` | 13자리 + 가중치 체크섬 |
| `biz_num` (사업자등록번호) | `BIZNUM` | 10자리 + 가중치 체크섬 |
| `card` (신용카드) | `CARD` | LUHN 체크섬 |

### 3. **재사용 카테고리** (별도 추가 안 함)

| 한국 PII | 사용 카테고리 | 이유 |
|---|---|---|
| 한국 이름 | `PERSON` | 영문 이름과 의미적 동일, 토큰 카테고리 분리 무의미 |
| 한국 전화 (010-) | `PHONE` | 형식만 다를 뿐 의미 동일 |
| 한국 이메일 | `EMAIL` | TLD만 다름 |
| 한국 주소 | `ADDRESS` | v1 미보장 — OPF가 잡는 만큼만 |

### 4. **카테고리별 OPF backend vs local detector 책임**

| 카테고리 | v1 책임 | 비고 |
|---|---|---|
| `PERSON` | OPF + 한국 휴리스틱 union | 한국 이름은 휴리스틱이 우선 |
| `EMAIL` | OPF + 로컬 RFC 5322 정규식 union | |
| `PHONE` | OPF + 한국 010 정규식 union | |
| `ADDRESS` | OPF only | 한국 주소는 v1 미보장 |
| `ACCOUNT` | OPF only | |
| `DATE` | OPF only | |
| `URL` | OPF + 로컬 URL 정규식 | |
| `SECRET` | OPF + 로컬 (API key 패턴 등) | |
| `RRN` | **로컬 정규식 + 체크섬 only** | OPF 라벨에 없음 |
| `BIZNUM` | **로컬 정규식 + 체크섬 only** | OPF 라벨에 없음 |
| `CARD` | **로컬 LUHN only** | OPF의 `account_number`가 일부 잡을 수 있으나 우리는 별도 검출 |

### 5. 사용자 config로 카테고리 활성/비활성

```jsonc
{
  "detection": {
    "enabled_categories": [
      "private_person", "private_email", "private_phone",
      "private_address", "account_number", "private_date",
      "private_url", "secret",
      "rrn", "biz_num", "card"
    ]
  }
}
```

기본은 모두 활성. 사용자가 `enabled_categories`에서 빼면 해당 카테고리는 detection skip.

---

## Consequences

### 긍정적
- **OPF 호환성**: OPF API 응답 형식 그대로 사용 → backend 교체 시 매핑 코드 변경 X.
- **명확한 한국 PII 식별**: 토큰 `__OPF_RRN_1__`는 명확히 주민번호임을 사용자에게 알려줌 (응답 검토 시 도움).
- **체크섬 검증으로 false positive 0에 가까움**: RRN/BIZNUM/CARD 모두 체크섬 통과 시 거의 확실한 PII.
- **확장 경로 단순**: 향후 카테고리 추가 시(예: 운전면허증 번호) 새 토큰 prefix만 추가.

### 부정적
- **카테고리 수 증가 (8 → 11)**: vault 인덱스 가능 공간 증가, 다만 실제 영향 미미.
- **OPF 결과와 한국 로컬 결과의 overlap 처리 복잡도**:
  - 카드번호의 경우 OPF가 `account_number`로 잡을 수도 있고, 우리 LUHN이 `CARD`로 잡음. 두 결과 union 시 충돌. → longer-span 우선, 동일 길이는 한국 로컬 우선 (더 구체적 카테고리).

### 위험 / 미해결 사항
- **한국 주소 (`ADDRESS`) 미보장**: v1에서 한국 주소(예: "서울시 강남구 ...")를 OPF가 못 잡을 수 있음. v2에서 한국 주소 정규식 추가 검토.
- **외래어 이름**: "스미스", "톰슨" 등은 OPF가 잡을지 휴리스틱이 못 잡을지 모호. corpus 측정 필요.
- **사업자번호 vs 일반 10자리 숫자**: 체크섬으로 99% 회피 가능하나, 우연 일치 시 false positive.

---

## Alternatives Considered

### 한국 카테고리를 OPF `account_number`에 통합
- **거부 이유**: 정보 손실. 사용자가 토큰만 보고 "이게 주민번호인지 사업자번호인지 카드번호인지" 구분 불가. 응답 검토 UX 저하.

### 한국 이름을 `KR_PERSON` 별도 토큰
- **거부 이유**: 의미적 차이 없음. 한 사람을 다국어 컨텍스트에서 언급할 때 같은 카테고리가 일관적.

### OPF 카테고리 일부 제외 (예: `private_url`, `private_date`)
- **거부 이유**: 사용자가 enabled_categories로 끄면 됨. default 포함이 안전한 선택.

### 카테고리를 동적으로 추가/제거 가능하게 (custom recognizer)
- **연기 이유**: Presidio-style custom recognizer 인터페이스는 강력하지만 v1 critical path 아님. v2 ADR로.

---

## Implementation Notes

### 카테고리 매핑 상수
```typescript
// packages/core/src/token/category-map.ts
export const CATEGORY_MAP: Record<string, string> = {
  private_person:  'PERSON',
  private_email:   'EMAIL',
  private_phone:   'PHONE',
  private_address: 'ADDRESS',
  account_number:  'ACCOUNT',
  private_date:    'DATE',
  private_url:     'URL',
  secret:          'SECRET',
  rrn:             'RRN',
  biz_num:         'BIZNUM',
  card:            'CARD',
}
```

### TypeScript 타입
```typescript
export type PIICategory =
  | 'account_number' | 'private_address' | 'private_email'
  | 'private_person' | 'private_phone'  | 'private_url'
  | 'private_date'   | 'secret'
  | 'rrn' | 'biz_num' | 'card'
```

### Overlap 해결 정책 (ADR-0007 참조)
```text
같은 span에 여러 카테고리 매치:
  1. longer-span 우선
  2. 같은 길이면: 한국 로컬(RRN/BIZNUM/CARD) > OPF
  3. 같은 길이 + 같은 우선순위: 첫 등장 detector 결과 채택
```

---

## References
- OPF 모델 카테고리: https://github.com/openai/privacy-filter (README)
- ADR-0002: 토큰 형식 명세
- ADR-0007: 한국 PII 전략
- ADR-0008: 자체 backend 응답 형식 (OPF HTTP API 호환)
- ARCHITECTURE.md §5.2 (OPF → 토큰 매핑 표)
