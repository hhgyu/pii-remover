# ADR-0023: 재생 불가 thinking 블록 처리 — 빈 블록 우회 + 미스 시 드롭

- **Status**: Accepted
- **Date**: 2026-09-07
- **Related**: [ADR-0003](./0003-vault-session-in-memory.md) — vault는 인메모리로 유지되며 이 ADR은 그 결정을 건드리지 않는다. [ADR-0004](./0004-local-llm-proxy-streaming.md), [ADR-0020](./0020-deterministic-hash-token.md), [ADR-0021](./0021-token-epoch-and-bounded-repair.md)

---

## Context

Anthropic은 재생된 `thinking` 블록을 불투명한 `signature`로 검증하고, 바이트가
다르면 요청을 거부한다. 프록시는 사용자가 자기 PII를 읽을 수 있도록 **복원된**
thinking을 클라이언트에 건네므로, 클라이언트가 되돌려주는 바이트는 서명된 바이트가
아니다. 그래서 [`ThinkingCache`](../../packages/backend/server/pii/thinking_cache.py)가
업스트림 바이트를 서명으로 키잉해 기억했다가 되돌려 넣는다.

### 관측된 장애

89개 메시지를 쌓은 세션(`ses_f986a82d2ffel25VqKM2mRhLmB`)이 영구 사망했다. 모든
시각은 UTC다.

```
09-03 09:21:49   백엔드 컨테이너 Created
09-03 09:23      컨테이너 내 ~/.config/pii-remover/key 생성
09-03 17:06:38   마지막 정상 메시지
      ── 56.8h 유휴 ──
09-06 01:53:50   재개 성공          ← 2.4일 유휴를 살아남음
09-06 01:55:05   정상
      ── 31.7h 유휴 ──
09-07 09:35:35   400 thinking_replay_unavailable
09-07 09:36:09   컨테이너 StartedAt   ← 34초 후
09-07 09:36:42   400 다시 실패        ← 기동 33초 후
```

### 원인 확정

세 후보 중 둘이 반증되고 하나가 증명됐다.

**상류 서명 만료 — 반증.** 이 오류는 프록시 자신의 로컬 거부이므로 요청이 Anthropic에
도달조차 하지 않았다. 게다가 **56.8시간은 성공하고 31.7시간은 실패**했다. 나이 기반
만료라면 더 긴 쪽이 먼저 죽어야 하므로 단조성이 깨진다.

**용량 축출 — 반증.** 09-06 01:55 이후 성공한 턴이 없어 새 `set()` 호출이 없었고,
따라서 축출 압력이 발생할 수 없다.

**프로세스 재기동 — 확정.** 실패는 경과 시간이 아니라 사건에 반응했고, 마지막 실패는
컨테이너 기동 **33초 후**다. 세션 풀은 `app.state`에 있어 프로세스와 함께 사라진다.

### 그런데 캐시된 값은 빈 문자열이었다

라이브 API 실측(`claude-sonnet-5`, `thinking: {type: "adaptive"}`):

| 프롬프트 | thinking 토큰 | `thinking` 길이 | `signature` 길이 |
|---|---|---|---|
| 간단한 곱셈 | 소량 | **0** | 416 |
| 어려운 논리 퍼즐 | 4000 | **0** | 14,020 |
| 동일 + `effort: high` | 4000 | **0** | 14,272 |

추론 토큰을 4000개 태워도 본문은 0바이트이고 추론은 전부 서명 안에 들어간다. 즉 이
모델에서 캐시가 담는 값은 **빈 문자열**이며, 캐시 히트는
`{**block, "thinking": ""}` — 입력과 바이트가 동일한 **no-op**이다.

**89메시지 세션은 빈 문자열을 기억하지 못해서 죽었다.**

### 상류가 실제로 요구하는 것

Anthropic 문서: *"Manual mode adds one requirement: the final assistant turn of a
thinking-enabled request must begin with a thinking block (**adaptive thinking
drops that requirement**)."*

"assistant 턴을 통째로 echo해야 한다"는 요구는 문서에 없다. 로컬 프록시를 거친 실측
3단계가 이를 확인했다.

| 단계 | 요청 | 결과 |
|---|---|---|
| 1 | 초기 요청 | 200 — `["thinking","text"]` |
| 2 | assistant 턴 전체 echo | 200 |
| 3 | **thinking 블록 제거 후 전송** | **200** |

