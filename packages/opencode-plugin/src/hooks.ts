import {
  AuditEmitter,
  FailClosedError,
  OPF_PLACEHOLDER_SYSTEM_NOTE,
  PIIRemover,
  TOKEN_PREFIX,
  TOKEN_PREFIX_PATTERN,
  TOKEN_STRICT_PATTERN,
  maybeAutoStartBackend,
  type BackendClient,
  type MaskResult,
  type PiiRemoverConfig,
  type PIIRemoverInitOptions,
  type RestoreOrigin,
} from "@pii-remover/core";

import { loadPluginConfig } from "./config-loader.js";
import {
  DEFAULT_SKIP_FIELDS,
  MIN_MASK_LENGTH,
  maskTextFields,
  maskTextFieldsStrict,
  restoreTextFields,
  type MaskOptions,
} from "./text-field-masker.js";
import {
  DEFAULT_DISPLAY_TOOL_NAMES,
  DEFAULT_DISPLAY_TOOL_SUFFIXES,
  isDisplayTool,
  resolveDisplayToolConfig,
  type DisplayToolConfig,
} from "./display-tools.js";

export {
  DEFAULT_SKIP_FIELDS,
  MIN_MASK_LENGTH,
  maskTextFields,
  maskTextFieldsStrict,
  restoreTextFields,
  loadPluginConfig,
  DEFAULT_DISPLAY_TOOL_NAMES,
  DEFAULT_DISPLAY_TOOL_SUFFIXES,
  isDisplayTool,
  resolveDisplayToolConfig,
};
export type { MaskOptions, PiiRemoverConfig, DisplayToolConfig };

interface PluginInputLike {
  project?: { id?: unknown; worktree?: unknown } | null | undefined;
  worktree?: unknown;
  directory?: unknown;
}

interface EventEnvelope {
  event: { type?: string; properties?: { sessionID?: unknown } | undefined };
}

interface ToolBeforeInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface ToolBeforeOutput {
  args: unknown;
}

interface ToolAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: unknown;
}

interface ToolAfterOutput {
  title: unknown;
  output: unknown;
  metadata: unknown;
}

interface TextCompleteInput {
  sessionID: string;
  messageID: string;
  partID: string;
}

interface TextCompleteOutput {
  text: string;
}

interface SystemTransformInput {
  sessionID?: string;
  model: unknown;
}

interface SystemTransformOutput {
  system: string[];
}

interface ChatMessageTransformToolState {
  status?: string;
  input?: unknown;
  output?: unknown;
  title?: unknown;
  metadata?: unknown;
}

interface ChatMessageTransformFileSource {
  text?: { value?: unknown } | undefined;
}

interface ChatMessageTransformAgentSource {
  value?: unknown;
}

interface ChatMessageTransformPart {
  type?: string;
  text?: unknown;
  state?: ChatMessageTransformToolState;
  prompt?: unknown;
  description?: unknown;
  source?: ChatMessageTransformFileSource | ChatMessageTransformAgentSource;
}

interface ChatMessageTransformMessage {
  info?: { role?: string };
  parts?: ChatMessageTransformPart[];
}

interface ChatMessagesTransformOutput {
  messages: ChatMessageTransformMessage[];
}

export interface CreatedHooks {
  event(input: EventEnvelope): Promise<void>;
  "tool.execute.before"?(
    input: ToolBeforeInput,
    output: ToolBeforeOutput
  ): Promise<void>;
  "tool.execute.after"?(
    input: ToolAfterInput,
    output: ToolAfterOutput
  ): Promise<void>;
  "experimental.text.complete"?(
    input: TextCompleteInput,
    output: TextCompleteOutput
  ): Promise<void>;
  "experimental.chat.messages.transform"?(
    input: {},
    output: ChatMessagesTransformOutput
  ): Promise<void>;
  "experimental.chat.system.transform"?(
    input: SystemTransformInput,
    output: SystemTransformOutput
  ): Promise<void>;
}

