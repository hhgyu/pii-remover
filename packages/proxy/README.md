# @pii-remover/proxy — reference implementation (not shipped)

> **This package is no longer a runtime.** The proxy that actually runs is the
> Python port in [`packages/backend`](../backend), served on the same port as
> detection (`8000`). Start it with
> `docker compose -f packages/backend/docker-compose.yml up -d`.
>
> This package is kept, unpublished (`"private": true`), for two jobs that
> nothing else can do:
>
> 1. **It is the source of truth for the golden vectors.**
>    `scripts/gen-*-vectors.ts` import from here to generate the fixtures in
>    `packages/backend/tests/fixtures/`, which are what prove the Python port
>    byte-identical. Delete this package and the port becomes unverifiable.
> 2. **The eval harness's streaming mutator** imports `findUnsafeBoundary` and
>    `createStreamBuffer` from here.
>
> The `pii-remover-proxy` binary and its `start` / `health` commands were
> removed along with `src/cli.ts`. The programmatic `startProxy()` remains for
> the tests below.

The sections that follow describe the TypeScript behaviour that the Python port
reproduces. They are the specification the parity tests check against.

- **License**: Apache-2.0
- **Related ADRs**:
  - [ADR-0004](../../docs/ADR/0004-local-llm-proxy-streaming.md) — proxy architecture, path-prefix routing, streaming algorithm
  - [ADR-0005](../../docs/ADR/0005-backend-strategy-trust-tiers.md) — backend trust tiers
  - [ADR-0011](../../docs/ADR/0011-message-part-updated-feasibility.md) — why both proxy & OpenCode plugin

## Path-prefix routing

Single port `8765`, providers selected by URL prefix (ADR-0004):

| Client sends to | Proxy forwards to | Masked? |
| --- | --- | --- |
| `POST /anthropic/v1/messages` | `https://api.anthropic.com/v1/messages` | ✅ |
| `POST /openai/v1/chat/completions` | `https://api.openai.com/v1/chat/completions` | ✅ |
| `POST /openai/v1/responses` | `https://api.openai.com/v1/responses` | ✅ |
| `POST /codex/v1/responses` | `https://api.openai.com/v1/responses` | ✅ |
| `POST /openai/v1/embeddings` | passthrough (no transform) | — |
| other `/openai/*`, `/codex/*` paths (e.g. `/openai/v1/responses/resp_123`) | same host | passthrough |
| `GET /health` | `{ ok, version, providers: ["anthropic", "openai"] }` | — |

`/openai/v1/responses` and `/codex/v1/responses` are exact-match routes
carrying the same OpenAI Responses API body — OpenCode's built-in OpenAI
provider posts to the first, Codex CLI to the second — so they share one
**transform** (masking + restoration), but keep distinct upstream bases and
distinct audit `provider` identity (`openai` vs `codex`). Only that exact
path is masked; child resource paths such as `/openai/v1/responses/resp_123`
carry no prompt to mask and stay passthrough.

## Streaming (SSE)

When the client request carries `stream: true`, the proxy:

1. Masks the request body as usual (request side is byte-identical to the non-streaming case).
2. Pipes the upstream `text/event-stream` body through `AnthropicSseTransformer` / `OpenAISseTransformer`.
3. Each delta is parsed, the text content is fed into a **token-boundary buffer** that holds back any incomplete `__OPF_*__` prefix until the rest of the chunk arrives (ADR-0004 §12.3.3, see `src/stream/buffer.ts`).
4. Once a token is complete, the buffered text passes through `PIIRemover.restore()` and the restored slice is re-encoded into the SSE delta back to the client.
5. On stream end (`message_stop` or `[DONE]`), the buffer is flushed with lenient restoration so partial-suffix tokens (`__OPF_EMAIL_1`) still resolve.

The buffer is verified by **22 fuzz tests** that split tokens 1, 2, 3, 5
chars at a time across simulated SSE deltas — all reassemble losslessly.

## What gets masked

