# @pii-remover/backend

Self-built Docker image for the `pii-remover` detection backend. Wraps the
[`openai/privacy-filter`](https://huggingface.co/openai/privacy-filter) (OPF)
token-classification model behind a FastAPI HTTP API whose surface is
compatible with the **gh0stkey OPF HTTP API** (see
[ADR-0008](../../docs/ADR/0008-detection-backend-self-built-docker.md)).

- **License**: Apache-2.0 (this package's code) — same as the underlying OPF
  model and the project at large.
- **Status**: Phase 1 MVP — text only. Vision/multimodal redaction lands in
  Phase 6 (see [ADR-0009](../../docs/ADR/0009-vision-multimodal-v2.md)) and
  is **not** implemented here.

## Image variants

| Tag suffix       | Base                                | Weights           | First boot   | Image size |
| ---------------- | ----------------------------------- | ----------------- | ------------ | ---------- |
| (default)        | `python:3.11-slim`                  | Pre-baked         | ~10s         | ~5-6 GB    |
| `:latest-gpu`    | `nvidia/cuda:12.1.1-runtime`        | Pre-baked         | ~10s         | ~6-7 GB    |
| `:latest-slim`   | `python:3.11-slim`                  | Downloaded on boot | ~5-10 min   | ~500 MB    |

The corresponding Dockerfiles are `Dockerfile`, `Dockerfile.gpu`, and
`Dockerfile.slim`.

## Quick start (CPU, default)

```bash
cd packages/backend
docker compose up --build
```

First build pre-downloads the OPF weights (~5 GB) into the image — expect
**5-10 minutes** on a typical home connection. Once the image is built,
subsequent `docker compose up` calls boot in seconds because the weights
live in the image and the HF cache volume is mounted across restarts.

When healthy, exercise the API:

```bash
curl -s http://localhost:8000/health
# {"ok":true,"version":"0.0.1","model":"openai/privacy-filter","device":"cpu","model_loaded":true}

curl -s -X POST http://localhost:8000/redact \
  -H 'content-type: application/json' \
  -d '{"text":"Email alice@example.com about the meeting."}'
# {"detections":[{"start":6,"end":23,"label":"private_email","score":0.99,"text":"alice@example.com"}],
#  "redacted_text":"Email [OPF:PRIVATE_EMAIL] about the meeting."}

curl -s -X POST http://localhost:8000/redact/text \
  -H 'content-type: application/json' \
  -d '{"text":"Call John Smith at +1-415-555-0142."}'
# Call [OPF:PRIVATE_PERSON] at [OPF:PRIVATE_PHONE].

curl -s -X POST http://localhost:8000/redact/batch \
  -H 'content-type: application/json' \
  -d '{"texts":["foo@bar.com","just plain text"]}'
```

## GPU variant

```bash
cd packages/backend
docker compose -f docker-compose.gpu.yml up --build
```

Requires a host with the NVIDIA Container Toolkit installed and a CUDA
12.1-compatible driver.

## LLM proxy (same port)

This service also hosts the local LLM proxy (ADR-0004), so `docker compose up`
brings up detection **and** the masking proxy as one container on one port.
Providers are selected by path prefix:

| Client sends to | Forwarded to | Body |
| --- | --- | --- |
| `POST /anthropic/v1/messages` | `api.anthropic.com/v1/messages` | masked / restored |
| `POST /openai/v1/chat/completions` | `api.openai.com/v1/chat/completions` | masked / restored |
| `POST /codex/v1/responses` | `api.openai.com/v1/responses` | masked / restored |
| `/anthropic/api/*`, other `/openai/*`, `/codex/*` | same host | relayed untouched |

Point your client at it:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8000/anthropic/v1
export OPENAI_API_BASE=http://localhost:8000/openai/v1
```

Streaming works: tokens split across SSE deltas are buffered and reassembled
before restoration, so the client never sees a half-token.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PII_PROXY_ENABLED` | `0` | Master switch. **Off by default** — this image also ships as a standalone shared detection backend, and enabling an outbound proxy there would start relaying callers' API keys. The bundled compose sets it to `1`. |
| `PII_REMOVER_TOKEN_KEY` | (unset) | Secret the token HMAC is derived from. Must match the host-side hook's key. |
| `PII_PROXY_ANTHROPIC_UPSTREAM` | `https://api.anthropic.com` | Upstream override |
| `PII_PROXY_OPENAI_UPSTREAM` | `https://api.openai.com` | Upstream override |
| `PII_PROXY_CODEX_UPSTREAM` | `https://api.openai.com` | Upstream override |
| `PII_PROXY_BUFFER_WINDOW` | `64` | SSE token-boundary lookback |
| `PII_PROXY_TIMEOUT_SECONDS` | `600` | Upstream timeout; LLM streams run for minutes |

### Two things that will bite you

**Know what the published port exposes.** The bundled compose publishes
`8000:8000`, i.e. on every interface. That was fine when this image only did
detection; with `PII_PROXY_ENABLED=1` the same port also relays the caller's
`Authorization` header upstream and serves PII vaults whose `X-PII-Session`
header is *not* authenticated — any caller that reaches the port can name any
session and read that vault back. There is no auth in front of it.

On a machine that is not alone on a trusted network, pick one:

```yaml
ports:
  - "127.0.0.1:8000:8000"   # single-user workstation: proxy stays local
```

```yaml
environment:
  PII_PROXY_ENABLED: "0"    # shared server: detection only, as before
```

**Set `PII_REMOVER_TOKEN_KEY`.** Tokens are `HMAC(key, category + text)`, so the
key decides the token. The TypeScript hook running on the host and this
container must derive the same key or neither can restore the other's tokens.
Leave it unset and the container mints a fresh key on every start, so nothing
survives a restart.

## HTTP API

All endpoints accept and return `application/json` unless noted otherwise.

### `GET /health`

```json
{
  "ok": true,
  "version": "0.0.1",
  "model": "openai/privacy-filter",
  "device": "cpu",
  "model_loaded": true
}
```

`model_loaded` is `false` between container start and weight load completion.
Docker `HEALTHCHECK` uses this endpoint; the `start_period` is set to 120s
for the prebuilt images and 900s for `:slim` so the first download doesn't
trip the restart policy.

### `POST /warmup`

Forces a synchronous lazy-reload of the OPF runner (and the Korean NER
runner when configured). Designed for the TypeScript core's auto-start
flow ([ADR-0019](../../docs/ADR/0019-backend-auto-start-and-idle-unload.md)):
when the container is up but the model has been idle-unloaded, the
client calls `/warmup` with a generous timeout so the user's first
`/redact` hits a warm model.

Idempotent — already-loaded runners return immediately. `/warmup` does
not count as `/redact` activity (the idle timer is not bumped).

Response (success):
```json
{
  "ok": true,
  "model_loaded": true,
  "korean_ner_loaded": true,
  "elapsed_ms": 1342.8,
  "warnings": []
}
```

Korean NER failures are non-fatal — `/redact` falls through to OPF +
regex without it. The failure is reported via `warnings`:
```json
{
  "ok": true,
  "model_loaded": true,
  "korean_ner_loaded": false,
  "elapsed_ms": 850.1,
  "warnings": ["korean_ner_load_failed: <reason>"]
}
```

OPF load failures map to `503`:
```json
{ "detail": "OPF load failed: <reason>" }
```

### `POST /redact`

Request:
```json
{ "text": "Email alice@example.com about the meeting." }
```

Response:
```json
{
  "detections": [
    { "start": 6, "end": 23, "label": "private_email", "score": 0.99, "text": "alice@example.com" }
  ],
  "redacted_text": "Email [OPF:PRIVATE_EMAIL] about the meeting."
}
```

`label` is one of the eight OPF categories (see
[ADR-0010](../../docs/ADR/0010-pii-categories-opf-plus-korean.md)):
`account_number`, `private_address`, `private_email`, `private_person`,
`private_phone`, `private_url`, `private_date`, `secret`.

> The `redacted_text` placeholders use a stateless `[OPF:<LABEL>]` form. The
> TypeScript core (see ADR-0002) is responsible for promoting them to the
> reversible `__OPF_<CATEGORY>_<INDEX>__` form against a vault.

### `POST /redact/text`

Same input as `/redact`; returns the redacted body as `text/plain`. Useful
for shell pipelines.

### `POST /redact/batch`

Request:
```json
{ "texts": ["foo@bar.com", "plain text"] }
```

Response:
```json
{
  "results": [
    { "detections": [ ... ], "redacted_text": "[OPF:PRIVATE_EMAIL]" },
    { "detections": [], "redacted_text": "plain text" }
  ]
}
```

The batch size is capped by `OPF_BATCH_MAX` (default `32`); over-sized
requests return `413`.

## Configuration

All settings are environment variables consumed by `server.config.Settings`:

| Variable             | Default                | Purpose                                  |
| -------------------- | ---------------------- | ---------------------------------------- |
| `OPF_DEVICE`         | `cpu`                  | `cpu` \| `cuda` \| `mps`                 |
| `OPF_HOST`           | `0.0.0.0`              | Uvicorn bind address                     |
| `OPF_PORT`           | `8000`                 | Uvicorn bind port                        |
| `OPF_MODEL_ID`       | `openai/privacy-filter`| HuggingFace model id                     |
| `OPF_MODEL_REVISION` | (unset)                | Pin a specific HF revision/hash          |
| `OPF_HF_CACHE_DIR`   | (unset)                | Override HF cache dir                    |
| `OPF_BATCH_MAX`      | `32`                   | Max texts per `/redact/batch` request    |
| `OPF_LOG_LEVEL`      | `info`                 | uvicorn / app log level                  |

## Local development

```bash
cd packages/backend
python -m venv .venv
. .venv/Scripts/activate   # PowerShell on Windows: . .venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
pytest                    # unit tests use a mocked OPF runner (no downloads)
ruff check .
mypy server
```

The tests never download the real model — a regex-based `FakeOpfRunner`
covers the API plumbing. The real weight download only happens during a
Docker build or the first run of a `:slim` container.

## Release / CI

Multi-arch builds and GHCR pushes are wired up in
[`.github/workflows/backend-build.yml`](../../.github/workflows/backend-build.yml).
The workflow:

- triggers on `push` to `main` and on `v*` tags;
- builds `linux/amd64` + `linux/arm64`;
- caches the HuggingFace download via `actions/cache`;
- pushes to `ghcr.io/<owner>/pii-remover-backend`.

Replace the `hhgyu` placeholder in `docker-compose.yml` and
`docker-compose.gpu.yml` with the actual GHCR org once it is allocated.

## Why not use `gh0stkey/opf-privacy-filter` directly?

Short version: supply-chain control, license clarity, and patch freedom.
The long answer lives in [ADR-0008](../../docs/ADR/0008-detection-backend-self-built-docker.md).
We do, however, intentionally remain **API-compatible** with that image so
the two are drop-in interchangeable for operators.

## Phase 6 (vision) is out of scope here

Image redaction (`/redact/image`, OCR + Pillow boxing) is tracked under
Phase 6 / ADR-0009 and lives behind a future feature flag. This package
intentionally ships text-only.

## Related ADRs

- [ADR-0002](../../docs/ADR/0002-token-format-opf-underscore.md) — token format `__OPF_<CATEGORY>_<INDEX>__`
- [ADR-0005](../../docs/ADR/0005-backend-strategy-trust-tiers.md) — backend trust tiers
- [ADR-0008](../../docs/ADR/0008-detection-backend-self-built-docker.md) — self-built Docker (this package's charter)
- [ADR-0010](../../docs/ADR/0010-pii-categories-opf-plus-korean.md) — PII category taxonomy
