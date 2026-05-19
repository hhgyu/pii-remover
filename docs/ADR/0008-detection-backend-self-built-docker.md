# ADR-0008: Detection 백엔드 — 자체 Docker 이미지 빌드 (gh0stkey API 호환)

- **Status**: Accepted
- **Date**: 2026-05-12
- **Related**: [ARCHITECTURE.md §3.1, §7.2](../ARCHITECTURE.md), [ADR-0005](./0005-backend-strategy-trust-tiers.md), [ADR-0010](./0010-pii-categories-opf-plus-korean.md)

---

## Context

`openai/privacy-filter` 모델(1.5B param MoE, Apache-2.0)을 어떻게 실행할 것인가? 옵션:

| 옵션 | 설명 | 비고 |
|---|---|---|
| (a) gh0stkey/opf-privacy-filter Docker **직접 사용** | `docker pull ghcr.io/gh0stkey/opf-privacy-filter:latest` | 즉시 사용 가능 |
| (b) **자체 Docker 이미지 빌드** | `packages/backend/Dockerfile`로 직접 빌드, `ghcr.io/<our-org>/pii-remover-backend` 자체 publish | 통제권 ↑ |
| (c) Python CLI 직접 호출 | 매 호출마다 subprocess + 모델 로드 (콜드스타트 1-2분) | UX 부적합 |
| (d) Transformers.js Bun 임베드 | 백엔드 없음, ~50MB 모델 + WASM 추론 | v2 백로그 |
| (e) HuggingFace Inference API | 3rd-party 클라우드 | ADR-0005 Tier 4, 거부 |

### 요구사항 (초기 + 변경)
- 초기: "Detection 백엔드는 gh0stkey Docker 사이드카 + 원격 endpoint도 지원"
- 변경: "ghcr.io/gh0stkey/opf-privacy-filter 그대로 사용하는 게 아니라 자체 도커 이미지를 만들어야 됨"

### 3rd-party 이미지 직접 사용의 위험 (gh0stkey 옵션 (a) 재평가)

| 위험 | 영향 |
|---|---|
| **공급망 공격** | 압축된 이미지에 멀웨어 주입 시 우리 사용자 모두 영향. 단일 메인테이너(`gh0stkey`)가 손상되거나 압류되면 우리 통제 불가 |
| **라이선스 불명확** | gh0stkey 리포지토리 README에 코드 라이선스 명시 없음. OPF 모델은 Apache-2.0이지만 Dockerfile/server.py의 라이선스는 별도 |
| **메인테너 단일점 장애** | 메인테너가 활동 중단 시 보안 패치/CVE 대응 끊김. 마지막 커밋 시점이 우리 출시 후 12개월 지나면 사용자 신뢰 떨어짐 |
| **버전 고정 불가** | gh0stkey가 이미지 retag/replace 시 우리 사용자가 받는 코드가 변경. SBOM 추적 어려움 |
| **확장 불가**: KLUE-NER (ADR-0007 Phase 7), 한국 정규식 사전 검증 등 추가 모델을 같은 컨테이너에 넣으려면 fork 필요 — 라이선스 재확인 필요 |
| **보안 감사 어려움** | base image, Python 의존성, CVE 패치 cycle을 우리가 통제 불가 |

### 평가 기준
1. 즉시 사용 가능성
2. 재현성 (모든 사용자 머신 동일 동작)
3. 라이선스 명확성
4. 보안 패치 자유도
5. 향후 모델 확장(KLUE-NER 등) 통합 용이성
6. SBOM/CVE 추적 가능성
7. API 표준 — drop-in 호환성

---

## Decision

### 1. **자체 Docker 이미지를 빌드한다** (옵션 (b))

- 리포지토리 내 `packages/backend/`에 Dockerfile + Python FastAPI 서버 코드를 둠
- `ghcr.io/<our-org>/pii-remover-backend:vX.Y.Z` 로 publish
- 사용자 default: `docker compose up`이 자체 이미지를 pull

