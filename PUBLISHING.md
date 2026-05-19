# PUBLISHING

릴리즈 절차와 npm 배포 인증 설정. 본 프로젝트는 **OIDC Trusted Publisher**를 1순위로 채택해 `NPM_TOKEN` Secret 없이 publish한다.

## 배포 대상 패키지

| Package | 배포 경로 |
|---|---|
| `@pii-remover/core` | npm registry |
| `@pii-remover/cli` | npm registry |
| `@pii-remover/mcp-server` | npm registry |
| `@pii-remover/proxy` | npm registry |
| `@pii-remover/opencode-plugin` | npm registry |
| `@pii-remover/vision` | npm registry |
| `@pii-remover/shared-types` | **private** (publish 안 함 — 의존 패키지에 타입만 인라인) |
| `@pii-remover/backend` | **GHCR (Docker)** — `backend-build.yml`에서 처리, npm 아님 |

6개 npm 패키지 모두 `publishConfig: { access: "public", provenance: true }` 설정 — 첫 publish 시 자동 공개 + provenance attestation 첨부.

## 워크플로 (정상 릴리즈 흐름)

```bash
# 1) 모든 곳의 version을 한 번에 갱신 (single source of truth = root package.json)
npm version 0.0.2          # root version bump → npm version hook이 sync-versions 자동 실행
# 또는 manual:
#   root package.json의 version 편집 후
#   bun run sync-versions

# 2) commit + tag
git add -A && git commit -m "chore: release v0.0.2"
git tag v0.0.2

# 3) push (tag가 npm-publish.yml + mcp-server-build.yml 트리거)
git push && git push --tags
```

`v*` 태그 push → CI 동작:

| Workflow | 동작 |
|---|---|
| `.github/workflows/npm-publish.yml` | 6개 npm 패키지 dependency 순서로 publish + provenance attestation |
| `.github/workflows/mcp-server-build.yml` | 4-platform 단일 바이너리 빌드 + GitHub Release 자동 첨부 |
| `.github/workflows/backend-build.yml` | Docker 이미지 빌드 + GHCR push |

## OIDC Trusted Publisher 등록 절차 (각 패키지마다 1회)

