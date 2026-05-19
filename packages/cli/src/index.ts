export { runCli, parseFlags, helpText } from "./cli.js";
export type { CliIo, ParsedFlags } from "./cli.js";

export { runHookCommand, readStdin } from "./commands/hook.js";
export type { HookCommandIo, HookCommandResult } from "./commands/hook.js";

export { runInstall } from "./commands/install.js";
export type {
  InstallOptions,
  InstallResult,
  InstallTarget,
  InstallFs,
} from "./commands/install.js";

export {
  runCodexInstall,
  patchCodexConfigToml,
  CODEX_HOOK_EVENT_NAME,
  CODEX_HOOK_TYPE,
} from "./commands/codex-install.js";
export type {
  CodexInstallOptions,
  CodexPatchResult,
} from "./commands/codex-install.js";

export { runDetectCommand } from "./commands/detect.js";
export type {
  DetectCommandIo,
  DetectCommandResult,
} from "./commands/detect.js";

export { runHealthCommand } from "./commands/health.js";
export type {
  HealthCommandIo,
  HealthCommandResult,
  FetchLike,
} from "./commands/health.js";

export {
  parseHookInput,
  serializeOutput,
  HookProtocolError,
} from "./protocol/user-prompt-submit.js";
export type {
  UserPromptSubmitInput,
  UserPromptSubmitOutput,
  HookExitCode,
} from "./protocol/user-prompt-submit.js";

export { detectProxy } from "./protocol/proxy-detection.js";
export type {
  ProxyDetectionResult,
  ProxyDetectionEnv,
} from "./protocol/proxy-detection.js";

export {
  HOOK_EVENT_NAME,
  CLAUDE_HOOK_TYPE,
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  DEFAULT_PROXY_PORT,
  PACKAGE_VERSION,
} from "./constants.js";
