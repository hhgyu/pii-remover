# @pii-remover/cli

PII Remover CLI — `UserPromptSubmit` hook installer + helper utilities for
**Claude Code**, **OpenCode**, and **OpenAI Codex CLI**.

The hook does **not** mask the prompt itself — none of the supported hosts
expose a prompt-rewrite hook API (source-verified, see [ADR-0012] and
[ADR-0013]). Actual masking and response restoration is delegated to the
local proxy (`@pii-remover/proxy`) via the host's base-URL override.

- **License**: Apache-2.0
- **Related ADRs**:
  - [ADR-0004] — proxy architecture & path-prefix routing
  - [ADR-0011] — OpenCode `experimental.text.complete`
  - [ADR-0012] — Claude Code hook detection-only
  - [ADR-0013] — OpenAI Codex hook detection-only (compatible with Claude Code stdin/stdout)
  - [ADR-0014] — Codex Responses API proxy routing (`/codex/v1/responses`)

[ADR-0004]: ../../docs/ADR/0004-local-llm-proxy-streaming.md
[ADR-0011]: ../../docs/ADR/0011-message-part-updated-feasibility.md
[ADR-0012]: ../../docs/ADR/0012-claude-code-hook-protocol.md
[ADR-0013]: ../../docs/ADR/0013-codex-hook-protocol.md
[ADR-0014]: ../../docs/ADR/0014-codex-proxy-routing.md

## Why hook + proxy?

The hook runs **before** the host calls its LLM upstream. Neither Claude
Code nor Codex allow replacing the prompt — only adding side context or
blocking. So the hook's role is:

1. **Detect** PII in the user's typed prompt.
2. **Block** when PII is found *and* no local proxy is configured (fail-closed).
3. **Warn** via `additionalContext` when PII is found *and* a proxy is configured
   (the proxy actually masks the network payload).

## Install

```bash
pii-remover install --proxy
```

Without `--target`, `install` shows a checkbox for **Claude Code**,
**OpenCode**, and **OpenAI Codex CLI** (all unchecked by default). The PII
backend endpoint/category prompt runs once and that same config is reused
for every host you pick; installs run in a fixed order — Claude Code →
OpenCode → Codex — and one target failing doesn't stop the others (final
exit code is `2` if any selected target failed). Selecting nothing exits
`64`.

Pass `--target` to skip the checkbox and install exactly one host
non-interactively — the path used below for automation and single-host
setups.

### Claude Code

```bash
pii-remover install --target claude-code           # global
pii-remover install --target claude-code --scope project
```

Writes `~/.claude/settings.json` (`UserPromptSubmit` hook) and a
`.pii-remover.json` config.

### OpenCode

```bash
pii-remover install --target opencode                  # global (default)
pii-remover install --target opencode --scope project  # project-scoped
```

Writes **two** `file://` entries to the `plugin` array in `opencode.json`
— `dist/mask.js` first, `dist/restore.js` last, so PII is masked before
any other plugin reads tool args and restored after every other plugin's
`tool.execute.after` has finished:

```jsonc
{
  "plugin": [
    "file:///.../@pii-remover/opencode-plugin/dist/mask.js",   // FIRST
    "your-other-plugin@latest",
    "file:///.../@pii-remover/opencode-plugin/dist/restore.js" // LAST
  ]
}
```

OpenCode's dedup is keyed by package name for npm specs but by full URL
for `file://` specs, so the two entries are treated as distinct plugins
while still sharing the same in-memory vault.

