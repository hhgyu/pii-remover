import { resolve } from "node:path";

import {
  OPENCODE_PLUGIN_PACKAGE,
  defaultProxyRoot,
  normalizeProxyRoot,
  type InstallScope,
  type InstallTarget,
  type PiiRemoverConfigSlice,
  type ProxyRoot,
} from "./install.js";
import {
  isInstalled,
  renderInstallReport,
  type TargetOutcome,
} from "./install-report.js";
import {
  promptForTargets,
  resolvePiiConfig,
  type PiiConfigFlags,
  type PromptIo,
} from "./install-prompt.js";
import { installTarget, type TargetInstallRequest } from "./install-targets.js";

export type {
  CheckboxChoice,
  SelectCategoriesFn,
  SelectTargetsFn,
} from "./install-prompt.js";

export interface InstallCommandIo extends PromptIo {
  stderr: (s: string) => void;
  argv0?: string;
}

export interface InstallCommandFlags extends PiiConfigFlags {
  target?: InstallTarget;
  scope?: InstallScope;
  commandPath?: string;
  proxyUrl?: string;
  proxy?: boolean;
  proxyOnly?: boolean;
  idleTimeoutSeconds?: number;
  dryRun: boolean;
}

/**
 * Execution order, and the order the checkbox offers. Fixed rather than
 * following the order the user ticked boxes in, so the same selection always
 * produces the same write sequence and the same report.
 */
export const INSTALL_TARGET_ORDER: readonly InstallTarget[] = [
  "claude-code",
  "opencode",
  "codex",
];

const TARGET_LABELS: Readonly<Record<InstallTarget, string>> = {
  "claude-code": "Claude Code — UserPromptSubmit hook + ANTHROPIC_BASE_URL",
  opencode: "OpenCode — mask/restore plugin + provider baseURL",
  codex: "OpenAI Codex CLI — UserPromptSubmit hook + openai_base_url",
};

interface InstallRunContext {
  readonly flags: InstallCommandFlags;
  readonly io: InstallCommandIo;
  readonly piiConfig: PiiRemoverConfigSlice;
}

export async function runInstallCommand(
  flags: InstallCommandFlags,
  io: InstallCommandIo
): Promise<number> {
  const targets = await resolveTargets(flags, io);
  if (targets.length === 0) {
    io.stderr(
      "install: select at least one target (claude-code | opencode | codex)\n"
    );
    return 64;
  }
  if (flags.proxyOnly === true && !targets.includes("opencode")) {
    io.stderr(
      `install: --proxy-only applies to opencode only, which is not in the selection (${targets.join(", ")})\n`
    );
    return 64;
  }

  const piiConfig = await resolvePiiConfig(flags, io);
  const ctx: InstallRunContext = { flags, io, piiConfig };

  const outcomes: TargetOutcome[] = [];
  for (const target of targets) {
    const outcome = await installTarget(buildRequest(target, ctx));
    if (!isInstalled(outcome)) {
      const where = targets.length > 1 ? ` [${target}]` : "";
      io.stderr(`install failed${where}: ${outcome.message}\n`);
    }
    outcomes.push(outcome);
  }

  const report = renderInstallReport(outcomes, {
    dryRun: flags.dryRun,
    piiConfig,
    idleTimeoutSeconds: flags.idleTimeoutSeconds,
  });
  if (report !== "") io.stdout(report);

  return outcomes.every(isInstalled) ? 0 : 2;
}

async function resolveTargets(
  flags: InstallCommandFlags,
  io: InstallCommandIo
): Promise<readonly InstallTarget[]> {
  if (flags.target !== undefined) return [flags.target];

  const select = io.selectTargets ?? promptForTargets;
  const chosen = await select(
    INSTALL_TARGET_ORDER.map((value) => ({
      value,
      name: TARGET_LABELS[value],
      checked: false,
    }))
  );
  return INSTALL_TARGET_ORDER.filter((target) => chosen.includes(target));
}

function buildRequest(
  target: InstallTarget,
  ctx: InstallRunContext
): TargetInstallRequest {
  const { flags, io } = ctx;
  return {
    target,
    scope: flags.scope ?? "global",
    commandPath:
      flags.commandPath ?? resolve(io.argv0 ?? process.argv[1] ?? "pii-remover"),
    pluginRef: flags.commandPath ?? OPENCODE_PLUGIN_PACKAGE,
    dryRun: flags.dryRun,
    proxyOnly: flags.proxyOnly === true,
    piiConfig: ctx.piiConfig,
    proxyRoot: resolveProxyRoot(flags),
    fs: io.installFs,
  };
}

function resolveProxyRoot(flags: InstallCommandFlags): ProxyRoot | undefined {
  if (flags.proxyUrl !== undefined) return normalizeProxyRoot(flags.proxyUrl);
  if (flags.proxy === true) return defaultProxyRoot();
  return undefined;
}
