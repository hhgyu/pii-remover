# ADR-0021: 토큰 epoch 접두 + vault 경계 복구

- **Status**: Accepted
- **Date**: 2026-08-10
- **Amends**: [ADR-0020](./0020-deterministic-hash-token.md) (토큰 형식 유지, 해시 내부 구조만 변경)
- **Related**: [ADR-0002](./0002-token-format-opf-underscore.md), [ADR-0003](./0003-vault-session-in-memory.md), [ADR-0004](./0004-local-llm-proxy-streaming.md), [QUALITY-MEASUREMENT-PLAN.md](../QUALITY-MEASUREMENT-PLAN.md)

## Context

ADR-0020이 토큰을 `__OPF_<CATEGORY>__<HASH>__`로 확정하고 HASH를 결정론적 HMAC으로 만들면서,
`resolveTokenKey()`가 키를 `~/.config/pii-remover/key`에 영속화한다. 즉 **같은 PII는 재시작 후에도 같은 토큰**이다.

그럼에도 복원 실패는 남아 있고, 복원기는 실패를 한 덩어리로만 본다. vault 미스는 전부 동일하게 취급된다:

- LLM이 만들어낸 적 없는 토큰 (환각)
- 이전 프로세스가 발행했으나 in-memory vault가 사라진 토큰 (ADR-0003의 구조적 귀결)
- LLM이 해시 한 글자를 바꿔 쓴 토큰

셋은 원인도 대응도 다르다. 환각은 프롬프트로 줄이고, dead token은 vault 수명으로 줄이고,
변형은 복구로 되살린다. **구분하지 못하면 어느 쪽을 고쳐야 하는지 알 수 없다** — 이것이
[측정 계획](../QUALITY-MEASUREMENT-PLAN.md) §1의 P1/P4 병목이다.

## Decision

### 1. epoch을 HASH 길이 **안에서** 잘라 쓴다

`tokenHash(key, category, text)`가 `tokenEpoch(key)(3자) + body(13자)`를 반환한다.
`tokenEpoch(key) = base36(HMAC(key, "opf-key-epoch-v1")).slice(0, 3)`.

**`TOKEN_HASH_LENGTH`는 16 그대로다.** 따라서:

| 영향 대상 | 변경 |
|---|---|
| `TOKEN_STRICT_REGEX` / `TOKEN_LENIENT_REGEX` | 없음 |
| `COMPLETE_TOKEN_AT_END_REGEX` / `UNSAFE_TOKEN_TAIL_REGEX` (SSE 경계) | 없음 |
| `DEFAULT_BUFFER_WINDOW = 64` | 없음 |
| 토큰 문자열 길이 | 없음 |
| 하위 소비자 (plugin dead-token sweep, secret-scanner 제외 regex) | 없음 |

epoch을 **덧붙이지 않고 잘라 쓴 것**이 이 ADR의 핵심이다. 덧붙였다면 위 6줄이 전부 바뀌고
SSE 버퍼 윈도우까지 재검토해야 했다.

**파라미터 근거**
- epoch 3자 = 36³ = 46,656. 서로 다른 두 키가 같은 epoch을 가질 확률 ≈ 1/46,656 — 이것이 dead token 오분류율.
- body 13자 ≈ 67비트. `MAX_ENTRIES_HARD = 100_000` 상한에서 생일 충돌 ≈ 1e-11.
  `VaultManager.assign()`은 어차피 충돌 시 fail-closed.

### 2. vault 미스를 3분류한다

키가 영속이므로 epoch은 재시작 후에도 안정적이다. 이 사실이 분류를 가능하게 한다:

```
vault 히트                          → 복원
미스 + 후보 정확히 1개               → 복구 후 복원
미스 + 후보 2개 이상                 → ambiguous (fail closed)
미스 + 후보 0개 + epoch 일치         → expired   (이 키가 발행했으나 vault에 없음 = 세션 재개)
미스 + 후보 0개 + epoch 불일치       → foreign   (이 키가 발행한 적 없음 = 환각, 또는 키 교체)
```

**복구를 epoch 비교보다 먼저 시도한다.** epoch은 16자 해시의 앞 3자를 차지하므로, epoch을 먼저 게이트로
쓰면 **거기에 떨어진 손상(단일 문자 손상의 약 1/5)을 전부 `foreign`으로 버리게 된다.** epoch은 분류
보조이지 안전 검사가 아니다 — 안전은 카테고리 일치 + 단일 후보 규칙에서 나온다.