// Both are derived from the core token grammar so the hash length can never
// desync from TOKEN_HASH_LENGTH. Sweep regex is global but only ever used with
// String.replace, which resets lastIndex on entry and exit; the probe regex is
// non-global so .test() stays stateless.
const OPF_TOKEN_SWEEP_REGEX = new RegExp(TOKEN_STRICT_PATTERN, "gi");
const OPF_PREFIX_PROBE_REGEX = new RegExp(TOKEN_PREFIX_PATTERN, "i");

const NEUTRALIZE_REASON = {
  expired:
    "this key minted it but the vault no longer holds it (session resumed)",
  foreign: "this key never minted it (model-invented, or the key was replaced)",
} as const;

export type PluginMode = "mask" | "restore" | "full";

export interface PiiRemoverPluginOptions {
  sessionId?: string;
  config?: PiiRemoverConfig;
  configPath?: string;
  warn?: (message: string) => void;
  remover?: PIIRemover;
  backends?: readonly BackendClient[];
  audit?: AuditEmitter;
  maskOptions?: MaskOptions;
  healthCheck?: boolean;
  /**
   * Configure which tools are "display tools" whose args are restored
   * (PII tokens → original values) in `tool.execute.before` so the UI
   * renders real values to the user. See `DisplayToolConfig` for the
   * matching strategy and ADR-0015 for the rationale + persistence
   * tradeoff. Defaults match OpenCode's built-in `question` tool and
   * MCP variants matching `*_question`.
   */
  displayTools?: DisplayToolConfig;
  /**
   * Register `experimental.text.complete` hook to restore PII tokens in
   * assistant response text (ADR-0011). Default: `true`.
   *
   * Set to `false` to skip the experimental hook — restoration then only
   * happens via the stable `tool.execute.after` hook (tool results) or via
   * the Phase 3 Local LLM Proxy (ADR-0004). Useful when the OpenCode
   * minor version is known to have an incompatible `experimental.*`
   * signature.
   */
  experimental?: boolean;
  /**
   * Split-mode for multi-plugin ordering (mask-first / restore-last).
   *
   * - `"full"` (default): registers all hooks — backward compatible.
   * - `"mask"`: registers only `tool.execute.before` and
   *   `experimental.chat.messages.transform` (masking hooks). Place this
   *   plugin FIRST in `.opencode/plugins/`.
   * - `"restore"`: registers only `tool.execute.after` and
   *   `experimental.text.complete` (restoration hooks). Place this plugin
   *   LAST in `.opencode/plugins/`.
   *
   * Both `"mask"` and `"restore"` share the same `PIIRemover` instance
   * (module-level singleton) so the vault is shared across the split.
   */
  mode?: PluginMode;
}

function isPluginInputLike(x: unknown): x is PluginInputLike {
  return typeof x === "object" && x !== null;
}

function deriveSessionId(ctx: unknown, fallback: string): string {
  if (!isPluginInputLike(ctx)) return fallback;
  const projectId = ctx.project?.id;
  if (typeof projectId === "string" && projectId.length > 0) return projectId;
  if (typeof ctx.worktree === "string" && ctx.worktree.length > 0) {
    return ctx.worktree;
  }
  if (typeof ctx.directory === "string" && ctx.directory.length > 0) {
    return ctx.directory;
  }
  return fallback;
}

function isMaskBypassed(result: MaskResult): boolean {
  return Boolean(result.bypassed);
}

let singletonRemover: PIIRemover | null = null;
let singletonInitPromise: Promise<PIIRemover> | null = null;
const initializedModes: PluginMode[] = [];

export function __resetTrackedModesForTests(): void {
  initializedModes.length = 0;
}

export function trackMode(mode: PluginMode, warn: (msg: string) => void): void {
  if (mode === "full") return;
  initializedModes.push(mode);
  if (mode === "restore" && !initializedModes.includes("mask")) {
    warn(
      "[pii-remover] WARNING: restore plugin loaded before mask plugin. " +
      "Masking will NOT run before other plugins. " +
      "Ensure mask entry appears before restore in your plugin config array."
    );
  }
  if (mode === "mask" && initializedModes.includes("restore")) {
    warn(
      "[pii-remover] WARNING: mask plugin loaded after restore plugin. " +
      "Hook execution order is incorrect. " +
      "Ensure mask entry appears BEFORE restore in your plugin config array."
    );
  }
}

