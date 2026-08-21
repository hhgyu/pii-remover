# ADR-0022: Markdown 중립 토큰 구분자 `{{OPF:<CATEGORY>:<HASH>}}`

- **Status**: Accepted
- **Date**: 2026-08-21
- **Supersedes**: [ADR-0020](./0020-deterministic-hash-token.md) — **표면 문법에 한정**. 해시 유도(HMAC + base36 절단)와 카테고리 매핑은 그대로 유효하다.
- **Related**: [ADR-0002](./0002-token-format-opf-underscore.md), [ADR-0004](./0004-local-llm-proxy-streaming.md), [ADR-0021](./0021-token-epoch-and-bounded-repair.md)

---

## Context

ADR-0020의 토큰은 `__OPF_<CATEGORY>__<HASH>__`였다. 이 문법에는 아무도 의도하지
않았던 성질이 있다 — **`__OPF_PERSON__`은 그 자체로 완결된 Markdown bold
스팬이다.** `__텍스트__`는 CommonMark의 강조 문법이고, 토큰의 prefix가 우연히 그
쌍을 온전히 품고 있었다.

자기 출력을 Markdown으로 취급하는 모델은 그 쌍을 **강조로 소비**했고, 카테고리와
해시 사이의 구분자가 사라진 채 토큰이 돌아왔다. 실측 로그의 9건이 전부 같은
패턴이었다:

```text
  __OPF_PERSON__50p56nfk4kk63k1o__   (발행)
  __OPF_PERSON50p56nfk4kk63k1o__     (관측)
    OPF_PERSON50p56nfk4kk63k1o__     (관측)
  __OPF_PERSON50p1cnf5uj9np46q       (관측)
```

**중간 `__`가 9건 전부에서 소실**되었고 해시 본체는 전부 무손상이었다. 산발적
오류가 아니라 렌더링된 보고서의 모든 토큰에서 결정론적으로 발생했다.

`TOKEN_REPAIR_PATTERN`은 이를 하나도 보지 못했다. 후행 suffix만 optional로 두고
**정작 항상 사라지는 중간 `__`는 필수**로 요구했기 때문이다.

밑줄은 두 번째 비용도 강요했다. Markdown 렌더러가 토큰을 `\_\_OPF\_…`로
이스케이프하므로, 문법 자체가 `escapableLiteral()`이라는 백슬래시 허용 로직을
매처마다 끌고 다녀야 했다. 기존 설계는 **원인을 남겨둔 채 사후 복구로 방어**하는
형태였다.

## Decision

```text
{{OPF:<CATEGORY>:<HASH>}}
```

- `{`, `}`는 CommonMark의 **어떤 구문도 claim하지 않는다.** Markdown 왕복에서
  원형이 보존되고, 이스케이프 방어가 통째로 불필요해진다.
- `:`는 인라인에서 무해하며 카테고리 charset(`[A-Z][A-Z0-9_]*`)에 포함되지
  않으므로 구분자가 모호하지 않다. ADR-0020에서 `BIZ_NUM`이 밑줄 구분자를 삼키는
  것을 막으려 쓰던 lazy `*?`가 greedy로 단순화된다.
- `{{…}}`는 모델이 **불투명 템플릿 placeholder**로 대량 학습한 형태다.

해시는 ADR-0020 그대로 `HMAC(key, category ‖ canonicalText)`의 base36 절단이며 앞
`TOKEN_EPOCH_LENGTH`자는 ADR-0021의 epoch이다. **이 ADR은 구분자만 바꾼다.**

## Consequences

**얻는 것**

- Markdown bold 충돌 제거 — 관측된 손상 클래스 전체가 사라진다.
- `escapableLiteral()` 및 백슬래시 허용 매칭 로직 삭제.
- `MAX_TOKEN_LENGTH` 33 → 32.

**잃는 것 / 주의**

- **식별자 안전성 포기.** ADR-0002가 밑줄 문법을 고른 이유 중 하나가 "토큰이
  그대로 유효한 식별자"라는 점이었다. 의도된 트레이드오프다 — 식별자 안전성은
  있으면 좋은 성질이었고, Markdown 안전성은 **실제로 관측된 실패 모드**다.
- **`TOKEN_PREFIX`가 정규식 특수문자 `{`를 포함한다.** `new RegExp(TOKEN_PREFIX)`는
  리터럴이 아니라 **수량자**를 만든다. 이스케이프본 `TOKEN_PREFIX_PATTERN`을
  export하며 프로브 용도는 반드시 이쪽을 써야 한다.
- **기존 vault 토큰은 복원 불가.** vault는 ADR-0003에 따라 in-memory이므로
  마이그레이션 경로는 불필요하다. 이전 포맷 토큰이 남은 히스토리는
  `[UNRESTORABLE]`로 중화된다.
- **golden vector 전량 재생성** 필요(`bun run gen-vectors`).

### 전환 중 실제로 밟은 지뢰 두 개

문법 상수를 바꾸는 것만으로는 부족했다. 아래 두 곳은 상수에서 유도되지 않고
`__`를 **하드코딩**하고 있어, 놓쳤다면 조용히 PII를 흘렸을 것이다:

1. `proxy/src/stream/buffer.ts`와 `backend/server/pii/stream_buffer.py`의
   `COMPLETE_TOKEN_AT_END` / `UNSAFE_TOKEN_TAIL` 패턴. SSE 델타 경계에서 분할된
   토큰을 재조립하는 핵심이며, 옛 구분자를 그대로 갖고 있었다.
2. `stream_buffer.py`의 fast-path `if "_" not in tail: return len(buffer)`.
   "모든 대안이 밑줄로 시작한다"는 전제의 최적화라, 접두사가 `{`로 바뀌자
   **부분 토큰을 raw로 방출**했다. 이제 `TOKEN_PREFIX[0]`에서 유도한다.

lenient 매처의 후행 `(?![A-Za-z0-9_])` 가드도 필수다. 없으면 한 글자 늘어난 해시가
앞 16자만 매치되어 **다른 vault 엔트리로 오복원**된다.

## Alternatives considered

| 대안 | 기각 이유 |
|---|---|
| `__` 유지 + 이스케이프 방어 강화 | 이미 그 구조였고 실패했다. 렌더러의 **이스케이프**는 막았지만 **소비**는 막지 못한다 |
| `⟦OPF:PERSON:hash⟧` | 비ASCII. 토크나이저 분해가 예측 불가하고 TS/Python 포트 간 문자 취급 차이 위험 |
| `[[OPF:PERSON:hash]]` | 일부 렌더러가 wiki-link로 claim. `[`는 CommonMark 링크 구문의 시작이기도 하다 |
| `<OPF:PERSON:hash>` | `<…>`는 CommonMark autolink / raw HTML 후보 |
| `PERSON_1` 같은 짧은 surrogate ID | 결정론 파괴(같은 사람이 요청마다 다른 ID). 더 심각하게는 모델이 배정된 적 없는 ID를 **지어낼 수 있어** false-restoration 표면이 급격히 넓어진다 |
| Structured Output으로 ID를 enum 강제 | 본 시스템은 `ANTHROPIC_BASE_URL`을 가로채는 **투명 프록시**다. 통과 트래픽의 프롬프트나 스키마를 프록시가 정할 수 없어 적용 불가 |
