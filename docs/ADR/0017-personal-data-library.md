# ADR-0017: Personal Data Library — 사용자 정의 PII 사전 등록

- **Status**: Accepted
- **Date**: 2026-05-19
- **Related**: [ADR-0005](./0005-backend-strategy-trust-tiers.md) (Backend Strategy), [ADR-0006](./0006-fail-closed-default.md) (fail-closed), [ADR-0007](./0007-korean-pii-strategy.md) (Korean PII), [ADR-0010](./0010-pii-categories-opf-plus-korean.md) (카테고리)

---

## Context

### 문제: false negative — 검출 못 하는 사용자 고유 PII

현재 검출 파이프라인은 generic NER (OPF) + 정규식 (한국 PII 5종 + 영문 secret) + 한국 이름 휴리스틱(상위 100 성씨). 다음은 **모두 미검출**:

- **흔치 않은 성씨 한국 이름** — 100위 밖 성씨 (예: `위`, `석`, `방`, `정`, `반` 등의 외국 귀화 사례)
- **회사명 / 부서명** (예: `XX테크`, `라온그룹` 등) — OPF/KLUE는 일반 organization으로 분류 후 PII 토큰화 안 함 (ADR-0007 §Decision §2: PS만 promote)
- **프로젝트 코드네임** (예: `Project-Phoenix`, `OP-WALRUS-7`) — 패턴이 generic NER에 학습 안 됨
- **사내 jargon / 시스템 이름** (예: `SmartFactory-2`, `MAGI-Core`) — 일반 명사로 인식
- **자기 사적 이메일 alias** (예: `me+work@example.com`, `dev.kim@startup.kr`) — generic email regex는 잡지만 분류만 `private_email`
- **사내 ID 포맷** (예: `KRX-1234-A`, `EMP00789`) — generic regex로는 잡기 어렵고 false positive 위험

### 경쟁사 패턴

- **PrivacyPal**: "Personal Data Library" — 사용자 자기 PII (이름, 회사, 클라이언트 등)를 사전 등록 → 항상 검출
- **CloakLLM**: "Custom LLM Categories" — 사용자 정의 카테고리 + Ollama로 LLM-powered 검출. 무거움
- **Veil / Private Guard**: 브라우저 확장에 "watchlist terms" / "custom patterns" — 사용자가 단어 등록 → 정규식 매칭

본 프로젝트의 차별점: **AI 코딩 워크플로 + 한국 시장**. 한국 개발자가 자기 이름 / 회사명 / 클라이언트 이름 / 사내 프로젝트 코드를 등록하면 그 사람의 모든 prompt에서 자동 마스킹 — 시장에 정확히 일치하는 도구 없음.

### 본 ADR이 답해야 할 질문

1. 데이터 schema — 단순 list (string only)인가 structured (category + options)인가?
2. 매칭 — literal substring? word boundary? regex 허용?
3. case sensitivity 정책
4. 카테고리 — 기존 11종에 매핑하는가 신규 `personal_*` 카테고리를 추가하는가?
5. 파일 위치 + 우선순위 (project / user / config inline)
6. Backend 합성 — `LocalRegexBackend`에 통합하는가 별도 `PersonalDataBackend`인가?
7. TieredStrategy 호환 — placeholder 보호 동작
8. 보안 — 파일 권한 / 디스크 영속화 / ReDoS

---

## Decision

### 1. 데이터 schema — structured, 보수적 surface

`personal-data.json` (또는 config 인라인) 스키마:

```jsonc
{
  "$schema": "https://pii-remover.dev/schema/personal-data-v1.json",
  "entries": [
    {
      "value": "김민재",
      "category": "private_person",
      "case_sensitive": true,
      "word_boundary": true
    },
    {
      "value": "Project-Phoenix",
      "category": "secret",
      "case_sensitive": false,
      "word_boundary": true
    },
    {
      "value": "me+work@startup.kr",
      "category": "private_email"
    }
  ]
}
```

**필수 필드**: `value`, `category`.
**옵션 필드**: `case_sensitive` (default `false`), `word_boundary` (default 모든 영숫자/한글 양쪽으로 `true`).

**근거**:
- generic NER이 못 잡는 항목들이 다양한 category — 단순 list로는 categorization 불가.
- 사용자가 직접 의도 표현해야 vault 토큰 family 정확함 (`__OPF_PERSON_1__` vs `__OPF_SECRET_1__`).

### 2. 매칭 — literal only, regex 비허용