### 2. **API는 gh0stkey의 endpoint를 사실상의 표준으로 채택** (호환성 유지)

코드는 자체 작성하지만 API 형식은 gh0stkey와 동일:
- `GET /health` → `{ ok: bool, version?: string, model: string }`
- `POST /redact` → 단건 텍스트 redaction (`{ text: string }` → `{ detections: [...], redacted_text: string }`)
- `POST /redact/text` → 텍스트만 반환 (raw string)
- `POST /redact/batch` → 배열

→ 사용자가 자체 이미지 대신 gh0stkey를 쓰고 싶어도 동작. 또한 다른 OPF wrapper(향후 등장 가능)도 같은 API면 drop-in.

### 3. 베이스 이미지 + 의존성

- **베이스**: `python:3.11-slim` (CPU) + `nvidia/cuda:12.x-runtime-ubuntu22.04` (GPU variant)
- **모델 가중치**: HuggingFace에서 직접 pull (`openai/privacy-filter`, Apache-2.0)
- **서버**: FastAPI + Uvicorn (가벼움, 비동기)
- **추론 라이브러리**: PyTorch + Transformers (`openai/privacy-filter`가 표준 transformers 호환)

### 4. 이미지 배포

- **GitHub Container Registry (GHCR)** 메인 publish 위치
- **버전 태그**: `vX.Y.Z` (semver), `latest`, `main` (브랜치 빌드)
- **멀티 아키**: `linux/amd64` + `linux/arm64` (Apple Silicon 지원)
- **GitHub Actions**: `.github/workflows/backend-build.yml`에서 자동 빌드/푸시

### 5. 모델 weights 포함 전략

| 전략 | 이미지 크기 | 첫 가동 시간 | 권장 |
|---|---|---|---|
| 사전 포함 (이미지에 weights 포함) | ~5-6GB | ~10초 (모델 로드만) | ✅ 권장 |
| 첫 실행 시 다운로드 | ~500MB | ~1-2분 (다운로드 + 로드) | 옵션 |

기본은 **사전 포함** (`Dockerfile`의 `RUN python -c "from transformers import ...; AutoModel.from_pretrained('openai/privacy-filter')"` 으로 빌드 시점에 캐싱). 다운로드 옵션은 `:slim` 태그로 제공.

### 6. gh0stkey 코드는 참조 only — 사용 X

- gh0stkey/opf-privacy-filter README와 `server.py`는 API 형식 참조용
- 코드 복사/fork 없음 (라이선스 불명확이라 위험 회피)
- 우리 `server.py`는 OPF 공식 패키지(`openai/privacy-filter` GitHub repo) 직접 사용 → Apache-2.0 명확

### 7. 자체 이미지 라이선스

- 우리 코드(Dockerfile, server.py, requirements.txt): **Apache-2.0** (OPF 라이선스와 일치)
- 의존성: PyTorch (BSD), Transformers (Apache-2.0), FastAPI (MIT), Uvicorn (BSD) — 모두 호환

---

## Consequences

### 긍정적
- **라이선스 명확**: 우리가 작성한 코드 = Apache-2.0 명시. 의존성 모두 호환 라이선스.
- **공급망 통제**: GHCR 푸시 권한 우리만 보유. 멀웨어 주입 위험 ↓.
- **보안 패치 자유**: CVE 발견 시 즉시 base image 업그레이드 + 재빌드.
- **확장 자유**: v2 KLUE-NER 통합 시 같은 컨테이너 또는 별도 컨테이너 자유롭게 추가 가능.
- **SBOM 추적**: GitHub의 dependency graph + `docker scout` 등으로 의존성 가시성 확보.
- **재현 빌드**: Dockerfile + lockfile로 모든 사용자 동일 이미지.
- **API 호환성**: gh0stkey와 같은 API 형식 → 사용자가 둘 사이 쉽게 교체 가능 (자체 호스팅 환경 마이그레이션 시 유용).

