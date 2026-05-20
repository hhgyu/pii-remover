# ADR-0019: Backend auto-start (opt-in) + idle model unload (default-on)

- **Status**: Accepted
- **Date**: 2026-05-20
- **Related**: [ADR-0006 fail-closed default](./0006-fail-closed-default.md), [ADR-0008 self-built Docker](./0008-detection-backend-self-built-docker.md)

---

## Context

Phase 1~7 까지의 백엔드 운영 모델은 다음을 가정한다:

1. 사용자가 직접 `docker compose up --build` 로 백엔드를 띄운다.
2. 일단 띄우면 `restart: unless-stopped` 로 무한히 떠 있고 모델 weights는 항상 메모리에 상주한다.

이 가정에서 발견된 두 가지 운영 문제:

### 문제 1: "왜 안 돼?" — 백엔드 미기동 시 silent failure

OpenCode/Claude Code/Codex 가 시작될 때 백엔드가 꺼져 있어도 hook 은 그대로 진행한다. `failure_policy: closed` 가 잡지만 사용자는 매번 별도로 `docker compose up` 을 기억해야 한다. 운영 마찰이 크다.

### 문제 2: 유휴 메모리 점유 — OPF + KLUE NER 합계 1~3 GB

ONNX 모델 weights 가 컨테이너 RAM 에 항상 상주한다. 개인 PC 에서 하루 한두 번 쓰는 워크로드인데 1~3 GB 가 24시간 점유되는 비대칭. 사용자가 "30분 이상 안 쓰면 모델 좀 내려놨다 다시 띄우면 안 되나" 요청.

### 추가 고려사항

- **컨테이너 자체를 끄는 것 vs 모델만 내리는 것**: 컨테이너 stop → 다음 요청 시 5~10초 cold start. 모델 unload → 1~3초 lazy reload. 후자가 UX 우월.
- **Docker spawn 의 보안 위험**: 사용자 머신에 임의로 `docker compose up -d` 를 호출하는 건 큰 부작용. 환경마다 결과가 다르다 (Docker 미설치 / 데몬 꺼짐 / 권한 부족 / WSL2 통합 미설정 등).
- **fail-closed 정책과의 일관성**: ADR-0006 의 "보안에 영향 주는 동작은 명시적으로" 원칙. 자동 spawn 같이 사이드이펙트 큰 동작은 opt-in 이어야 한다.
- **`/health` 가 idle 추적을 오염시키지 않을 것**: Docker `HEALTHCHECK` 가 30초 간격으로 `/health` 를 때리므로 health 가 활동으로 카운트되면 모델은 영원히 안 내려간다.

---

## Decision

### 1. **Backend auto-start: opt-in, fail-closed**

`backend.auto_start: true` 일 때만 활성. 기본 `false`. 활성화되면:

1. 플러그인 init 시 `<endpoint>/health` 를 짧은 timeout 으로 probe → 이미 healthy 면 spawn 생략 후 종료
2. 아니면 `docker compose -f <resolved-path> up -d` 를 spawn
3. spawn 실패 (Docker 미설치/데몬 꺼짐/compose 파일 missing/exit code !=0) → **`FailClosedError` throw**
4. spawn 성공 시 `start_timeout_ms` 동안 1초 간격으로 `/health` 폴링
5. `model_loaded: true` 응답을 얻으면 정상 진행, 아니면 `FailClosedError` throw

**compose_file** 셀렉터:
- `"cpu"` (default) → `packages/backend/docker-compose.yml` 자동 탐색
- `"gpu"` → `packages/backend/docker-compose.gpu.yml`
- 절대경로 → 그 경로 직접 사용

탐색은 module 의 `import.meta.url` 부터 상위 8단계까지 walk-up. monorepo 외부에서 npm 설치된 경우 자동 탐색은 실패하고 사용자가 `compose_file` 로 절대경로 명시해야 한다.

### 2. **Idle model unload: default-on (30분)**

백엔드 측에서 처리한다 (Docker stop 이 아니라 모델 weights 만 메모리 해제).

- 신규 환경변수:
  - `OPF_IDLE_TIMEOUT_SECONDS` (default `1800`, 즉 30분). `0` 으로 비활성.
  - `OPF_IDLE_CHECK_INTERVAL_SECONDS` (default `60`).