- **literal substring match** (regex 미허용). 사용자가 정규식 직접 작성 시 ReDoS 가능성 + UX 실수 위험.
- **word_boundary**: 영문은 `\b`, 한글은 양쪽 인접 문자가 한글이 아닌지 검증.
  - **default가 entry 언어에 따라 다름**: 영문/숫자 값은 `true` (false positive 방지), 한글 값은 `false` (한국어 조사 "는/이/가/을/를" 등이 모두 한 글자라 strict boundary면 거의 매칭 안 됨)
  - 사용자가 명시적으로 `word_boundary: true/false` 지정 시 그 값 우선
- **case_sensitive**: default `false`. 한글은 case 무관이라 무시.

**근거**:
- regex 허용은 v2. v1은 보수적으로 시작 — 사용자 학습 부담 ↓, 보안 ↑.
- `word_boundary: false`는 substring 매칭이 필요한 케이스 (예: `"민재"`만 등록해도 `"김민재"` 안에서 잡고 싶을 때) 지원.

### 3. 카테고리 — 기존 11종에 매핑 (신규 카테고리 추가 X)

`category` 값은 `PIICategory` enum의 11종 중 하나:
- 한국/영문 이름 → `private_person`
- 사내 시스템 이름 / 프로젝트 코드 → `secret` (가장 안전한 default. LLM에 노출 시 큰 영향)
- 사내 이메일 → `private_email`
- 사내 전화 → `private_phone`
- 사내 주소 → `private_address`
- 사내 ID 포맷 → `account_number` 또는 `secret`

**근거**:
- 신규 카테고리 (`personal_custom`) 추가하면 token format 변경 (ADR-0002), 카테고리 매핑 (ADR-0010), 11종 → 12종 schema 변경 등 광범위 영향.
- 기존 11종이 충분히 표현력 있음. `secret`은 catch-all로 적합.
- v2에서 사용자 요청 빈도 확인 후 도입.

### 4. 파일 위치 + 우선순위

1. **Project**: `<cwd>/.pii-remover/personal.json` (또는 `<cwd>/.pii-remover/personal-data.json`)
2. **User**: `~/.config/pii-remover/personal.json` (Windows: `%APPDATA%\pii-remover\personal.json`)
3. **Config inline**: `pii-remover.json`의 `personal_data.entries`
4. **Programmatic**: `PIIRemover.init({ personalData: [...] })`

우선순위: 1 > 2 > 3 > 4. **Merge**, override 아님 — 모든 source의 entries가 합쳐짐. 중복은 dedup (value + category 기준).

**근거**:
- project-level은 프로젝트 팀이 공유 (회사명, 프로젝트 코드)
- user-level은 개인 (자기 이름, 사적 이메일)
- config inline은 단순 시나리오
- programmatic은 SDK 사용자

### 5. Backend — 신규 `PersonalDataBackend`, MergeStrategy 합류

- 신규 `BackendClient` 구현체: `PersonalDataBackend` (`packages/core/src/backend/personal-data.ts`)
- `name`: `"personal-data"`
- `trust_tier`: `"local"`
- `detect()`: in-process, 모든 entry에 대해 indexOf 또는 word-boundary regex로 검출
- `buildDefaultStrategy`에서 `LocalRegexBackend` 다음으로 자동 합류 (config에 entries가 있을 때만)
- **MergeStrategy의 longer-span 우선 정책** 그대로 적용 — personal data가 generic regex와 겹치면 personal data 우선 (사용자 의도 존중)

### 6. TieredStrategy 호환 — local tier로 처리

- `PersonalDataBackend`는 `trust_tier: "local"` → `TieredStrategy`의 첫 단계(`local.detect`)에 합류
- placeholder 보호: 사용자 등록 PII는 한국 PII와 동일하게 **외부 원격으로 절대 전송 안 됨** (보안 invariant 유지)

### 7. 보안

- **파일 내용은 PII 평문**: 사용자 책임 — file system 권한 (0600 권장). 본 도구는 별도 권한 검증 안 함.
- **Vault 인메모리 invariant 보존**: 사용자 등록 entries는 디스크에 있지만, **detection 결과 vault entry는 여전히 인메모리만** (ADR-0003). 다른 vault entry와 동일하게 process 종료 시 사라짐.
- **No ReDoS**: regex 미허용 (§2). 모든 매칭은 indexOf 또는 fixed-pattern regex (`\b` boundary)만 사용 — exponential backtracking 불가능.
- **No telemetry**: 사용자 등록 entries는 절대 외부로 송신 안 함 (audit log도 PII plaintext 미로깅, ADR-0006).

### 8. 카테고리 검증

