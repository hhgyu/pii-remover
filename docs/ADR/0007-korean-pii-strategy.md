# ADR-0007: 한국 PII — v1 정규식+휴리스틱, v2 KLUE-NER 분리

- **Status**: Accepted
- **Date**: 2026-05-12
- **Related**: [ARCHITECTURE.md §11](../ARCHITECTURE.md#11-한국-pii-처리), [ROADMAP.md Phase 2, Phase 7](../ROADMAP.md), [ADR-0010](./0010-pii-categories-opf-plus-korean.md)

---

## Context

`openai/privacy-filter` 모델은 영어 중심. README도 "selected multilingual robustness evaluation reported" + "performance may drop on non-English text, non-Latin scripts"를 명시. 한국어 PII는 별도 처리 레이어 필요.

### 한국 PII 카테고리
- **확정적 (정규식 + 체크섬)**: 주민번호(13자리), 사업자등록번호(10자리), 카드번호(LUHN), 전화번호(010-XXXX-XXXX), 이메일
- **모호 (NER 또는 휴리스틱 필요)**: 한국 이름, 한국 주소
- **OPF가 일부 잡음**: 영문 이름, 이메일, URL — 한국 워크플로에서도 영문 PII는 OPF에 위임

### 요구사항
"한국 이름 NER까지 필요" — 정규식만으로는 부족.

### 검토 옵션
| 옵션 | 정확도 | 비용 | 응답 속도 |
|---|---|---|---|
| (a) KLUE-NER/KoBERT Docker | 높음 (F1 ~0.9) | 모델 ~500MB, 추론 50~100ms | 중 |
| (b) 정규식 + 휴리스틱 (성씨 리스트) | 중 (~85-90%) | 0 (코드만) | 매우 빠름 |
| (c) OPF fine-tuning | 미지수 | GPU + 데이터셋 + 시간 | n/a |
| (d) spaCy ko | 낮음 (~70%) | 작음 | 빠름 |
| (e) LLM 호출 (Claude/GPT) | 매우 높음 | 토큰 비용 + 지연 | 느림 |

---

## Decision

### 1. **v1: 정규식 5종 + 한국 이름 휴리스틱 (b)**

#### 정규식 (체크섬 포함)
| 카테고리 | 패턴 | 검증 |
|---|---|---|
| `rrn` | `\b\d{6}-?[1-4]\d{6}\b` | 가중치 [2,3,4,5,6,7,8,9,2,3,4,5], `(11 - sum%11) % 10` |
| `biz_num` | `\b\d{3}-?\d{2}-?\d{5}\b` | 가중치 [1,3,7,1,3,7,1,3,5] |
| `card` | `\b(?:\d{4}[- ]?){3}\d{4}\b` | LUHN 알고리즘 |
| `phone` | `\b01[016-9]-?\d{3,4}-?\d{4}\b` | 길이/통신사 검증 |
| `email` | RFC 5322 단순화 | TLD 화이트리스트(옵션) |

#### 한국 이름 휴리스틱
- **상위 100 성씨 내장 리스트** (김/이/박/최/정/강/조/윤/장/임 등) → 99% 한국 인구 커버
- 패턴: `^(성씨)[가-힣]{1,2}$` (2~3음절)
- **차단 리스트 (stopwords)**: 박스/정말/최선/김치/이거 등 false positive 빈출 단어
- 신뢰 카테고리: `private_person` (OPF 카테고리 재사용)
- 예상 정확도: precision ~85-90%, recall ~80-85%

### 2. **v2: KLUE-NER Docker sidecar 추가 (a)**

- KLUE-NER 또는 KoBERT-NER 모델을 두 번째 Docker 컨테이너로 호스팅
- 기존 OPF 컨테이너와 별도 endpoint (`POST /redact/korean` 등)
- 휴리스틱과 결과 union (longer-span 우선, 동일 길이는 KLUE > 휴리스틱)
- 예상 정확도: F1 ≥ 0.90 (Phase 7 success criteria)

### 3. Union/Cascade 전략

```text
[OPF detector + 한국 휴리스틱 + (v2: KLUE-NER)] 병렬 실행
   ↓
모든 spans 결과 union
   ↓
Overlap 해결:
  - longer-span 우선
  - 같은 길이: (v2) KLUE > 휴리스틱 > OPF
   ↓
카테고리 매핑 (휴리스틱 hit → private_person)
```

### 4. v1 출시 카테고리
정규식 5종 + 휴리스틱 이름 = 한국 PII 6종 검출 가능.

---

## Consequences

### 긍정적
- **MVP 일정 단축**: KLUE-NER 통합/평가에 2-3주 추가 작업 회피.
- **로컬 실행**: 휴리스틱은 네트워크 호출 없음 → PII 외부 노출 0 (ADR-0005 신뢰 모델과 정합).
- **체크섬 강도**: 주민/사업자/카드는 체크섬 검증으로 false positive 거의 0.
- **확장 경로 명확**: v2에서 KLUE-NER 추가는 BackendClient 하나 더 등록만 하면 됨.

### 부정적
- **휴리스틱 한계**:
  - **False positive**: stopword 리스트가 불완전하면 "박스가 도착", "정말 좋다" 등 일반 단어 마스킹.
  - **외래어 이름**: "스미스", "톰슨" 등 한국 성씨 아닌 외국 이름 못 잡음.
  - **회사명 vs 인명 모호**: "박철수컴퍼니" 같은 케이스.
  - **3글자 초과 이름**: 4자 이상 한국 이름(흔치 않음) 누락.
- **사용자 추가 stopwords 입력 필요**: 도메인 특화 단어("최고 매출", "김치찌개 메뉴" 등) 사용자가 직접 등록해야 할 수 있음.

### 위험 / 미해결 사항
- **휴리스틱 false positive 폭증 시 사용자 짜증**: bypass 영구 활성화 → 도구 무력화. **stopword list 적극 확장 + telemetry로 빈출 패턴 식별** (로컬만).
- **OPF의 한국 이름 결과와 충돌**: OPF가 가끔 한글 이름을 `private_person`으로 잡을 수 있음. union 후 dedup 필수.
- **주민번호 체크섬 false negative**: 일부 옛 주민번호는 체크섬 미적용. → 체크섬 실패해도 13자리 + 1-4 시작 패턴이면 일단 마스킹 (false positive 허용).

---

## Alternatives Considered

### v1부터 KLUE-NER 포함 (a)
- **거부 이유**: MVP 2-3주 추가 작업. 휴리스틱이 ~85% 잡으면 사용자 가치 충분히 제공. v1으로 빠르게 출시 후 사용자 피드백 기반 v2 우선순위 결정.

### OPF fine-tuning (c)
- **거부 이유**: GPU 비용 + 한국어 라벨링 데이터셋 부재 + 모델 재배포 부담. KLUE 같은 사전학습 모델 활용이 훨씬 효율적.

### spaCy ko (d)
- **거부 이유**: 정확도 ~70%로 KLUE 대비 약함. KLUE가 v2에서 정답인데 v1에 spaCy 두는 건 중복 작업.

### LLM 호출 (e)
- **거부 이유**: PII 마스킹을 위해 LLM에 PII를 보내는 모순. + 비용 + 지연.

### 정규식만 (이름 휴리스틱 제외)
- **거부 이유**: 요구사항에 "한국 이름까지 필요" 명시. 정규식만으로는 이름 못 잡음.

---

## Implementation Notes

### 패키지 구조
```
packages/core/src/detector/
├── regex/
│   ├── korean-rrn.ts          # 주민번호 + 체크섬
│   ├── korean-bizNum.ts        # 사업자 + 체크섬
│   ├── korean-phone.ts         # 010-XXXX-XXXX
│   ├── card-luhn.ts            # LUHN
│   └── email.ts
├── korean-heuristic/
│   ├── surnames.ts             # import surnames.json
│   ├── stopwords.ts            # import stopwords.json
│   └── matcher.ts              # 패턴 매칭 로직
└── data/
    ├── korean-surnames.json    # 상위 100 성씨
    └── korean-stopwords.json   # 기본 차단 리스트
```

### 주민번호 체크섬 알고리즘
```typescript
function rrnChecksum(digits: number[]): boolean {
  const weights = [2,3,4,5,6,7,8,9,2,3,4,5]
  const sum = digits.slice(0,12).reduce((s,d,i) => s + d*weights[i], 0)
  const check = (11 - (sum % 11)) % 10
  return check === digits[12]
}
```

### Korean 이름 매칭 의사코드
```typescript
function findKoreanNames(text: string): Span[] {
  const surnames = loadSurnames()      // Set<string>
  const stopwords = loadStopwords()    // Set<string>
  const matches: Span[] = []
  const regex = /[가-힣]{2,3}/g
  for (const m of text.matchAll(regex)) {
    const surname = m[0][0]
    if (!surnames.has(surname)) continue
    if (stopwords.has(m[0])) continue
    matches.push({ start: m.index!, end: m.index! + m[0].length, category: 'private_person' })
  }
  return matches
}
```

### 데이터 출처
- 한국 성씨 통계: 통계청 인구주택총조사 (공개 데이터)
- Stopwords 초기 시드: KoNLPy 불용어 리스트 + 수동 큐레이션

---

## References

- 요구사항: 한국 이름 NER 필요
- KLUE benchmark: https://klue-benchmark.com
- 통계청 인구주택총조사: 한국 성씨 분포
- ADR-0010: 한국 카테고리 3종(RRN/BIZNUM/CARD) 추가 정의
- ROADMAP.md Phase 2 (v1 휴리스틱), Phase 7 (v2 KLUE-NER)
