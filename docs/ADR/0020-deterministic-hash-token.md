# ADR-0020: 결정론적 해시 토큰 `__OPF_<CATEGORY>__<HASH>__`

- **Status**: Accepted — 단, 표면 문법은 [ADR-0022](./0022-markdown-inert-token-delimiters.md)가 대체
- **Date**: 2026-06-12
- **Supersedes**: [ADR-0002](./0002-token-format-opf-underscore.md)
- **Superseded in part by**: [ADR-0022](./0022-markdown-inert-token-delimiters.md)
- **Related**: [ADR-0003](./0003-vault-session-in-memory.md), [ADR-0004](./0004-local-llm-proxy-streaming.md), [ADR-0010](./0010-pii-categories-opf-plus-korean.md), [ADR-0018](./0018-synthetic-substitution.md)

> **부분 대체 (2026-08-21)**: 이 ADR의 **해시 유도**(HMAC + base36 절단)와 카테고리
> 매핑은 그대로 유효하다. 대체되는 것은 **표면 문법뿐**이다 — `__OPF_PERSON__`이
> 완결된 Markdown bold 스팬이라 모델이 렌더링하면서 중간 구분자를 삭제하는 문제가
> 실측되었고, [ADR-0022](./0022-markdown-inert-token-delimiters.md)가
> `{{OPF:<CATEGORY>:<HASH>}}`로 교체한다. 아래 본문의 `__OPF_…__` 표기는 당시
> 결정의 기록으로 그대로 둔다.

---

## Context

ADR-0002는 토큰을 `__OPF_<CATEGORY>_<INDEX>__`로 정의했고, `<INDEX>`는 vault 세션 내에서 1부터 증가하는 **정수**였다. 이 인덱스는 세션·프로세스 로컬이라 **비결정론적**이다:

- 같은 PII(예: 동일 이메일)라도 세션/프로세스가 다르면 다른 인덱스를 받는다.
- 프로세스가 재시작되면 vault가 비므로, 이전 프로세스가 만든 토큰이 대화 히스토리(세션 재개)에 남아 있을 때 복원이 불가능하다. 이를 **dead token**이라 하며, opencode-plugin은 이를 `[UNRESTORABLE]`로 무력화(neutralize)한다.

ADR-0002 자체가 "LLM 환각 토큰 빈도 측정 후 HMAC suffix(`__OPF_PERSON_1_a3f9__`) 도입 재평가"를 미해결 사항으로 남겨두었다(§위험 / 미해결 사항, §Alternatives Considered). 본 ADR이 그 재평가를 수행한다.

### 요구사항

1. **크로스 프로세스 일관성**: 같은 PII는 키만 같으면 어떤 프로세스/세션에서도 같은 토큰으로 마스킹된다.
2. **가역성 유지**: vault round-trip 복원은 그대로 동작한다(ADR-0003).
3. **dead token 감소**: 같은 원본 PII를 다시 만나면 동일 토큰을 재생성해 vault가 다시 채워진다.

---

## Decision

**토큰 형식: `__OPF_<CATEGORY>__<HASH>__`** (예: `__OPF_EMAIL__3kf9sl2p8q4m7xza__`, `__OPF_BIZ_NUM__a1b2c3d4e5f6g7h8__`)

### 구체적 규칙

- `__OPF_` prefix 고정 (네임스페이스).
- `<CATEGORY>`: 대문자 ASCII + 언더스코어 (예: `PERSON`, `EMAIL`, `BIZ_NUM`).
- **구분자 `__` (이중 언더스코어)**: 카테고리와 해시를 분리. `BIZ_NUM`처럼 카테고리에 단일 언더스코어가 있어도 파싱 모호성이 없다.
- `<HASH>`: **소문자 base36 `[a-z0-9]`, 고정 16자**. 대문자 카테고리와 문자 클래스가 disjoint → greedy 매칭 모호성 제거.
- `__` suffix 고정 (boundary).

### 해시 산출

```
HASH = base36( HMAC-SHA256(key, "<CATEGORY>\0<canonical_text>") )[0..16]
```

- `key`: 비밀 키 (아래 키 관리 참조).
- `canonical_text`: vault 정규화(trim + 공백 단일화)와 동일한 입력. **정규화 로직이 바뀌면 해시도 바뀐다.**
- 같은 `(category, canonical_text, key)` → 항상 동일 토큰.

### 복원 정규식

```typescript
// 엄격 (1차)
const STRICT  = /__OPF_([A-Z][A-Z0-9_]*?)__([a-z0-9]{16})__/g
// 관대 (2차 fallback) — 구조적으로 파싱한 뒤 정규화
const LENIENT = /\b__OPF_([A-Za-z][A-Za-z0-9_]*?)__([a-z0-9]{16})(?:__)?\b/gi
```

`[A-Z0-9_]*?`는 lazy 매칭으로 첫 `__` 구분자에서 멈춘다. 해시는 고정 16자라 길이로도 경계가 확정된다.

### 키 관리 (우선순위)

1. **환경변수** (`restoration.hmac.secret_env`, 기본 `PII_REMOVER_TOKEN_KEY`)가 설정되면 그 값을 키로 사용.
2. 없으면 **키 파일** (`~/.config/pii-remover/key`, 권한 `0600`)을 읽는다. 설치 시 생성된다.
3. 키 파일도 없으면 **런타임에 생성**해 저장한다(영속).
4. 생성/저장이 실패하면(읽기전용 FS, CI 등) **프로세스별 임시 랜덤 키**로 폴백하고 1회 경고한다 — 이 경우 동작은 기존(ADR-0002)처럼 프로세스 로컬 비결정론으로 안전하게 퇴화한다.