- `category`가 `ALL_CATEGORIES`에 없으면 fail-closed (init throw) — 잘못된 카테고리로 vault 토큰 family 깨지지 않도록.
- 빈 `value` (`""`) 또는 whitespace-only는 fail-closed (init throw).
- 1글자 value는 false positive 폭증 위험 → warning 발생 후 허용 (사용자 책임).

---

## Consequences

### 긍정적

- **False negative 제로**: 사용자가 자기 critical PII (이름, 회사, 프로젝트 코드)를 사전 등록 → 검출 누락 없음.
- **시장 차별점 강화**: 한국 개발자의 사내 jargon / 프로젝트명 보호 — 시장에서 정확히 매칭되는 도구 거의 없음.
- **MCP server와 자연스러운 결합**: Phase 8의 `sanitize` tool이 자동으로 personal data 활용.
- **TieredStrategy 보호**: 사용자 personal data는 원격 백엔드로 절대 누출 안 됨 (placeholder 단방향성).
- **Core 변경 최소**: 신규 backend + config schema 1개 섹션 추가. 기존 동작 회귀 0.

### 부정적

- **사용자 셋업 부담**: 처음 등록할 때 수작업. v2에서 active learning(자주 등장 PII 자동 등록 제안) 검토.
- **Config 파일 손실 시 false negative 부활**: 사용자가 personal.json 백업 안 하면 재등록 필요.
- **카테고리 매핑 학습 곡선**: 사용자가 "프로젝트 코드는 `secret`이야"라는 매핑을 처음엔 모를 수 있음. README + 예시 파일 제공.

### 위험 / 미해결

- **회사명 false positive**: `"애플"` 등록 후 일반 단어 매칭 위험. `word_boundary: true` + case_sensitive로 완화하되 사용자가 결정.
- **dedup 충돌**: 같은 `value` + 다른 `category`인 경우 어떻게? — 둘 다 유지 (independent entries). 매칭 시 둘 다 매칭되면 MergeStrategy의 longer-span 우선 + tie-break.
- **활성/비활성 toggle**: 임시로 비활성화하고 싶을 때 entry 삭제하기 번거로움. v2에서 `enabled: false` 필드 옵션.
- **TieredStrategy + remote backend**: remote가 personal data redacted placeholder를 보면 generic NER이 그 위치를 잘못 분류 가능. invariant 유지하되 결과 품질 모니터링.

---

## Alternatives Considered

### A1. Regex 허용

거부 이유: ReDoS 위험 + 사용자 학습 곡선 + 단순성 유지. v2에서 사용자 요청 빈도 확인 후 추가. 현재 v1은 literal + word boundary로 95% use case 커버.

### A2. 신규 카테고리 `personal_custom` 추가

거부 이유: ADR-0002 토큰 형식 + ADR-0010 카테고리 매핑 + vault schema 영향. 11종 → 12종 확장은 광범위 변경. 기존 카테고리에 매핑하는 게 단순.

### A3. 단일 list (string only)

거부 이유:
- 카테고리 정보 없으면 vault 토큰 family 잘못 (`__OPF_PERSON_X__`인지 `__OPF_SECRET_X__`인지 모름)
- 매칭 정확도 제어 옵션(`case_sensitive`, `word_boundary`) 불가
- 의도 표현력 부족

### A4. LocalRegexBackend에 통합

거부 이유:
- 책임 분리 — `LocalRegexBackend`는 hardcoded 한국 PII + 영문 secret용. 사용자 entries는 별도 lifecycle.
- 단위 테스트 isolation — `PersonalDataBackend`만 단독 검증 가능.
- 향후 변경 격리 — schema 확장 시 `LocalRegexBackend` 안 건드림.

### A5. Active learning (CloakLLM 패턴)

거부 이유:
- Ollama 또는 LLM 의존성 추가. 본 프로젝트의 Bun-first / Docker-optional 정책과 충돌.
- v1 scope 외. ROADMAP v2 백로그.

### A6. 파일 위치 — 한 곳만

거부 이유: project / user / programmatic 시나리오 다 다름. 우선순위 + merge가 자연스러움. `INSTALL.md`에 우선순위 명시하면 학습 부담 작음.

---

## Implementation Notes

### 신규 모듈

```
packages/core/src/
├── backend/
│   └── personal-data.ts            # PersonalDataBackend 구현
├── config/
│   ├── schema.ts                    # PersonalDataConfig + PersonalDataEntry types 추가
│   └── personal-data-loader.ts     # 파일 우선순위 + merge + validation
└── data/
    └── personal-data-example.json  # 예시 파일 (사용자 참고용)
```

### config schema 추가

