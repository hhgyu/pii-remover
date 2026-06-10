# @pii-remover/opencode-plugin

OpenCode plugin that routes text through `@pii-remover/core` so PII is
masked **before** it reaches the LLM, then **restored** in the assistant
response and tool results so the user-facing UI shows the original values.

**Phase 2 status** (current): full mask → restore round-trip via two hooks
documented in [ADR-0011](../../docs/ADR/0011-message-part-updated-feasibility.md):

- **`tool.execute.before`** — masks tool args (stable, Phase 1).
- **`tool.execute.after`** — restores `__OPF_*__` tokens in tool results
  (stable, Phase 2 NEW).
- **`experimental.text.complete`** — restores tokens in the assistant's
  final text part before persistence/UI render (experimental API; opt-out
  via `experimental: false`).

Korean PII (RRN/사업자번호/010 휴대폰/한국 이름) is detected by the
in-process [`LocalRegexBackend`](../core/src/backend/local-regex.ts);
algorithm details in [`docs/KOREAN_PII.md`](../../docs/KOREAN_PII.md).
The Phase 3 [Local LLM Proxy (ADR-0004)](../../docs/ADR/0004-local-llm-proxy-streaming.md)
remains the cross-host (OpenCode + Claude Code) restoration path and is
still recommended for streaming workloads — see
[`docs/ROADMAP.md`](../../docs/ROADMAP.md).

## Install

```bash
npx @pii-remover/cli install --target opencode
```

Registers **two** plugin entries in `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///.../@pii-remover/opencode-plugin/dist/mask.js",   // FIRST
    "your-other-plugin@latest",
    "another-plugin@latest",
    "file:///.../@pii-remover/opencode-plugin/dist/restore.js" // LAST
  ]
}
```

Why two entries? OpenCode runs plugin hooks in array order. PII masking
must happen **before** any other plugin sees tool args, and restoration
must happen **after** every other plugin's `tool.execute.after` has
finished. Bundling both phases into one entry would force them into the
same array slot, leaking PII to plugins registered between them. The two
entries share a module-level `VaultManager` singleton so the vault stays
consistent.

OpenCode's plugin deduplication is keyed by package name for npm specs
but by full URL for `file://` specs (source-verified in
`packages/opencode/src/config/plugin.ts:75`), so the two entries above
are treated as distinct plugins even though they ship from the same npm
package.

Re-running the installer is **idempotent** — it strips any prior
PII-Remover entries and re-inserts mask first and restore last around
your other plugins.

### Fallback (resolver failure)

If the CLI can't resolve `@pii-remover/opencode-plugin` from its
`node_modules` (e.g. plugin not installed yet), the installer writes a
single bare-package entry and prints a `WARNING` telling you to
`bun add -d @pii-remover/opencode-plugin` then re-run. Hooks still
function in that mode, but they share the array slot with no
guarantee of running before/after other plugins.

### Runtime ordering check

Both entry points log a `WARNING` via the OpenCode plugin `warn`
channel if the array order is wrong (e.g. restore registered before
mask). The check is cheap, runs once at plugin init, and helps catch
hand-edited `opencode.json` files where the entries drifted apart.

## Backend requirement

The plugin talks to a local OPF HTTP backend. Bring up the self-built
image once:

```bash
git clone https://github.com/hhgyu/pii-remover
cd pii-remover/packages/backend
docker compose up --build
```