### 부정적
- **초기 빌드/유지 비용**: Phase 1 시작 시 Dockerfile 작성 + GitHub Actions 셋업 (예상 1-2일 추가).
- **CI 시간/디스크 비용**: 5-6GB 이미지 빌드/푸시는 GHCR free tier 한도에서 빠르게 소진 가능 → 푸시 빈도 제한(릴리즈 태그만) + slim variant 옵션 제공으로 완화.
- **사용자 다운로드 부담**: 첫 `docker pull`이 5-6GB → 사용자 인터넷 환경에 따라 분 단위. slim variant로 완화.
- **메인테너 책임**: 우리가 base image CVE 추적 + 의존성 업데이트 책임.

### 위험 / 미해결 사항
- **GHCR 의존**: GHCR이 다운되거나 정책 변경 시 영향. **완화**: Docker Hub 미러 publish 검토 (v1.x).
- **모델 가중치 재배포 라이선스 확인**: Apache-2.0이라 자유롭지만 HuggingFace 약관도 확인 필요 (현재까지 문제 없음 — Apache-2.0 모델은 자유 재배포 허용).
- **Apple Silicon (arm64) PyTorch 지원**: MPS 가속이 일부 모델 op 미지원 가능 → CPU fallback 필요할 수 있음. Phase 1 검증.

---

## Alternatives Considered

### (a) gh0stkey 직접 사용 (초기안)
- **거부 이유**: 위 Context에 나열된 6가지 위험. 특히 **라이선스 불명확**과 **공급망 통제 불가**가 critical.
- 다만 API 형식은 gh0stkey가 정의한 사실상의 표준이라 그대로 채택.

### (c) Python CLI 직접 호출
- **거부 이유**: 매 호출마다 subprocess + 모델 로드 = 콜드스타트 1-2분. 사용자 페르소나(대화형 CLI 도구)에 부적합.

### (d) Transformers.js Bun 임베드
- **연기 이유**: 백엔드 불필요한 장점 있음. 다만 Bun의 Transformers.js 지원 검증 + WebGPU 부재 시 WASM 느림 등 검증 비용. v2 백로그.

### (e) HuggingFace Inference API
- **거부 이유**: ADR-0005 Tier 4 (PII 외부 유출 위험).

### (f) 자체 PyPI 패키지로 배포 (Docker 없이)
- **거부 이유**: Python 환경/의존성 사용자별 차이로 재현성 저하. PyTorch + CUDA 버전 매칭 등 사용자 부담 큼. Docker가 정답.

### (g) gh0stkey fork 후 재빌드
- **거부 이유**: 라이선스 불명확이라 fork도 위험. 차라리 처음부터 자체 작성이 명확.

---

## Implementation Notes

### 패키지 구조
```
packages/backend/
├── Dockerfile                   # multi-stage: builder + runtime
├── Dockerfile.gpu               # CUDA 변형
├── Dockerfile.slim              # weights 미포함 (런타임 다운로드)
├── docker-compose.yml           # 사용자 default 가동 스크립트
├── docker-compose.gpu.yml       # GPU 가동
├── server/
│   ├── main.py                  # FastAPI 진입점
│   ├── api/
│   │   ├── redact.py            # POST /redact, /redact/text, /redact/batch
│   │   └── health.py            # GET /health
│   ├── opf_runner.py            # OPF 모델 로드/추론 래퍼
│   └── schemas.py               # Pydantic request/response
├── tests/
│   ├── test_api.py
│   └── fixtures/
├── pyproject.toml
├── requirements.txt
├── requirements-dev.txt
└── LICENSE                       # Apache-2.0
```