코드 주석의 *"requires the assistant turn to be echoed back whole — a request that
quietly omits one block is answered with a 400"*은 **반증됐고 정정됐다.**

### 캐시가 필요한 진짜 이유

기존 주석은 *"토큰 해시가 vault 엔트리마다 새로 민팅/salt된다"*고 적고 있었으나,
ADR-0020 이후 `tokenHash`는 `(category, canonical_text)`에 대한 결정적 HMAC이며
per-entry salt가 없다. **이 서술은 거짓이었고 정정됐다.**

캐시가 필요한 실제 이유는 **검출기 비결정성**이다. 복원된 텍스트를 다시 마스킹해
서명 바이트를 재구성하려면 검출기가 동일한 span을 다시 잡아야 하는데, 검출은 모델이고
한 span만 놓쳐도 평문 PII가 와이어에 오른다.

## Decision

### 1. `thinking`이 빈 블록은 캐시를 조회하지 않는다

`restore`는 토큰을 원문으로 치환할 뿐 문자열을 비우지 않는다. 따라서 **복원값이
`""`이면 원본도 `""`**이고, 유출할 평문도 되돌릴 바이트도 없다. 조회는 no-op이며
미스는 세션을 이유 없이 죽인다.

### 2. 해석 불가 블록은 상류가 허용하는 곳에서 드롭한다

`replay_thinking(..., allow_drop=True)`이면 해당 블록만 제거하고 턴을 살린다.
`thinking_drop_allowed()`가 **`thinking.type == "adaptive"`일 때만** 참을 반환한다 —
실측으로 검증한 범위가 거기까지다. manual mode는 최종 assistant 턴이 thinking 블록으로
시작해야 하므로 종전 거부를 유지한다.

### 3. 해석 불가 블록을 forward하는 일은 없다

드롭은 **거부를 대체하는 것이지 유출 방지를 대체하지 않는다.** 본문이 있는 블록이
미스이면 그 블록은 제거되거나 요청이 거부되며, 복원된 평문이 업스트림으로 가는 경로는
어느 쪽에서도 열리지 않는다.

### 4. Vault는 인메모리로 유지한다

ADR-0003은 무변경이다. 평문 PII는 계속 메모리에만 존재한다.

### 5. 캐시 영속화는 채택하지 않는다

아래 Alternatives 참조. 관측된 장애는 Decision 1이 완전히 제거하며, 영속화는 존재하지
않는 페이로드(빈 문자열)를 지키기 위해 at-rest 공격면과 신규 의존성을 새로 만든다.

## Consequences

### 긍정적

- **관측된 장애 클래스 제거.** adaptive 모델의 모든 블록이 빈 본문이므로 재기동·회전·
  손상 어느 원인으로도 세션이 죽지 않는다.
- **디스크 산출물 0.** 암호화, retention, GC, 삭제 CLI, 볼륨 마운트가 전부 불필요하다.
- **신규 의존성 0.** `token_hash.py`가 명시적으로 회피한 암호 라이브러리를 들이지 않는다.
- **유출 방지 불변식 보존.** 본문 있는 미스는 여전히 forward되지 않는다.
- **거짓 서술 3건 제거.** 코드 주석이 상류 동작과 자기 토큰 설계를 잘못 기술하고 있었다.

### 부정적

- **드롭은 추론 맥락을 잃는다.** 본문 있는 블록이 미스면 모델은 그 턴의 과거 추론 없이
  진행한다. 세션 사망보다는 낫지만 무손실은 아니다.
- **manual mode는 여전히 거부된다.** 실측 범위를 벗어나므로 보수적으로 남겼다.
- **`thinking.type` 판별은 요청 본문에 의존한다.** 상류가 이 필드의 의미를 바꾸면
  드롭 허용 범위가 조용히 어긋난다.

### 위험 / 미해결

- **manual mode의 드롭 가능성은 미검증.** 최종 assistant 턴이 아닌 앞선 턴의 thinking을
  드롭하는 것이 manual mode에서도 허용되는지는 확인하지 않았다. 검증되면 Decision 2의
  조건을 넓힐 수 있다.