> **ADR-0020 시점 가정의 정정**: 초안 단계에서는 "epoch 불일치 = dead token"으로 잡았다.
> 이는 키가 자주 바뀐다는 가정이었다. 실제로는 키가 영속이므로 **dead token의 지배적 원인은
> 키 변경이 아니라 vault 소멸**이다. 따라서 매핑은 위와 같이 뒤집힌다:
> epoch 일치 + 미스 = `expired`(dead), epoch 불일치 = `foreign`(환각).

`RestoreResult`에 `foreignCount` / `deadTokenCount` / `ambiguousCount`가 추가되고
`unknownTokenCount = foreignCount + deadTokenCount + ambiguousCount`가 불변식으로 성립한다.

**`foreign`은 사실이지 책임이 아니다.** "이 키가 발행하지 않았다"에는 모델의 창작뿐 아니라
도구·파일 내용, 사용자 입력, 다른 키로 발행된 토큰이 전부 들어온다. 그래서 카운터 이름을
`hallucinatedCount`가 아니라 `foreignCount`로 둔다. 책임 귀속은 출처를 아는 **호출 지점**이 하며,
`RestoreOptions.origin`(`model` | `tool` | `user`)에 따라 감사에 `hallucinated_count`(모델 저작) 또는
`unminted_token_count`(그 외)로 기록된다. 기본값은 `model`이라 빠뜨린 호출자가 면죄되지 않는다.
plugin에서 `tool.execute.after`(도구 결과)는 `tool`, 나머지 모델 저작 경로는 `model`이다.

### 3. 복구는 vault 키셋으로 경계 짓는다

관측된 해시가 vault에 없을 때, **살아 있는 vault 키 중 편집거리 1 이내인 것이 정확히 하나일 때만** 복원한다.
2개 이상이면 `ambiguous`로 fail closed.

- 후보 생성이 아니라 **vault 키셋 순회**로 판정한다 → 복구 결과는 항상 실제로 발행된 적 있는 토큰이다.
- **카테고리도 일치해야 한다.**
- `repair: false`로 끌 수 있다.

> **초안 정정 (Tier-1 하네스가 실측으로 반증)**: 이 ADR의 초안은 "해시가 `HMAC(key, category ‖ text)`이라
> 해시 → 엔트리가 단사이므로 카테고리는 비교하지 않아도 된다"고 적었다. `packages/eval` Tier-1이
> 그 결과를 측정했다 — 모델이 카테고리를 바꾸거나 맞바꾸면 해시-only 복구가 **다른 엔트리의 값을
> 돌려준다. 59-entry corpus에서 54건.** vault 키는 `카테고리 + 해시`이므로 "자기 엔트리"는 둘 다를 뜻한다.
> 카테고리가 변형된 토큰은 **보류하는 것이 I1이 요구하는 fail-closed 결과**다.
> 대가는 카테고리 변형 토큰(변이 클래스 11·12)의 복구 포기이며, 안전을 택했다.
> 정정 후 `false_restoration_rate` = 3.7% → **0**.

### 4. 복구 전용 후보 스캔 — 일반 매처는 건드리지 않는다

해시 길이가 바뀌거나(15/17자) 마크다운이 언더스코어를 이스케이프하면(`\_\_OPF\_...`)
strict/lenient 매처는 **토큰을 보지도 못한다**. 그렇다고 두 매처를 넓히면 false-restoration 표면이
같이 넓어진다(측정 계획 §8 금지 항목).

대신 `TOKEN_REPAIR_PATTERN`을 별도로 둔다 — 해시 길이 ±1 허용, 모든 언더스코어 앞 백슬래시 허용.
여기서 나온 매치는 `matchType: "repair"`로 표시되며 **그 자체로는 아무 권한이 없다**:

- 정규화 결과가 그대로 vault 키면 → 정확 조회로 복원 (마크다운 이스케이프가 이 경로)
- 아니면 → epoch·카테고리·단일 후보 검사를 거쳐야만 복구 (길이 변형이 이 경로)
- 해결 실패 시 → **한 바이트도 건드리지 않는다.** 토큰을 닮았을 뿐인 평범한 텍스트를
  `[UNRESTORABLE]`로 덮어쓰지 않기 위해 핸들러도 호출하지 않는다

### 5. 별도 체크섬은 도입하지 않는다

체크섬의 유일한 고유 가치는 퍼지 복구의 경계를 정하는 것인데, **vault 키셋이 더 정확하고 엄격한 경계**다.
체크섬은 길이만 먹고 엔트로피만 깎으며, vault가 없을 때만 유용한데 그 경우는 epoch이 이미 커버한다.

## Consequences