async function getOrCreateRemover(
  sessionId: string,
  config: PiiRemoverConfig,
  warn: (msg: string) => void,
  backends?: readonly BackendClient[],
  audit?: AuditEmitter
): Promise<PIIRemover> {
  if (singletonRemover) return singletonRemover;
  if (!singletonInitPromise) {
    singletonInitPromise = PIIRemover.init(
      buildInitOptions({ sessionId, config, warn, backends, audit })
    ).then((r) => {
      singletonRemover = r;
      return r;
    });
  }
  return singletonInitPromise;
}

async function performHealthCheck(
  remover: PIIRemover,
  warn: (message: string) => void
): Promise<void> {
  try {
    const probe = await remover.mask("", { request_id: "plugin_health_probe" });
    if (isMaskBypassed(probe)) {
      warn(
        "[pii-remover] backend health probe ran in bypass mode (PII_REMOVER_BYPASS)"
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`[pii-remover] backend health probe failed: ${reason}`);
    if (err instanceof FailClosedError) {
      throw err;
    }
  }
}

/**
 * Compose the OpenCode hook set against an already-constructed `PIIRemover`.
 *
 * Exposed separately from `PiiRemoverPlugin` so tests can drive the hooks
 * without standing up a full PluginInput / OpenCode context.
 */
export function createPluginHooks(
  remover: PIIRemover,
  options: {
    maskOptions?: MaskOptions;
    warn?: (message: string) => void;
    experimental?: boolean;
    mode?: PluginMode;
    displayTools?: DisplayToolConfig;
  } = {}
): CreatedHooks {
  const warn = options.warn ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const registerExperimental = options.experimental !== false;
  const mode = options.mode ?? "full";
  const displayToolConfig = resolveDisplayToolConfig(options.displayTools ?? {});
  const allowDisplayRestoreWithoutBoundary =
    options.displayTools?.allowWithoutBoundaryMask === true;
  const displayRestoreEnabled =
    registerExperimental || allowDisplayRestoreWithoutBoundary;
  const warnedDeadTokens = new Set<string>();

  if (!registerExperimental && !allowDisplayRestoreWithoutBoundary) {
    warn(
      "[pii-remover] experimental:false disables the LLM-boundary mask " +
      "(experimental.chat.messages.transform). Display-tool args will be " +
      "MASKED (not restored to the UI) to prevent restored raw PII from " +
      "leaking to the model on subsequent turns. Set " +
      "displayTools.allowWithoutBoundaryMask:true to override (requires an " +
      "alternative boundary mask such as the local proxy in ADR-0004)."
    );
  }

  async function maskText(text: string): Promise<string> {
    try {
      const r = await remover.mask(text);
      return r.text;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warn(`[pii-remover] tool.execute.before masking failed: ${reason}`);
      throw err;
    }
  }

  async function maskMessagePartText(text: string): Promise<string> {
    if (typeof text !== "string" || text.length === 0) return text;
    try {
      const r = await remover.mask(text);
      return r.text;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warn(
        `[pii-remover] experimental.chat.messages.transform masking failed: ${reason}`
      );
      throw err;
    }
  }

  function restoreText(
    text: string,
    where: string,
    origin: RestoreOrigin
  ): string {
    if (typeof text !== "string" || text.length === 0) return text;
    if (!text.includes(TOKEN_PREFIX) && !OPF_PREFIX_PROBE_REGEX.test(text)) {
      return text;
    }
    try {
      const r = remover.restore(text, { warn: (msg) => warn(msg), origin });
      return r.text;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warn(`[pii-remover] ${where} restore failed: ${reason}`);
      return text;
    }
  }

  // Tool ARGS were written by the model; tool RESULTS were written by whatever
  // the tool read. Blaming the model for a token-shaped string that came out of
  // a file would report a hallucination it never committed.
  function restoreArgText(text: string): string {
    return restoreText(text, "tool.execute.before display-tool restore", "model");
  }

  function restoreResultText(text: string): string {
    return restoreText(text, "tool.execute.after", "tool");
  }

  function stripTokens(text: string): string {
    return text.replace(OPF_TOKEN_SWEEP_REGEX, "[REDACTED]");
  }

  // Tokens whose vault mapping no longer exists (minted by a previous
  // process before a session resume) can never be restored. Left as-is the
  // LLM copies them verbatim into new tool args — surfacing {{OPF:* in
  // permission prompts and broken filesystem paths. Replacing them forces
  // the LLM onto a normal failure path (re-discover or ask the user).
  // Live tokens are preserved so the LLM can keep reusing them.
  function neutralizeDeadTokens(text: string): string {
    if (!OPF_PREFIX_PROBE_REGEX.test(text)) return text;
    return text.replace(
      OPF_TOKEN_SWEEP_REGEX,
      (raw, label: string, hash: string) => {
        const category = label.toUpperCase();
        const normalized = `{{OPF:${category}:${hash.toLowerCase()}}}`;
        const status = remover.tokenStatus(normalized);
        if (status === "live") return raw;
        if (!warnedDeadTokens.has(normalized)) {
          warnedDeadTokens.add(normalized);
          warn(
            `[pii-remover] neutralized ${status} token ${normalized}: ${NEUTRALIZE_REASON[status]}`
          );
        }
        return `[UNRESTORABLE:${category}/${status}]`;
      }
    );
  }

  async function maskPartInPlace(
    part: ChatMessageTransformPart,
    authoredByUser: boolean
  ): Promise<void> {
    if (!part || typeof part !== "object") return;
    const type = part.type;

    // Compaction parts strip EVERY token to [REDACTED] below, so the
    // dead-token sweep would only change the placeholder text.
    //
    // User-authored parts are never swept. Neutralization exists to stop the
    // MODEL copying an unusable token into a new tool call; the user typing
    // one is authoritative input. Sweeping it silently rewrote documentation,
    // tests and the "what is this {{OPF: token?" question itself before the
    // model ever saw it.
    if (type !== "compaction" && !authoredByUser) {
      await maskTextFieldsStrict(part, neutralizeDeadTokens);
    }

    if (type === "text" || type === "reasoning") {
      if (typeof part.text === "string") {
        part.text = await maskMessagePartText(part.text);
      }
      return;
    }

    if (type === "tool") {
      const state = part.state;
      if (state && typeof state === "object") {
        if (state.input !== undefined && state.input !== null) {
          // Use maskTextFields (with path-skip) instead of strict so the LLM
          // sees real filesystem paths. This prevents token-index confusion
          // where the LLM picks the wrong {{OPF:PERSON_N: for a path.
          state.input = await maskTextFields(
            state.input,
            maskMessagePartText
          );
        }
        if (typeof state.output === "string") {
          state.output = await maskMessagePartText(state.output);
        } else if (state.output !== undefined && state.output !== null) {
          state.output = await maskTextFields(state.output, maskMessagePartText);
        }
        if (typeof state.title === "string") {
          state.title = await maskMessagePartText(state.title);
        }
        if (state.metadata !== undefined && state.metadata !== null) {
          state.metadata = await maskTextFields(
            state.metadata,
            maskMessagePartText
          );
        }
      }
      return;
    }

    if (type === "subtask") {
      if (typeof part.prompt === "string") {
        part.prompt = await maskMessagePartText(part.prompt);
      }
      if (typeof part.description === "string") {
        part.description = await maskMessagePartText(part.description);
      }
      return;
    }

    if (type === "file") {
      const src = part.source as ChatMessageTransformFileSource | undefined;
      if (src && typeof src === "object") {
        const t = src.text;
        if (t && typeof t === "object" && typeof t.value === "string") {
          t.value = await maskMessagePartText(t.value);
        }
      }
      return;
    }

    if (type === "agent") {
      const src = part.source as ChatMessageTransformAgentSource | undefined;
      if (src && typeof src === "object" && typeof src.value === "string") {
        src.value = await maskMessagePartText(src.value);
      }
      return;
    }

    if (
      type === "step-start" ||
      type === "step-finish" ||
      type === "snapshot" ||
      type === "patch" ||
      type === "retry"
    ) {
      return;
    }

    if (type === "compaction") {
      await maskTextFieldsStrict(part, stripTokens);
      return;
    }

    await maskTextFieldsStrict(part, maskMessagePartText);
  }

  const isMask = mode === "mask" || mode === "full";
  const isRestore = mode === "restore" || mode === "full";

  const hooks: CreatedHooks = {
    // `session.idle` is deliberately NOT handled: OpenCode emits it after
    // EVERY completed turn and for every subagent session, so disposing the
    // vault here destroyed live mappings mid-conversation (unrestorable
    // {{OPF:* tokens in permission prompts and tool args). The vault is
    // in-memory only and deduplicated, so process lifetime is the correct
    // and affordable disposal boundary.
    async event(_input: EventEnvelope): Promise<void> {},
  };

  if (isMask) {
    hooks["tool.execute.before"] = async (
      input: ToolBeforeInput,
      output: ToolBeforeOutput
    ): Promise<void> => {
      if (output.args === undefined || output.args === null) return;

      // Restore vault tokens the LLM echoed into args (e.g.
      // "D:\Git\{{OPF:PERSON_1:Plugin" composed from masked context) so
      // the permission dialog and the tool both see the real filesystem.
      const restored = await restoreTextFields(output.args, restoreArgText);
      output.args = restored;

      // Args originate FROM the LLM, so masking them here adds no LLM-side
      // privacy — the boundary mask (experimental.chat.messages.transform)
      // re-tokenises everything before the next dispatch. Re-masking here
      // would re-introduce {{OPF:* into paths right after restoring them,
      // breaking execution and the external_directory permission prompt.
      if (registerExperimental) return;

      // Boundary mask absent (experimental: false): keep the legacy
      // Phase-1 execution-time mask as a best-effort net. Display tools
      // stay restored only when the user explicitly opted in via
      // displayTools.allowWithoutBoundaryMask (ADR-0015).
      if (
        displayRestoreEnabled &&
        isDisplayTool(input.tool, displayToolConfig)
      ) {
        return;
      }
      const next = await maskTextFields(
        restored,
        maskText,
        options.maskOptions ?? {}
      );
      output.args = next;
    };
  }

  if (isRestore) {
    hooks["tool.execute.after"] = async (
      _input: ToolAfterInput,
      output: ToolAfterOutput
    ): Promise<void> => {
      if (typeof output.output === "string") {
        output.output = restoreResultText(output.output);
      } else if (output.output !== undefined && output.output !== null) {
        output.output = await restoreTextFields(output.output, restoreResultText);
      }
      if (typeof output.title === "string") {
        output.title = restoreResultText(output.title);
      }
      if (output.metadata !== undefined && output.metadata !== null) {
        output.metadata = await restoreTextFields(
          output.metadata,
          restoreResultText
        );
      }
    };
  }

  if (registerExperimental) {
    if (isMask) {
      hooks["experimental.chat.system.transform"] = async (
        _input: SystemTransformInput,
        output: SystemTransformOutput
      ): Promise<void> => {
        if (!Array.isArray(output.system)) return;
        if (!output.system.includes(OPF_PLACEHOLDER_SYSTEM_NOTE)) {
          output.system.push(OPF_PLACEHOLDER_SYSTEM_NOTE);
        }
      };
      hooks["experimental.chat.messages.transform"] = async (
        _input: {},
        output: ChatMessagesTransformOutput
      ): Promise<void> => {
        if (!Array.isArray(output.messages)) return;
        for (const message of output.messages) {
          if (!message || !Array.isArray(message.parts)) continue;
          const authoredByUser = message.info?.role === "user";
          for (const part of message.parts) {
            await maskPartInPlace(part, authoredByUser);
          }
        }
      };
    }
    if (isRestore) {
      hooks["experimental.text.complete"] = async (
        _input: TextCompleteInput,
        output: TextCompleteOutput
      ): Promise<void> => {
        if (typeof output.text !== "string") return;
        output.text = restoreText(
          output.text,
          "experimental.text.complete",
          "model"
        );
      };
    }
  }

  return hooks;
}

async function buildPluginFromCtx(
  ctx: unknown,
  pluginOptions: PiiRemoverPluginOptions
): Promise<CreatedHooks> {
  const warn =
    pluginOptions.warn ??
    ((msg: string) => process.stderr.write(`${msg}\n`));

  const config =
    pluginOptions.config ??
    (await loadPluginConfig(
      pluginOptions.configPath
        ? { configPath: pluginOptions.configPath }
        : {}
    ));

  const sessionId =
    pluginOptions.sessionId ?? deriveSessionId(ctx, `opencode_${Date.now()}`);

  const mode = pluginOptions.mode ?? "full";
  trackMode(mode, warn);

  if (config.backend.auto_start === true) {
    await maybeAutoStartBackend({
      enabled: true,
      endpoint: config.backend.endpoint,
      composeFile: config.backend.compose_file ?? "cpu",
      startTimeoutMs: config.backend.start_timeout_ms ?? 60000,
      bypassEnv: config.bypass_env,
      warn,
    });
  }

  const remover =
    pluginOptions.remover ??
    (mode === "mask" || mode === "restore"
      ? await getOrCreateRemover(
          sessionId,
          config,
          warn,
          pluginOptions.backends,
          pluginOptions.audit
        )
      : await PIIRemover.init(
          buildInitOptions({
            sessionId,
            config,
            warn,
            backends: pluginOptions.backends,
            audit: pluginOptions.audit,
          })
        ));

  if (pluginOptions.healthCheck !== false) {
    await performHealthCheck(remover, warn);
  }

  const hookOpts: {
    warn: typeof warn;
    maskOptions?: MaskOptions;
    experimental?: boolean;
    displayTools?: DisplayToolConfig;
  } = { warn };
  if (pluginOptions.maskOptions) hookOpts.maskOptions = pluginOptions.maskOptions;
  if (pluginOptions.experimental !== undefined)
    hookOpts.experimental = pluginOptions.experimental;
  if (pluginOptions.displayTools)
    hookOpts.displayTools = pluginOptions.displayTools;

  return createPluginHooks(remover, { ...hookOpts, mode });
}

// OpenCode loads plugins by importing the module and calling each exported
// function with the PluginInput context. The signature MUST be `(ctx) => hooks`
// (not `(options) => (ctx) => hooks`) so that adding the package name to
// `opencode.json`'s `plugin` array is enough to activate it with no glue file.
export const PiiRemoverPlugin = async (
  ctx: unknown
): Promise<CreatedHooks> => buildPluginFromCtx(ctx, {});

// Customization escape hatch for users who want to inject options
// (custom backends, alternative config path, disable health probe, ...).
// `.opencode/plugins/pii-remover.ts`:
//   import { configurePiiRemoverPlugin } from "@pii-remover/opencode-plugin"
//   export const plugin = configurePiiRemoverPlugin({ healthCheck: false })
export function configurePiiRemoverPlugin(
  pluginOptions: PiiRemoverPluginOptions
): (ctx: unknown) => Promise<CreatedHooks> {
  return (ctx: unknown) => buildPluginFromCtx(ctx, pluginOptions);
}

function buildInitOptions(args: {
  sessionId: string;
  config: PiiRemoverConfig;
  warn: (message: string) => void;
  backends?: readonly BackendClient[];
  audit?: AuditEmitter;
}): PIIRemoverInitOptions {
  const out: PIIRemoverInitOptions = {
    sessionId: args.sessionId,
    config: args.config,
    warn: args.warn,
  };
  if (args.backends && args.backends.length > 0) {
    out.backends = args.backends;
  }
  if (args.audit) {
    out.audit = args.audit;
  }
  return out;
}

export default PiiRemoverPlugin;