**고정 하드코딩 키는 사용하지 않는다.** 이메일/전화번호 같은 저엔트로피 PII는 공개 키로 해시 시 사전공격으로 역산 가능하기 때문이다. 토큰은 가명(pseudonym)이며 키는 비밀로 유지되어야 한다.

---

## Consequences

### 긍정적

- **크로스 프로세스 일관성**: 같은 PII → 같은 토큰. 멀티 세션/프로세스에서 토큰이 안정적.
- **dead token 대폭 감소**: 원본 PII가 다시 등장하면 동일 토큰으로 vault가 재충전된다.
- **파싱 명확성**: `__` 구분자 + 소문자 고정길이 해시 → 카테고리 언더스코어와 무관하게 단일 토크나이저로 파싱.
- **고정 길이**: SSE 토큰 경계 버퍼링이 더 안전해진다(미완성 토큰 판정이 길이로 확정).

### 부정적

- **토큰 길이 증가**: 정수(`_1`) 대비 길어짐(`__<16자>`). 가독성·대역폭 소폭 손해. 사용자는 마스킹 텍스트를 직접 볼 일이 드물어 영향 작음.
- **vault 인메모리 + 토큰의 이중성**: 결정론적 해시는 `(category, canonical_text, key)`의 순수 함수라 토큰 자체가 식별자다. vault는 여전히 복원 매핑 저장소로 필요(원본 텍스트 보관).
- **키 의존**: 키가 바뀌면(rotation) 기존 토큰은 모두 dead가 된다(해당 vault 엔트리가 살아 있지 않는 한).

### 위험 / 미해결 사항

- **해시 충돌**: 서로 다른 PII가 같은 16자 base36 해시를 받을 확률. base36^16 ≈ 8e24 공간, 세션당 ~10k 고유 PII 기준 충돌 확률 무시 가능. 그래도 vault에서 `token → entry` 역매핑으로 **충돌을 명시적으로 검출**하고, 다른 canonical_text가 같은 토큰에 매핑되면 fail-closed 처리한다.
- **dead token 폴백 유지**: 히스토리에 토큰만 있고 원본 PII가 없는 경우(예: compaction 요약)는 결정론으로도 복원 불가. opencode-plugin의 neutralize 폴백은 **여전히 필요**하며 regex만 갱신한다.
- **canonicalization drift**: 정규화 로직 변경이 토큰을 바꾼다. 정규화는 안정적으로 유지해야 한다.
- **lenient `/i` 매칭**: 대소문자 무시가 카테고리/해시 모호성을 재도입하지 않도록, 구조적으로 파싱한 뒤 카테고리는 대문자·해시는 소문자로 정규화한다.

---

## Alternatives Considered

### 정수 인덱스 유지 + HMAC suffix `__OPF_PERSON_1_3kF9__`
- ADR-0002가 제안한 형태. 그러나 이는 **체크섬(환각 탐지)** 용도이지 결정론이 아니다. 인덱스가 여전히 세션 로컬이라 크로스 프로세스 일관성을 못 준다. 요구사항 불충족.

### 정수를 유지하되 값만 결정론적으로 (`__OPF_EMAIL_<큰 정수>__`)
- 해시를 정수로 변환. regex `\d+` 유지로 변경 최소화. 그러나 큰 정수는 가독성·길이 면에서 base36보다 나쁘고, "정수 조건 제거" 의도와 어긋남. 거부.

### base62/base64url 해시
- 대문자·`_`·`-` 포함 → 카테고리(`[A-Z_]`)와 문자 클래스 충돌, LLM 대소문자 변형 시 모호. Oracle 권고로 거부.

### 단일 언더스코어 유지 `__OPF_EMAIL_<hash>__`
- `__OPF_BIZ_NUM_<hash>__`에서 카테고리⟷해시 경계가 모호(greedy `[A-Z_]+`가 해시 일부를 삼킴). 이중 언더스코어 구분자로 해결.

### 고정 하드코딩 기본 키
- 설치 없이도 결정론적이 되지만, 저엔트로피 PII가 사전공격에 노출. 거부.

---

## Implementation Notes

- 결정론적 해시 + 키 관리: `packages/core/src/redaction/token-hash.ts`
- 토큰 생성기/정규식: `packages/core/src/token/format.ts`
  - `formatToken(category, hash)` → `__OPF_${category}__${hash}__`
  - `parseToken(text)` → `{ category, hash } | null`
- vault: `packages/core/src/vault/schema.ts`(`id: string`, schema `opf.reversible.v2`), `packages/core/src/vault/manager.ts`(결정론적 할당 + 충돌 검출)
- 복원기: `packages/core/src/restorer/index.ts` — 엄격 1차, 관대 2차
- SSE 경계 버퍼: `packages/proxy/src/stream/buffer.ts` — 고정 길이 해시 기준
- dead token: `packages/opencode-plugin/src/hooks.ts` — vault 미스 시 `[UNRESTORABLE]` (regex 갱신)
- secret-scanner OPF 제외: `packages/core/src/detector/secret-scanner.ts`

---

## References

- ADR-0002: 정수 인덱스 토큰 형식 (본 ADR이 supersede)
- ADR-0003: vault 스키마 + 세션 스코프 (round-trip)
- Python `__dunder__` 패턴: identifier-safe 토큰 근거 (ADR-0002에서 계승)