- `OpfRunner.unload()` / `KoreanNerRunner.unload()` 신규 — `_session = None`, GC 가 회수.
- FastAPI lifespan 에서 background task (`_idle_unload_monitor`) 가 polling.
- 미들웨어 `_track_redact_activity` 가 `/redact*` 응답 시 `app.state.last_request_at = time.monotonic()`.
- **`/health` 는 활동으로 카운트하지 않는다** — Docker healthcheck 가 idle 타이머를 영원히 깨우는 문제 방지.
- 다음 `/redact` 요청 시 기존 lazy load 경로 (`detect() → load()`) 가 자동 reload.
- `/health` 응답에 신규 필드:
  - `idle_unloaded: bool` — 현재 unload 상태인지
  - `idle_timeout_seconds: int` — 현재 설정값
  - `seconds_since_last_request: float | null` — 마지막 `/redact` 이후 경과

### 3. 양쪽 동작은 직교 (orthogonal)

| auto_start | idle_timeout | 동작 |
|---|---|---|
| `false` | `>0` | 사용자가 직접 띄우고, 30분 idle 시 모델만 unload, 다음 요청 시 lazy reload |
| `false` | `0` | 사용자가 직접 띄우고 모델 영구 상주 (기존 v1.x 동작) |
| `true` | `>0` | 플러그인이 spawn + 모델은 idle 시 unload (개인 PC 권장) |
| `true` | `0` | 플러그인이 spawn + 모델 영구 상주 (CI / dedicated host) |

---

## Consequences

### 보안

- auto-start 의 모든 실패 경로가 `FailClosedError` 로 propagate → ADR-0006 정책과 일관. 사용자가 명시적으로 켜야만 docker spawn 발생.
- idle unload 는 fail-closed 영향 없음 (다음 요청 시 lazy reload, reload 실패는 기존 detect() 에러 경로와 동일).
- compose 파일 경로는 string-array 인자로 spawn (shell=false). injection 위험 없음.

### 운영

- 개인 PC: 메모리 회수로 1~3 GB 절약. cold reload 1~3초 첫 요청에만.
- CI / dedicated host: `OPF_IDLE_TIMEOUT_SECONDS=0` 으로 비활성하면 기존 동작.
- Docker HEALTHCHECK 가 idle 타이머를 깨우지 않으므로 idle unload 는 의도대로 동작.

### 사용자 영향

- **변경 없음** (기본값 유지 시):
  - `backend.auto_start` 미설정 → spawn 안 함
  - `OPF_IDLE_TIMEOUT_SECONDS` 미설정 → 30분 default (사용자가 명시적으로 의도하지 않은 동작 변경)
- 영구 상주를 원하면 `OPF_IDLE_TIMEOUT_SECONDS=0` 으로 명시. README 에 명시.

### 호환성

- `BackendConfig` 의 3개 필드는 모두 optional. 기존 config 파일 호환.
- `HealthResponse` 의 3개 신규 필드는 모두 default 값 있음. 기존 클라이언트 (Pydantic / TS) 호환.

---

## Alternatives Considered

### A. auto-start 를 default-on
- 거부. ADR-0006 원칙 위반. Docker 가 없는 환경에서 첫 마스킹 요청 시 폭발.

### B. systemd / launchd 서비스로 백엔드 등록
- 거부. OS 별 인스톨러 필요, 관리자 권한, 사용자 친화도 낮음. v2 에서 별도 검토.

### C. 모델을 디스크-mmap 으로 영구 로드 + LRU 페이지 회수
- 거부. ONNX runtime 의 mmap 지원이 백엔드별 천차만별 (CUDA 미지원). 복잡도 대비 이득 적음.

### D. 컨테이너 자체를 idle stop
- 거부. cold start 5~10초 vs 모델 unload 후 reload 1~3초. UX 우월성 차이.

### E. fail-closed 가 아닌 fail-open auto-start
- 거부. spawn 실패가 silent 이면 백엔드 없이도 마스킹이 일어난 것처럼 행동 → ADR-0006 위반.

---

## References

- [ADR-0006](./0006-fail-closed-default.md) — fail-closed default
- [ADR-0008](./0008-detection-backend-self-built-docker.md) — 자체 Docker 이미지
- [`packages/core/src/backend/auto-start.ts`](../../packages/core/src/backend/auto-start.ts) — 구현
- [`packages/backend/server/main.py`](../../packages/backend/server/main.py) — idle monitor task + middleware
- [`packages/backend/server/opf_runner.py`](../../packages/backend/server/opf_runner.py) — `OpfRunner.unload()`
- [`packages/backend/server/korean_ner_runner.py`](../../packages/backend/server/korean_ner_runner.py) — `KoreanNerRunner.unload()`
