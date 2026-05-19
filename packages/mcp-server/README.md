# @pii-remover/mcp-server

MCP (Model Context Protocol) server exposing `@pii-remover/core` as 5 tools that any MCP-compatible client can call:

| Tool | Purpose |
|---|---|
| `sanitize` | Mask PII in one text → return `vault_id` |
| `sanitize_batch` | Mask many texts inside one shared vault (token dedup) |
| `desanitize` | Restore PII tokens using `vault_id` |
| `desanitize_batch` | Restore many texts from one vault |
| `analyze` | Detect PII spans without creating a vault (no original text in response) |

Designed for **Claude Desktop, Cursor, Cline, Cody, opencode, Continue, Aider**, or any client that speaks MCP.

See [`docs/ADR/0016-mcp-server-package.md`](../../docs/ADR/0016-mcp-server-package.md) for the design rationale.

## Quick start

### Claude Desktop / Cursor (stdio, recommended)

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```jsonc
{
  "mcpServers": {
    "pii-remover": {
      "command": "npx",
      "args": ["-y", "@pii-remover/mcp-server"]
    }
  }
}
```

Restart Claude Desktop. The 5 tools appear in the tool picker.

### Streamable HTTP (remote / container scenario, opt-in)

Start the server:

```bash
pii-remover-mcp --transport http --port 8766
```

Client config:

```jsonc
{
  "mcpServers": {
    "pii-remover-remote": {
      "url": "http://localhost:8766/mcp"
    }
  }
}
```

### Detection backend

The MCP server delegates detection to `@pii-remover/core`, which by default looks for a local OPF Docker backend on `http://localhost:8000/redact`. To run with the built-in `LocalRegexBackend` only (no Docker required), set `backend.endpoint = ""` in your config — useful for development and CI:

```jsonc
// .pii-remover.json
{
  "backend": {
    "type": "single",
    "endpoint": "",
    "trust_tier": "local",
    "auth": { "type": "none" }
  }
}
```

Pass `--config /path/to/pii-remover.json` to override.

## CLI flags

```
pii-remover-mcp [--transport stdio|http] [--port N] [--host HOST]
                [--config PATH] [--max-vaults N] [--ttl-ms N]
```

| Flag | Default | Notes |
|---|---|---|
| `--transport` | `stdio` | `http` enables Streamable HTTP (ADR-0016 §2) |
| `--port` | `8766` | HTTP transport only |
| `--host` | `127.0.0.1` | HTTP transport only |
| `--config` | env-resolved | Path to `pii-remover.json` |
| `--max-vaults` | `100` | LRU pool size |
| `--ttl-ms` | `3600000` (1h) | Vault idle TTL |

## Tool surface

### `sanitize`

Input:

```jsonc
{ "text": "Reach me at user@example.com",
  "vault_id": "session_..." }            // optional
```

Output (`structuredContent`):

```jsonc
{
  "text": "Reach me at __OPF_EMAIL_1__",
  "vault_id": "session_a1b2…",
  "token_count": 1,
  "categories": { "private_email": 1 },
  "latency_ms": 3.2,
  "backend_name": "local-regex"
}
```

Reuse the returned `vault_id` on subsequent `sanitize` calls to keep token dedup (same PII → same token). Pass it to `desanitize` to round-trip the response back to the original PII.

### `sanitize_batch`

Same as `sanitize`, but takes `texts: string[]` and returns `results: SanitizeOutput[]`. All inputs share one vault.

### `desanitize`

Input:

```jsonc
{ "text": "Hi __OPF_EMAIL_1__",
  "vault_id": "session_a1b2…" }          // required
```

Output:

```jsonc
{
  "text": "Hi user@example.com",
  "restored_count": 1,
  "unknown_token_count": 0,
  "partial_match_count": 0,
  "vault_id": "session_a1b2…"
}
```

If `vault_id` is missing or expired, returns `isError: true` with `structuredContent.error_code = "vault_not_found"` or `"vault_expired"`.

