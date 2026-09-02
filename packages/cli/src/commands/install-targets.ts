import { runCodexInstall } from "./codex-install.js";
import {
  proxyUrlForTarget,
  runInstall,
  runOpenCodeInstall,
  type InstallFs,
  type InstallResult,
  type InstallScope,
  type InstallTarget,
  type PiiRemoverConfigSlice,
  type ProxyRoot,
} from "./install.js";
import type { TargetOutcome } from "./install-report.js";

export interface TargetInstallRequest {
  readonly target: InstallTarget;
  readonly scope: InstallScope;
  readonly commandPath: string;
  readonly pluginRef: string;
  readonly dryRun: boolean;
  readonly proxyOnly: boolean;
  readonly piiConfig: PiiRemoverConfigSlice;
  readonly proxyRoot?: ProxyRoot;
  readonly fs?: InstallFs;
}

export async function installTarget(
  req: TargetInstallRequest
): Promise<TargetOutcome> {
  const proxyUrl =
    req.proxyRoot === undefined
      ? undefined
      : installerProxyUrl(req.target, req.proxyRoot);
  try {
    const result = await dispatchInstall(req, proxyUrl);
    return { kind: "installed", target: req.target, result, proxyUrl };
  } catch (err) {
    return { kind: "failed", target: req.target, message: errorMessage(err) };
  }
}

/**
 * OpenCode gets the bare root because it patches two provider entries and
 * derives an Anthropic and an OpenAI route from whatever it is handed; the
 * single-route hosts get their own already-prefixed URL.
 */
function installerProxyUrl(target: InstallTarget, root: ProxyRoot): string {
  switch (target) {
    case "opencode":
      return root.value;
    case "claude-code":
    case "codex":
      return proxyUrlForTarget(root, target);
    default:
      return assertNever(target);
  }
}

function dispatchInstall(
  req: TargetInstallRequest,
  proxyUrl: string | undefined
): Promise<InstallResult> {
  switch (req.target) {
    case "opencode":
      return installOpenCode(req, proxyUrl);
    case "codex":
      return installCodex(req, proxyUrl);
    case "claude-code":
      return installClaudeCode(req, proxyUrl);
    default:
      return assertNever(req.target);
  }
}

function installOpenCode(
  req: TargetInstallRequest,
  proxyUrl: string | undefined
): Promise<InstallResult> {
  const opts: Parameters<typeof runOpenCodeInstall>[0] = {
    target: "opencode",
    scope: req.scope,
    pluginRef: req.pluginRef,
    dryRun: req.dryRun,
    piiConfig: req.piiConfig,
  };
  if (proxyUrl !== undefined) opts.proxyUrl = proxyUrl;
  if (req.proxyOnly) opts.proxyOnly = true;
  if (req.fs) opts.fs = req.fs;
  return runOpenCodeInstall(opts);
}

function installCodex(
  req: TargetInstallRequest,
  proxyUrl: string | undefined
): Promise<InstallResult> {
  const opts: Parameters<typeof runCodexInstall>[0] = {
    target: "codex",
    scope: req.scope,
    commandPath: req.commandPath,
    dryRun: req.dryRun,
    piiConfig: req.piiConfig,
  };
  if (proxyUrl !== undefined) opts.proxyUrl = proxyUrl;
  if (req.fs) opts.fs = req.fs;
  return runCodexInstall(opts);
}

function installClaudeCode(
  req: TargetInstallRequest,
  proxyUrl: string | undefined
): Promise<InstallResult> {
  const opts: Parameters<typeof runInstall>[0] = {
    target: "claude-code",
    scope: req.scope,
    commandPath: req.commandPath,
    dryRun: req.dryRun,
    piiConfig: req.piiConfig,
  };
  if (proxyUrl !== undefined) opts.proxyUrl = proxyUrl;
  if (req.fs) opts.fs = req.fs;
  return runInstall(opts);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertNever(value: never): never {
  throw new Error(`unreachable install target: ${JSON.stringify(value)}`);
}