> ⚠️ Trusted Publisher는 **이미 publish된 패키지**에만 등록 가능. 따라서 첫 publish는 manual auth 또는 `NPM_TOKEN` 폴백을 한 번 거친다(아래 [§첫 publish (Chicken-and-Egg)](#첫-publish-chicken-and-egg)).

각 6개 npm 패키지에 대해 반복:

1. <https://www.npmjs.com/> 로그인 → 패키지 페이지 (예: `https://www.npmjs.com/package/@pii-remover/mcp-server`)
2. **Settings** 탭 → **Trusted Publishers** 섹션
3. **Add trusted publisher** → **GitHub Actions**
4. 입력:
   - **Organization or user**: 이 repository의 GitHub owner
   - **Repository**: `pii-remover`
   - **Workflow filename**: `npm-publish.yml` (workflow 파일명만, 경로 X)
   - **Environment** (optional): 비워둠 (workflow에 environment 사용 안 함)
5. 저장.

설정 후 그 패키지의 publish 요청에 GitHub Actions OIDC 토큰 사용. `NPM_TOKEN` 없어도 됨.

## 첫 publish (Chicken-and-Egg)

Trusted Publisher 등록은 패키지가 npm registry에 존재해야 가능. 첫 publish는 두 옵션 중 택:

### Option A — 로컬에서 manual publish (권장)

⚠️ **`bun publish`는 OIDC를 지원하지 않지만 로컬 `npm login` 세션 publish는 잘 작동한다.** 다만 CI workflow와 동일한 도구 (npm CLI)를 쓰는 것이 디버깅·재현·provenance attestation 측면에서 일관성이 높으므로 `npm publish` 사용을 권장.

```bash
# 1) npm 로그인 (browser-based 또는 토큰)
npm login

# 2) sync 확인
bun run sync-versions
git status                  # diff 없어야 함

# 3) 전체 빌드 + 테스트
bun run typecheck && bun test && bun run build

# 4) dry-run으로 tarball 확인 (bun이 빠르므로 dry-run만 bun 사용해도 무방)
cd packages/core && npm publish --dry-run && cd -
# ... 6개 모두 dry-run

# 5) 실 publish (의존성 순서)
#    --provenance: GitHub Actions 외부에서는 attestation 생성 불가하므로
#                  로컬 publish 시에는 생략 (CI에서 재 publish 하면 첨부됨).
for pkg in core cli proxy opencode-plugin vision mcp-server; do
  (cd packages/$pkg && npm publish --access public)
done

# 6) Trusted Publisher 등록 (위 §OIDC Trusted Publisher 등록 절차)
# 7) 다음 릴리즈부터는 git tag push → CI에서 npm publish --provenance 자동
```

### Option B — 임시 NPM_TOKEN으로 CI에서 publish

1. npm.com → Account Settings → Access Tokens → **Generate New Token (Granular Access)** → publish 권한만 부여
2. 토큰을 GitHub repo의 **Secrets** → `NPM_TOKEN`으로 등록
3. `npm-publish.yml`의 `publish` job에 임시 `env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` 추가 후 tag push
4. 첫 publish 성공 후 Trusted Publisher 등록 → `NODE_AUTH_TOKEN` env 제거 + `NPM_TOKEN` secret 삭제

> ⚠️ **`NODE_AUTH_TOKEN` 잔존 주의**: Trusted Publisher 등록 후에도 `NODE_AUTH_TOKEN`이 환경에 남아 있으면 npm CLI는 토큰 인증을 우선시하고 OIDC fallback을 건너뛴다. 등록 후 반드시 env 라인과 secret 모두 삭제.

## CI workflow 동작 상세 (`npm-publish.yml`)

```
test job (필수 검증):
  1. checkout
  2. bun install --frozen-lockfile
  3. sync-versions 무변경 확인 (idempotent check)
  4. v* tag 시 tag와 root version 일치 검증
  5. bun run typecheck (6 packages)
  6. bun test (full workspace, ~780 tests)

publish job (test 후):
  permissions:
    id-token: write              # ← OIDC 토큰 발급용
  env:
    # NPM_TOKEN / NODE_AUTH_TOKEN 의도적 미설정 → npm CLI가 OIDC 사용
  1. checkout + bun (build·dependency 설치용) + Node 20 (npm CLI v11.5+)
  2. bun install --frozen-lockfile
  3. bun run build (dist 생성)
  4. 6개 패키지 dependency 순서로 publish:
       core → cli → proxy → opencode-plugin → vision → mcp-server
     - 명령: npm publish --provenance --access public
     - 이미 등록된 version은 skip (npm view로 사전 체크, 재실행 가능)
     - workflow_dispatch + dry_run=true 면 --dry-run flag 추가
```

### 왜 publish는 `bun publish`가 아닌 `npm publish`인가

| 항목 | bun publish | npm publish (v11.5+) |
|---|---|---|
| `--dry-run` / tarball pack | ✅ | ✅ |
| `--access`, `--tag`, `--otp` | ✅ | ✅ |
| **OIDC Trusted Publisher 토큰 교환** | ❌ ([oven-sh/bun#22423](https://github.com/oven-sh/bun/issues/22423), PR [#29374](https://github.com/oven-sh/bun/pull/29374) / [#30522](https://github.com/oven-sh/bun/pull/30522) open) | ✅ ([공식 문서](https://docs.npmjs.com/cli/v11/commands/npm-publish)) |
| `--provenance` attestation | ❌ (PR #30522 open) | ✅ |

Bun이 OIDC + provenance를 머지하면 publish step만 다시 평가. 그 전까지 publish는 `npm publish`, install·build·test·dry-run·로컬 검증은 `bun` 유지가 합리적.

## sync-versions 동작 범위

`scripts/sync-versions.mjs`가 동기화하는 17개 파일:

- 7 `package.json` (root + 6 publishable + shared-types)
- `packages/backend/pyproject.toml`
- `packages/backend/server/__init__.py`
- 5 TypeScript source const (`mcp-server/src/server.ts`, `cli.ts`, `proxy/src/server.ts`, `cli.ts`, `cli/src/constants.ts`)
- 2 test assertion (`proxy/tests/cli.test.ts`, `cli/tests/health.test.ts`)
- 1 README 예시 (`packages/backend/README.md`)

신규 sync 대상 추가는 `scripts/sync-versions.mjs`의 `SOURCE_FILES` / `TEST_FILES` / `README_FILES` 배열에 entry 추가.

## 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| `Version not synchronized` CI 에러 | `bun run sync-versions` 로컬 실행 후 diff 커밋 |
| `Tag does not match package.json version` | Tag (`v0.0.2`)와 root `package.json` version이 다름. `npm version` 사용 또는 manual edit + tag 재발급 |
| `403 Forbidden` on publish | OIDC trusted publisher 미등록 또는 workflow filename 불일치. 위 [§OIDC Trusted Publisher 등록 절차](#oidc-trusted-publisher-등록-절차-각-패키지마다-1회) 재확인 |
| `Cannot publish over existing version` | 이미 같은 version publish 됨. version bump 필요 |
| `npm ERR! ENEEDAUTH` 첫 publish | Chicken-and-egg. [Option A 또는 B](#첫-publish-chicken-and-egg) 사용 |
| Provenance attestation 누락 | `id-token: write` permission 누락, `--provenance` flag 누락, 또는 `publishConfig.provenance: true` 누락 |
| Trusted Publisher 등록했는데 토큰 인증으로 처리됨 | `NODE_AUTH_TOKEN` 환경변수가 남아있음. workflow에서 env 라인 제거 + `NPM_TOKEN` secret 삭제 |
| `bun publish`로 OIDC 시도 시 403 | bun publish는 아직 OIDC 미지원 (oven-sh/bun#22423). `npm publish`로 전환 |

## 검증된 사전 작업

- [x] 6개 publishable package에 `publishConfig` (access: public + provenance: true)
- [x] `scripts/sync-versions.mjs` — root version 변경 시 17개 파일 자동 동기
- [x] `npm-publish.yml` workflow — OIDC 기반 자동 publish
- [x] `mcp-server-build.yml` workflow — 4-platform 단일 바이너리 빌드 + Release attach
- [ ] **6개 패키지 npm registry 첫 publish** (사용자 작업, 위 [§첫 publish](#첫-publish-chicken-and-egg))
- [ ] **6개 패키지에 Trusted Publisher 등록** (사용자 작업, npm.com 측 1회 설정)

## 관련 문서

- [`docs/ADR/0016-mcp-server-package.md`](./docs/ADR/0016-mcp-server-package.md) — MCP server 패키지 설계 (배포 채널 §8)
- [`packages/mcp-server/README.md`](./packages/mcp-server/README.md) — 사용자 셋업 (`npx @pii-remover/mcp-server`)
- [`packages/cli/README.md`](./packages/cli/README.md) — Claude Code / Codex 통합 셋업
