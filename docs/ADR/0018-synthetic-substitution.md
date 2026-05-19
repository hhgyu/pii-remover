# ADR-0018: Synthetic Substitution 모드 — 토큰 대신 그럴듯한 가짜 값

- **Status**: Accepted
- **Date**: 2026-05-19
- **Related**: [ADR-0002](./0002-token-format-opf-underscore.md) (토큰 형식), [ADR-0003](./0003-vault-session-in-memory.md) (vault), [ADR-0006](./0006-fail-closed-default.md) (fail-closed), [ADR-0010](./0010-pii-categories-opf-plus-korean.md) (카테고리), [ADR-0015](./0015-display-tool-restoration.md) (boundary mask)

---

## Context

### 토큰 모드의 한계

현재 v1은 모든 PII를 `__OPF_<CATEGORY>_<INDEX>__` 토큰으로 치환 (ADR-0002). identifier-safe + LLM이 변형 안 함 + Markdown/번역 견고. 그러나 다음 시나리오에서 부자연스러움:

1. **번역**: "철수의 이메일은 user@example.com" → 마스킹 → `"__OPF_PERSON_1__의 이메일은 __OPF_EMAIL_1__"` → LLM이 영어로 번역 → `"__OPF_PERSON_1__'s email is __OPF_EMAIL_1__"`. 토큰이 번역되지 않은 채 남아 어색.
2. **창작 / 시나리오**: 사용자가 "다음 인물의 성격을 묘사해주세요: 김철수" → 마스킹 → `"다음 인물의 성격을 묘사해주세요: __OPF_PERSON_1__"`. LLM은 토큰만 보고 무의미한 generic 묘사.
3. **문서 작성**: 이메일 / 보고서 초안에서 LLM이 자연스러운 호칭 / 인사말 / 대명사를 생성하려면 진짜 이름처럼 보이는 입력이 필요.
4. **RAG / chain-of-thought**: LLM이 추론 과정에 PII를 가공해야 하는 시나리오에서 토큰은 reasoning에 방해.

### 경쟁사 패턴

- **Redactly**: synthetic substitution / pseudonymization 모드 (`[PERSON]` token vs `John Smith` synthetic)
- **Private AI**: "Reversible Pseudonymization" — token + synthetic 둘 다 지원
- **PrivacyProxy**: token only (placeholder)
- **CloakLLM**: token only

본 프로젝트는 **token (default) + synthetic (opt-in) 양쪽 지원**으로 사용 시나리오 양극화 커버. Phase 8의 MCP server / Phase 9의 Personal Data Library와 직교 — 모드만 바꾸면 됨.

### 본 ADR이 답해야 할 질문

1. Synthetic 값 생성 — 데이터 source / 결정론성 / 카테고리별 전략
2. Vault 스키마 — token + synthetic 두 값 어떻게 보관
3. 복원 알고리즘 — synthetic 값을 어떻게 찾을 것인가 (full match? partial? case?)
4. 모드 전환 — config / runtime / 카테고리별 mixed mode 지원?
5. Backward compatibility — 기존 vault / 토큰 / 사용자 영향
6. 보안 / 위험 — 가짜 값 자체가 다른 entity와 충돌 / LLM이 가짜 값을 새 사람으로 인식 / RNG 결정론성

---

## Decision

### 1. Synthetic 값 생성 — 결정론적, 카테고리별 strategy

#### 1.1 결정론적 매핑

`synthesize(category, index)` → string. 같은 입력 → 같은 출력. 이유:
- vault 재구축 가능 (세션 재개 시)
- 테스트 가능
- LLM 응답에서 같은 vault entry는 같은 synthetic 값으로 나타남 (consistency)

RNG 사용 안 함. 결정론적이어야 vault entry idx → synthetic value 1:1 매핑.

#### 1.2 카테고리별 전략