- **본문 있는 thinking을 반환하는 모델.** 그런 모델에서는 캐시가 실제 값을 담고 미스가
  실제 손실이 된다. 영속화는 그 조건이 성립할 때 다시 검토할 대상이다.
- **상류 서명 유효기간은 문서화되어 있지 않다.** 이번 장애의 원인은 아니지만(로컬
  거부였다), 서버측 만료가 존재한다면 Decision 2의 드롭이 그 경우의 완화책이 된다.

## Alternatives considered

### 캐시를 머신 스코프로 암호화 영속화 (이 ADR의 최초 초안)

**기각.** Oracle·Momus 두 리뷰가 blocking 13건, should-fix 23건, 구현자가 추측해야 할
항목 37건을 냈고, 그중 다수가 설계의 근간을 건드렸다 — AAD 미바인딩으로 세션 격리
불변식 미달성, flush-on-dispose가 크래시를 못 견딤, 키 파생 서술이 문서 내에서 모순,
`env`/`ephemeral` 키 소스 미정의, 고아 epoch 디렉터리 미회수.

그러나 결정적인 것은 findings 개수가 아니다. **adaptive 모델에서 캐시가 담는 값은 빈
문자열이므로 영속화가 지킬 대상이 존재하지 않는다.** 암호화 논의 전체가 존재하지 않는
페이로드를 방어하고 있었다.

### thinking을 클라이언트에 복원하지 않기 (캐시 자체를 끄기)

**기각.** `cache=None` 경로로 이미 구현되어 있고 실패 클래스를 구조적으로 제거하지만,
이는 고장난 기능을 **제거**하는 것이지 고치는 것이 아니다. 사용자는 reasoning 패널에서
자기 PII 대신 토큰을 보게 된다. 영속화가 불가능한 환경의 축퇴 모드로는 여전히 유효하다.

### 미스 시 복원된 텍스트를 재마스킹해 서명 바이트를 복구

**기각.** ADR-0020의 결정적 토큰 덕분에 원리적으로는 가능하나, 검출기가 두 번째 패스에서
같은 span을 놓치면 평문이 와이어에 오른다. 실패 모드가 조용하고 결과가 PII 유출이라
받아들일 수 없다.

### 인메모리 상한 확대

**기각.** 원인이 용량이 아니다. `get()`의 재삽입 때문에 재생되는 블록은 축출되지 않으며,
관측된 사례에서는 그 구간에 `set()` 호출 자체가 없었다.

## Implementation Notes

**변경 파일**

- `packages/backend/server/pii/thinking_replay.py` — 빈 블록 우회, `allow_drop`,
  `thinking_drop_allowed`, 모듈 docstring 정정
- `packages/backend/server/pii/pipeline.py` — `allow_drop` 배선
- `packages/backend/server/pii/thinking_cache.py` — docstring 정정
- `packages/proxy/src/providers/thinking-replay.ts` — 동일 변경 (parity)
- `packages/proxy/src/stream/thinking-cache.ts` — docstring 정정

**테스트**

| 대상 | 위치 |
|---|---|
| 빈 블록이 미스에서 살아남음 | `test_thinking_replay.py`, `thinking-restore.test.ts` |
| 드롭 허용은 adaptive 한정 | 양쪽 |
| 드롭 시 나머지 블록 생존 | 양쪽 |
| 드롭해도 평문 미유출 | `test_thinking_replay.py` |
| **재기동 + 빈 블록 → 200** (사건 회귀) | `test_thinking_proxy.py` |
| **재기동 + adaptive → 드롭 후 200** | `test_thinking_proxy.py` |

`bun test` 1177 pass / 0 fail, `pytest` 1572 passed.

## References

- [`thinking_replay.py`](../../packages/backend/server/pii/thinking_replay.py) — `THINKING_REPLAY_REJECTION`, `thinking_drop_allowed`
- [`thinking_cache.py`](../../packages/backend/server/pii/thinking_cache.py) — 상한과 불변식
- [`token_hash.py`](../../packages/backend/server/pii/token_hash.py) — `resolve_token_key`, 결정적 토큰 해시
- ADR-0003 §Decision 1 — vault 디스크 영속 금지 (`schema_version: "opf.reversible.v1"`)
- [Anthropic — Extended thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking) — manual mode의 최종 턴 요구와 adaptive의 예외
