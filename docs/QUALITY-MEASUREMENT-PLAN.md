# 환각 · 복원 실패 측정/개선 계획

- **Status**: Phase A · B · C 구현 완료 / Phase D 미착수
- **Date**: 2026-08-10 (계획) → 2026-08-10 (A·B·C 구현)
- **Related**: [ADR-0002](./ADR/0002-token-format-opf-underscore.md), [ADR-0003](./ADR/0003-vault-session-in-memory.md), [ADR-0018](./ADR/0018-synthetic-substitution.md), [ADR-0020](./ADR/0020-deterministic-hash-token.md), [ADR-0021](./ADR/0021-token-epoch-and-bounded-repair.md), [ROADMAP.md](./ROADMAP.md)

> 원칙: **측정 먼저, 개선은 그다음.** 감사(audit) 스트림에서 뽑은 수치는 신뢰할 수 없었으므로(§2),
> 지표 기반이 정상화되기 전에 개선을 넣으면 깨진 기준선 위에서 평가하게 된다.

## 구현 현황 (2026-08-10)

| Phase | 상태 | 결과 |
|---|---|---|
| **A** — 관측 가능하게 | ✅ | B1~B4 해소. 3개 SSE 변환기에 `request_id` 전파, 전송 경로 분모 정렬 |
| **B** — 오프라인 하네스 | ✅ | `packages/eval` Tier-1. 59-entry 합성 corpus, 16 변이, 913 케이스, 1457 identity probe |
| **C** — 판별과 복구 | ✅ | L2·L3·L4·L7. **복구 가능 12개 변이 클래스 전부 100%**, `false_restoration_rate = 0` |
| **D** — 의미 품질 | ❌ 미착수 | Tier 2·3 러너 미구현. P2(masking tax) 지표는 여전히 없음 |

게이트: `bun run build` exit 0 · typecheck clean(root + eval) · `bun test` **1019 pass / 0 fail** ·
`bun install --frozen-lockfile` ok · `packages/eval/baseline.md` 커밋본 = 생성본.

**구현 중 발견해 고친 결함 5건** (계획 수립 시점엔 몰랐던 것):

| # | 결함 | 성격 |
|---|---|---|
| 1 | SSE 경계 버퍼가 정확히 `__OPF_`에서 끝나면 `__OPF`를 방출해 토큰을 두 restore 호출로 쪼갬 | 기존 버그. fuzz 21건이 놓침 |
| 2 | 카테고리를 무시한 복구가 **다른 엔트리의 값**을 54건 반환 | 본 계획 초안의 설계 오류 |
| 3 | dead-token 중화가 **사용자가 직접 친 텍스트**를 덮어씀 | 기존 버그 → 불변식 I6 신설 |
| 4 | `foreign` 미스를 전부 모델 탓으로 귀속 — **파일 하나 읽을 때마다 환각률 상승** | 본 계획의 분모 정의와 구현 불일치 |
| 5 | `eval.yml`이 동작하지 않는 `bun run --filter` 사용 + `\|\| true`로 **거짓 green** 생성 | 위임 산출물 검증 누락 |

---

## 0. 착수 전 정정된 전제

계획 수립 중 원본을 확인해 다음 3가지 통념이 **사실과 다름**을 확인했다. 계획의 방향이 바뀐다.

| 통념 | 사실 |
|---|---|
| "토큰 키가 프로세스마다 랜덤이라 재시작하면 토큰이 달라진다" | **틀림.** `resolveTokenKey()` ([token-hash.ts:80](../packages/core/src/redaction/token-hash.ts)) 가 `PII_REMOVER_TOKEN_KEY` → `~/.config/pii-remover/key` → 생성·영속 → ephemeral 순으로 해결하고, `PIIRemover.init()`이 이를 `VaultManager`에 주입한다. `randomBytes(32)` 폴백은 테스트에서 `new VaultManager()`를 직접 만들 때만 발동. **같은 PII는 이미 재시작 후에도 같은 토큰이 된다.** → dead token은 *키* 문제가 아니라 **vault 영속성** 문제다. |
| "경로 안의 토큰은 복원에서 제외된다" | **부정확.** [restorer/index.ts:162–181](../packages/core/src/restorer/index.ts)에서 `isInsidePath` 검사는 `if (entry)` 조기 반환 **뒤에** 있다. vault에 있는 토큰은 경로 안이어도 정상 복원된다. `pathSkipCount`는 **vault 미스만** 센다. → 환각 토큰이 `unknownTokenCount`에 안 잡히고 조용히 빠지는 **집계 누수 구멍**이다. |
| "LLM에게 토큰을 그대로 두라고 지시하는 장치가 없다" | **틀림.** `OPF_PLACEHOLDER_SYSTEM_NOTE` ([hooks.ts:153](../packages/opencode-plugin/src/hooks.ts))가 이미 존재. 단 `experimental.chat.system.transform` 경로에만 주입되고 **proxy / Claude Code CLI hook 경로엔 없다.** 커버하는 테스트도 없다. |

부수적으로: `restoration.mode`는 `token | synthetic`만이 아니라 **`hmac`(비가역 해시)** 도 지원하며,
`restoration.type_overrides` → `TypeRedactor`도 존재한다. 즉 LangChain `PIIMiddleware`의 `hash` 전략은 이미 구현되어 있다.

---

## 1. 문제 정의 — 4갈래로 분해

사용자가 말한 "환각 + 복원 실패"는 원인도 대응도 다른 4개 문제다. 섞어 재면 아무것도 안 보인다.

