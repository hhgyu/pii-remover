# Korean PII — Detection Algorithms (v1)

Operational reference for the Korean PII detectors that ship in
`@pii-remover/core` Phase 2. Mirrors [ADR-0007](./ADR/0007-korean-pii-strategy.md)
(strategy) and [ADR-0010](./ADR/0010-pii-categories-opf-plus-korean.md)
(category taxonomy) with implementation-grade detail.

> **Scope**: text-only, regex + checksum + surname heuristic. No ML model.
> KLUE-NER comes in **Phase 7** (ADR-0007 §Decision §2).

## 1. Category taxonomy

| Korean PII | Token category | Backend | Confidence (default) |
|---|---|---|---|
| 주민등록번호 (RRN) | `rrn` → `__OPF_RRN_<i>__` | LocalRegexBackend (regex + checksum) | 0.99 (strict) / 0.7 (no-checksum) |
| 사업자등록번호 | `biz_num` → `__OPF_BIZNUM_<i>__` | LocalRegexBackend (regex + checksum) | 0.99 |
| 신용카드 (LUHN) | `card` → `__OPF_CARD_<i>__` | LocalRegexBackend (LUHN) | 0.95 |
| 한국 휴대폰 (010/011/016-019) | `private_phone` → `__OPF_PHONE_<i>__` | LocalRegexBackend (regex) | 0.95 |
| 한국 이름 | `private_person` → `__OPF_PERSON_<i>__` | LocalRegexBackend (surname heuristic) | 0.6 |

`private_phone` / `private_person`은 OPF 영문 카테고리와 토큰 family 공유
([ADR-0010](./ADR/0010-pii-categories-opf-plus-korean.md) §3).

## 2. 주민등록번호 (RRN) — `src/detector/regex/korean-rrn.ts`

### 형식
13자리 숫자. 가운데 하이픈 옵션. `YYMMDD-GXXXXXX`.
- `YYMMDD`: 생년월일
- `G` (gender/century digit): `1`/`2` (남/여, 1900년대), `3`/`4` (남/여, 2000년대)
- 끝 6자리: 출생지 코드 + 일련번호 + 체크섬

### Regex (1차 필터)
```
\b\d{6}-?[1-4]\d{6}\b
```

### 체크섬 알고리즘
```
weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5]
sum     = Σ (digits[i] · weights[i])   for i in 0..11
check   = (11 - sum mod 11) mod 10
valid   = (digits[12] == check)
```

### 옵션: `strict_checksum` (기본 `true`)
- `true`: 체크섬 검증 통과한 RRN만 검출. confidence 0.99. False positive 거의 0.
- `false`: 13자리 + gender digit `[1-4]` 패턴만으로 검출. confidence 0.7.
  옛 RRN(체크섬 미적용) 대응 — 정부 발급 13자리 더미 데이터, 시뮬레이션 등.

### 예시 (모두 알고리즘 생성 더미, 실제 사람 정보 아님)

| 입력 | strict_checksum=true | strict_checksum=false |
|---|---|---|
| `920101-1234562` (가상, 체크섬 valid) | ✅ rrn | ✅ rrn |
| `920101-1234561` (체크섬 invalid) | ❌ | ✅ rrn |
| `920101-5234567` (gender digit 5 — invalid) | ❌ | ❌ |

## 3. 사업자등록번호 — `src/detector/regex/korean-biznum.ts`

### 형식
10자리 숫자. `XXX-XX-XXXXX` 또는 `XXXXXXXXXX`.

### Regex
```
\b\d{3}-?\d{2}-?\d{5}\b
```

### 체크섬 알고리즘
```
weights      = [1, 3, 7, 1, 3, 7, 1, 3, 5]
partial_sum  = Σ (digits[i] · weights[i])   for i in 0..8
sum          = partial_sum + floor((digits[8] * 5) / 10)
check        = (10 - sum mod 10) mod 10
valid        = (digits[9] == check)
```

위 알고리즘에서 `floor(digits[8] * 5 / 10)`는 마지막 가중치 5와 9번째 digit의 결과
중 십의 자리를 더하는 한국 국세청 공식 규칙입니다.

## 4. 한국 휴대폰 — `src/detector/regex/korean-phone.ts`