### `desanitize_batch`

Takes `texts: string[]` + required `vault_id`. Returns `results: DesanitizeOutput[]`.

### `analyze`

Input:

```jsonc
{ "text": "secret user@example.com here" }
```

Output:

```jsonc
{
  "detections": [
    { "start": 7, "end": 23, "category": "private_email", "confidence": 0.9 }
  ],
  "backend_name": "local-regex",
  "latency_ms": 0.8
}
```

**Security note**: response intentionally omits the original PII text. If you need the masked text, use `sanitize` instead. No vault is created.

## Vault lifecycle

Per [ADR-0016 §4](../../docs/ADR/0016-mcp-server-package.md):

- `vault_id` is a server-generated opaque string, independent of MCP-Session-Id.
- LRU eviction when pool reaches `--max-vaults` (default 100). Oldest entry first.
- TTL eviction after idle period (`--ttl-ms`, default 1 hour). Sweeper runs every `ttlMs/4`.
- All vault data is **in-memory only** — never persisted to disk (ADR-0003 invariant).
- Pool is single-tenant per server process. Multi-tenant client isolation is v2.

## Error semantics

Per [ADR-0016 §7](../../docs/ADR/0016-mcp-server-package.md):

| Situation | Response |
|---|---|
| Schema violation (e.g., `text` is a number) | JSON-RPC `-32602` (SDK auto) |
| `vault_id` missing or unknown | tool `isError: true`, `error_code: "vault_not_found"` |
| `vault_id` expired (idle past TTL) | tool `isError: true`, `error_code: "vault_expired"` |
| Detection backend fail-closed | tool `isError: true`, `error_code: "fail_closed"` |
| Server internal panic | JSON-RPC `-32603` (SDK auto) |

## Logging

`logging` capability declared. Use any MCP client supporting `logging/setLevel` to control verbosity. **Logs never contain PII plaintext** — only category counts, vault IDs, backend names, latencies, error classes.

In stdio mode, stdout is the JSON-RPC channel; runtime logs flow through `notifications/message`, never stdout. stderr is reserved for fatal boot errors only.

## Build / test

```bash
bun install
bun run --filter '@pii-remover/mcp-server' typecheck
bun run --filter '@pii-remover/mcp-server' build
bun test packages/mcp-server/tests/
```

Single-file binary:

```bash
cd packages/mcp-server
bun run compile:linux-x64       # → dist/pii-remover-mcp-linux-x64
bun run compile:darwin-arm64    # → dist/pii-remover-mcp-darwin-arm64
bun run compile:darwin-x64      # → dist/pii-remover-mcp-darwin-x64
bun run compile:windows-x64     # → dist/pii-remover-mcp-windows-x64.exe
```

## Programmatic use

```ts
import { createPiiRemoverMcpServer, runStdio } from "@pii-remover/mcp-server";

const server = createPiiRemoverMcpServer({
  vaultPoolOptions: {
    maxSize: 50,
    ttlMs: 30 * 60 * 1000,
  },
});

await runStdio(server);
```

For programmatic Streamable HTTP:

```ts
import { createPiiRemoverMcpServer, runStreamableHttp } from "@pii-remover/mcp-server";

const server = createPiiRemoverMcpServer();
const { close } = await runStreamableHttp(server, { port: 8766 });
// ... later
await close();
```

## Limitations (v1)

- Single-tenant per process — multiple MCP clients hitting the same server share vault state (no client identity isolation).
- No `analyze_context_risk` (CloakLLM parity) — `ContextAnalyzer` not yet implemented in core.
- No `dispose_vault` tool — vaults clean up automatically via LRU+TTL. Add an explicit tool if your usage demands it.
- No MCP `resources` / `prompts` / `sampling` — those primitives are out of scope.
- SDK v1.x stable line; v2 split-package migration planned when v2 reaches stable.

## License

Apache-2.0