| # | 문제 | 증상 | 계획 시점 | 현재 |
|---|---|---|---|---|
| **P1** | **토큰 환각** — LLM이 발행된 적 없는 `__OPF_*__`를 만들어냄 (해시 창작, 카테고리 오기, 이전 대화에서 복사) | 출력에 raw 토큰 또는 `[UNRESTORABLE]` 잔존 | ❌ dead token과 구분 불가 | ✅ `hallucinated_count` (출처가 model일 때만) |
| **P2** | **의미 품질 저하 (masking tax)** — 불투명한 16자 해시가 의미 신호를 파괴해 LLM 추론이 망가짐 (PERSON 두 개를 혼동, 속성 교차 배정) | 답변이 틀림. 복원은 "성공"으로 집계됨 | ❌ 지표 자체가 없음 | ❌ **여전히 없음** (Phase D 미착수) |
| **P3** | **복원 실패** — 정상 발행된 토큰이 왕복 실패 (LLM 변형, SSE 분할, 마크다운 이스케이프, JSON 이스케이프, 한국어 조사 교착) | `[UNRESTORABLE]` 또는 토큰 잔존 | △ 카운터는 있으나 분모가 깨짐 | ✅ 분모 정상화 + Tier-1 변이 12종 100% |
| **P4** | **dead token** — 이전 프로세스가 발행한 토큰의 vault 매핑 소실 | `[UNRESTORABLE]` | ❌ P1과 구분 불가 | ✅ `dead_token_count` (epoch 일치 + vault 미스) |

**P1과 P4의 구분 불가**가 1차 병목이었다 — ADR-0021의 epoch 마커로 해소.
**P2는 지표가 아예 없다** — 복원이 100% 성공해도 답이 틀릴 수 있고, 지금도 그걸 성공으로 센다.
Phase A·B·C는 P1·P3·P4만 다뤘다. **P2는 손대지 않았다.**

---

## 2. 측정 신뢰성 블로커 — 이걸 먼저 고치지 않으면 모든 수치가 무효

| # | 결함 | 위치 | 영향 | 상태 |
|---|---|---|---|---|
| **B1** | **스트리밍 경로가 SSE delta마다 restore 감사 이벤트를 `request_id` 없이 발행.** 반면 plugin 경로(`hooks.ts`)는 `!text.includes("__OPF_")`로 조기 반환해 토큰 있는 텍스트에만 발행 | `proxy/src/stream/{anthropic,openai,codex}-sse.ts` · `opencode-plugin/src/hooks.ts` | **두 전송 경로의 분모가 서로 호환되지 않고, 스트리밍 쪽은 요청 단위 묶음 키가 없다. 계획 시점에 뽑는 모든 온라인 수치는 방향을 알 수 없게 틀렸다.** | ✅ 해소 — `server.ts`가 요청당 1개 id 발행, 토큰 없는 텍스트는 이벤트 미발행 |
| **B2** | `RestoreResult.pathSkipCount`를 계산하고도 감사에 안 실음 | `pii-remover.ts` `restore()` | 환각 토큰 일부가 어떤 카운터에도 안 잡힘 | ✅ 해소 |
| **B3** | mask 이벤트에 발행 토큰 수(`minted_count`) 없음 (`sum(categories)`로 유도 가능하나 취약) | `audit/types.ts` | 세션당 토큰 참조율 계산 불가 | ✅ 해소 |
| **B4** | `partialMatchCount`가 lenient **복원 성공**과 **실패**를 합산 | `restorer/index.ts` | lenient 매칭이 실제로 구제하는 비율을 모름 | ✅ 해소 — `lenientRestoredCount` 분리 |
| **B5** | synthetic 모드는 토큰을 안 쓰므로 **런타임 관측치가 0** | `synthetic/restore.ts` | 품질 좋아 보여도 실패를 감지할 수단이 없음 | ❌ **미해결** — L6를 켜면 그 카테고리는 관측 불가가 된다 |
| **B6** | 감사 귀속이 출처를 보지 않아 **도구·사용자 텍스트의 토큰 모양 문자열이 환각으로 집계**됨 (구현 중 발견) | `pii-remover.ts` `restore()` | `hallucination_rate`가 파일 읽기마다 상승 | ✅ 해소 — `RestoreOptions.origin` (§4) |

---

## 3. 지표 모델

### 3.1 온라인 지표 — 감사 스트림에서 유도, 정답 라벨 불필요, PII 유출 0

분모는 **발행 토큰 수가 아니라 LLM 출력에서 관측된 토큰 수**로 잡는다.
(발행했지만 모델이 언급하지 않은 토큰은 실패가 아니다.)

```
observed = restored_count + unknown_token_count + path_skip_count
```

| 지표 | 산식 | 필요한 신규 감사 필드 |
|---|---|---|
| `token_restore_rate` | `restored_count / observed` | `path_skip_count` |
| `unknown_token_rate` | `(unknown_token_count + path_skip_count) / observed` | `path_skip_count` |
| `lenient_rate` | `partial_match_count / observed` | — |
| `lenient_recovery_rate` | `lenient_restored / partial_match_count` | `lenient_restored_count` |
| `unrestorable_surface_rate` | 최종 텍스트에 `[UNRESTORABLE]` 또는 `TOKEN_LENIENT_REGEX` 잔존한 요청 수 / 전체 restore 요청 | `residual_token_count` |
| `token_reference_rate` | `observed / minted` (session_id 조인) | `minted_count` |
| `leak_rate` | 마스킹된 텍스트를 **재탐지**해 span ≥1 나온 mask 요청 / 전체 mask 요청 | `residual_detection_count` |
| `mask_density` | `masked_char_count / text_length` (카테고리별) | `text_length`, `masked_char_count` |
| `bypass_rate` | bypass 이벤트 / 전체 | (이미 있음) |

