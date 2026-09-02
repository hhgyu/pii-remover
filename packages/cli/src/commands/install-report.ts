import type {
  InstallResult,
  InstallTarget,
  PiiRemoverConfigSlice,
} from "./install.js";

export interface InstalledOutcome {
  readonly kind: "installed";
  readonly target: InstallTarget;
  readonly result: InstallResult;
  readonly proxyUrl?: string;
}

export interface FailedOutcome {
  readonly kind: "failed";
  readonly target: InstallTarget;
  readonly message: string;
}

export type TargetOutcome = InstalledOutcome | FailedOutcome;

export interface ReportContext {
  readonly dryRun: boolean;
  readonly piiConfig: PiiRemoverConfigSlice;
  readonly idleTimeoutSeconds?: number;
}

/**
 * Renders the console report. A lone target keeps the pre-checkbox layout
 * verbatim — no header, no summary — so scripts that installed one host and
 * parsed stdout keep working; headers and a summary appear only once a run
 * covers more than one host. When a single target fails, the failure is
 * already reported on stderr by runInstallCommand; this function returns ""
 * if no idle timeout is set, or only the idle guidance if one is set.
 */
export function renderInstallReport(
  outcomes: readonly TargetOutcome[],
  ctx: ReportContext
): string {
  const multi = outcomes.length > 1;
  const hasInstalled = outcomes.some(isInstalled);
  const idleLines = idleTimeoutLines(ctx.idleTimeoutSeconds);

  // Single target failed: no stdout output unless idle timeout guidance exists
  if (!multi && !hasInstalled) {
    if (idleLines.length === 0) return "";
    return [...idleLines, ""].join("\n");
  }

  const lines = outcomes.flatMap((outcome) =>
    multi
      ? [`=== ${outcome.target} ===`, ...outcomeLines(outcome, ctx), ""]
      : [...outcomeLines(outcome, ctx)]
  );
  if (multi) lines.push(...summaryLines(outcomes));
  lines.push(...idleLines);
  lines.push("");
  return lines.join("\n");
}

export function isInstalled(outcome: TargetOutcome): outcome is InstalledOutcome {
  return outcome.kind === "installed";
}

function outcomeLines(
  outcome: TargetOutcome,
  ctx: ReportContext
): readonly string[] {
  switch (outcome.kind) {
    case "installed":
      return installedLines(outcome, ctx);
    case "failed":
      return [`install failed: ${outcome.message}`];
    default:
      return assertNever(outcome);
  }
}

function installedLines(
  outcome: InstalledOutcome,
  ctx: ReportContext
): readonly string[] {
  const result = outcome.result;
  const lines = [
    `${ctx.dryRun ? "[dry-run] " : ""}${result.settings_path}`,
    `${ctx.dryRun ? "would " : ""}${result.created ? "create" : "patch"}; plugin/hook ${
      result.hook_already_present ? "already present" : "registered"
    }.`,
  ];
  if (result.config_written && result.config_path) {
    lines.push(`Config written: ${result.config_path}`);
  }
  if (outcome.proxyUrl !== undefined) {
    lines.push(...proxyLines(result, outcome.proxyUrl));
  }
  if (ctx.piiConfig.auto_start === true) {
    lines.push(
      `Backend auto-start: ENABLED (compose_file=${ctx.piiConfig.compose_file ?? "cpu"})`
    );
  } else if (ctx.piiConfig.auto_start === false) {
    lines.push("Backend auto-start: DISABLED (explicit opt-out)");
  }
  lines.push("", "Next steps:", ...result.next_steps);
  return lines;
}

const BYPASS_WARNING =
  "NOT APPLIED (existing base URL left untouched) — requests will bypass the proxy";

/**
 * A host that patches several provider entries reports each one, because one
 * conflicting entry leaves that provider talking straight to its vendor while
 * the others go through the proxy — a single verdict would hide the leak.
 */
function proxyLines(
  result: InstallResult,
  proxyUrl: string
): readonly string[] {
  const patches = result.provider_base_urls;
  if (patches !== undefined && patches.length > 0) {
    return patches.map((patch) =>
      patch.outcome.written
        ? `Proxy mode (${patch.provider}): ENABLED -> ${patch.url}`
        : `Proxy mode (${patch.provider}): ${BYPASS_WARNING}`
    );
  }
  return [
    result.base_url_written === true
      ? `Proxy mode: ENABLED -> ${proxyUrl}`
      : `Proxy mode: ${BYPASS_WARNING}`,
  ];
}

function summaryLines(outcomes: readonly TargetOutcome[]): readonly string[] {
  const width = Math.max(...outcomes.map((o) => o.target.length));
  return ["Summary:", ...outcomes.map((o) => summaryLine(o, width))];
}

function summaryLine(outcome: TargetOutcome, width: number): string {
  const name = outcome.target.padEnd(width);
  switch (outcome.kind) {
    case "installed":
      return `  ${name}  installed`;
    case "failed":
      return `  ${name}  FAILED — ${outcome.message}`;
    default:
      return assertNever(outcome);
  }
}

function idleTimeoutLines(seconds: number | undefined): readonly string[] {
  if (seconds === undefined) return [];
  return [
    "",
    `Idle-unload timeout requested: ${seconds}s`,
    `  (config files do NOT carry OPF_IDLE_TIMEOUT_SECONDS — it is a backend-side env var)`,
    `  Set on the backend container, e.g.:`,
    `    OPF_IDLE_TIMEOUT_SECONDS=${seconds} docker compose up -d`,
    `  Or persist via packages/backend/docker-compose.yml or a .env file.`,
    seconds === 0
      ? `  (0 = disabled; model stays loaded until container stops)`
      : `  Next /redact after ${seconds}s idle lazy-reloads the model.`,
  ];
}

function assertNever(value: never): never {
  throw new Error(`unreachable install outcome: ${JSON.stringify(value)}`);
}