### `Dockerfile` 골자 (예시)
```dockerfile
# Stage 1: builder — 모델 가중치 사전 다운로드
FROM python:3.11-slim AS builder
WORKDIR /build
RUN pip install --no-cache-dir torch transformers
RUN python -c "from transformers import AutoModelForTokenClassification, AutoTokenizer; \
    AutoModelForTokenClassification.from_pretrained('openai/privacy-filter'); \
    AutoTokenizer.from_pretrained('openai/privacy-filter')"

# Stage 2: runtime — slim 베이스 + 캐시된 모델만 복사
FROM python:3.11-slim
WORKDIR /app
COPY --from=builder /root/.cache/huggingface /root/.cache/huggingface
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/ ./server/
ENV OPF_DEVICE=cpu \
    OPF_HOST=0.0.0.0 \
    OPF_PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -fs http://localhost:8000/health || exit 1
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### `docker-compose.yml` 골자 (사용자 받는 default)
```yaml
services:
  opf:
    image: ghcr.io/<our-org>/pii-remover-backend:latest
    ports: ["8000:8000"]
    environment:
      OPF_DEVICE: cpu
    healthcheck:
      test: ["CMD", "curl", "-fs", "http://localhost:8000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

### GitHub Actions (`.github/workflows/backend-build.yml`) 핵심
- 트리거: `push` to main + `release: published` 태그
- multi-arch buildx: amd64 + arm64
- 모델 가중치 caching: actions/cache로 HF 캐시 보존
- 푸시: GHCR + (옵션) Docker Hub 미러
- 이미지 서명: cosign (v1.x 옵션)
- vulnerability scan: trivy 또는 docker scout

### pii-remover CLI 서브커맨드 (변경 없음)
```bash
pii-remover backend start     # docker compose up -d 자체 이미지 사용
pii-remover backend stop
pii-remover backend status     # health check
pii-remover backend logs
pii-remover backend update     # docker compose pull + restart
```

### 검증 시점
- 시작 후 health 200 OK까지 최대 5분 폴링 (모델 로드 시간)
- 실패 시 `docker logs` 안내

### 원격 배포 가이드 (변경 없음, docs/REMOTE_BACKEND.md 향후 작성)
1. 사내 서버에 docker compose로 가동
2. Caddy/nginx로 HTTPS + Bearer 토큰 추가
3. 클라이언트 config에 endpoint + trust_tier 설정

---

## Migration / Follow-up

### 다른 문서 영향
- [ADR-0005](./0005-backend-strategy-trust-tiers.md): `OpfHttpBackend` 설명에 "gh0stkey API 호환"을 "표준 OPF HTTP API 호환"으로 표현 다듬기 (선택)
- [ARCHITECTURE.md §7.2](../ARCHITECTURE.md): "gh0stkey Docker API 호환"을 "OPF HTTP API 호환 (gh0stkey가 정의한 사실상 표준)"으로 다듬기 (선택)
- [ROADMAP.md Phase 1](../ROADMAP.md): "Docker Compose 예제 (`gh0stkey/opf-privacy-filter` 그대로)" → "자체 백엔드 이미지 빌드 + docker-compose.yml" — Phase 1 deliverable에 추가

### Phase 1 추가 작업 (예상 +1-2일)
- `packages/backend/` 작성
- Dockerfile + 모델 사전 캐싱
- FastAPI 서버 + 4개 endpoint
- 단위 테스트 (mock OPF model)
- GitHub Actions 빌드 파이프라인

---

## References
- `openai/privacy-filter` (Apache-2.0): https://github.com/openai/privacy-filter
- 모델 weights (HuggingFace): https://huggingface.co/openai/privacy-filter
- gh0stkey API 참조 (코드는 사용 안 함): https://github.com/gh0stkey/opf-privacy-filter (raison d'être: API 형식만 채택)
- ADR-0005: backend trust tier (자체 이미지는 Tier 1 localhost / Tier 2 self-hosted)
- ADR-0010: PII 카테고리 매핑
- 변경 요청 (2026-05-12)