**`leak_rate` 주의 2가지**
1. 탐지 1회분 지연이 추가된다 → 1/N 샘플링 또는 config 게이트.
2. 잔여 검사에서 **`TOKEN_STRICT_REGEX` 매치 span과 알려진 `synthetic_value`는 반드시 제외**해야 한다.
   안 그러면 synthetic 모드가 leak 100%로 보고된다(synthetic 값은 *진짜처럼 보이도록* 설계됐으므로).
   `detector/secret-scanner.ts`에 이미 OPF 제외 패턴이 있으니 그대로 차용.

**과탐(over-masking)은 정답 없이 정의 불가.** 대리 지표 2개로 추세만 본다 —
`mask_density`(카테고리 × 파일유형별 드리프트)와 `bypass_rate`(과탐에 질린 사용자는 bypass를 켠다).
진짜 FP율은 오프라인 전용.

§4의 epoch 마커 도입 후 `unknown_token_rate`는
`hallucinated_count` / `unminted_token_count` / `dead_token_count` / `ambiguous_count`로 분해된다.
앞의 둘은 **같은 실패를 출처로 나눈 것**이며, `hallucination_rate`의 분자는 `hallucinated_count`뿐이다 —
도구 출력이나 사용자 입력에 들어 있던 토큰 모양 문자열은 절대 포함하지 않는다.

### 3.2 오프라인 지표 — 라벨링된 corpus 필요

| 지표 | 산식 |
|---|---|
| `detection_recall` / `detection_precision` | 카테고리별, 기존 fixture의 기대값 대비 |
| `roundtrip_exact_rate` | `restore(mask(x)) === x` — ROADMAP의 기존 `≥98%` 항목 |
| **`roundtrip_after_mutation_rate`** | 변이 클래스별 왕복률 — **신규 대표 지표** |
| **`false_restoration_rate`** | 토큰이 **다른** vault 엔트리 값으로 복원된 비율 — **하드 불변식 = 0** |
| `semantic_delta` | §5 |

---

## 4. 환각 vs dead token 판별

키가 이미 영속이므로 토큰 해시는 재시작 후에도 재현된다. 없는 건 **역방향 맵**뿐이다.

```
vault 히트                          → 복원
미스 + 후보 정확히 1개               → 복구 후 복원
미스 + 후보 2개 이상                 → ambiguous (fail closed)
미스 + 후보 0개 + epoch 일치         → expired   (이 키가 발행했으나 vault에 없음 = dead token)
미스 + 후보 0개 + epoch 불일치       → foreign   (이 키가 발행한 적 없음)
```

복구를 epoch 비교보다 **먼저** 시도한다. epoch은 16자 해시의 앞 3자를 차지하므로 먼저 게이트로 쓰면
거기 떨어진 손상(단일 문자 손상의 약 1/5)을 전부 버린다. epoch은 분류 보조이지 안전 검사가 아니다.

> **`foreign`은 사실이지 책임이 아니다.** "이 키가 발행하지 않았다"는 네 가지를 한꺼번에 뜻한다 —
> ① 모델이 지어냄 ② 도구·파일·웹 내용에 토큰 모양 문자열이 있었음 ③ 사용자가 직접 침 ④ 다른 키로 발행됨.
> **이 중 ①만 환각이다.** 코딩 에이전트는 파일을 끊임없이 읽고 이 리포지토리 문서·테스트에도 토큰
> 리터럴이 있어, 구분 없이 세면 **파일 하나 읽을 때마다 환각률이 오른다** — 프롬프트 레버(L3)를 당길지
> 결정하는 바로 그 수치가 오염된다(실측 확인).
> 출처는 호출 지점만 알므로 `RestoreOptions.origin`(`model` | `tool` | `user`)으로 받아 `model`이면
> `hallucinated_count`, 아니면 `unminted_token_count`로 귀속한다. 기본값은 `model` — 빠뜨린 호출자가
> 조용히 면죄되지 않도록 보수적으로 잡는다.

> **초안 정정 (구현 중 발견)**: 이 표의 초판은 `epoch 불일치 = dead token`, `epoch 일치 + 후보 0 = 환각`으로
> 잡았다. 이는 키가 자주 바뀐다는 가정이었으나, `resolveTokenKey()`가 키를 영속화하므로 **dead token의
> 지배적 원인은 키 변경이 아니라 vault 소멸**이다. 따라서 매핑은 위와 같이 뒤집힌다.
> 구현과 근거는 [ADR-0021](./ADR/0021-token-epoch-and-bounded-repair.md).

### 권고: **기존 16자 안에 epoch 마커를 심는다. wire-format 변경 비용 0.**

`tokenHash()` ([token-hash.ts:37–52](../packages/core/src/redaction/token-hash.ts)) **한 함수만** 바꿔
`epoch(3자) + body(13자)`를 반환하게 한다. `epoch = base36(HMAC(key, "opf-key-epoch-v1")).slice(0,3)`.

이 선택의 근거:

- `TOKEN_HASH_LENGTH`는 **16 그대로**. `TOKEN_STRICT_REGEX` / `TOKEN_LENIENT_REGEX`
  ([format.ts:21,26](../packages/core/src/token/format.ts)) 무변경.
  `COMPLETE_TOKEN_AT_END_REGEX` / `UNSAFE_TOKEN_TAIL_REGEX` / `DEFAULT_BUFFER_WINDOW=64`
  ([buffer.ts](../packages/proxy/src/stream/buffer.ts)) 무변경.
  (계획 시점에 있던 **하드코딩된 `{16}` 리터럴 3곳은 L0에서 제거**되어 이제 전부 `TOKEN_HASH_LENGTH` 파생이다.)
