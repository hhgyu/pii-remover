import {
  AuditEmitter,
  FailClosedError,
  PIIRemover,
  type BackendClient,
  type MaskResult,
  type PiiRemoverConfig,
  type PIIRemoverInitOptions,
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
  title: string;
  output: string;
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

const OPF_PLACEHOLDER_SYSTEM_NOTE =
  "Inputs may contain privacy-preserving placeholders matching the pattern __OPF_<LABEL>_<N>__. " +
  "Treat them as the original semantic entity, but never generate, expand, or invent new placeholders. " +
  "When summarizing or compressing conversation history, preserve every __OPF_*__ token exactly as written.";

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
  let disposed = false;

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
    if (disposed) return text;
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
    if (disposed) return text;
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

  function restoreText(text: string, where: string): string {
    if (disposed) return text;
    if (typeof text !== "string" || text.length === 0) return text;
    if (!text.includes("__OPF_") && !/__opf_/i.test(text)) return text;
    try {
      const r = remover.restore(text, {
        warn: (msg) => warn(msg),
      });
      return r.text;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warn(`[pii-remover] ${where} restore failed: ${reason}`);
      return text;
    }
  }

  function restoreFieldText(text: string): string {
    return restoreText(text, "tool.execute.before display-tool restore");
  }

  function stripTokens(text: string): string {
    return text.replace(/__OPF_[A-Z_]+_\d+__/gi, "[REDACTED]");
  }

  async function maskPartInPlace(part: ChatMessageTransformPart): Promise<void> {
    if (!part || typeof part !== "object") return;
    const type = part.type;

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
          state.input = await maskTextFieldsStrict(
            state.input,
            maskMessagePartText
          );
        }
        if (typeof state.output === "string") {
          state.output = await maskMessagePartText(state.output);
        }
        if (typeof state.title === "string") {
          state.title = await maskMessagePartText(state.title);
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
    async event(input: EventEnvelope): Promise<void> {
      const ev = input?.event;
      if (!ev || typeof ev.type !== "string") return;
      if (ev.type === "session.idle" && !disposed) {
        disposed = true;
        try {
          remover.dispose();
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          warn(`[pii-remover] dispose on session.idle failed: ${reason}`);
        }
      }
    },
  };

  if (isMask) {
    hooks["tool.execute.before"] = async (
      input: ToolBeforeInput,
      output: ToolBeforeOutput
    ): Promise<void> => {
      if (disposed) return;
      if (output.args === undefined || output.args === null) return;
      if (
        displayRestoreEnabled &&
        isDisplayTool(input.tool, displayToolConfig)
      ) {
        const restored = await restoreTextFields(output.args, restoreFieldText);
        output.args = restored;
        return;
      }
      const next = await maskTextFields(
        output.args,
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
      if (disposed) return;
      if (typeof output.output === "string") {
        output.output = restoreText(output.output, "tool.execute.after");
      }
      if (typeof output.title === "string") {
        output.title = restoreText(output.title, "tool.execute.after");
      }
    };
  }

  if (registerExperimental) {
    if (isMask) {
      hooks["experimental.chat.system.transform"] = async (
        _input: SystemTransformInput,
        output: SystemTransformOutput
      ): Promise<void> => {
        if (disposed) return;
        if (!Array.isArray(output.system)) return;
        if (!output.system.includes(OPF_PLACEHOLDER_SYSTEM_NOTE)) {
          output.system.push(OPF_PLACEHOLDER_SYSTEM_NOTE);
        }
      };
      hooks["experimental.chat.messages.transform"] = async (
        _input: {},
        output: ChatMessagesTransformOutput
      ): Promise<void> => {
        if (disposed) return;
        if (!Array.isArray(output.messages)) return;
        for (const message of output.messages) {
          if (!message || !Array.isArray(message.parts)) continue;
          for (const part of message.parts) {
            await maskPartInPlace(part);
          }
        }
      };
    }
    if (isRestore) {
      hooks["experimental.text.complete"] = async (
        _input: TextCompleteInput,
        output: TextCompleteOutput
      ): Promise<void> => {
        if (disposed) return;
        if (typeof output.text !== "string") return;
        output.text = restoreText(output.text, "experimental.text.complete");
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