### 형식
- 11자리: `01[016-9]-XXXX-XXXX`
- 10자리: `01[016-9]-XXX-XXXX`
- 하이픈/공백 옵션

### Regex
```
\b01[016-9]-?\d{3,4}-?\d{4}\b
```

### 통신사 prefix 매트릭스 (참고)
| Prefix | 통신사 (현재/구) |
|---|---|
| 010 | (통합 번호, 모든 통신사) |
| 011 | (구 SKT) |
| 016 | (구 KT) |
| 017 | (구 신세기 → SKT 합병) |
| 018 | (구 한솔 → KT 합병) |
| 019 | (구 LGT) |

> Phase 1의 영문 전화 정규식과 overlap 가능. `MergeStrategy`가 longer-span 우선 원칙으로 자동 dedup ([ADR-0005](./ADR/0005-backend-strategy-trust-tiers.md) §2).

## 5. 신용카드 (LUHN)

Phase 1부터 영문/한국 공통으로 동작. 16자리 + LUHN 검증.

```
def luhn(digits):
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 1:
            d = d * 2
            if d > 9: d -= 9
        total += d
    return total % 10 == 0
```

## 6. 한국 이름 휴리스틱 — `src/detector/korean-heuristic/`

### 데이터 소스
- **`surnames.json`**: 100개 (94 단성 + 6 복성). 통계청 인구주택총조사 기반 상위 분포.
  - 단성 예: 김 이 박 최 정 강 조 윤 장 임 한 오 서 신 권 황 안 송 류 전 ...
  - 복성: 남궁 황보 제갈 선우 사공 서문
- **`stopwords.json`**: ~220개 차단 단어. 성씨 글자로 시작하는 흔한 단어들.
  - 박 → 박스 박물관 박수 박사 박정 박해 박살 박애
  - 정 → 정말 정도 정상 정원 정보 정부 정치 정신 정확 정답 정해
  - 김 → 김치 김밥 김장 김포 김해 김장훈
  - 이 → 이거 이건 이번 이전 이후 이상 이하 이메일 이름 ...
  - 한 → 한강 한국 한복 한문 한식 한정 한자 한반도 ...

### 매칭 알고리즘 (`matcher.ts`)

```text
HANGUL_RUN = /[\uAC00-\uD7A3]{2,4}/g  # 한글 음절 2-4자 연속

for each match `raw` at position `start`:
    # 1. 끝자리 조사/존칭 제거 (있을 때만)
    raw_stripped = stripTrailingParticle(raw)

    # 2. Stopword 필터
    if raw_stripped in KOREAN_STOPWORDS: skip

    # 3. 이름 구조 검증
    if not isNameStructure(raw_stripped): skip

    # 4. Detection 발행
    emit { start, end: start + len(raw_stripped), category: 'private_person', confidence: 0.6 }
```

### `isNameStructure()` 규칙
```text
- length 2-4 자 한글
- (compound surname) 처음 2자가 복성 (남궁/황보/...) → 나머지 1-2자가 이름. 매치.
- (single surname) 처음 1자가 단성 → 나머지 1-3자가 이름. 매치.
- 그 외: skip.
```

복성이 단성보다 **우선** — `황보영`은 `황보(성)+영(이름)`으로 해석 (`황(성)+보영(이름)` 아님).

### `stripTrailingParticle()` — 끝자리 조사/존칭 자동 제거
정규식의 greedy 매칭 때문에 `"김철수님"`이 4자로 한 덩어리로 잡히지만,
실제로는 `"김철수" + "님"(존칭)`이라야 옳음. 14종 제거:

| 부류 | 글자 |
|---|---|
| 주격/주제 마커 | 이 가 은 는 |
| 목적격 | 을 를 |
| 소유격 | 의 |
| 접속/공동격 | 와 과 |
| 추가/제한 | 도 만 |
| 존칭 | 씨 님 군 양 |

**Overstrip 방지**: 끝자리 제거 후 `isNameStructure()` 재검증. 깨지면 제거 취소.
예: `"안녕"`은 `"녕"`이 `TRAILING_PARTICLES`에 없어 무변. 만약 `"강서"`(`서`가 단성)
같은 ambiguous 케이스에서 잘못 제거하면 다시 stopword 필터에서 잡힘.

### 동작 예시