### 긍정적
- 환각률과 dead token률이 **분리 측정 가능**해진다. 어느 레버(프롬프트 vs vault 수명)를 당길지 데이터로 결정한다.
- 해시 손상(치환·삽입·삭제)과 마크다운 이스케이프가 복구된다.
  Tier-1 실측: **변이 클래스 3·4·5가 각각 0% → 100%**, 복구 가능한 12개 클래스 전부 100%,
  probe 4개 클래스 전부 정상 보류, `false_restoration_rate = 0`.
- **덤으로 잡힌 기존 버그**: Tier-1 하네스가 SSE 경계 버퍼의 off-by-one을 드러냈다.
  `buildUnsafePrefixGroup()`이 접두사 길이 1~5만 생성해 **정확히 `__OPF_`에서 끝나는 버퍼**를 붙잡지 못했고,
  `__OPF`를 안전하다고 방출해 토큰이 두 restore 호출로 쪼개져 사용자에게 raw로 도달했다.
  기존 21건 fuzz 테스트가 놓친 구간이다 (`packages/proxy/src/stream/buffer.ts`, 재현: 76개 split offset 중 2개).
- `[UNRESTORABLE]`이 `[UNRESTORABLE:PERSON/expired]`로 바뀌어 사용자가 원인을 본다.
- **적대적/우연한 사용자 입력 검증** (실측): 창작 토큰은 복원되지 않고 `foreign`으로 분류되며,
  산문 속 `__OPF_<CATEGORY>__<HASH>__`는 전 경로에서 무손상이고, 사용자가 decoy 토큰을 섞어도
  같은 메시지의 진짜 PII는 정상 마스킹된다(탐지 우회 불가). 다만 dead-token 중화가
  **사용자가 직접 친 토큰까지 덮어쓰던 문제**를 발견해, 중화를 모델·도구 저작 텍스트로 한정했다
  (측정 계획 §8 I6). 편집거리-1 복구는 공격면을 넓히지 않는다 — 변형을 만들려면 원본 토큰을 이미
  가지고 있어야 하고, 맨땅 추측은 여전히 36¹³이다.
- wire format 무변경 → 프록시/플러그인/스캐너 회귀 0.

### 부정적
- **기존에 살아 있던 토큰이 전부 무효화된다.** 다만 vault가 in-memory `Map`이라 프로세스 재시작 시
  어차피 소멸하므로 실질 피해 반경은 1 세션이다. `SCHEMA_VERSION`을 `opf.reversible.v3`로 올린다.
- 미스 경로에서 vault 키셋을 1회 순회한다 (미스가 있는 restore 호출당 1회, 미스마다가 아님).
- epoch 3자를 body에서 가져오므로 유효 엔트로피가 16자 → 13자로 줄어든다 (위 근거대로 무해).

### 위험 / 미해결
- **후보 스캔은 미스 경로를 넓힌다.** 토큰을 닮은 문자열(`__OPF_<CAT>__` + 15~17 base36)이
  평범한 텍스트에 있으면 관측 토큰으로 집계되어 `unknown_token_rate`를 미세하게 부풀린다.
  복원은 절대 일어나지 않으므로 안전에는 영향이 없고, 접두사·카테고리·길이를 모두 만족하는
  우연한 문자열은 실측 corpus(59 entry)에서 0건이었다.
- **완전한 두 유효 토큰을 LLM이 서로 맞바꾸면 복원기는 알 수 없다.** 두 해시 모두 vault에 실재하므로
  정확 조회가 성공한다. 이것은 복원 결함이 아니라 모델의 재라벨링이며 명시적 non-goal이다.
- epoch 충돌(1/46,656) 시 다른 키의 토큰이 `expired`로 오분류된다. 복원은 여전히 실패하므로
  안전에는 영향이 없고 지표만 미세하게 오염된다.

## Implementation Notes

- epoch/해시: `packages/core/src/redaction/token-hash.ts` (`tokenEpoch`, `TOKEN_EPOCH_LENGTH`)
- 분류/복구: `packages/core/src/restorer/repair.ts` (`resolveMiss`, `isWithinOneEdit`, `buildRepairIndex`)
- 복원 루프: `packages/core/src/restorer/index.ts`
- vault: `packages/core/src/vault/manager.ts` (`epoch()`, `tokens()`), `schema.ts` (v3)
- 호스트 표면: `packages/core/src/pii-remover.ts` (`tokenStatus`), `packages/opencode-plugin/src/hooks.ts`
- 테스트: `packages/core/tests/miss-classification.test.ts`

## References

- ADR-0020: 결정론적 해시 토큰 (본 ADR이 해시 내부 구조만 수정)
- ADR-0003: vault in-memory 불변식 — dead token의 구조적 원인
- [QUALITY-MEASUREMENT-PLAN.md](../QUALITY-MEASUREMENT-PLAN.md) §4 (판별), §7 L2/L4, §8 불변식 I1
