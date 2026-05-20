# pii-remover Installation Guide

pii-remover detects and masks PII (personally identifiable information) in AI prompts before they reach the API — protecting sensitive data like names, phone numbers, emails, and Korean RRN from being sent to external LLMs.

## Install for Claude Code

```bash
npx @pii-remover/cli install --target claude-code \
  --endpoint http://localhost:8000/redact \
  --categories private_person,private_email,private_phone,private_address,account_number,private_date,private_url,secret,rrn,biz_num,card
```

For project-level install (committed to repo):

```bash
npx @pii-remover/cli install --target claude-code --scope project \
  --endpoint http://localhost:8000/redact \
  --categories private_person,private_email,private_phone,private_address,account_number,private_date,private_url,secret,rrn,biz_num,card
```

## Install for OpenCode

```bash
npx @pii-remover/cli install --target opencode \
  --endpoint http://localhost:8000/redact \
  --categories private_person,private_email,private_phone,private_address,account_number,private_date,private_url,secret,rrn,biz_num,card
```

This adds `@pii-remover/opencode-plugin` to your `opencode.json` plugin array. The plugin intercepts all prompts via the `experimental.text.complete` hook.

## Install for OpenAI Codex CLI

```bash
npx @pii-remover/cli install --target codex \
  --proxy-url http://localhost:8765/codex/v1 \
  --endpoint http://localhost:8000/redact \
  --categories private_person,private_email,private_phone,private_address,account_number,private_date,private_url,secret,rrn,biz_num,card
```

Codex hook is registered in `~/.codex/config.toml` and `openai_base_url` is set to the proxy automatically. Codex has no env-var override for the base URL — set `PII_REMOVER_PROXY_TRUST=1` after install so the hook trusts the proxy is configured.

> To choose categories interactively, omit `--endpoint` and `--categories` flags.

## Config file locations (where install writes)

| `--target` | `--scope` | Path the installer writes (loader will read this) |
|---|---|---|
| `claude-code` | `global` (default) | `~/.config/pii-remover/config.json` |
| `claude-code` | `project` | `<project>/.pii-remover.json` |
| `opencode` | `global` (default) | `~/.config/opencode/pii-remover.json` |
| `opencode` | `project` | `<project>/.opencode/pii-remover.json` |
| `codex` | `global` (default) | `~/.codex/pii-remover.json` |
| `codex` | `project` | `<project>/.codex/pii-remover.json` |

## Backend lifecycle flags (ADR-0019)

The installer supports four flags that configure backend auto-start and idle-unload behaviour. All are optional and **off** by default — the existing install command continues to work unchanged.

| Flag | Effect on generated `.pii-remover.json` | Default |
| --- | --- | --- |
| `--auto-start` | `backend.auto_start = true` — plugin / proxy / hook will run `docker compose up -d` if `/health` probe fails | `false` |
| `--no-auto-start` | `backend.auto_start = false` (explicit opt-out, useful for overriding existing config) | — |
| `--compose-file <s>` | `backend.compose_file = "<s>"`. `"cpu"` (default), `"gpu"`, or an absolute path to a custom `docker-compose.yml` | `"cpu"` |
| `--start-timeout-ms <n>` | `backend.start_timeout_ms = <n>` — health-poll deadline (ms) after `docker compose up -d` | `60000` |
| `--idle-timeout <seconds>` | **Not written to config** (it's a backend-side env var). Surfaces a copy-paste hint: `OPF_IDLE_TIMEOUT_SECONDS=<n> docker compose up -d`. `0` = disable idle unload. | `1800` (30 min) |

### Examples

Personal dev machine — auto-start + 1 hour idle:

```bash
npx @pii-remover/cli install --target opencode \
  --auto-start \
  --idle-timeout 3600
```

GPU server, CI-friendly (model permanently resident):

```bash
npx @pii-remover/cli install --target claude-code \
  --auto-start \
  --compose-file gpu \
  --start-timeout-ms 120000 \
  --idle-timeout 0
```

Existing install — explicitly turn auto-start off:

```bash
npx @pii-remover/cli install --target opencode --no-auto-start
```

Fail-closed contract: when `--auto-start` is set and the backend cannot be brought up (Docker missing / daemon down / compose missing / health timeout), the plugin/proxy/hook raises `FailClosedError` — consistent with `failure_policy: "closed"`. See [ADR-0019](./docs/ADR/0019-backend-auto-start-and-idle-unload.md).

## Start the proxy (required for actual masking)

The hook detects PII but cannot rewrite prompts — the proxy does the actual masking at the HTTP layer:

```bash
pii-remover-proxy start
```

Per-host setup:

| Host | Configuration |
| --- | --- |
| Claude Code | `export ANTHROPIC_BASE_URL=http://localhost:8765/anthropic/v1` |
| OpenCode | plugin handles masking directly (proxy optional) |
| Codex | `openai_base_url = "http://localhost:8765/codex/v1"` in `~/.codex/config.toml` (set automatically by `install --target codex --proxy-url`) |

Without the proxy, the hook **blocks** any prompt containing PII (fail-closed).
With the proxy, PII is masked before the request leaves your machine.

## Verify

```bash
# Should be blocked (PII, no proxy running):
claude -p "Please contact user@example.com"

# Should pass (no PII):
claude -p "What is the weather today?"

# Check proxy connectivity:
npx @pii-remover/cli health
```

## Detected PII categories

| Category | Examples |
|---|---|
| `private_person` | Names (김철수, John Doe) |
| `private_email` | user@example.com |
| `private_phone` | 010-1234-5678, +1-555-000-0000 |
| `private_address` | Street addresses |
| `account_number` | Account / ID numbers |
| `private_date` | Dates of birth |
| `private_url` | Private URLs |
| `secret` | API keys, AWS keys, GitHub PATs |
| `rrn` | Korean 주민등록번호 |
| `biz_num` | Korean 사업자번호 |
| `card` | Credit / debit card numbers |

## Configuration

Edit `.pii-remover.json` (or `.codex/pii-remover.json` / `.opencode/pii-remover.json`):

```json
{
  "backend": {
    "endpoint": "http://localhost:8000/redact"
  },
  "detection": {
    "enabled_categories": ["private_person", "private_email", "private_phone", "secret"]
  }
}
```

Config lookup chain (highest priority first):
1. `<cwd>/.opencode/pii-remover.json`
2. `<cwd>/.codex/pii-remover.json`
3. `<cwd>/.pii-remover.json`
4. `~/.config/opencode/pii-remover.json`
5. `~/.codex/pii-remover.json`
6. `~/.config/pii-remover/config.json`

## Environment variables

| Variable | Effect |
|---|---|
| `ANTHROPIC_BASE_URL` | Set to proxy URL when proxy is running (Claude Code). |
| `PII_REMOVER_PROXY_TRUST=1` | Trust proxy without URL check (Codex users typically need this). |
| `PII_REMOVER_BYPASS=1` | Disable masking entirely (not recommended). |

## Local development install

If working on pii-remover itself:

```bash
# Build first (node runs dist/)
bun run build

# Install from local path
node packages/cli/bin/pii-remover.js install --target claude-code \
  --command-path "$(pwd)/packages/cli/bin/pii-remover.js"
```

> **Windows**: use absolute path with quotes, e.g.:
> `node packages\cli\bin\pii-remover.js install --target claude-code --command-path "D:\Git\pii-remover\packages\cli\bin\pii-remover.js"`