| 입력 | greedy 매치 | strip 후 | 최종 |
|---|---|---|---|
| `김철수님 안녕하세요` | `김철수님` | `님` 제거 → `김철수` | `김철수` ✅ |
| `박영희가 도착` | `박영희가` | `가` 제거 → `박영희` | `박영희` ✅ |
| `황보영희를 만났다` | `황보영희` (4자) | `를` 제거? 마지막이 `희` → 무변 | `황보영희` (복성+이름2자) ✅ |
| `오늘 김철수, 반갑` | `김철수` (3자) | strip 안 됨 (`수` not in particle) | `김철수` ✅ |
| `황보` 단독 | `황보` (2자) | length < 3, strip skip | structure invalid (이름 없음) → 미검출 ✅ |
| `박물관에 갔다` | `박물관` | stopwords hit → skip ✅ |

### 정확도 (ADR-0007 목표 대비)
- Precision (false positive ≤ 5%): stopword 리스트 확충으로 달성
- Recall (≥ 85%): 상위 100 성씨가 99% 한국 인구 커버 + 복성 처리

## 7. LocalRegexBackend 통합

`src/backend/local-regex.ts`의 `LocalRegexBackend`는 Phase 2부터 한국 detector도 호출:

```typescript
const r = new LocalRegexBackend({
  enable_korean_pii: true,        // 기본 true — 한국 detector 일괄 on/off
  strict_rrn_checksum: true,      // 기본 true — RRN strict 모드
})
```

`enabled_categories` 옵션 존중:
```jsonc
{
  "detection": {
    "enabled_categories": [
      "private_email", "private_url",     // 영문 OPF 카테고리
      "rrn", "biz_num", "card",            // 한국 카테고리
      "private_phone", "private_person"   // 둘 다
      // 빠진 카테고리는 detector skip
    ]
  }
}
```

## 8. 테스트 corpus 위치

| 영역 | 파일 |
|---|---|
| RRN/BIZNUM/Phone 단위 테스트 | `packages/core/tests/korean-regex.test.ts` (23 tests) |
| 휴리스틱 단위 테스트 | `packages/core/tests/korean-heuristic.test.ts` (21 tests) |
| Backend 통합 테스트 | `packages/core/tests/backend.test.ts` (Phase 2 통합 7건) |
| E2E corpus (PII + non-PII) | `tests/integration/fixtures/developer-corpus-sample.json` |
| E2E 라운드트립 | `tests/integration/e2e-mask-roundtrip.test.ts` |

## 9. 알려진 한계

1. **외래어 이름 미검출**: "스미스", "톰슨" 등 한글 외래 표기는 100 성씨에 없어 미매치. 영문 표기는 OPF 모델이 처리.
2. **희귀 성씨 누락**: 100위 밖 성씨(예: 유럽계 귀화 등)는 stopword 필터를 통과해도 매칭 안 됨. 사용자가 `findKoreanNames(text, { surnames: customSet })`로 확장 가능.
3. **한국 주소 미지원**: "서울시 강남구 ..." 같은 한국 주소 정규식은 v1.x 백로그 (`ADR-XXXX` 예정).
4. **한국 이름 NER**: 휴리스틱 한계(예: `장면`, `한복`이 사람 이름일 수도)는 Phase 7 KLUE-NER로 보강.
5. **회사명 vs 인명 ambiguous**: `박철수컴퍼니`는 `박철수`로 매치되어 잘못 마스킹될 수 있음. 도메인 stopwords 또는 KLUE-NER 필요.

## 10. 데이터 추가/제거 운영 가이드

### Stopword 추가
도메인별 빈출 false positive를 발견하면:

1. `packages/core/src/data/korean-stopwords.json`에 단어 추가
2. `packages/core/src/detector/korean-heuristic/stopwords.ts`의 TS Set도 동기화 (또는 JSON 한쪽만 source로 사용)
3. `bun test` 재실행

### Stopword 너무 공격적인 경우 (재현 false negative)
정확한 한국 이름이 stopword에 잡히면 단어 제거. 단 false positive 재현 위험 있으므로
회귀 테스트 추가 권장.

### 사용자 정의 surnames
```typescript
import { findKoreanNames } from "@pii-remover/core/detector/korean-heuristic"

const customSurnames = new Set(["김", "이", ..., "위트나우어"])
const dets = findKoreanNames(text, { surnames: customSurnames })
```

