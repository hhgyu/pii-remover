/**
 * Display-tool detection for `tool.execute.before` restoration.
 *
 * "Display tools" are tools whose ARGS are rendered to the user — i.e. the
 * tool args themselves are user-facing content (a question prompt, an option
 * label, etc.), not just plumbing to drive the tool. For these tools, masked
 * tokens like `{{OPF:PERSON_27:` in the args produce a broken UX because
 * the user sees gibberish instead of the original PII.
 *
 * Restoring tokens in such args is a narrow exception to the general "mask
 * tool args" defense-in-depth rule. The exception is safe because:
 *  - The LLM only ever saw masked text, so any tokens in args are already
 *    in the vault.
 *  - `experimental.chat.messages.transform` re-masks the entire message
 *    tree before the next LLM dispatch, so the LLM-boundary invariant
 *    ("nothing raw reaches the LLM") still holds.
 *
 * Persistence tradeoff: restored args flow into OpenCode's `ToolPart.state.input`
 * via `tool.execute.before`, which may be persisted to the session log on disk.
 * The vault remains in-memory and never persists. See ADR-0015.
 *
 * Built-in OpenCode tool IDs are exact strings (verified at
 * https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/question.ts
 * and `.../tool/todo.ts`).
 *
 * MCP tool IDs are constructed by OpenCode as
 * `sanitize(clientName) + "_" + sanitize(mcpTool.name)` where
 * `sanitize(s) = s.replace(/[^a-zA-Z0-9_-]/g, "_")` (case-preserving). See
 * `packages/opencode/src/mcp/index.ts:683` in sst/opencode. Match against
 * the lower-cased name to be defensive against future case changes.
 */

/**
 * Tools whose args are user-facing content rendered to the user. The
 * plugin's primary security invariant is "no raw PII to external LLM",
 * enforced at the `experimental.chat.messages.transform` boundary. Local
 * disk persistence (session log, todo sqlite) is out of scope — the user's
 * own machine. So tools whose args render to the user are restored even
 * if their state persists locally, because the boundary remask catches
 * any restored PII before it can leave the machine.
 *
 * All entries are compared case-insensitively.
 */
export const DEFAULT_DISPLAY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "question",
  "todowrite",
]);

/**
 * Suffix patterns matched (case-insensitive) against the full tool name.
 * Used to cover MCP-prefixed variants like `omo_question`, `server_Todowrite`.
 *
 * The suffix is matched against the *delimited* tail so unrelated tools
 * with names containing "question" as a substring (e.g. `questionnaire`)
 * do NOT match.
 */
export const DEFAULT_DISPLAY_TOOL_SUFFIXES: ReadonlyArray<string> = [
  "_question",
  "_todowrite",
];

export interface DisplayToolConfig {
  /**
   * Exact tool names (case-insensitive) considered display tools. When
   * provided, REPLACES the default name set; use `extraNames` to extend.
   */
  names?: ReadonlySet<string>;
  /**
   * Suffix patterns matched against the lower-cased tool name. When
   * provided, REPLACES the default suffix list; use `extraSuffixes` to
   * extend.
   */
  suffixes?: ReadonlyArray<string>;
  /**
   * Extra exact names (case-insensitive) added on top of `names` (or the
   * default name set).
   */
  extraNames?: ReadonlyArray<string>;
  /**
   * Extra suffix patterns added on top of `suffixes` (or the default
   * suffix list).
   */
  extraSuffixes?: ReadonlyArray<string>;
  /**
   * Names to exclude. Useful when `extraNames` would over-match. Compared
   * case-insensitively.
   */
  excludeNames?: ReadonlyArray<string>;
  /**
   * Allow display-tool args restoration to run even when the
   * `experimental.chat.messages.transform` LLM-boundary masking hook is
   * disabled (`experimental: false`).
   *
   * Default `false` (secure). When `experimental: false` is set without
   * this override, display-tool args are MASKED instead of restored,
   * because the boundary remask is the only thing preventing restored
   * raw PII from reaching the LLM on the next turn.
   *
   * Set `true` ONLY if you have an alternative boundary mask in place,
   * e.g. the Phase 3 local proxy (ADR-0004) catches all outgoing LLM
   * requests. With the proxy active, the plugin's boundary hook is
   * redundant defense-in-depth and can be turned off.
   */
  allowWithoutBoundaryMask?: boolean;
}

interface ResolvedDisplayToolConfig {
  names: ReadonlySet<string>;
  suffixes: ReadonlyArray<string>;
  excludeNames: ReadonlySet<string>;
}

function toLowerSet(values: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const v of values) out.add(v.toLowerCase());
  return out;
}

function toLowerArray(values: ReadonlyArray<string>): string[] {
  return values.map((s) => s.toLowerCase());
}

export function resolveDisplayToolConfig(
  config: DisplayToolConfig = {}
): ResolvedDisplayToolConfig {
  const baseNames = config.names ?? DEFAULT_DISPLAY_TOOL_NAMES;
  const baseSuffixes = config.suffixes ?? DEFAULT_DISPLAY_TOOL_SUFFIXES;
  const names = toLowerSet(baseNames);
  if (config.extraNames) {
    for (const n of config.extraNames) names.add(n.toLowerCase());
  }
  const suffixes = toLowerArray([
    ...baseSuffixes,
    ...(config.extraSuffixes ?? []),
  ]);
  const excludeNames = toLowerSet(config.excludeNames ?? []);
  return { names, suffixes, excludeNames };
}

/**
 * Decide whether `toolName` is a display tool whose args should be restored
 * in `tool.execute.before` for UI rendering.
 *
 * Matching strategy:
 *  1. Case-insensitive equality against the configured name set.
 *  2. Case-insensitive suffix match (the suffix MUST include its leading
 *     delimiter, e.g. `_question`, so substring-style false positives like
 *     `questionnaire` cannot match).
 *  3. `excludeNames` always wins — even if a name matches via 1 or 2.
 */
export function isDisplayTool(
  toolName: string,
  config: DisplayToolConfig | ResolvedDisplayToolConfig = {}
): boolean {
  if (typeof toolName !== "string" || toolName.length === 0) return false;
  const resolved =
    isResolved(config) ? config : resolveDisplayToolConfig(config);
  const lower = toolName.toLowerCase();
  if (resolved.excludeNames.has(lower)) return false;
  if (resolved.names.has(lower)) return true;
  for (const suffix of resolved.suffixes) {
    if (suffix.length > 0 && lower.length > suffix.length && lower.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

function isResolved(
  config: DisplayToolConfig | ResolvedDisplayToolConfig
): config is ResolvedDisplayToolConfig {
  return (
    typeof (config as ResolvedDisplayToolConfig).names === "object" &&
    (config as ResolvedDisplayToolConfig).names instanceof Set &&
    Array.isArray((config as ResolvedDisplayToolConfig).suffixes) &&
    (config as ResolvedDisplayToolConfig).excludeNames instanceof Set
  );
}