- body 13 base36 ≈ 67비트. `MAX_ENTRIES_HARD = 100_000` 상한에서 생일 충돌 ~1e-11.
  `VaultManager.assign()`은 어차피 충돌 시 fail-closed.
- epoch은 키당 고정, 키 교체 시 자동 변경, 별도 카운터 상태 불필요.
  256비트 키에 대한 단방향 함수 출력 3자이므로 유의미한 누출 없음. 오분류율 = 1/46656.
- **파괴적 변경**: 현재 살아 있는 토큰이 전부 죽는다. 그러나 vault가 in-memory `Map`이라
  **어차피 프로세스 재시작 시 죽는다** → 실질 피해 반경 = 1 세션. `SCHEMA_VERSION` → `"opf.reversible.v3"`.

### 별도 체크섬: 도입하지 않는다
체크섬의 유일한 고유 가치는 퍼지 복구의 경계를 정하는 것인데,
**vault 키셋이 더 정확하고 엄격한 경계**다(§6 L4). 길이만 먹고 엔트로피만 깎는다.

### vault 영속화: 한다, 단 opt-in
dead token의 진짜 해법이며 epoch 작업과 분리 가능.
제약: 이미 해결된 토큰 키로 **암호화**, TTL 24h, `~/.config/pii-remover/vault/<session>.jsonl` mode `0600`, **기본 off**.
위협 모델은 "PII를 클라우드로 보내지 말 것"이지 "로컬에 PII를 두지 말 것"이 아니다.
그러나 디스크 상의 PII 저장소는 in-memory `Map`과 **위험 등급이 다르므로** 반드시 사용자의 명시적 선택이어야 한다
(ADR-0003이 인용한 deformatic 경고와 동일 논지).

**순서**: epoch 먼저(한 함수 변경으로 문제를 *측정 가능*하게 만듦) → vault 영속화 나중(문제를 *없애지만* 보호 대상 자산이 늘어남).

---

## 5. 평가 하네스

**위치: 신규 `packages/eval` (private, 미배포).**
루트 `package.json`의 `workspaces: ["packages/*", "tests/integration"]`가 이미 `packages/*`를 잡으므로
루트 수정 0으로 워크스페이스 해석(`@pii-remover/core`, `@pii-remover/proxy`)을 그대로 받는다.

계획한 구조:

```
packages/eval/
  src/mutators/      # 16종 결정론적 변이 함수
  src/scoring/       # roundtrip · false-restoration · entity-consistency
  src/runners/       # tier1-mutation.ts · tier2-replay.ts · tier3-live.ts
  fixtures/
    mutation-corpus.json   # 기존 pii-corpus.json 계층 확장
    recorded/              # tier2 — 마스킹된 형태로만 체크인
    tasks/                 # tier3 — 의미 품질 A/B/C 태스크셋
  tests/             # tier1은 평범한 `bun test`로 실행
```

**실제 구현과의 차이** (Tier 1만 만들었으므로):

| 계획 | 실제 |
|---|---|
| `src/runners/{tier1,tier2,tier3}` | `src/runners/tier1-mutation.ts` **만**. tier2·tier3 미구현 |
| `fixtures/recorded/`, `fixtures/tasks/` | 없음 (각각 tier2·tier3 전용) |
| corpus ~300건 | **59건**. 언어 2 × 표면형 5 × 카테고리 11 + 적대적 케이스는 덮었으나 밀도는 계획의 1/5 |
| — | 신규: `src/corpus/`(결정론적 마스킹), `src/report/`(표·상태 판정), `baseline.md`(커밋되는 기준선) |

corpus 59건은 **계획 미달**이다. 변이 클래스별 93 토큰 · 913 케이스는 나오지만,
카테고리 × 표면형 조합당 표본이 얇아 클래스 간 미세한 회귀는 놓칠 수 있다.

### 3-tier 분리

| Tier | 내용 | 비용 | 주기 |
|---|---|---|---|
| **1 — 변이 시뮬레이터** | 마스킹된 텍스트에 기계적 변형을 결정론적으로 적용. 복원기의 **견고성 한계선**을 측정 | $0, <30s, 네트워크 없음 | 모든 PR |
| **2 — 녹화 재생** | 실 사용에서 1회 캡처한 트랜스크립트를 **마스킹된 형태로만** 체크인 | $0 | 야간 cron |
| **3 — 실 LLM** | 프롬프트 50~100 × 3 arm × 2 모델 | ~$20 | `workflow_dispatch` + 포맷 변경 전 |

**Tier 3의 역할은 회귀 게이트가 아니다.** Tier 1의 가중치가 될 **변이 빈도 사전분포**와 의미 품질 수치를 생산한다.
역할 분담: Tier 1 = *변이 X를 견딜 수 있는가*, Tier 3 = *변이 X가 실제로 얼마나 자주 일어나는가*.

### 변이 카탈로그 (Tier 1) — 가중치는 Tier 3에서 도출