```typescript
export interface PersonalDataEntry {
  value: string;
  category: PIICategory;
  case_sensitive?: boolean;
  word_boundary?: boolean;
}

export interface PersonalDataConfig {
  enabled: boolean;                  // default true
  entries: readonly PersonalDataEntry[];
  /** Additional file paths to load on top of default locations. */
  extra_paths?: readonly string[];
}

// PiiRemoverConfig에 personal_data 필드 추가
export interface PiiRemoverConfig {
  // ... 기존 ...
  personal_data: PersonalDataConfig;
}

// DEFAULT_CONFIG.personal_data = { enabled: true, entries: [] }
```

### `PersonalDataBackend` 핵심 로직

```typescript
export class PersonalDataBackend implements BackendClient {
  readonly name = "personal-data";
  readonly trust_tier: TrustTier = "local";

  constructor(private readonly entries: readonly NormalizedEntry[]) {}

  async detect(text: string, opts: DetectOpts): Promise<DetectionResult> {
    const t0 = performance.now();
    const detections: Detection[] = [];
    for (const entry of this.entries) {
      for (const match of findMatches(text, entry)) {
        detections.push({
          start: match.start,
          end: match.end,
          category: entry.category,
          confidence: 0.95,
          text: text.slice(match.start, match.end),
        });
      }
    }
    return {
      detections,
      backend_name: this.name,
      latency_ms: performance.now() - t0,
    };
  }
  async healthCheck() {
    return { ok: true, latency_ms: 0, version: "v1" };
  }
}
```

### Word boundary 알고리즘

```typescript
// 양쪽 인접 글자가 다음이면 boundary로 간주:
//   - undefined (텍스트 시작/끝)
//   - 한글 entry value 양쪽: 한글이 아닌 글자
//   - 영문 entry value 양쪽: 영숫자가 아닌 글자
function isWordBoundary(text: string, start: number, end: number, value: string): boolean {
  const isHangul = /[\uAC00-\uD7A3]/.test(value);
  const left = text[start - 1];
  const right = text[end];
  if (isHangul) {
    return !(left && /[\uAC00-\uD7A3]/.test(left))
        && !(right && /[\uAC00-\uD7A3]/.test(right));
  }
  return !(left && /[A-Za-z0-9_]/.test(left))
      && !(right && /[A-Za-z0-9_]/.test(right));
}
```

### `buildDefaultStrategy` 통합

```typescript
function buildDefaultStrategy(
  config: PiiRemoverConfig,
  extraBackends?: readonly BackendClient[],
): BuiltStrategy {
  // ... 기존 ...
  const backends: BackendClient[] = [
    new LocalRegexBackend({ enabledCategories: config.detection.enabled_categories }),
  ];
  if (config.personal_data.enabled && config.personal_data.entries.length > 0) {
    backends.push(new PersonalDataBackend(config.personal_data.entries));
  }
  if (config.backend.endpoint) backends.push(buildRemoteBackend(config.backend));
  // ... 기존 MergeStrategy / SingleStrategy 선택 ...
}
```

### Tests

| 카테고리 | 추정 |
|---|---|
| `PersonalDataBackend.detect` literal match | 5 |
| word_boundary on/off (한글 / 영문) | 6 |
| case_sensitive 조합 | 4 |
| 카테고리별 매핑 (private_person / secret / private_email) | 4 |
| MergeStrategy 통합 (longer-span 우선 + dedup) | 3 |
| TieredStrategy 호환 (personal data가 remote로 누출 안 됨) | 3 |
| Config loader (project > user > inline merge) | 5 |
| Validation (빈 value, 잘못된 category, 1글자 warning) | 4 |
| **합계** | **~30 new tests** |

### Backwards compatibility

- 기존 사용자 영향 0: `personal_data.entries: []`이 default → backend 미생성 → 기존 동작 그대로.
- 기존 config 파일 마이그레이션 불필요 — schema에 새 optional 필드 추가만.

### Limitations (v1)

- Regex 미지원 — literal + word boundary만. v2에서 안전한 regex (timeout + size cap) 추가 검토.
- 신규 카테고리 미지원 — 11종 매핑. v2에서 `personal_custom` 검토.
- Active learning 미지원 — 사용자가 manual 등록. v2에서 LLM-powered 제안 검토.
- 1글자 entry 허용 — warning만. v2에서 default block + opt-in 검토.

---

## References

- 경쟁 패턴: PrivacyPal Personal Data Library, CloakLLM custom categories, Veil watchlist terms
- ADR-0005 §2 (Backend Strategy + MergeStrategy)
- ADR-0006 (fail-closed init)
- ADR-0007 (한국 PII v1 휴리스틱 한계 — false negative 보강 동기)
- ADR-0010 (PII categories — 기존 11종 매핑 결정 근거)