| Category | Synthetic 전략 | 예시 |
|---|---|---|
| `private_person` | Hangul/English name pool에서 (index % pool.size) 선택. 입력이 한글이면 한국 이름 pool, 영문이면 영문 pool. mixed면 한국 default | `김민준`, `이서연`, `John Smith`, `Jane Doe` |
| `private_email` | `synthetic.user{N}@example.invalid` | `synthetic.user1@example.invalid` |
| `private_phone` | `010-0000-{NNNN}` (N = index padded 4 digits) | `010-0000-0001` |
| `private_url` | `https://example-{N}.invalid/` | `https://example-1.invalid/` |
| `private_address` | `서울시 가상구 가상동 {N}번지` | `서울시 가상구 가상동 1번지` |
| `private_date` | `2000-01-{N:02d}` (N modulo 28) | `2000-01-01` |
| `account_number` | `ACC-{N:08d}` | `ACC-00000001` |
| `secret` | `SYNTH_SECRET_{N}` (synthetic도 토큰-like — secret은 자연어로 만들면 위험) | `SYNTH_SECRET_1` |
| `rrn` | `Synthetic deterministic valid RRN` (가짜 YYMMDD + valid checksum) | `900101-1234567` (check 계산) |
| `biz_num` | Synthetic deterministic valid biz num | `100-00-00001` (check 계산) |
| `card` | LUHN-valid synthetic card (`4242 4242 4242 NNNN` LUHN 보정) | `4242 4242 4242 0001` (LUHN 보정) |

**근거**:
- `.invalid` TLD: RFC 2606 보장 미사용 도메인 — synthetic value가 실제 도메인을 닮으면 phishing/오인용 위험
- `.example.invalid` 결합으로 더 확실 (RFC 2606 + RFC 6761 양쪽 안전)
- 한국 RRN/biznum: 체크섬 valid해야 다음 라운드에서 본 도구 자체가 다시 검출 → infinite loop 방지를 위해 checksum 보장
- `secret`: 자연어로 만들면 LLM이 진짜 secret으로 오인. token-like placeholder 유지
- 한국 이름 pool: 통계청 상위 100 이름과 다른 신생 이름 (synthetic임을 운영자가 식별 가능하도록 ".invalid" 같은 마커는 자연어 이름에는 못 박음 — pool 자체를 알려진 fictional name 위주)

#### 1.3 데이터 파일

`packages/core/src/data/synthetic-names.json`:

```jsonc
{
  "korean": ["김민준", "이서연", "박지호", "최지우", ...],   // 50개
  "english": ["John Smith", "Jane Doe", "Alex Park", ...]    // 50개
}
```

**근거**: pool 크기 50이면 vault 한 세션 내 PII 빈도가 50을 넘어가도 modulo로 wrap. 동일 vault에서 다른 PERSON에 같은 synthetic name 할당될 수 있으나 vault index가 다르니 충돌은 token format 자체로 구분 가능.

### 2. Vault 스키마 — `synthetic_value` 옵션 필드

```typescript
interface VaultEntry {
  label: string;
  text: string;             // 기존 — 원본 PII
  canonical_text: string;
  index: number;
  synthetic_value?: string; // 신규 — synthetic mode에서 만 채워짐
}
```

#### 동작:
- token mode (default): `synthetic_value` 비어있음. 기존 동작 그대로.
- synthetic mode: `vault.assign()` 시 `synthesize(category, index)` 호출해서 `synthetic_value` 채움. 토큰 자체는 여전히 생성 (vault 키로 사용).

**근거**:
- 두 값 모두 vault에 보관 → mask는 synthetic 출력, restore는 양방향 매칭 가능
- 기존 schema에 optional 필드 추가만 — backward compatible
- Schema version bump 안 함 (`opf.reversible.v1` 유지, 옵션 필드는 명세에 호환)

### 3. 복원 알고리즘 — 양방향 매칭

`Restorer.scan()`이 두 가지 패턴을 동시에 찾음:
1. **Token regex** (기존): `__OPF_<CAT>_<IDX>__` strict + lenient
2. **Synthetic match** (신규, synthetic mode일 때만): 각 vault entry의 `synthetic_value`에 대해 word-boundary literal search

복원 우선순위: token 매치 → synthetic 매치 (longer-span 우선). 둘 다 매치되는 영역은 token 우선.

#### 3.1 Synthetic 매칭 — exact only

- case-sensitive (한국어는 case 무관이라 무시)
- word boundary (영문 `\b`, 한국어는 양쪽 한글 검사)
- partial / fuzzy match 비지원 (false restoration 위험)

