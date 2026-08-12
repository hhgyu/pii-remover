# Development Guide

> pii-remover 로컬 개발 환경 설정 및 기여 가이드.

---

## 1. 사전 요구사항

| 도구 | 버전 | 비고 |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.0.0 | TS 워크스페이스 빌드, 테스트 러너, CLI 컴파일 |
| [Node.js](https://nodejs.org) | ≥ 18.0.0 | Bun 대체 가능 (테스트/빌드 동일) |
| [Docker](https://www.docker.com/) | 최신 | 백엔드(OPF + KLUE-NER + OCR) 실행용 |
| [Python](https://www.python.org/) | 3.11+ | 백엔드 로컬 개발 시 (Docker 없이) |
| [Git](https://git-scm.com/) | 최신 | — |

Windows에서는 PowerShell 7+ 권장.

---

## 2. 저장소 클론 및 초기 설정

```bash
git clone https://github.com/hhgyu/pii-remover.git
cd pii-remover

# 의존성 설치 (Bun workspace)
bun install
```

### Windows (PowerShell)

```powershell
git clone https://github.com/hhgyu/pii-remover.git
cd pii-remover
bun install
```

---

## 3. 빌드

```bash
# 전체 빌드 (core → plugins 5개 패키지)
bun run build

# 타입 체크만
bun run typecheck

# 개별 패키지 빌드
bun run build:core        # @pii-remover/core 만
bun run build:plugins     # opencode-plugin, proxy, cli, vision
```

빌드 산출물은 각 패키지의 `dist/` 디렉토리에 생성. `.gitignore`에 포함되어 있음.

---

## 4. 테스트

```bash
# 전체 테스트 (워크스페이스)
bun test

# 특정 패키지만
bun test packages/core/tests
bun test packages/proxy/tests
bun test packages/cli/tests
```

### E2E 테스트 (백엔드 Docker 필요)

```bash
# 백엔드 기동
cd packages/backend
docker compose up --build -d

# E2E corpus 테스트
PII_REMOVER_E2E=1 bun test packages/core/tests/pii-corpus.test.ts

# 한국 이름 NER 정밀 측정 (Phase 7)
PII_REMOVER_KLUE_E2E=1 bun test packages/core/tests/korean-name-corpus.test.ts
```

### Python 백엔드 테스트

```bash
cd packages/backend

# venv 생성
python -m venv .venv

# Windows PowerShell 활성화
. .venv\Scripts\Activate.ps1

# macOS/Linux
source .venv/bin/activate

# 의존성 설치
pip install -r requirements-dev.txt

# 단위 테스트 (모델 다운로드 없이 mock으로 실행)
pytest

# 린트
ruff check .

# 타입 체크
mypy server
```

---

## 5. 프로젝트 구조

```
pii-remover/
├── packages/
│   ├── core/                  # @pii-remover/core — 공통 엔진
│   │   └── src/
│   │       ├── detector/      # PII 검출 (정규식, 한국어 휴리스틱)
│   │       ├── backend/       # BackendClient 인터페이스 + 구현체
│   │       ├── vault/         # 인메모리 vault (세션 스코프)
│   │       ├── restorer/      # 토큰 → 원본 복원
│   │       ├── token/         # __OPF_<CAT>_<IDX>__ 포맷
│   │       ├── config/        # 설정 로더 (JSON + env substitution)
│   │       ├── policy/        # fail-closed / hybrid / open
│   │       └── data/          # 한국 성씨/불용어 JSON
│   │
│   ├── cli/                   # @pii-remover/cli — 멀티호스트 훅 CLI
│   │   └── src/
│   │       ├── commands/      # hook, install, detect, health
│   │       └── protocol/      # UserPromptSubmit JSON 프로토콜
│   │
│   ├── proxy/                 # @pii-remover/proxy — 로컬 LLM 프록시
│   │   └── src/
│   │       ├── providers/     # anthropic.ts, openai.ts, codex.ts
│   │       ├── stream/        # SSE 토큰 boundary buffering
│   │       ├── router.ts      # path prefix → provider 라우팅
│   │       └── session.ts     # 프록시 단위 vault 풀
│   │
│   ├── opencode-plugin/       # @pii-remover/opencode-plugin
│   ├── vision/                # @pii-remover/vision — 이미지 OCR 클라이언트
│   ├── shared-types/          # 공유 타입 (선택)
│   │
│   └── backend/               # Python FastAPI 백엔드 (Docker)
│       ├── server/
│       │   ├── main.py        # FastAPI 앱 진입점
│       │   ├── opf_runner.py  # OPF 모델 래퍼
│       │   ├── korean_ner_runner.py  # KLUE-NER 래퍼
│       │   ├── regex_pipeline.py     # 한국 PII 정규식
│       │   ├── ocr_pipeline.py       # Tesseract OCR
│       │   └── api/           # redact, redact_image, health
│       └── tests/
│
├── docs/
│   ├── ARCHITECTURE.md        # 시스템 설계
│   ├── ROADMAP.md             # Phase별 마일스톤
│   ├── KOREAN_PII.md          # 한국 PII 검출 알고리즘
│   ├── TRUST_TIERS.md         # 4-Tier 신뢰 모델 운영 가이드
│   └── ADR/                   # Architecture Decision Records (15건)
│
├── tests/
│   └── integration/           # 통합 테스트 + corpus fixture
│
├── examples/                  # 호스트별 설정 예시
└── package.json               # Bun workspace root
```

---

## 6. 로컬 파일로 설치 (개발 중 변경사항 실시간 반영)

배포된 npm 패키지 대신 로컬 소스에서 직접 설치하여 개발하는 방법.

### 6.1 빌드 후 CLI 설치

```bash
# 전체 빌드 (필수 — CLI는 dist/ 기반으로 동작)
bun run build

# Claude Code용 설치 (로컬 경로 지정)
node packages/cli/bin/pii-remover.js install --target claude-code \
  --command-path "D:\Git\pii-remover\packages\cli\bin\pii-remover.js"

# OpenCode용 설치 (split-mode: mask 첫 번째 + restore 마지막 두 entry 등록)
node packages/cli/bin/pii-remover.js install --target opencode

# Codex CLI용 설치
node packages/cli/bin/pii-remover.js install --target codex \
  --proxy-url http://localhost:8000/codex/v1
```

> **Windows 경로**: 반드시 절대경로를 따옴표로 감쌀 것.

OpenCode 설치는 `opencode.json`의 `plugin` 배열에 `dist/mask.js`(첫 번째)와
`dist/restore.js`(마지막) 두 개의 `file://` entry를 등록한다. 그 사이에
존재하는 다른 OpenCode 플러그인들은 마스킹된 입력만 보고, 자신의
`tool.execute.after`가 끝난 뒤에 restore가 토큰을 원본으로 되돌린다.
재실행은 idempotent — 기존 PII-Remover entry를 제거하고 다시 삽입.

**왜 두 entry로 나눴나?** OpenCode는 `plugin` 배열 순서대로 hook을
호출한다. 그래서 한 plugin이 등록한 `tool.execute.before`와
`tool.execute.after`는 **같은 array slot**에 묶여 있다. 만약 PII Remover를
single entry로 등록하면 mask와 restore가 동일 슬롯에 위치해, 다른
플러그인은 그 슬롯의 "바깥"에서만 실행된다 — 즉 mask 이전 또는 restore
이후에. 다른 플러그인을 mask와 restore "사이"에 끼워 넣어 PII 평문을
숨기는 게 불가능하다. mask와 restore를 두 entry로 분리하고 다른 플러그인을
사이에 두면, 다른 플러그인의 `before` 훅은 이미 마스킹된 입력을 보고,
`after` 훅이 끝난 뒤에 PII Remover의 restore가 토큰을 원본으로 되돌린다.
두 entry는 module-level 싱글턴 `VaultManager`를 공유하므로 vault 상태는
일관된다. 보안 동기는 단순하다 — **PII 평문이 PII Remover 외의 어떤
플러그인에도 노출되지 않게** 보장하는 것. 두 entry 모두 plugin init 시점에
배열 순서를 검사하고, 잘못된 순서(restore가 mask보다 먼저 등 hand-edit으로
인한 드리프트)면 `warn` 채널로 경고를 남긴다.

워크스페이스에서는 `@pii-remover/opencode-plugin`이 `@pii-remover/cli`의
`optionalDependency`로 선언되어 있어 `bun install` 후 CLI의 `node_modules`에
symlink가 생긴다. CLI가 `require.resolve('@pii-remover/opencode-plugin/mask')`로
실제 dist 경로를 찾을 때 이 symlink가 필요하다. 해석에 실패하면 single
bare-package entry로 fallback하면서 WARNING을 출력 (수동으로
`bun add -d @pii-remover/opencode-plugin` 후 재실행 안내).

### 6.2 프록시 로컬 실행

프록시는 백엔드와 같은 프로세스에서 서빙됩니다 (Python 포팅, 포트 8000).
별도 프록시 데몬은 없습니다.

```bash
docker compose -f packages/backend/docker-compose.yml up -d
# 탐지(/redact)와 프록시(/anthropic, /openai, /codex)가 함께 8000에 뜸

# 또는 컨테이너 없이 로컬에서
cd packages/backend
PII_PROXY_ENABLED=1 uvicorn server.main:app --port 8000
```

`packages/proxy`(TypeScript)는 더 이상 런타임이 아닙니다. 골든 벡터
생성기(`scripts/gen-*-vectors.ts`)와 eval 하니스가 참조하는 레퍼런스
구현으로만 남아 있으며 배포되지 않습니다.

프록시 실행 후 환경변수 설정:

```bash
# Claude Code
export ANTHROPIC_BASE_URL=http://localhost:8000/anthropic/v1

# OpenAI
export OPENAI_API_BASE=http://localhost:8000/openai/v1
```

### 6.3 백엔드 로컬 실행

```bash
cd packages/backend

# Docker로 실행 (권장)
docker compose up --build
# 최초 빌드 시 모델 weights 다운로드로 5-10분 소요

# GPU 사용
docker compose -f docker-compose.gpu.yml up --build

# Docker 없이 로컬 Python 실행
python -m venv .venv
. .venv/Scripts/Activate.ps1   # Windows
pip install -r requirements.txt
OPF_DEVICE=cpu uvicorn server.main:app --host 0.0.0.0 --port 8000
```

### 6.4 코드 변경 후 반영

| 패키지 | 변경 후 작업 |
|---|---|
| `@pii-remover/core` | `bun run build:core` 후 의존 패키지 재빌드 |
| `@pii-remover/cli` | `bun run build` 후 재설치 불요 (dist 경로 그대로 참조) |
| `@pii-remover/proxy` | 프록시 재시작 (`Ctrl+C` 후 재실행) |
| `@pii-remover/opencode-plugin` | `bun run build` 후 OpenCode 재시작 (`opencode.json`이 `dist/mask.js`/`dist/restore.js`를 `file://`로 직접 참조하므로 빌드 필수) |
| `packages/backend` (Python) | Docker: `docker compose up --build` / 로컬: uvicorn auto-reload |

---

## 7. 개발 워크플로

### 7.1 일반적인 흐름

```
코드 수정 → bun run typecheck → bun test → bun run build → 수동 검증
```

### 7.2 커밋 전 체크리스트

```bash
# 1. 타입 체크
bun run typecheck

# 2. 전체 테스트
bun test

# 3. 변경된 파일 LSP 진단
# (에디터에서 자동으로 표시되거나, CLI에서 확인)

# 4. 빌드
bun run build
```

### 7.3 CLI 단일 바이너리 컴파일 (릴리스용)

```bash
cd packages/cli

# 플랫폼별 컴파일
bun run compile:linux-x64
bun run compile:darwin-arm64
bun run compile:darwin-x64
bun run compile:windows-x64
```

산출물: `packages/cli/dist/pii-remover-<platform>` 단일 실행 파일.

---

## 8. 설정 파일

### 8.1 설정 조회 우선순위 (높은 순)

1. `<cwd>/.opencode/pii-remover.json`
2. `<cwd>/.codex/pii-remover.json`
3. `<cwd>/.pii-remover.json`
4. `~/.config/opencode/pii-remover.json`
5. `~/.codex/pii-remover.json`
6. `~/.config/pii-remover/config.json`
7. 내장 기본값 (`packages/core/src/config/schema.ts`의 `DEFAULT_CONFIG`)

### 8.2 최소 설정 예시 (로컬 백엔드)

`.pii-remover.json`:

```json
{
  "backend": {
    "endpoint": "http://localhost:8000/redact"
  }
}
```

### 8.3 환경변수

| 변수 | 효과 |
|---|---|
| `ANTHROPIC_BASE_URL` | Claude Code 프록시 URL |
| `OPENAI_API_BASE` | OpenAI 프록시 URL |
| `PII_REMOVER_PROXY_TRUST=1` | 프록시 URL 확인 생략 (Codex용) |
| `PII_REMOVER_BYPASS=1` | 마스킹 완전 비활성화 (위험) |

---

## 9. 검출 카테고리

| 카테고리 | 토큰 | 예시 | 백엔드 |
|---|---|---|---|
| `private_person` | `__OPF_PERSON_N__` | 김철수, John Doe | OPF NER + 한국 휴리스틱 + KLUE-NER |
| `private_email` | `__OPF_EMAIL_N__` | user@example.com | OPF + 정규식 |
| `private_phone` | `__OPF_PHONE_N__` | 010-1234-5678 | OPF + 한국 전화 정규식 |
| `private_address` | `__OPF_ADDRESS_N__` | 우편 주소 | OPF |
| `account_number` | `__OPF_ACCOUNT_N__` | 계좌/ID 번호 | OPF |
| `private_date` | `__OPF_DATE_N__` | 생년월일 | OPF |
| `private_url` | `__OPF_URL_N__` | 사설 URL | OPF |
| `secret` | `__OPF_SECRET_N__` | API 키, PAT | OPF |
| `rrn` | `__OPF_RRN_N__` | 주민등록번호 | 정규식 + 체크섬 |
| `biz_num` | `__OPF_BIZNUM_N__` | 사업자등록번호 | 정규식 + 체크섬 |
| `card` | `__OPF_CARD_N__` | 신용카드 | LUHN |

---

## 10. 아키텍처 요약

```
사용자 입력
  │
  ▼
[Hook/Plugin] — PII 사전 탐지 + fail-closed 게이트
  │
  ▼
[Proxy] — HTTP 레이어에서 실제 마스킹 (Anthropic/OpenAI/Codex API 호환)
  │
  ▼
[Core] — Detector + Vault + Restorer
  │
  ▼
[Backend] — OPF 모델 + KLUE-NER + Tesseract OCR (Docker)
```

- **Hook은 프롬프트를 교체할 수 없음** — 마스킹은 항상 프록시에서.
- **Vault는 인메모리, 세션 스코프** — 디스크에 절대 저장 안 함.
- **Fail-closed 기본** — 탐지 실패 시 LLM 호출 차단.

---

## 11. 문서 인덱스

| 문서 | 내용 |
|---|---|
| [README.md](./README.md) | 프로젝트 개요, Quick Start |
| [INSTALL.md](./INSTALL.md) | 설치 가이드 (호스트별) |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 시스템 설계, 데이터 흐름, 보안 모델 |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Phase별 마일스톤, exit criteria |
| [docs/KOREAN_PII.md](./docs/KOREAN_PII.md) | 한국 PII 검출 알고리즘 상세 |
| [docs/TRUST_TIERS.md](./docs/TRUST_TIERS.md) | 4-Tier 백엔드 신뢰 모델 운영 가이드 |
| [docs/ADR/](./docs/ADR/) | Architecture Decision Records (15건) |
| [packages/backend/README.md](./packages/backend/README.md) | Python 백엔드 API, Docker 설정 |
| [packages/proxy/README.md](./packages/proxy/README.md) | 프록시 아키텍처, SSE 스트리밍 |
| [packages/cli/README.md](./packages/cli/README.md) | CLI 명령어, 훅 프로토콜 |
| [packages/opencode-plugin/README.md](./packages/opencode-plugin/README.md) | OpenCode plugin split-mode 동작, 설치 가이드, hook 분리 메커니즘 |

---

## 12. 유용한 명령어 모음

```bash
# 전체 빌드 + 테스트
bun run build && bun test

# 특정 테스트 파일만 실행
bun test packages/core/tests/korean-regex.test.ts

# 프로덕션 마스킹 테스트 (백엔드 필요)
curl -s -X POST http://localhost:8000/redact \
  -H 'content-type: application/json' \
  -d '{"text":"연락처: 010-1234-5678, 이메일: test@example.com"}'

# 프록시 헬스체크 (백엔드 /health와 동일 — 단일 서비스)
curl -s http://localhost:8000/health

# CLI 헬스체크
node packages/cli/bin/pii-remover.js health

# CLI로 마스킹 테스트
node packages/cli/bin/pii-remover.js detect --text "김철수의 주민번호 920101-1234562"

# Python 백엔드 헬스체크
curl http://localhost:8000/health

# Docker 백엔드 로그 확인
cd packages/backend && docker compose logs -f
```
