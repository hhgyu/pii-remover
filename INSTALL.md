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