## 11. ADR cross-reference

- [ADR-0007](./ADR/0007-korean-pii-strategy.md) — 전략 (v1 휴리스틱, v2 KLUE-NER)
- [ADR-0010](./ADR/0010-pii-categories-opf-plus-korean.md) — 카테고리 매핑 (OPF 8 + 한국 3)
- [ADR-0005](./ADR/0005-backend-strategy-trust-tiers.md) — Backend Strategy + MergeStrategy overlap 해결
- [ADR-0002](./ADR/0002-token-format-opf-underscore.md) — 토큰 형식
- [ARCHITECTURE.md §11](./ARCHITECTURE.md) — 시스템 다이어그램상 위치

---

## v2 (Phase 7) — KLUE-NER 통합 (구현 완료, 2026-05-12)

휴리스틱의 false positive 한계(예: `반갑습니` → 성씨 `반` + 활용형 → 사람으로 오탐)를 ML 모델로 보강.

**모델**: 기본 `soddokayo/koelectra-base-klue-ner` (Apache-2.0, KLUE-NER F1 0.7911). 정확도 우선이면 `chunwoolee0/klue_ner_bert_model` (CC BY-SA 4.0, F1 0.8902) opt-in (`KNER_MODEL_ID` 환경변수).

**설치**:
- Backend Docker 이미지에 KLUE 모델 weight 사전 다운로드 (~377MB 추가). `KNER_PRELOAD=1`이면 startup 시 메모리 로드, 미설정이면 첫 호출 시 lazy-load.
- Korean NER은 `/redact` 엔드포인트에 통합됨 — 한글이 감지된 텍스트에 대해 OPF + KLUE NER 결과를 자동 병합하여 반환. 별도 엔드포인트 불필요.
- 요청 시 `korean_ner_min_confidence` 필드로 per-request confidence 임계값 오버라이드 가능 (생략 시 서버 기본값 `KNER_MIN_CONFIDENCE` 사용).

**TS core 사용법**:
```ts
import { MergeStrategy, LocalRegexBackend, OpfHttpBackend } from "@pii-remover/core";

const strategy = new MergeStrategy([
  new OpfHttpBackend({ endpoint: "http://localhost:8000" }), // OPF + Korean NER (통합)
  new LocalRegexBackend({ enable_korean_pii: true }),       // 한국 PII 정규식 (RRN/BIZNUM/CARD/Phone)
]);
```

`/redact` 엔드포인트가 OPF + Korean NER을 서버 측에서 병합하므로 클라이언트는 `OpfHttpBackend` 하나로 모든 PII 검출을 처리합니다. `MergeStrategy`의 longer-span priority + FIFO ties 정책이 그대로 적용됨.

**KLUE 태그 정책**:
- `PS` (Person)만 PII로 promote → `private_person` category
- `LC`/`OG`/`DT`/`TI`/`QT`는 응답에 `other_spans`로 노출되지만 PII 토큰화 안 됨 (보수적 scope)

**측정 가이드**:
1. `cd packages/backend && docker build -t pii-remover-backend .`
2. `docker run -p 8000:8000 pii-remover-backend`
3. `PII_REMOVER_E2E=1 bun test packages/core/tests/pii-corpus.test.ts` (통합 corpus — 한국어/영어/혼합)
4. `PII_REMOVER_E2E=korean bun test packages/core/tests/pii-corpus.test.ts` (한국어만)
5. precision / recall / F1 + per-category metrics 출력 확인 → ROADMAP Phase 7 exit criteria 검증

corpus는 `packages/core/tests/fixtures/pii-corpus.json` (249건: TP 163 + TN 54 + edge 32, 한국어/영어/혼합 `lang` 태그) — 사용자 confidential corpus를 추가해 확장 가능.

**예상 false positive 감소**:
- `반갑습`, `김치찌개`, `박물관` 등이 휴리스틱에서는 성씨 prefix로 오탐. KLUE-NER가 이를 PERSON으로 분류하지 않음 → MergeStrategy의 longer-span/FIFO 규칙 하에서 NER 결과 우선이 자연스럽게 false positive를 흡수.
- 사용자 측정에서 ≥50% FP 감소 시 ADR-0007 v2 exit criteria 만족.
