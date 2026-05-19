# @pii-remover/vision

Thin TypeScript HTTP client for the `@pii-remover/backend` `/redact/image`
endpoint (Phase 6, [ADR-0009](../../docs/ADR/0009-vision-multimodal-v2.md)).

**This package does not do OCR or image masking.** All of that runs
server-side in Python (Tesseract + Pillow inside the Docker backend
container). The client's only responsibilities are: validate the input,
make the HTTP call, integrate detections with the shared `VaultManager`,
and hand the redacted base64 back to the caller.

- **Bundle impact**: zero new dependencies beyond `@pii-remover/core`. Uses the
  runtime's native `fetch`.
- **License**: Apache-2.0.

## Usage

```ts
import { VisionClient } from "@pii-remover/vision";
import { VaultManager } from "@pii-remover/core";

const client = new VisionClient({ backendUrl: "http://localhost:8000" });
const manager = new VaultManager();

const { redacted_image_b64, tokens, warnings } = await client.redactImage(
  {
    image_b64: "<base64>",
    languages: ["kor", "eng"],
    confidence_threshold: 60,
    policy_on_low_confidence: "mask",
  },
  { manager, sessionId: "session-1" }
);

// `redacted_image_b64` is the masked PNG, base64-encoded.
// `tokens` are vault-assigned __OPF_<CATEGORY>_<INDEX>__ tokens, shared
// with text masking inside the same session.
```

## When to use

- You have an image bytes payload and you want masked PNG bytes back, with PII
  region detections.
- You want the image's detected PII to **share tokens** with text PII inside
  the same conversation (so `김철수` mentioned in text and a screenshot
  both resolve to `__OPF_PERSON_1__`).
- You want **client-side bundle size of zero** — heavy lifting stays in the
  backend container.

## When not to use

- You want on-device OCR (no Docker backend). Use a different library — this
  package is intentionally a thin client by design (ADR-0009 §Decision §2).
- You want to mask non-image content (text, PDF). Use `@pii-remover/core`
  (text) or wait for Phase 7+ (PDF, v1.x backlog).

## API

| Member | Purpose |
| --- | --- |
| `VisionClient(opts)` | Construct with `backendUrl` / `timeoutMs` / `fetchImpl`. |
| `redactImage(req, vault?)` | POST `/redact/image`; returns `RedactImageResult`. |
| `healthCheck()` | GET `/health`; returns boolean. |

`RedactImageResult`:
- `redacted_image_b64: string` — masked PNG, base64.
- `tokens: AssignedToken[]` — vault tokens (empty if no `vault` given).
- `raw_detections: ImageDetection[]` — server's raw detections.
- `warnings: string[]` — server warnings (e.g., `policy_on_low_confidence='warn'`).
- `backend_latency_ms: number` — Python side latency.
- `client_latency_ms: number` — round-trip including network.

## Configuration

```ts
new VisionClient({
  backendUrl: "http://backend:8000", // default: http://localhost:8000
  timeoutMs: 30_000,                 // default: 30s
  fetchImpl: customFetch,            // override for tests
});
```

Image size limit: 8 MB (matches the server's MAX_IMAGE_BYTES, see ADR-0009).
Throws `VisionClientError` before the network call if exceeded.

## Tests

```bash
bun test packages/vision/tests
```

9 unit tests cover: happy path, vault integration, base64 validation,
size limit, HTTP 400 / malformed response handling, health check, and
cross-call token sharing.

## Related

- [ADR-0009](../../docs/ADR/0009-vision-multimodal-v2.md) — image masking via Docker backend
- [`@pii-remover/backend`](../backend/README.md) — server-side OCR + Pillow pipeline
- [`@pii-remover/core`](../core) — VaultManager + token format
- Phase 6 [ROADMAP](../../docs/ROADMAP.md#phase-6--visionmultimodal-pii-마스킹-becoolme-패턴-docker-백엔드-통합)