`1` 대소문자 뒤집기 · `2` 끝 `__` 탈락 · `3` 해시 1자 치환 · `4` 해시 1자 삽입/삭제(길이 변화) · `5` 마크다운 이스케이프 `\_\_OPF\_...` · `6` 백틱 감싸기 · `7` 모든 오프셋에서 delta 분할 · `8` JSON 문자열 이스케이프 · `9` Windows 경로 내부 삽입 · `10` 한국어 조사 교착(`…님이`, `…씨는`) · `11` 카테고리 개명(`PERSON`→`NAME`) · `12` 카테고리만 교체, 해시 유지 · `13` **살아 있는 토큰 2개의 해시 스왑(false-restoration 탐침)** · `14` 완전 창작 토큰(환각 탐침) · `15` 코드펜스 내부 · `16` 토큰 중복

**실측 결과** (`packages/eval/baseline.md`, 59 entry / 913 케이스 / 1457 identity probe):

- 복구 대상 12개 클래스(1–10, 15, 16) **전부 100%**
- 탐침 4개 클래스(11–14) 전부 정상 **보류** — 카테고리가 변형된 토큰과 창작 토큰은 복원하지 않는다
- **`false_restoration_rate = 0`** (하드 불변식 I1)
- 계획 시점에 "완전 손실"로 적었던 클래스 4·5는 **복구 전용 후보 스캔**(§7 L4)으로 0% → 100%

### corpus 설계 — 새로 만들지 말고 확장

기존 자산 재사용: `packages/core/tests/fixtures/pii-corpus.json`(11 카테고리, 49KB),
`tests/integration/fixtures/developer-corpus-sample.json`(코드/git/경로 + non-PII 음성),
`tests/integration/fixtures/korean-pii-corpus.json`.

목표 ~300건, 계층: 언어 {en, ko} × 표면형 {산문, 코드, 경로, JSON, 마크다운} × 카테고리(11)
+ 적대적 40건(근접 오탐 토큰, 실제 코드 속 `__OPF_` 유사 문자열, URL 내부 토큰).

### 디스크에 PII를 쓰지 않는 문제 — 이미 해결됨

기존 fixture는 명시적으로 합성 데이터다(성씨 + 한글 음절 조합, 체크섬 유효 더미).
**따라서 평문 대조 채점이 그대로 가능하다.** 다만 불변식으로 명문화한다:

> Tier 2 녹화본은 합성 corpus에서 생성해야 하며, **실사용 세션에서 캡처해서는 안 된다.**

CI 체크: fixture 파일에 선언된 합성 집합 밖의 고신뢰 탐지 패턴이 나오면 실패.

### CI

신규 `.github/workflows/eval.yml` — **Tier 1만 구현**. Tier 2(`schedule`)·Tier 3(`workflow_dispatch`)는 미구현.

- `tier1` job: 기존 `reusable-bun-checks.yml`에 `test-paths: "packages/eval/tests/"`로 `pull_request` 훅
- `baseline` job: 러너를 다시 돌려 `baseline.md`가 커밋본과 다르면 실패 — 기준선이 조용히 낡는 것을 막는다

> 구현 시 주의 2가지 (실측): `bun run --filter <pkg>`는 이 워크스페이스에서 **동작하지 않는다**
> (기존 proxy 패키지에도 실패) → 전부 `working-directory`로 지정한다.
> 그리고 baseline 재생성 단계에 `|| true`를 붙이면 러너가 죽어도 파일이 안 바뀌어 drift 검사가 통과 —
> **이 게이트가 막으려던 단 하나의 결과인 거짓 green**이 나온다.

---

## 6. 의미 품질 측정 (P2)

A/B/C 짝지음이 맞다. 비용을 감당 가능하게 만드는 결정은
**태스크셋의 70% 이상을 판정 모델 없이 채점 가능한 형태로 설계**하는 것이다.

**태스크셋: 40~60건, 개발자 도메인, 기계 채점 가능한 정답**
- *엔티티 추적* — "3명 중 010-으로 시작하는 번호의 소유자는?" → 엔티티 핸들
- *계수* — "이 로그에 서로 다른 사용자 몇 명?" → 정수
- *속성 결합* — "각 사람의 이메일 도메인을 JSON으로" → 구조 비교
- *코드 태스크* — 마스킹된 이메일이 포함된 스니펫의 버그 수정 → diff 검사
- *다단 참조* — "김철수의 상사의 연락처는?" → 엔티티 핸들

**판정 계층 — 강제될 때만 상승**
1. **정확/구조 일치** (목표 ≥70%). 무료, 결정론적.
2. **엔티티 일관성 검사** — 모델 없이 프로그램으로. 답변 복원 후
   (a) 언급된 모든 엔티티가 입력에 존재했는가 (b) 속성이 교차 배정되지 않았는가.
   vault를 가지고 있으므로 완전 계산 가능하며, **"PERSON 토큰 두 개를 혼동" 실패를 직접 측정**한다.
3. **LLM-as-judge** — 남은 자유형 태스크에만.

**판정 모델에 PII가 가는 문제는 성립하지 않는다** (corpus가 합성이므로). 계획서에 명시해 재논쟁을 막는다.

**지표와 임계값**
- `semantic_delta(arm) = accuracy(arm) − accuracy(unmasked)`, 태스크 계열별로 보고.
- **게이트: token 모드 `semantic_delta ≥ −5pp` (구조형 태스크) AND 엔티티 스왑률 = 0.**
- **에스컬레이션 트리거: *엔티티 추적* 계열에서 token 모드가 `−10pp`보다 나쁘면**
  → 카테고리 스코프 synthetic 모드(§7 L6) 도입의 근거로 삼는다.
- **모델 2종**(강 1 + 소형 1)에서 실행. masking tax는 모델 능력에 강하게 의존하며 소형 모델이 훨씬 크게 다친다.
  50 × 3 arm × 3 seed × 2 모델 ≈ 900 호출, $20 미만.

