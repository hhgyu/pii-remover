# PII Remover

> Local security layer that **auto-masks PII** in prompts your AI coding tool sends to LLMs, and **restores the originals** in the response. Works with **Claude Code**, **OpenCode**, and **OpenAI Codex CLI**.

**Languages**: **English** · [한국어](./README.ko.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
[![Tests](https://img.shields.io/badge/tests-659%20pass-brightgreen.svg)](#tests)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](packages/core)

```
┌────────┐   plaintext PII   ┌────────────┐   masked tokens   ┌──────────┐
│  user  │ ─────────────▶ │ PII Remover │ ─────────────▶ │   LLM    │
└────────┘                  └────────────┘                  └──────────┘
                                  │                              │
                                  │  vault: __OPF_PERSON_1__     │
                                  ▼                              │
                             ┌─────────┐                         │
                             │ restore │ ◀───── tokens ──────────┘
                             └─────────┘
                                  │
                                  ▼
                            user screen (original PII)
```

## Features

- **Round-trip**: user input → mask → LLM → token restore on response → user sees original PII
- **OPF 8 categories + 3 Korean PII categories** (11 total): English NER via the OpenAI Privacy Filter model + Korean regex with checksums (RRN, business number, credit card LUHN) + Korean name heuristic / KLUE-NER
- **Three host integrations**:
  - **Claude Code** — `UserPromptSubmit` hook + `ANTHROPIC_BASE_URL` proxy
  - **OpenCode** — `tool.execute.before/after` + `experimental.text.complete` + `experimental.chat.messages.transform` (LLM-boundary remask) in-process plugin
  - **OpenAI Codex CLI** — `UserPromptSubmit` hook + `openai_base_url` Responses API proxy
- **Live SSE streaming**: token-boundary buffering rebuilds masking tokens even when the LLM splits them across SSE deltas
- **Interactive UI restoration**: display tools (`question`, `todowrite`, and MCP `*_question` / `*_todowrite` variants) restore PII tokens in args before the UI renders them, so users see their original input — the LLM-boundary remask still prevents raw PII from reaching external APIs ([ADR-0015](./docs/ADR/0015-display-tool-restoration.md)).
- **Vision / multimodal**: image OCR → region masking (Phase 6, Tesseract backend)
- **Fail-closed by default**: PII-containing prompts are blocked when the proxy is not configured. Explicit `PII_REMOVER_BYPASS=1` to override.
- **Local-first**: self-hosted Docker backend recommended. Remote backends are opt-in under a 4-tier trust model.
- **Audit logging** (opt-in): structured JSONL audit trail records mask/restore/bypass/block events with category counts — never logs PII plaintext. Toggle at runtime with `PII_REMOVER_AUDIT=true/false` (overrides config).

## Quick Start

### 1) Start the detection backend

```bash
cd packages/backend
docker compose up --build   # ~5-10 min the first time (model weights)
```

### 2) Install for your host

**Claude Code**:
```bash
npx @pii-remover/cli install --target claude-code
pii-remover-proxy start &
export ANTHROPIC_BASE_URL=http://localhost:8765/anthropic/v1
```

**OpenCode**:
```bash
npx @pii-remover/cli install --target opencode
```

Writes two `file://` plugin entries (mask first, restore last) into
`opencode.json` so PII is masked before any other OpenCode plugin reads
tool args and restored after every plugin's `tool.execute.after` has run.
Re-running is idempotent and survives hand-edits to the array.

**OpenAI Codex CLI**:
```bash
npx @pii-remover/cli install --target codex --proxy-url http://localhost:8765/codex/v1
pii-remover-proxy start &
export PII_REMOVER_PROXY_TRUST=1
```

See [`INSTALL.md`](./INSTALL.md) for the full installation guide.

## Packages

Bun + TypeScript workspace monorepo:

| Package | Role |
|---|---|
| [`@pii-remover/core`](./packages/core) | Host-agnostic core: detector, vault, restorer, backend strategy |
| [`@pii-remover/cli`](./packages/cli) | Multi-host CLI: `UserPromptSubmit` hook (Claude Code + Codex) + installer |
| [`@pii-remover/opencode-plugin`](./packages/opencode-plugin) | OpenCode plugin (in-process tool/message hooks) |
| [`@pii-remover/proxy`](./packages/proxy) | Local LLM proxy: Anthropic / OpenAI Chat / Codex Responses API routing |
| [`@pii-remover/vision`](./packages/vision) | Image OCR PII redaction client (Phase 6) |
| `packages/backend` | Python FastAPI backend (OPF + KLUE NER + Tesseract OCR Docker image) |

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Host Integration Layer                                          │
│  ┌──────────────┐  ┌─────────────────────┐  ┌──────────────┐    │
│  │ Claude Code  │  │   OpenCode plugin    │  │ Codex CLI    │    │
│  │ + hook       │  │   (in-process)       │  │ + hook       │    │
│  └──────┬───────┘  └──────┬──────────────┘  └──────┬───────┘    │
│         │                 │                        │            │
│         │     ┌───────────┴──────────┐             │            │
│         └────▶│   @pii-remover/cli   │◀────────────┘            │
│               │   hook binary        │                          │
│               └───────────┬──────────┘                          │
│                           │                                     │
│  ┌────────────────────────▼────────────────────────┐           │
│  │  @pii-remover/proxy (Anthropic + OpenAI + Codex)│           │
│  │  - request mask  - response restore  - SSE      │           │
│  └────────────────────────┬────────────────────────┘           │
└───────────────────────────┼────────────────────────────────────┘
                            │
                            ▼
            ┌────────────────────────────┐
            │   @pii-remover/core        │
            │   Detector / Vault / Restorer
            └────────────┬───────────────┘
                         │
                         ▼ HTTP /redact
            ┌────────────────────────────┐
            │   Detection backend         │
            │   (OPF + KLUE NER + OCR)    │
            └────────────────────────────┘
```

Full design in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Backend lifecycle (auto-start + idle unload) — ADR-0019

The detection backend (Docker) can be auto-started by the plugin/proxy/CLI and automatically releases model weights when idle.

### Auto-start (opt-in, fail-closed)

Set in `pii-remover.json` (same shape as the default config — see [`packages/core/src/config/schema.ts`](./packages/core/src/config/schema.ts)):
```jsonc
{
  "backend": {
    "endpoint": "<your backend /redact URL>",
    "auto_start": true,            // default: false (opt-in)
    "compose_file": "cpu",          // "cpu" | "gpu" | "<absolute path>"
    "start_timeout_ms": 60000       // health-poll deadline after `docker compose up -d`
  }
}
```

When `auto_start: true`, the plugin / `pii-remover-proxy start` / `pii-remover hook`:
1. Probes `<endpoint>/health` (1.5s timeout) — if already healthy, skips spawn.
2. Otherwise runs `docker compose -f <resolved-path> up -d`.
3. Polls `/health` until `model_loaded: true` (or `start_timeout_ms` elapses).
4. Any failure (Docker missing / daemon down / compose missing / timeout) raises **`FailClosedError`** — consistent with `failure_policy: "closed"`.

### Idle model unload (default-on, 30 min)

Backend-side; `OpfRunner.unload()` + `KoreanNerRunner.unload()` release ONNX session references when `/redact*` has been idle longer than `OPF_IDLE_TIMEOUT_SECONDS`. The container stays up; the next `/redact` request lazy-reloads (~1-3 s cold start).

| Env var | Default | Effect |
| --- | --- | --- |
| `OPF_IDLE_TIMEOUT_SECONDS` | `1800` (30 min) | Idle-unload threshold. `0` disables (model permanently resident). |
| `OPF_IDLE_CHECK_INTERVAL_SECONDS` | `60` | Background monitor polling interval. |

`/health` reports the live state:
```json
{
  "ok": true,
  "model_loaded": false,
  "idle_unloaded": true,
  "idle_timeout_seconds": 1800,
  "seconds_since_last_request": 1842.7
}
```

> **Note**: `/health` requests do NOT count as activity — Docker `HEALTHCHECK` polls don't keep the model loaded. Only `/redact*` requests bump the idle timer.

## Security Model

- **The hook cannot replace the prompt** (both Claude Code and Codex are source-verified). Masking always happens at the proxy. The hook is detection + fail-closed gate only.
- **Vault is in-memory, project-scoped**: process memory only, never persisted to disk. Lives for the host process lifetime (all chat/subagent sessions of a project share it — required so subagents can restore tokens minted in the parent session); tokens that survive a process restart in persisted history are neutralized to `[UNRESTORABLE]` at the LLM boundary.
- **Token format `__OPF_<CATEGORY>_<INDEX>__`**: identifier-safe — survives translation, Markdown formatting, and code generation contexts.
- **4-tier backend trust model**: localhost (default) → self-hosted+TLS → vendor+DPA → public SaaS (discouraged). See [`docs/TRUST_TIERS.md`](./docs/TRUST_TIERS.md).
- **Fail-closed by default**: any detection failure blocks the LLM call. `PII_REMOVER_BYPASS=1` is the only escape.
- **Audit logging** (disabled by default): structured JSONL records `mask` / `restore` / `bypass` / `block` / `error` events with ISO timestamps, category counts (`{ private_email: 2, rrn: 1 }`), vault ID, backend name, latency, and provider — **no PII plaintext ever written**. Enable via config (`audit.enabled: true` + `audit.log_path`) or toggle at runtime with `PII_REMOVER_AUDIT=true/false`.
- **Compaction-safe**: when the host compresses conversation history, PII tokens in compaction summaries are replaced with `[REDACTED]` (fail-closed strip). The system prompt also instructs the LLM to preserve `__OPF_*__` tokens verbatim during summarization — dual defense.

## Detected categories

| Category | Examples | Backend |
|---|---|---|
| `private_person` | 김철수, John Doe | OPF NER + Korean surname heuristic + KLUE-NER (v2) |
| `private_email` | user@example.com | OPF + regex |
| `private_phone` | 010-1234-5678 | OPF + Korean 010/011/016-9 regex |
| `private_address` | postal addresses | OPF |
| `account_number` | account / ID numbers | OPF |
| `private_date` | DOB | OPF |
| `private_url` | private/internal URLs | OPF |
| `secret` | API keys (AWS, OpenAI, Anthropic, Google, Stripe, GitLab, SendGrid, DigitalOcean, Twilio, Shopify, Postman, Databricks, PyPI, Mailgun, Discord, Telegram, Slack), GitHub tokens (PAT/OAuth/fine-grained/refresh), PEM private keys, JWT, npm tokens, connection strings with passwords | OPF + regex |
| `rrn` | Korean 주민등록번호 | weight `[2,3,4,5,6,7,8,9,2,3,4,5]` checksum |
| `biz_num` | Korean 사업자등록번호 | weight `[1,3,7,1,3,7,1,3,5]` checksum |
| `card` | Credit card | LUHN |

Korean PII algorithm details: [`docs/KOREAN_PII.md`](./docs/KOREAN_PII.md).

## Tests

```bash
bun test
# 659 pass / 0 fail / 1 skip (44 files, 3945 expect calls)
```

| Verification | Status |
|---|---|
| English PII round-trip ≥ 95% accuracy (50-case corpus) | ✅ |
| Korean PII round-trip ≥ 98% accuracy (100-case corpus) | ✅ |
| SSE token-split fuzz (delta 1-3 chars) | ✅ (22 cases) |
| TLS pinning fingerprint match/mismatch | ✅ |
| Tiered redaction: 0 Korean PII leaks to remote backend | ✅ |
| Auth headers never logged to stdout/stderr | ✅ |
| `UserPromptSubmit` hook decision matrix (Claude/Codex) | ✅ |

## Build

```bash
bun install
bun run build         # tsc across 5 packages
bun run typecheck     # tsc --noEmit
```

CLI single-file binary:
```bash
cd packages/cli
bun run compile:linux-x64
bun run compile:darwin-arm64
bun run compile:darwin-x64
bun run compile:windows-x64
```

## Documentation

- [INSTALL.md](./INSTALL.md) — installation guide
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — system design, data flow, security model
- [docs/ROADMAP.md](./docs/ROADMAP.md) — phase-by-phase milestones
- [docs/KOREAN_PII.md](./docs/KOREAN_PII.md) — Korean PII detection algorithm
- [docs/TRUST_TIERS.md](./docs/TRUST_TIERS.md) — 4-tier trust model operations guide
- [docs/ADR/](./docs/ADR/) — Architecture Decision Records (15 entries)

## Audit Logging

Audit logging records PII processing events (mask/restore/bypass/block/error) to a JSONL file **without ever writing PII plaintext**. Disabled by default.

```jsonc
// .pii-remover.json
{
  "audit": {
    "enabled": true,
    "log_path": "/var/log/pii-remover/audit.jsonl"
  }
}
```

Runtime toggle (overrides config):
```bash
PII_REMOVER_AUDIT=true  pii-remover-proxy start   # force on
PII_REMOVER_AUDIT=false pii-remover-proxy start   # force off
```

Sample entry:
```json
{"timestamp":"2025-05-17T12:00:00.000Z","event":"mask","vault_id":"a1b2","session_id":"session_x","categories":{"private_email":2,"rrn":1},"backend_name":"local-regex","latency_ms":3.2,"policy_result":"masked","provider":"anthropic"}
```

## License

Apache-2.0