#### 3.2 LLM이 synthetic 값 변형할 위험

LLM이 "김민준씨" → 한국어 조사 자동 첨가, "Smith" → "Mr. Smith" 등으로 변형 가능. v1은:
- 한국어: `stripTrailingParticle` 류 lenient mode (기존 한국 휴리스틱 패턴 재사용) — 짧은 한국어 조사 (`씨`, `님`, `이`, `가` 등) 무시하고 매칭
- 영문: word boundary로 prefix/suffix 무시. honorific (`Mr.`, `Ms.`) 직접 매칭 안 함 → 사용자 책임

### 4. 모드 전환 — config에 mode field 추가

```typescript
interface RestorationConfig {
  token_format: string;
  lenient_match: boolean;
  warn_on_partial: boolean;
  mode: "token" | "synthetic";        // 신규 — default "token"
}
```

전체 PIIRemover 단위로 단일 mode. 카테고리별 mixed 모드는 v2 (`secret`만 token, 나머지 synthetic 같은 시나리오).

#### 4.1 환경변수 override

`PII_REMOVER_RESTORATION_MODE=synthetic` 환경변수로 config 덮어쓰기 가능. CI / 빠른 실험용.

### 5. Backward compatibility

- default `restoration.mode: "token"` → 기존 사용자 영향 0
- 기존 vault entry는 `synthetic_value: undefined` → token mode와 동일 동작
- 기존 테스트 모두 통과 — 회귀 0
- proxy / MCP server / opencode plugin / CLI 모두 영향 없음 (mode가 mask/restore 안에서만 분기)

### 6. 보안 / 위험

#### 6.1 RFC-reserved domains for synthetic values

- `.invalid` (RFC 2606): 보장 미사용 TLD
- `.example` (RFC 2606): 보장 documentation TLD
- 조합 (`example-1.invalid`)으로 실제 도메인 충돌 0
- 사용자가 synthetic으로 출력된 텍스트를 외부에 공유해도 phishing 위험 0

#### 6.2 LUHN-valid card / 체크섬-valid RRN

- 본 도구가 다음 라운드에서 자기 synthetic 값을 다시 PII로 검출하면 (vault에 이미 있으니) 같은 토큰 재사용 → 무한 루프 가능 (이론상). LUHN/checksum valid면 검출이 일관되므로 idempotent.
- 가짜 RRN 사용 시 실제 사람과 매칭될 가능성: deterministic synthetic이라 특정 인덱스에 고정된 RRN을 사용 → 우연 충돌 가능. 충돌이 발생해도 vault는 in-memory 격리되어 다른 사용자에게 누출 안 됨.

#### 6.3 Sensitive synthetic for `secret`

- `synthesize("secret", N)`이 실제 secret처럼 보이면 (예: `sk-abc123...`) LLM이 진짜 키로 오인. → synthetic도 명시적 prefix (`SYNTH_SECRET_`) 사용. 보안 영향 최소.

#### 6.4 Token-mode invariant 보존

- mode가 synthetic이라도 vault는 여전히 in-memory only (ADR-0003)
- fail-closed semantics 그대로 (ADR-0006)
- LLM-boundary mask (ADR-0015) 그대로 — synthetic 값도 boundary 통과 시 masking 대상

### 7. Restorer lenient 매칭 (synthetic 모드 한국어)

기존 token lenient regex와 별개로, synthetic 값의 한국어 조사 처리:

```typescript
const KOREAN_PARTICLE_SUFFIXES = ["이", "가", "은", "는", "을", "를", "의", "씨", "님"];

function findSyntheticMatches(text: string, syntheticValue: string): Match[] {
  // 1차: exact match (with word boundary)
  // 2차: synthetic + particle suffix match (한국어만)
}
```

영문은 1차만. 한국어 1차 + 2차로 lenient.

---

## Consequences

### 긍정적