`@pii-remover/opencode-plugin` is declared as an `optionalDependency` of
this CLI so workspace/global installs resolve `require.resolve()` against
the same node_modules tree. If resolution fails (e.g. the plugin package
isn't installed), the installer falls back to a single bare-package entry
and prints a warning telling you to install the plugin before re-running.

Add `--proxy` (or `--proxy-url`) alongside `--target opencode` and the
installer also patches `provider.anthropic.options.baseURL` and
`provider.openai.options.baseURL` in `opencode.json`, independently of each
other. `--proxy-only` skips the plugin entries above and writes only those
two base URLs, masking entirely at the proxy. This is a minimal proxy-only
mode: the default plugin+proxy combination is supported normally, and
`--proxy-only` is only for when you don't want the plugin installed at all.
`--proxy-only` only applies when `opencode` is among the selected targets;
passing it otherwise exits `64`.

### OpenAI Codex CLI

```bash
pii-remover install --target codex \
  --proxy-url http://localhost:8000/codex/v1
```

Writes:

- `~/.codex/config.toml` (or `.codex/config.toml`) —
  `[[hooks.UserPromptSubmit]]` block + (optional) `openai_base_url`
- `~/.codex/pii-remover.json` (or `.codex/pii-remover.json`) — detection config

TOML editing is surgical (no parser dependency): idempotent and preserves
existing content. See [ADR-0013].

### Local development install

```bash
bun run build
node packages/cli/bin/pii-remover.js install --target claude-code \
  --command-path "$(pwd)/packages/cli/bin/pii-remover.js"
node packages/cli/bin/pii-remover.js detect --text "test user@example.com"
```

### Start the proxy (required for masking)

```bash
docker compose -f packages/backend/docker-compose.yml up -d
```

Per-host base-URL setup:

| Host | Setup |
| --- | --- |
| Claude Code | `export ANTHROPIC_BASE_URL=http://localhost:8000/anthropic/v1` |
| OpenCode | proxy optional if the plugin is active (plugin alone covers most cases); `--proxy` sets `provider.anthropic.options.baseURL` and `provider.openai.options.baseURL` to `http://localhost:8000/anthropic/v1` / `http://localhost:8000/openai/v1` |
| Codex | set `openai_base_url = "http://localhost:8000/codex/v1"` in `~/.codex/config.toml` |

## CLI

| Command | What it does |
| --- | --- |
| `pii-remover hook` | Read `UserPromptSubmit` JSON on stdin, write decision on stdout. Called by Claude Code / Codex. |
| `pii-remover install [--target <t>] [--scope <s>] [--proxy \| --proxy-url <u>] [--proxy-only]` | No `--target`: interactive checkbox over all three hosts (fixed order, one shared PII config, per-target failure isolation). With `--target`: register hook/plugin for exactly `<t>` = `claude-code` \| `opencode` \| `codex` non-interactively. |
| `pii-remover detect --text <s>` | Mask a string and print tokens + masked text. |
| `pii-remover health` | `GET /health` against the proxy. |
| `pii-remover version` | Print package version. |
| `pii-remover help` | Print usage. |

### `hook` decision matrix (Claude Code + Codex)

| Input | Proxy configured? | stdout | exit | Effect |
| --- | --- | --- | --- | --- |
| no PII | — | empty | 0 | prompt continues silently |
| has PII | yes | `{"hookSpecificOutput": {"additionalContext": "..."}}` | 0 | prompt continues; proxy masks at HTTP layer |
| has PII | no | `{"decision":"block","reason":"..."}` | 0 | prompt is cancelled; user sees reason |
| stdin invalid / init failed | — | `{"decision":"block","reason":"..."}` + stderr | 2 | fail-closed |

"Proxy configured" = `ANTHROPIC_BASE_URL` points to a localhost URL whose
path starts with `/anthropic/`, **or** `PII_REMOVER_PROXY_TRUST=1` is set.
Codex has no base-URL env override, so Codex users typically need to set
`PII_REMOVER_PROXY_TRUST=1` after configuring `openai_base_url` in
`config.toml`.

## Configuration lookup chain

The hook reads the first existing file in this order:

1. `<cwd>/.opencode/pii-remover.json`
2. `<cwd>/.codex/pii-remover.json`
3. `<cwd>/.pii-remover.json`
4. `~/.config/opencode/pii-remover.json`
5. `~/.codex/pii-remover.json`
6. `~/.config/pii-remover/config.json`
7. `DEFAULT_CONFIG` (see [`@pii-remover/core`])

## Environment variables

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_BASE_URL` | Inspected to decide if the proxy is configured (Claude Code). |
| `PII_REMOVER_PROXY_TRUST=1` | Trust that a proxy is running regardless of base URL (Codex users typically need this). |
| `PII_REMOVER_BYPASS=1` | Disable masking entirely (NOT recommended; see [ADR-0006]). |

[`@pii-remover/core`]: ../core/src/config/schema.ts
[ADR-0006]: ../../docs/ADR/0006-fail-closed-default.md

## Bun-compiled single binary

```bash
bun run compile:linux-x64
bun run compile:darwin-arm64
bun run compile:darwin-x64
bun run compile:windows-x64
```

## Tests

```bash
bun test packages/cli/tests
```

| Test file | Focus |
| --- | --- |
| `protocol.test.ts` | stdin JSON parsing + proxy detection |
| `hook.test.ts` | end-to-end hook decisions |
| `install.test.ts` | Claude Code + OpenCode install |
| `codex-install.test.ts` | TOML patch + Codex install |
| `detect.test.ts` | masking CLI |
| `health.test.ts` | proxy health check |
| `cli.test.ts` | CLI router + flag parsing |
| `regression-honorific.test.ts` | "안녕 김철수님 반갑습니다" round-trip |

## Limits / v1.x backlog

- Hook **cannot** replace the prompt on any supported host. Use the proxy
  for actual masking.
- Hook input only fires on `UserPromptSubmit`. Tool inputs (Bash, etc.)
  are masked by `@pii-remover/opencode-plugin`'s `tool.execute.before`,
  not by this CLI.
- Package was originally `@pii-remover/claude-hook` (v0.1.0). Renamed
  to `@pii-remover/cli` once it grew multi-host coverage.