---

## 7. 개선 레버 — impact/effort 순위

**구현 현황**: ✅ L0 · L1 · L2 · L3 · L4 · L7 — ❌ L5(vault 영속화, `dead_token_rate` 실측 후 결정)
· ❌ L6(카테고리 스코프 모드, Phase D의 `semantic_delta` 필요) · ❌ L8(지표로만, 자동 복원은 영구 보류 권고)

| # | 레버 | 파일 | 깨지는 것 | 움직이는 지표 | 노력 |
|---|---|---|---|---|---|
| **L0** | **하드코딩된 `{16}` 정규식 리터럴 3곳을 `TOKEN_HASH_LENGTH`로 통일**, 공용 스캔 정규식을 `token/format.ts`에서 단일 export, `tests/fixtures/regex-parity.json` 확장 | `opencode-plugin/src/hooks.ts`(dead-token 중화 regex) · `core/src/detector/secret-scanner.ts`(OPF 제외 regex) | 없음 | 무증상 desync 사고 예방 · **모든 포맷 변경을 언블록** | S |
| **L1** | **측정 기반 정상화**: 3개 SSE 변환기에 `request_id` 전파, `path_skip_count`·`lenient_restored_count`·`minted_count`·`text_length`·`masked_char_count` 발행, 전송 경로 간 조기 반환 조건 정렬 | `audit/types.ts` · `pii-remover.ts` · `restorer/index.ts` · `proxy/src/stream/*-sse.ts` | 없음(가산적) | **모든 온라인 지표를 유효하게 만듦** | S |
| **L2** | **epoch 접두 해시**(16자 내부 3자) + 복원기 분류 | `redaction/token-hash.ts` · `restorer/index.ts` · `vault/schema.ts`(v3) | 살아 있는 토큰 전부(어차피 프로세스 수명) | `hallucination_rate` vs `dead_token_rate` 분리 | S |
| **L3** | **`OPF_PLACEHOLDER_SYSTEM_NOTE`를 proxy 3개 provider로 이식** + 첫 테스트 추가. 상수를 core(`policy/system-note.ts`)로 올려 4개 호스트가 같은 문자열을 보냄 | `core/src/policy/system-note.ts` · `proxy/src/providers/{anthropic,openai,codex}.ts` · `opencode-plugin/src/hooks.ts` | 요청당 +~60 토큰. 프롬프트 캐시 prefix가 깨지지 않게 삽입 위치 고정 | `hallucination_rate`, `lenient_rate` — **가장 값싼 실질 개선** | S |
| **L4** | **vault 키셋 경계 복구**: 미스 시 **카테고리가 같고 edit-distance-1인 살아 있는 vault 키가 정확히 1개일 때만** 수용. ≥2개면 fail closed. 복구를 epoch 비교보다 먼저 시도(epoch은 해시 앞 3자라, 먼저 게이트로 쓰면 거기 떨어진 손상 ~1/5을 버림). 길이 변형·마크다운 이스케이프는 **복구 전용 후보 스캔**(`TOKEN_REPAIR_PATTERN`)으로만 보이게 하고, 일반 매처는 그대로 둠 | `token/format.ts` · `restorer/scan.ts` · `restorer/repair.ts` · `restorer/index.ts` | 미스가 있는 restore 호출당 vault 키셋 1회 순회 | **실측: 변이 클래스 3·4·5 모두 0% → 100%** | S |
| **L5** | **opt-in vault 영속화** (토큰 키로 암호화, TTL 24h, `0600`, 기본 off) | 신규 `vault/store.ts` · `vault/manager.ts` · `config/schema.ts` | 신규 온디스크 PII 자산 — opt-in + 문서화 필수 | `dead_token_rate` → ~0 | M |
| **L6** | **카테고리 스코프 복원 모드**: `secret`·`rrn`·`card`·`account_number` → token / `private_person`·`private_address`·`private_date` → synthetic | `config/schema.ts`(`mode` → `mode_by_category`) · `pii-remover.ts` | **synthetic 카테고리의 런타임 관측성 상실(B5)** | `semantic_delta` | M |
| **L7** | **`[UNRESTORABLE]` UX 개선**: 원인 인지형 — `[UNRESTORABLE:PERSON/expired]` vs `/unknown` | `opencode-plugin/src/hooks.ts` (L2 의존) | 없음 | 사용자 체감 증상 품질 | S |
| **L8** | 표면형 역인덱스 (`철수` → `김철수`) | `vault/manager.ts` · `restorer/index.ts` | **이 목록에서 false-restoration 위험 최대** | `partial_reference_rate` | M |
| — | 해시 단축 (16→10) | `token-hash.ts` | 광범위 | **맹목 도입 금지.** Tier 3에서 길이 상관 손상이 확인될 때만 | — |
| — | 대소문자 정규화 | — | — | **이미 구현됨** — `scanTokens`가 `buildNormalized` 전에 해시 소문자화 / 카테고리 대문자화 | — |

**L8에 대한 권고: 만들어서 재되, 켜지는 마라.** 역인덱스를 구축해 `partial_reference_rate`를 **지표로만** 내보내고
자동 복원은 하지 않는다. `철수`는 다른 사람일 수도, 평범한 텍스트의 부분문자열일 수도 있다.
훗날 출시한다면 게이트: vault 엔트리 정확히 1개 일치 + 변형 ≥2음절 + `korean-heuristic` stopword 아님 + config opt-in.

---

## 8. 안전 불변식과 안티골