- **자연어 시나리오 정확도 ↑**: 번역 / 창작 / 문서 작성 / RAG에서 토큰보다 자연스러운 LLM 응답
- **token mode 회귀 0**: default가 token이라 기존 사용자 영향 없음
- **MCP / Personal Data Library / Phase 8-9와 직교**: 모드 하나 바꾸면 자동으로 모든 통합 (Claude Code / OpenCode / Codex / MCP) 적용
- **시장 차별점 강화**: token + synthetic 둘 다 지원하는 한국어 1급 도구는 시장에 거의 없음
- **결정론성**: 같은 vault → 같은 synthetic. 재현 가능, 디버그 용이

### 부정적

- **복원 정확도 약간 ↓ (synthetic mode)**: LLM이 synthetic 값을 변형해도 lenient 매칭이 100% 못 잡음. token mode 대비 partial match 가능성 ↑
- **Compaction에 약함**: LLM이 대화 요약 시 자연어 synthetic 값을 토큰화하지 못해 변형 가능. token mode는 `__OPF_*__` 패턴이 식별자라 견고.
- **Synthetic data pool 유지 부담**: 한국/영문 이름 pool에 대한 미적 / 문화적 적합성 검토 필요. PR 검토 시 추가 부담.
- **사용자 학습 곡선**: token/synthetic mode 차이를 README에 명확히 문서화 필요. 잘못 이해하면 PII 누출 의심.

### 위험 / 미해결

- **충돌 synthetic 값 LLM 환각**: LLM이 응답에 "synthetic.user1@example.invalid" 같은 가짜 값을 그대로 출력 가능 → vault 매칭 정상. 그러나 LLM이 자기 생성한 다른 "John Smith"가 벽 충돌 가능 → exact match로 vault lookup 시도 → 다른 사람으로 잘못 복원 위험. v1은 사용자 책임.
- **카테고리별 synthetic 품질 차이**: 한국 이름 pool은 한국 이름 1순위 성씨 (김 이 박)가 흔해 자연스러움. 영문은 cultural neutrality 위해 단순.
- **Locale 다양성**: 한국/영문만 v1. 일본어/중국어 등은 v2 (`synthetic-names-{locale}.json`).
- **Synthetic value 재충돌**: 한 vault 안에서 인덱스 50이 넘으면 modulo wrap → 같은 synthetic name이 다른 vault entry에 사용 가능. mask 시는 토큰으로 구분되지만, synthetic 출력에선 LLM이 같은 이름을 보고 같은 사람으로 가정 → semantic 의미 변경 위험. v1은 50 entry 미만 가정.

---

## Alternatives Considered

### A1. RNG-based synthetic (non-deterministic)

거부 이유:
- vault 재구축 깨짐 (세션 재개 시)
- 테스트 어려움
- 같은 prompt를 두 번 실행하면 LLM 응답이 매번 달라짐 → UX 일관성 ↓

### A2. Synthetic 전용 모드 (token mode 제거)

거부 이유:
- token mode가 compaction / 식별자 / 코드 생성 시나리오에서 압도적으로 robust (ADR-0002)
- secret 카테고리는 자연어 synthetic 불가 (가짜 키로 오인)
- 사용자 시나리오 양극화 — 둘 다 지원이 정답

### A3. 카테고리별 mixed mode (`secret`은 token, 나머지는 synthetic)

거부 이유:
- v1 단순성 우선. 카테고리별 config 복잡도 ↑
- 사용자 요청 빈도 확인 후 v2에서 추가. 현재는 전체 모드 토글로 충분.

### A4. Fuzzy / partial match for synthetic restore

거부 이유:
- false restoration 위험 (LLM이 "smith"를 일반 단어로 사용해도 매칭됨)
- 한국어 짧은 조사는 별도 lenient 처리 (§7)로 충분
- 영문 honorific 자동 처리는 v2 (사용자 corpus 확인 후)

### A5. 사용자 정의 synthetic pool

거부 이유:
- v1 scope 외. Personal Data Library (Phase 9)는 검출용 — synthetic generation pool과 별개.
- v2에서 `synthetic.custom_names: [...]` config 옵션으로 검토.

### A6. Synthetic 모드에서 토큰 fallback 안 함

거부 이유:
- LLM이 synthetic 값을 출력 안 하고 토큰을 출력하는 경우 (LLM이 자기 reasoning에서 토큰 보존 시) restore 실패. → 복원기는 token + synthetic 양쪽 다 시도해서 견고성 확보.

