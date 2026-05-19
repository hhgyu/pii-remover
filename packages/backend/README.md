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

Replace the `your-org` placeholder in `docker-compose.yml` and
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