### 불변식 — 모든 변경이 6개 전부를 보존해야 함

- **I1 — false restoration 금지.** 토큰은 자기 vault 엔트리 외의 값으로 절대 해석되면 안 된다.
  복구는 후보 정확히 1개 **AND** 카테고리 일치를 요구하고, 모호하면 fail closed.
  A의 토큰 자리에 B의 이름을 복원하는 것은 **프라이버시 사고**이며, `[UNRESTORABLE]`을 남기는 것보다 범주적으로 나쁘다.
- **I2 — 감사 스트림에 PII도, 가명 식별자도 금지.** `sanitizeAuditEntry`(`audit/emitter.ts`)는 현재 `error`만 정화한다.
  신규 필드는 카운트 / 카테고리명 / 길이여야 한다.
  **환각 디버깅이 쉬워진다는 이유로 `unknown_tokens: string[]`을 추가하지 말 것** —
  토큰 해시는 실제 인물에 대한 안정적 가명 핸들이며, 그 JSONL은 연결(linkage) 위험이다.
- **I3 — 마스킹은 fail-closed.** `leak_rate` 자체 검사의 실패가 마스킹을 억제할 수 없도록 감싼다.
- **I4 — 평가 corpus는 합성 전용.** 실사용 트랜스크립트를 fixture로 녹화 금지. CI로 강제.
- **I5 — 복원은 비생성적.** 복원은 vault에 이미 있는 값의 치환만 허용. 모델 보조 "엔티티 추측" 금지.
- **I6 — 사용자가 친 글자는 고쳐 쓰지 않는다.** dead-token 중화(`[UNRESTORABLE:...]`)의 근거는
  "LLM이 못 쓰는 토큰을 새 tool call에 복사하는 것"을 막는 데 있으므로 **모델·도구가 만든 텍스트에만**
  적용된다. 사용자 메시지의 토큰 모양 문자열은 권위 있는 입력이다 — 실측 결과 이 구분이 없으면
  문서·테스트, 그리고 "이 `__OPF_` 토큰이 뭐냐"는 질문 자체가 모델에 닿기 전에 조용히 바뀐다.
  PII 마스킹은 이와 무관하게 사용자 메시지에도 그대로 적용된다.

### 적극적으로 해로운 접근

- **vault 키셋으로 경계 짓지 않은 퍼지 복원** — 환각 토큰을 *가장 가까운 실제 인물*로 매핑한다. 여기서 만들 수 있는 최악의 물건.
- **부분 표면형의 부분문자열 복원** — 무관한 텍스트에서 발화. I1 위반.
- **"환각 분석용"으로 unknown 토큰 해시를 로깅** — I2 위반.
- **`unknown_token_rate`를 낮추려고 `TOKEN_LENIENT_REGEX`를 넓히기** — 이미 충분히 느슨하다(대소문자 무시, 끝 `__` 선택).
  느슨해질 때마다 false-restoration 표면이 넓어진다. **분자(복구·프롬프팅)를 최적화하고 매처는 건드리지 않는다.**
- **현재의 per-delta 스트리밍 감사 스트림으로 무언가를 측정하기** — 부풀려진 카운트, 묶음 키 없음, plugin 경로와 분모 불일치.
- **측정 전에 synthetic 모드를 기본값으로 전환** — synthetic 모드엔 토큰이 없으므로 `unknown_token_rate`도 없고,
  따라서 **런타임 실패 신호가 없다.** 데이터 없이 관측성과 품질을 맞바꾸는 것이
  "잘 작동함"이 "조용히 망가짐"으로 바뀌는 정확한 경로다.
- **LLM 보조 토큰 복구** — 비결정론적이며 그럴듯하지만 틀린 토큰을 만들어낼 수 있다.

---

## 9. 단계 계획

### ✅ Phase A — 관측 가능하게 만들기 *(측정 전용, 동작 변경 0)*
L0 + L1.
**Exit**: 실사용 1일치 감사 JSONL에서 §3.1 온라인 지표 전부 산출 가능 ·
스트리밍 restore 이벤트가 `request_id`로 정확히 묶임 · plugin과 proxy 경로가 비교 가능한 분모 생산 ·
`bun test` + `bun run typecheck` green.
**결과**: 전부 충족. 단 "실사용 1일치 JSONL"은 **합성 검증만** 했다 — 실제 하루치 감사 로그로 지표를
뽑아본 적은 없다.

### ✅ Phase B — 오프라인 하네스 + 기준선 *(여전히 동작 변경 0)*
`packages/eval` 구축, 16종 변이 카탈로그, Tier-1 러너, CI 잡.
**Exit**: Tier 1이 CI에서 <30s · 변이 클래스별 `roundtrip_after_mutation_rate` 기준선 표 공개 ·
변이 13(해시 스왑) 전용 테스트로 `false_restoration_rate = 0` 단언.
**결과**: 전부 충족 (로컬 실행 ~70ms). corpus는 계획 300건 대비 **59건**(§5).

### ✅ Phase C — 판별과 복구
L2(epoch) + L4(vault 경계 복구) + L3(system note) + L7(UX).
**Exit**: unknown 토큰이 3버킷으로 분류되고 오분류 <1% · 변이 클래스 3·4가 ~0% → >90% 회복 ·
`false_restoration_rate` 여전히 정확히 0 · system note 유무 A/B에서 `hallucination_rate` 유의미 감소(Tier 3).
**결과**: 분류·복구·불변식 충족(클래스 3·4·5 모두 **100%**). 오분류율은 epoch 충돌 확률 1/46656로
설계상 <1%이나 **실측하지 않았다**. system note A/B는 **Tier 3가 없어 미검증** — L3는 배선만 되어 있고
효과는 측정되지 않았다. L5(vault 영속화)는 `dead_token_rate` 실측 전이라 착수하지 않았다.