---

## Implementation Notes

### 신규 모듈

```
packages/core/src/
├── synthetic/
│   ├── index.ts                # synthesize(category, index) public API
│   ├── name-pool.ts            # 한국/영문 이름 pool 로딩
│   ├── checksum.ts             # synthetic RRN / biz / card 체크섬 valid 생성
│   └── particles.ts            # 한국어 lenient 매칭용 조사 리스트
└── data/
    └── synthetic-names.json    # 한국 50 + 영문 50
```

### Schema 확장

```typescript
// vault/schema.ts
export interface VaultEntry {
  label: string;
  text: string;
  canonical_text: string;
  index: number;
  synthetic_value?: string;       // 신규
}

// config/schema.ts
export interface RestorationConfig {
  token_format: string;
  lenient_match: boolean;
  warn_on_partial: boolean;
  mode: "token" | "synthetic";    // 신규
}

DEFAULT_CONFIG.restoration.mode = "token";   // 기존 default 유지
```

### `VaultManager.assign` 수정

```typescript
assign(sessionId: string, detections: readonly Detection[]): AssignedToken[] {
  // ... 기존 dedup 로직 ...
  for (const newEntry of newEntries) {
    if (this.options.mode === "synthetic") {
      newEntry.synthetic_value = synthesize(newEntry.label, newEntry.index);
    }
  }
  // ...
}
```

### `applyTokens` 대체 — mode 분기

```typescript
function applyTokens(text: string, tokens: AssignedToken[], mode: "token" | "synthetic"): string {
  if (mode === "token") return /* 기존 동작 */;
  return /* synthetic_value로 치환 */;
}
```

### `Restorer.scan` 확장 (synthetic mode)

```typescript
scan(text: string, sessionId: string): TokenMatch[] {
  const tokenMatches = this.scanTokens(text);
  if (this.mode === "token") return tokenMatches;
  const syntheticMatches = this.scanSynthetic(text, sessionId);
  return this.mergeNonOverlapping(tokenMatches, syntheticMatches);
}
```

### Tests

| 카테고리 | 추정 |
|---|---|
| `synthesize()` 결정론성 (per category) | 10 |
| RNG 미사용 검증 | 1 |
| Korean/English name pool 분리 | 4 |
| RRN/biznum/card checksum 유효성 | 3 |
| `.invalid` TLD synthetic email/URL | 2 |
| Vault entry `synthetic_value` 채워짐 (synthetic mode) | 3 |
| Vault entry `synthetic_value` 안 채워짐 (token mode, default) | 2 |
| `applyTokens` mode 분기 | 4 |
| `Restorer` synthetic mode 양방향 매칭 | 6 |
| Korean particle lenient (씨/님/이/가/은/는) | 4 |
| Backward compat: token mode 회귀 0 | 2 |
| Synthetic mode round-trip (mask → restore) | 6 |
| 환경변수 override | 2 |
| **합계** | **~49 new tests** |

### Backward compatibility

- 기존 657 (베이스라인) → 723 (Phase 8) → 747 (Phase 9) tests 모두 통과
- default mode "token" → 기존 동작 그대로
- vault entry `synthetic_value` optional → 기존 entry 호환

### Limitations (v1)

- Korean + English pool만. 다른 locale은 v2.
- Mixed mode (카테고리별) 미지원. v2.
- 사용자 정의 synthetic pool 미지원. v2.
- LLM honorific / 변형 자동 처리는 한국어 조사 lenient만. 영문은 미지원.
- Compaction-safe 보장 약함 — 자연어 synthetic이 LLM 요약 시 변형 가능. token mode 대비 robust ↓.

---

## References

- 경쟁 패턴: Redactly synthetic substitution, Private AI Reversible Pseudonymization
- RFC 2606 (.invalid / .example TLD)
- RFC 6761 (special-use domain names)
- ADR-0002 (token format — synthetic mode가 token mode와 공존)
- ADR-0003 (vault in-memory invariant — synthetic value도 인메모리)
- ADR-0010 (PII categories — 11종 모두에 synthetic 전략 정의)
- ADR-0015 (LLM-boundary mask — synthetic 값도 boundary 통과 시 masking)
