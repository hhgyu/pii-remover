# ADR-0001: TypeScript 단일 core 언어

- **Status**: Accepted
- **Date**: 2026-05-12
- **Related**: [ARCHITECTURE.md §3.2, §4](../ARCHITECTURE.md), [ROADMAP.md Phase 1](../ROADMAP.md)

---

## Context

`pii-remover`는 두 개의 호스트 환경(OpenCode CLI, Claude Code CLI)에 통합되고, 1개의 Python Docker 백엔드(자체 빌드 OPF API — [ADR-0008](./0008-detection-backend-self-built-docker.md))에 의존하며, 로컬 LLM 프록시(`@pii-remover/proxy`)도 가동한다. 이 모든 구성요소가 공유하는 core 라이브러리(`@pii-remover/core`)의 구현 언어 선택이 필요했다.

### 제약조건
- OpenCode plugin은 `@opencode-ai/plugin` 인터페이스를 따르며 **TypeScript/JavaScript 런타임(Bun)만 지원**. 다른 언어 선택지 없음.
- Claude Code hook은 shell command이므로 어떤 언어로 작성된 바이너리든 stdin/stdout JSON I/O만 만족하면 됨.
- 참조 레포지토리 `deformatic/OPENAI-Privacy-Filter-Reversible-Tokenization`의 vault 로직은 Python으로 작성되어 있음(~150줄).
- Detection 백엔드(자체 빌드 OPF Docker)는 Python — core가 어느 언어든 HTTP로만 호출.
- 호스트 hook은 **빈번하게(매 도구 호출/매 프롬프트)** 발동되므로 콜드스타트 비용이 큰 런타임은 부적합.

### 검토 옵션
1. **TypeScript 단일** — OpenCode plugin은 in-process, Claude Code hook은 Bun compile 단일 바이너리.
2. **Python 단일** — OpenCode plugin이 매 hook마다 Python subprocess 호출 (콜드스타트 ~200~500ms).
3. **Python core + TypeScript wrapper** — 양쪽 IPC, 두 언어 유지보수.
4. **Go/Rust** — 한 바이너리에 모든 것 포함. OpenCode plugin TS 강제 회피 불가.

---

## Decision

**TypeScript를 단일 core 언어로 채택**한다.

- `@pii-remover/core` 패키지를 TypeScript로 작성.
- OpenCode plugin은 core를 **in-process로 직접 import**.
- Claude Code hook은 `bun build --compile` 또는 `pkg`로 만든 **단일 실행 바이너리**(`pii-remover`)로 배포.
- Detection 백엔드(Python OPF)는 **HTTP로만 호출**, 코드 공유 없음.
- `deformatic`의 vault 로직(~150줄)은 TypeScript로 **재이식**.

---

## Consequences

### 긍정적
- OpenCode plugin 호출이 in-process이므로 hook당 추가 지연 ≈ 0.
- 두 언어 유지보수 비용 제거.
- Bun 런타임이 모던 TS/ESM/HTTP 서버를 표준 라이브러리로 제공 — `@pii-remover/proxy`도 같은 런타임 활용.
- 단일 바이너리 배포로 Claude Code hook 사용자가 Bun을 직접 설치할 필요 없음.

### 부정적
- `deformatic` vault 코드를 재구현해야 함. 다만 vault 로직이 알고리즘적으로 단순하여 재구현 비용 < 두 언어 유지 비용.
- Python 생태계의 PII 라이브러리(Presidio, llm-guard 등)를 core에서 직접 import 불가 — 필요 시 HTTP 백엔드로 래핑해야 함.
- Bun compile 바이너리는 ~30~50MB로 큼 (npm 글로벌 설치 가능하나 size 부담).

### 중립적
- Claude Code hook의 콜드스타트가 ~50~150ms 발생 (Bun compile 바이너리). `UserPromptSubmit`은 사용자가 명시적으로 enter를 누른 시점이라 수용 가능.

---

## Alternatives Considered

### 옵션 2: Python 단일
- **거부 이유**: OpenCode plugin이 TS 강제이므로 Python core는 매 hook마다 subprocess 호출 필요. 콜드스타트 200~500ms × tool.execute.before 빈도 → UX 파괴.

### 옵션 3: Python core + TS wrapper
- **거부 이유**: 두 언어 동기화 부담, IPC 직렬화 오버헤드, 디버깅 복잡도. core 라이브러리는 detector orchestration + vault + restorer로 logic이 단순한데 두 언어로 나눌 만한 이득 없음.

### 옵션 4: Go/Rust 단일 바이너리
- **거부 이유**: OpenCode plugin은 TS 강제 — Go/Rust로 작성해도 plugin은 TS 래퍼가 필요하여 사실상 두 언어. Bun compile 바이너리가 같은 single-file 배포 이점을 TS에서도 제공.

---

## Implementation Notes

- 패키지 매니저: **pnpm workspace** (또는 Bun workspace). 모노레포로 packages/* 관리.
- TypeScript 설정: ESM, target ES2022.
- Claude Code / Codex hook 바이너리: `bun build packages/cli/src/cli.ts --compile --outfile bin/pii-remover`.
- core 라이브러리 의존성 최소화: HTTP 클라이언트는 native `fetch`, 정규식만 사용. NER 모델 통합 시점에 의존성 추가 검토.

---

## References
- OpenCode plugins 공식 문서: https://opencode.ai/docs/plugins

- `deformatic/...-Reversible-Tokenization` Python 코드 분량 확인: `opf/_core/reversible.py` (~150줄)