After the first build (~5–10 min for the model weights), subsequent
`docker compose start` calls boot in seconds. The plugin defaults to
`http://localhost:8000/redact` (see [Configuration](#configuration)).

## Configuration

Settings are loaded from the first file that exists, in this order:

1. `<cwd>/.opencode/pii-remover.json` — project, OpenCode-scoped
2. `<cwd>/.pii-remover.json` — project root (legacy / non-OpenCode hosts)
3. `~/.config/opencode/pii-remover.json` — user, OpenCode-scoped
4. `~/.config/pii-remover/config.json` — user global (legacy)
5. `DEFAULT_CONFIG` (in-code defaults)

The OpenCode-scoped paths exist so PII Remover settings sit next to
`opencode.json` and `.opencode/plugins/` — the layout OpenCode users
already keep.

Minimal `~/.config/opencode/pii-remover.json`:

```jsonc
{
  "backend": {
    "type": "single",
    "endpoint": "http://localhost:8000/redact",
    "trust_tier": "local",
    "auth": { "type": "none" }
  },
  "detection": {
    "enabled_categories": [
      "private_email",
      "private_url",
      "private_phone",
      "card",
      "secret"
    ]
  },
  "failure_policy": "hybrid"
}
```

A copy ships in [`examples/pii-remover.json`](../../examples/pii-remover.json).
String values support `${VAR}` and `${VAR:-default}` substitution; secret
material (Bearer tokens etc.) must come from environment variables via
`auth.token_env`, **never** as a literal in the JSON file.

See [`packages/core/src/config/schema.ts`](../core/src/config/schema.ts)
for the full surface area and defaults.

## Hooks registered

| Hook | Phase | Stability | Purpose |
| --- | --- | --- | --- |
| `tool.execute.before` | 1 / **5** | stable | Restores vault tokens in **every** arg field — including path-shaped ones (`filePath`, `workdir`, `*_path`, ...) — so tool execution, OpenCode's `external_directory` permission prompt, and display-tool UIs all see real values instead of `__OPF_*`. Args originate from the LLM, so masking them here adds no LLM-side privacy; the LLM boundary is enforced by `experimental.chat.messages.transform`. Only when that boundary mask is disabled (`experimental: false`) does this hook fall back to the legacy Phase-1 behavior: masking eligible string fields (skipping path-shaped fields and strings ≤ 8 chars). See [`displayTools`](#display-tools-restoration) and [ADR-0015](../../docs/ADR/0015-display-tool-restoration.md). |
| `tool.execute.after` | **2** | stable | Restores tokens (`__OPF_*__`) found in `output.output` and `output.title` back to vault originals. Lets the assistant reason about real file contents / shell stdout after a tool round-trip. |
| `experimental.text.complete` | **2** | **experimental** | Restores tokens in the assistant's final response `output.text`. Disable with `experimental: false` if you prefer to wait for the Phase 3 local proxy (ADR-0004) instead. |
| `experimental.chat.messages.transform` | **5** | **experimental** | **NEW**: Comprehensive LLM-boundary mask for every role (user / assistant / tool) and every text-bearing part type (`text`, `reasoning`, `tool.state.input/output/title`, `subtask.prompt/description`, `file.source.text.value`, `agent.source.value`). Unknown part types are recursively masked with a fail-closed strict policy so a new OpenCode part type cannot leak raw PII to the LLM. **Dead tokens** — `__OPF_*` strings persisted by a previous process (session resume) with no mapping in the current vault — are replaced with `[UNRESTORABLE]` so the LLM cannot copy them into new tool calls; live tokens pass through untouched. See [ADR-0015](../../docs/ADR/0015-display-tool-restoration.md). |
| `experimental.chat.system.transform` | 2 | experimental | Injects a one-line note into the system prompt telling the LLM that placeholders like `__OPF_PERSON_1__` are privacy-preserving stand-ins. |
| `event` | 1 | stable | Registered but intentionally inert. `session.idle` is **not** a disposal trigger: OpenCode emits it after every completed turn and for every subagent session, so disposing the vault there destroyed live token mappings mid-conversation. The vault (in-memory, deduplicated, ~300B per unique PII value) lives for the process lifetime. |

Intentionally **not** registered:

- `chat.params` / `chat.headers` — Phase 3 (local LLM proxy) territory.
- `permission.ask`, `command.execute.before`, `auth`, `provider` — out of scope.

### Display-tools restoration

Some tools render their args directly to the user — the args themselves are
the UI. For these, masked tokens in args produce a broken UX (the user sees
`__OPF_PERSON_27__` instead of `김철수`).

With the boundary mask active (`experimental` default), **all** tools get
token restoration in `tool.execute.before`, so the display-tool distinction
only matters when the boundary mask is off (`experimental: false`):

| Tool name | `experimental: false` behavior |
| --- | --- |
| `question` (built-in) | **restore** args (requires `allowWithoutBoundaryMask`) |
| `todowrite` (built-in) | **restore** args (requires `allowWithoutBoundaryMask`) |
| `omo_question`, `server_Question`, any `*_question` (MCP) | **restore** args (requires `allowWithoutBoundaryMask`) |
| `omo_todowrite`, `server_Todowrite`, any `*_todowrite` (MCP) | **restore** args (requires `allowWithoutBoundaryMask`) |
| `questionnaire`, `question_followup`, any name without delimited `_question` / `_todowrite` suffix | mask args (legacy Phase-1 net) |
| All other tools (`write`, `bash`, `read`, `task`, ...) | mask args (legacy Phase-1 net) |

**Primary security invariant**: raw PII never reaches the external LLM API.
This is enforced by `experimental.chat.messages.transform`, which re-masks
the entire message tree before each LLM dispatch — including any args that
were restored in `tool.execute.before`. Local disk (session log, todo
sqlite) is out of scope; the user owns that data.

**`experimental: false` interaction (important)**: setting
`experimental: false` disables `experimental.chat.messages.transform`,
which is the only thing preventing restored display-tool args from
reaching the LLM on subsequent turns. The plugin handles this by
**masking** display-tool args by default in this mode (broken UX, secure
default) and emits a one-line init warning. To override and keep UX,
set `displayTools.allowWithoutBoundaryMask: true` — but only do this when
you have an alternative boundary mask such as the Phase 3 local proxy
(ADR-0004) catching all outgoing LLM requests.

**Configure**:

```ts
import { configurePiiRemoverPlugin } from "@pii-remover/opencode-plugin";

export const plugin = configurePiiRemoverPlugin({
  displayTools: {
    extraNames: ["confirm"],
    extraSuffixes: ["_confirm", "_ask"],
    excludeNames: ["todowrite"],
    // Set to true only if you have an alternative LLM boundary mask
    // (e.g. the local proxy) and need display restoration without the
    // plugin's chat.messages.transform hook.
    allowWithoutBoundaryMask: false,
  },
});
```

> ⚠ `message.part.updated` is **not a real OpenCode hook** — earlier internal
> notes assumed it existed. The actual response-text mutation point is
> `experimental.text.complete`. See [ADR-0011](../../docs/ADR/0011-message-part-updated-feasibility.md)
> for the source-verified hook inventory.

## Bypass switch

To temporarily skip masking (debugging an upstream tool failure, etc.) set
`PII_REMOVER_BYPASS=1` in the environment. The plugin will short-circuit
`tool.execute.before` to a passthrough and emit a one-line stderr warning.
See [ADR-0006](../../docs/ADR/0006-fail-closed-default.md) for the policy
rationale.

## Customization escape hatch

Most users never need this. If you need to inject options (custom
backends, alternative config path, disable the startup health probe…)
write a tiny `.opencode/plugins/pii-remover.ts`:

```ts
import { configurePiiRemoverPlugin } from "@pii-remover/opencode-plugin";

export const plugin = configurePiiRemoverPlugin({
  configPath: "/abs/path/to/custom-pii-remover.json",
  healthCheck: false,
  warn: (msg) => console.warn(msg),
});
```

`configurePiiRemoverPlugin(options)` returns the same `(ctx) => hooks`
function shape that OpenCode expects, just with your options baked in.

## API surface for advanced use

```ts
import {
  PiiRemoverPlugin,            // (ctx) => Promise<hooks>  — OpenCode entry point
  configurePiiRemoverPlugin,   // (options) => (ctx) => Promise<hooks>
  createPluginHooks,           // (remover, opts?) => hooks  — works with your own PIIRemover
  maskTextFields,              // standalone recursive tree walker (existing skip/min-length policy)
  maskTextFieldsStrict,        // boundary fail-closed walker (no skip, no min-length)
  restoreTextFields,           // recursive restore walker for display-tool args
  DEFAULT_SKIP_FIELDS,         // path-shaped field names that are never masked
  MIN_MASK_LENGTH,             // ≤ this many chars → never masked
  loadPluginConfig,            // resolve PiiRemoverConfig from the search path
  DEFAULT_DISPLAY_TOOL_NAMES,  // exact tool names treated as display tools
  DEFAULT_DISPLAY_TOOL_SUFFIXES, // delimited suffix patterns for MCP variants
  isDisplayTool,               // (toolName, config?) => boolean
  resolveDisplayToolConfig,    // resolve a DisplayToolConfig with defaults
} from "@pii-remover/opencode-plugin";
```

## Phase 2 status (current)

1. **Assistant responses are restored automatically on OpenCode** via
   `experimental.text.complete` (default on). User-facing UI shows real
   PII values; the LLM never saw them. Disable with `experimental: false`
   if you only trust the stable `tool.execute.after` path.
2. **Korean PII is now first-class** — RRN (13-digit + checksum), business
   registration numbers (10-digit + checksum), Korean phone (010/011/
   016/017/018/019), and a 100-surname heuristic for Korean person names
   all run in the local-regex backend (no model dependency). See
   [`docs/KOREAN_PII.md`](../../docs/KOREAN_PII.md) for the algorithm.
3. **Tool-result restoration via `tool.execute.after`** — file contents,
   shell stdout, anything a tool returns gets de-masked before reaching
   the assistant's next reasoning step.
4. **Tool-arg paths are heuristically skipped.** If you author custom
   tools whose argument names do not follow the `*_path` / `*_dir` /
   `*_id` / `*_uri` / `*_url` conventions, extend `maskOptions.skipFields`
   via `configurePiiRemoverPlugin`, or rename the args to fit the
   heuristic.
5. **Claude Code is still Phase 4** — `experimental.text.complete` is
   OpenCode-only. Claude Code users will need the Phase 3 local proxy
   ([ADR-0004](../../docs/ADR/0004-local-llm-proxy-streaming.md)) for
   equivalent response restoration.

## Related packages

- [`@pii-remover/core`](../core/README.md) — host-agnostic detection,
  vault, restoration, policy. The plugin is a thin host adapter.
- [`@pii-remover/backend`](../backend/README.md) — self-built Docker image
  for the OPF HTTP API consumed by `OpfHttpBackend`.

## License

Apache-2.0
