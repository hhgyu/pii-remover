# ADR-0002: 토큰 형식 `__OPF_<CATEGORY>_<INDEX>__`

- **Status**: Superseded by [ADR-0020](./0020-deterministic-hash-token.md)
- **Date**: 2026-05-12
- **Related**: [ARCHITECTURE.md §5](../ARCHITECTURE.md#5-토큰-형식-명세), [ADR-0003](./0003-vault-session-in-memory.md), [ADR-0004](./0004-local-llm-proxy-streaming.md)

> **Superseded (2026-06-12)**: 정수 인덱스(`john.doe@example.com`)는 세션·프로세스
> 로컬이라 비결정론적이며, 프로세스 재시작 시 "dead token" 복원 불가 문제를
> 일으켰다. [ADR-0020](./0020-deterministic-hash-token.md)이 인덱스를 결정론적
> HMAC 해시(`__OPF_EMAIL__<16자>__`)로 대체한다. 카테고리 매핑(§카테고리 매핑)은
> ADR-0020에서도 유효하다.

---

## Context

가역 토큰화는 PII를 LLM에 보내기 전에 placeholder로 치환하고, 응답에 그대로 살아남은 placeholder를 다시 원본으로 복원하는 패턴이다. **토큰 형식의 선택이 시스템 견고성의 핵심**이다. LLM이 토큰을 변형/삭제/번역해버리면 복원이 깨진다.

### 실패 모드
- **번역 컨텍스트**: "Translate to Korean" 요청 시 LLM이 `<PRIVATE_PERSON_1>` → `<개인_인물_1>`로 번역.
- **마크다운/HTML 렌더링**: `<PRIVATE_PERSON_1>`이 HTML 태그로 해석되어 화면에서 사라짐.
- **코드 생성 컨텍스트**: 변수명에 박혀서 syntax error(예: `var <PRIVATE_PERSON_1> = ...`).
- **LLM 변형**: 공백 추가/제거(`PRIVATE_PERSON 1`), 대소문자 변경(`private_person_1`), 괄호 형식 변경(`[PRIVATE_PERSON_1]`).
- **터미널/copy-paste**: 유니코드 특수문자가 깨짐.

### 검토 후보
| 형식 | 코드 안전 | 번역 저항 | 마크다운 안전 | LLM 변형 저항 | 가독성 |
|---|---|---|---|---|---|
| `<PRIVATE_PERSON_1>` (deformatic 기본) | ❌ HTML/JSX 충돌 | 중 | ❌ 태그로 해석/제거 | 중 | ✅ |
| `__OPF_PERSON_1__` | ✅ identifier | 고 | ✅ | 고 | 중 |
| `[[PII:person:1]]` | 중 | 중 | ❌ wiki 링크 | 저 | 중 |
| `⟦PERSON_1⟧` | ❌ | 매우 고 | ✅ | 고 | ❌ 터미널 깨짐 |
| `XXX-PERSON-001-XXX` | ✅ | 중 | ✅ | 저 (대시 변형) | ✅ |

---

## Decision

**토큰 형식: `__OPF_<CATEGORY>_<INDEX>__`** (예: `__OPF_PERSON_1__`, `__OPF_RRN_3__`)

### 구체적 규칙
- `__OPF_` prefix는 고정 (네임스페이스 식별)
- `<CATEGORY>`: **대문자 ASCII**, 언더스코어 허용 (예: `PERSON`, `EMAIL`, `BIZ_NUM`)
- `<INDEX>`: 양의 정수, 1부터 vault 내에서 증가
- `__` suffix는 고정 (boundary 식별)

### 카테고리 매핑 (OPF + 한국 확장)
| OPF 원본 | 토큰 카테고리 |
|---|---|
| `private_person` | `PERSON` |
| `private_email` | `EMAIL` |
| `private_phone` | `PHONE` |
| `private_address` | `ADDRESS` |
| `account_number` | `ACCOUNT` |
| `private_date` | `DATE` |
| `private_url` | `URL` |
| `secret` | `SECRET` |
| (한국) 주민번호 | `RRN` |
| (한국) 사업자번호 | `BIZNUM` |
| (한국) 신용카드 | `CARD` |

### 복원 정규식
```typescript
// 엄격 (1차)
const STRICT  = /__OPF_([A-Z_]+)_(\d+)__/g
// 관대 (2차 fallback)
const LENIENT = /\b__OPF_([A-Z_]+)_(\d+)(?:__)?\b/gi
```

---

## Consequences

### 긍정적
- **Python `__dunder__` 패턴과 유사**: LLM이 "변수명/예약 식별자"로 인식 → 번역·대소문자 변형 거의 없음.
- **identifier-safe**: Python/JavaScript/Java/Go의 변수명에 그대로 박혀도 syntax 유효.
- **마크다운 안전**: 특수문자 없음, 인라인 코드/일반 텍스트에서 동일하게 표시.
- **ASCII only**: 터미널/copy-paste/grep 모두 안전.
- **정규식 단순**: 복원 매칭이 단일 정규식으로 완료.

### 부정적
- **사람이 읽기에 살짝 어색**: `<PRIVATE_PERSON_1>`보다 가독성이 약간 떨어짐. 다만 사용자는 마스킹된 텍스트를 직접 볼 일이 거의 없음(LLM에만 보임, 응답에서 복원).
- **부분 prefix 충돌 위험**: 사용자가 작성한 코드에 `__OPF_` prefix 변수가 있다면 false match. 발생 확률 극히 낮으나 stopword 처리 필요.

### 위험 / 미해결 사항
- **LLM이 토큰을 부분 절단**: `__OPF_PERSON_1`(suffix 누락)으로 출력할 가능성. → 관대(lenient) 정규식 fallback + 부분 매치 경고 로깅으로 완화.
- **체크섬 누락**: 가짜 토큰(`__OPF_FAKE_99__`)을 LLM이 환각으로 만들 가능성. 초기 vault에 없는 인덱스 매치 시 **원본 텍스트 보존**(복원 시도 안 함) + 환각 발생 빈도 모니터링. **첫 한 달 후 체크섬 추가 여부 재평가** (예: `__OPF_PERSON_1_a3f9__` HMAC suffix).

---

## Alternatives Considered

### `<PRIVATE_PERSON_1>` (deformatic 기본)
- **거부 이유**: HTML/JSX 태그로 해석되어 코드/마크다운 컨텍스트에서 사라짐. 또한 LLM이 XML/HTML 출력 시 자동 escape할 수 있음(`&lt;PRIVATE_PERSON_1&gt;` → 복원 실패).

### `⟦PERSON_1⟧` (유니코드 brackets)
- **거부 이유**: LLM 변형 저항 가장 높지만 터미널/copy-paste 깨짐. 한국어 입력기와 충돌 가능. CLI 환경 사용자에게 부적합.

### `[[PII:person:1]]` (wiki 스타일)
- **거부 이유**: MediaWiki/Obsidian 등에서 링크로 해석. LLM이 마크다운 모드일 때 형식 변경 위험.

### `XXX-PERSON-001-XXX` (체크섬 가능)
- **거부 이유**: LLM이 대시를 공백으로 자주 변환 (`XXX PERSON 001 XXX`). 또한 일반 텍스트에 가까워 false positive 매치 위험.

### 체크섬 포함 변형 `__OPF_PERSON_1_a3f9__`
- **연기 이유**: 토큰 길이 + 가독성 손실. 환각 토큰 발생 빈도가 실측되지 않은 상태에서 도입 시 yagni. v1 출시 후 측정 → ADR-XXXX로 재결정.

---

## Implementation Notes

- 토큰 생성기: `packages/core/src/token/format.ts`
  - `formatToken(category: string, index: number): string` → `__OPF_${category}_${index}__`
  - `parseToken(text: string): { category, index } | null`
- 카테고리 매핑 상수: `packages/core/src/token/category-map.ts`
- 복원기: `packages/core/src/restorer/index.ts` — 엄격 정규식 1차, 관대 정규식 2차 fallback
- 환각 토큰 처리: vault에 없는 매치는 원본 그대로 emit + `logging.level >= warn` 시 로깅

---

## References

- `deformatic/OPENAI-Privacy-Filter-Reversible-Tokenization` 토큰 형식 분석: README의 `<PRIVATE_PERSON_1>` 예시
- Python `__dunder__` 패턴: https://docs.python.org/3/reference/lexical_analysis.html#reserved-classes-of-identifiers