| Direction | Anthropic | OpenAI Chat | Responses API (OpenAI + Codex) |
| --- | --- | --- | --- |
| Request → upstream | `messages[].content` (string + `{type:"text"}` parts), `system` (string + array) | `messages[].content` (string + `{type:"text"}` parts) | `instructions`, `input` (string + items) |
| Response ← upstream (non-streaming) | `content[].text` + **`content[].tool_use.input`** (JSON walk) | `choices[].message.content` (string + array) and `choices[].message.tool_calls[].function.arguments` (JSON walk) | `output[].content[].text` + **`output[].arguments`** (JSON walk) |
| Response ← upstream (streaming) | `content_block_delta.delta.text` (per `index`) + **`content_block_delta.delta.input_json_delta`** (accumulated per block, restored on `content_block_stop`) | `choices[].delta.content` (per choice index) + **`choices[].delta.tool_calls[].function.arguments`** (accumulated per `choiceIdx:tcIdx`, restored on stream close) | `response.output_text.delta` + **`response.function_call_arguments.delta`** (accumulated per `output_index`, restored on `done` event) |
| Always **passthrough** | `image` / `image_url` parts (Phase 6, ADR-0009) | same | — |

## Sessions

The proxy runs a `ProxySessionPool` keyed on the optional `X-PII-Session`
request header:

- Header absent → shared `proxy:default` session vault. Multi-provider tokens stay consistent across Anthropic ↔ OpenAI within the same proxy process.
- Header present → isolated `proxy:<value>` vault (max 128 chars).

Vault disposal happens on `proxy.stop()`.

## Programmatic API

```ts
import { startProxy, ProxySessionPool } from "@pii-remover/proxy";
import { LocalRegexBackend } from "@pii-remover/core";

const proxy = await startProxy({
  port: 8765,
  backends: [new LocalRegexBackend()],
  upstream: {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
  },
});
// proxy.url, proxy.host, proxy.port, proxy.sessions
await proxy.stop();
```

## Security

- **127.0.0.1 bind only** by default (`host` override only for trusted scenarios).
- **No header logging** — `Authorization` / `x-api-key` / `anthropic-api-key` / `openai-api-key` / `cookie` are forwarded verbatim but **never** emitted to stdout/stderr (unit-tested). Use `safeHeaderLog()` if you must dump headers for diagnostics; it redacts those names.
- **No body logging** — request and response bodies stay in memory.
- **Hop-by-hop strip** — `Connection`, `Keep-Alive`, `Transfer-Encoding`, `Host`, `Content-Length` are not relayed. `Content-Encoding` is stripped from upstream responses so clients never double-decode.

## Testing

```bash
bun test packages/proxy/tests
# or full workspace:
bun test
```

All proxy tests use mock upstream (`fetch_impl` injection) — no real
Anthropic/OpenAI calls. The streaming tests construct in-memory SSE chunks
to validate token-boundary recovery across delta boundaries.

| Test file | Tests | Focus |
| --- | --- | --- |
| `router.test.ts` | 6 | path prefix → provider |
| `headers.test.ts` | ~12 | hop-by-hop strip + redaction logging |
| `session.test.ts` | 5 | default/per-session vault pool |
| `anthropic-non-streaming.test.ts` | 10 | request mask + response restore |
| `openai-non-streaming.test.ts` | 8 | including tool_calls JSON walk |
| `stream-buffer.test.ts` | 29 | findUnsafeBoundary + 21 fuzz cases |
| `stream-sse.test.ts` | 14 | Anthropic/OpenAI SSE transformer units |
| `e2e-streaming.test.ts` | 2 | full SSE round-trip Anthropic + OpenAI |
| `cli.test.ts` | 9 | flag parsing + commands |

## Phase 3 → 4 handoff

Implemented:
- HTTP server + path-prefix routing
- Anthropic / OpenAI **non-streaming + streaming** round-trip
- Token-boundary buffering for SSE deltas (ADR-0004 §12.3.3)
- Multi-provider shared vault
- ~~CLI (`pii-remover-proxy start/health/version`)~~ — removed; the runtime is now `packages/backend`
- Header pass-through + redaction-on-log

Coming in **Phase 4** ([ROADMAP](../../docs/ROADMAP.md#phase-4--claude-code-hook-통합)):
- `@pii-remover/cli` package — `UserPromptSubmit` hook (Claude Code + Codex) + `ANTHROPIC_BASE_URL` / `openai_base_url` proxy hand-off
- Daemonization (`start --detach`) and a PID file for `stop` / `status`

## Known limits / v1.x backlog

- Streaming `tool_calls.function.arguments` (fragmented JSON across deltas) — non-streaming path handles tool calls; streaming path passes them through unchanged. Live tool-call restoration ships in v1.x.
- Real network round-trip (`PII_REMOVER_PROXY_E2E_LIVE=1`) is not yet wired — all tests use mock upstream.