### ❌ Phase D — 의미 품질과 모드 정책 *(미착수)*
Tier 3 하네스, 50 태스크 × 2 모델 A/B/C, 그 데이터로 L6 결정.
**Exit**: 태스크 계열별·arm별 `semantic_delta` 공개 · 카테고리 스코프 모드에 대한 데이터 근거 결정 문서화 ·
ROADMAP의 종합 Success Criteria 표에 신규 지표 반영.
**현황**: 하나도 착수 안 됨. **P2(masking tax)는 여전히 측정 수단이 없다.**

### 시간이 딱 하나뿐이라면 → **L1**

`packages/core/src/audit/types.ts`, `packages/core/src/pii-remover.ts`,
`packages/core/src/restorer/index.ts`, `packages/proxy/src/stream/{anthropic,openai,codex}-sse.ts`.

지금 스트리밍 경로는 SSE delta마다 묶음 키 없이 restore 감사 이벤트를 쏘고,
plugin 경로는 토큰이 있는 텍스트에만 쏜다. **오늘 측정한 값은 어느 방향으로 틀렸는지조차 알 수 없으며,**
이후의 모든 개선이 깨진 기준선 위에서 평가된다. 이 계획의 나머지 전부가 신뢰 가능한 분모의 하위 항목이다.

---

## 10. 참조 3건 — 채택 / 기각

| 출처 | 채택 | 기각 / 부적합 |
|---|---|---|
| **[PII-Shield](https://github.com/gregmos/PII-Shield)** | ① **매핑 영속화**(`~/.pii_shield/mappings/`) → L5의 선례. ② `get_mapping`이 **플레이스홀더 키 + 엔티티 타입만 반환, 실제 값 없음** → I2를 만족하는 introspection primitive 설계 그대로 차용 가능. ③ **Human-in-the-loop 리뷰**(FP 제거 / 누락 추가 후 재익명화) → 과탐 문제의 정답이며, `packages/mcp-server`에 이미 MCP 도구 표면이 있으므로 이식 경로가 있다. ④ `export_session` AES-GCM + scrypt → L5의 암호화 설계 참고 | `<PERSON_1>` 꺾쇠 포맷은 **채택 불가** — ADR-0002가 HTML/JSX 충돌로 이미 기각. 문서 단위 배치 처리 모델이라 **스트리밍 SSE 경로가 없다** → 본 프로젝트 P3의 절반은 다루지 않는다 |
| **[LangChain PIIMiddleware](https://wikidocs.net/318933)** | ① 전략 분류 `block / redact / mask / hash` → **복원이 필요 없는 카테고리를 비가역 처리하면 복원 실패의 모수 자체가 줄어든다.** 본 프로젝트엔 `hmac` 모드와 `type_overrides`가 이미 있으나 **카테고리별 적용이 안 된다** → L6의 스코프를 `token/synthetic` 2택이 아니라 `token/synthetic/hmac/redact` 4택으로 넓히는 근거. ② `apply_to_input / output / tool_results` 3지점 분리 → 본 프로젝트의 hook/proxy/tool 지점별 정책 분리 아이디어 | 탐지 커버리지(email·credit_card·ip·mac·url 5종)는 본 프로젝트(11종 + 한국 3종 + KLUE-NER)보다 **좁아 참고 가치 없음**. 가역 복원 개념이 없어 P1/P3/P4에 기여 0 |
| **[compliance-skills](https://github.com/gosprinto/compliance-skills)** | 없음 (직접 채택 항목 없음) | 복원 메커니즘과 무관한 **컴플라이언스 감사 스킬**. CCPA/HIPAA/PCI-DSS 카테고리 커버리지 체크리스트로만 참고 가치가 있고, 본 계획의 4개 문제 어디에도 기여하지 않는다 |

---

## 11. 결정 기록

착수 전 4건은 모두 결정되었다.

| # | 결정 사항 | 결론 |
|---|---|---|
| 1 | 착수 범위 | **A + B + C** 일괄 진행 |
| 2 | L2 파괴적 변경 수용 | **수용.** vault가 in-memory라 실질 피해 반경 1 세션. `SCHEMA_VERSION` → `v3` |
| 3 | L5(vault 영속화) | **보류.** `dead_token_rate` 실측 후 재검토 |
| 4 | Tier 3 예산·모델 | **미결.** Phase D 착수 시 필요 |

## 12. 다음에 결정할 것

1. **Tier 3 착수 여부** — P2(masking tax)는 이 계획에서 **유일하게 손대지 못한 문제**다.
   L3(system note)의 효과도, L6(카테고리 스코프 모드)의 근거도 전부 여기에 걸려 있다.
2. **corpus를 59 → 300건으로 채울지** — 현재 밀도로는 클래스 간 미세 회귀를 놓칠 수 있다(§5).
3. **B5(synthetic 모드 관측 불가)** — L6를 켜는 순간 그 카테고리는 런타임 실패 신호가 사라진다.
   L6 착수 전에 synthetic 값에 대한 관측 수단을 먼저 설계해야 한다.
4. **L5(vault 영속화)** — `dead_token_rate`를 실사용 로그로 한 번 재고 나서.
5. **실사용 감사 로그로 §3.1 지표를 실제로 뽑아보기** — Phase A는 합성 검증만 했다.
