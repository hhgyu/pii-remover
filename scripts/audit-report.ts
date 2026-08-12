/**
 * Audit-log report — renders the online metrics of
 * `docs/QUALITY-MEASUREMENT-PLAN.md` §3.1 plus the §4 unknown-token partition
 * from an audit JSONL (`audit.enabled: true`, or `PII_REMOVER_AUDIT=true`).
 *
 * Phase A of the plan made the counters exist; nothing ever read them back, so
 * the step it exists for — "run §3.1 over a real day of logs" — had no tool and
 * stayed unmeasured. This is that tool. It is also the gate for three open
 * decisions: whether `dead_token_rate` justifies vault persistence (L5),
 * whether `hallucination_rate` justifies a live A/B of the system note (L3),
 * and whether Phase D is worth its budget at all.
 *
 * Counters only. `session_id`, `vault_id` and `request_id` are used for
 * grouping and never printed, so the output stays safe to paste into an issue
 * (invariant I2 — a token hash or session handle is a stable pseudonymous
 * identifier, and a report is a much likelier thing to share than a log).
 *
 * Run:
 *   bun scripts/audit-report.ts                          # audit.log_path from config
 *   bun scripts/audit-report.ts --input audit.jsonl
 *   bun scripts/audit-report.ts -i a.jsonl -i b.jsonl --since 2026-08-01
 *   bun scripts/audit-report.ts --json                   # machine-readable
 */
import { existsSync, readFileSync } from "node:fs";
import type { AuditEntry, AuditEvent } from "../packages/core/src/audit/types.js";
import { loadConfig } from "../packages/core/src/config/loader.js";

/** Bucket for events whose emitter did not set `provider`. */
const UNSET = "(unset)";
const TOTAL = "ALL";

interface RestoreAgg {
  events: number;
  restored: number;
  unknown: number;
  pathSkip: number;
  partial: number;
  lenientRestored: number;
  repaired: number;
  /** Restore calls that still had a token-shaped span in the final text. */
  residualEvents: number;
  hallucinated: number;
  unminted: number;
  dead: number;
  ambiguous: number;
}

interface MaskAgg {
  events: number;
  minted: number;
  textLength: number;
  maskedChars: number;
}

interface Group {
  restore: RestoreAgg;
  mask: MaskAgg;
  bypass: number;
  block: number;
  error: number;
}

interface Integrity {
  /** Restore events missing counters that Phase A (lever L1) added. */
  staleRestoreEvents: number;
  /** Mask events missing `minted_count` / `text_length` / `masked_char_count`. */
  staleMaskEvents: number;
  /** Events where the §4 partition does not sum back to `unknown_token_count`. */
  partitionMismatches: number;
}

interface Parsed {
  groups: Map<string, Group>;
  categories: Map<string, number>;
  sessionsWithMints: Set<string>;
  sessionsWithRestores: Set<string>;
  integrity: Integrity;
  lines: number;
  malformed: number;
  skippedByWindow: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

function emptyGroup(): Group {
  return {
    restore: {
      events: 0,
      restored: 0,
      unknown: 0,
      pathSkip: 0,
      partial: 0,
      lenientRestored: 0,
      repaired: 0,
      residualEvents: 0,
      hallucinated: 0,
      unminted: 0,
      dead: 0,
      ambiguous: 0,
    },
    mask: { events: 0, minted: 0, textLength: 0, maskedChars: 0 },
    bypass: 0,
    block: 0,
    error: 0,
  };
}

function observedOf(r: RestoreAgg): number {
  return r.restored + r.unknown + r.pathSkip;
}

function num(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function pct(numerator: number, denominator: number): string {
  const r = ratio(numerator, denominator);
  return r === null ? "n/a" : `${(r * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------- parsing

interface Args {
  inputs: string[];
  since: string | undefined;
  until: string | undefined;
  json: boolean;
}

const USAGE = `Usage: bun scripts/audit-report.ts [options] [file...]

  -i, --input <file>   Audit JSONL to read (repeatable). Default: audit.log_path from config.
      --since <iso>    Drop entries with timestamp < this ISO instant.
      --until <iso>    Drop entries with timestamp > this ISO instant.
      --json           Emit JSON instead of the Markdown report.
  -h, --help           Show this help.`;

function fail(message: string): never {
  process.stderr.write(`audit-report: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  const inputs: string[] = [];
  let since: string | undefined;
  let until: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const takeValue = (flag: string): string => {
      const value = argv[++i];
      if (value === undefined) fail(`${flag} requires a value`);
      return value;
    };
    if (arg === "-i" || arg === "--input") inputs.push(takeValue(arg));
    else if (arg === "--since") since = takeValue(arg);
    else if (arg === "--until") until = takeValue(arg);
    else if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (arg.startsWith("-")) fail(`unknown flag: ${arg}`);
    else inputs.push(arg);
  }

  for (const bound of [since, until]) {
    if (bound !== undefined && Number.isNaN(Date.parse(bound))) {
      fail(`not a parsable instant: ${bound}`);
    }
  }
  return { inputs, since, until, json };
}

async function resolveInputs(fromArgs: readonly string[]): Promise<string[]> {
  if (fromArgs.length > 0) return [...fromArgs];
  const config = await loadConfig();
  const configured = config.audit.log_path;
  if (configured === null) {
    fail("no --input given and audit.log_path is not configured");
  }
  return [configured];
}

function isAuditEvent(value: unknown): value is AuditEvent {
  return (
    value === "mask" ||
    value === "restore" ||
    value === "bypass" ||
    value === "block" ||
    value === "error"
  );
}

/**
 * A JSONL line is only trusted as an audit entry when it carries a known event
 * name and an ISO timestamp. Anything else is counted as malformed rather than
 * silently folded into a denominator.
 */
function toEntry(value: unknown): AuditEntry | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isAuditEvent(record["event"])) return null;
  if (typeof record["timestamp"] !== "string") return null;
  return record as unknown as AuditEntry;
}

function accumulate(parsed: Parsed, entry: AuditEntry): void {
  const provider = entry.provider ?? UNSET;
  let group = parsed.groups.get(provider);
  if (group === undefined) {
    group = emptyGroup();
    parsed.groups.set(provider, group);
  }

  if (entry.event === "restore") {
    const r = group.restore;
    r.events++;
    r.restored += num(entry.restored_count);
    r.unknown += num(entry.unknown_token_count);
    r.pathSkip += num(entry.path_skip_count);
    r.partial += num(entry.partial_match_count);
    r.lenientRestored += num(entry.lenient_restored_count);
    r.repaired += num(entry.repaired_count);
    if (num(entry.residual_token_count) > 0) r.residualEvents++;
    r.hallucinated += num(entry.hallucinated_count);
    r.unminted += num(entry.unminted_token_count);
    r.dead += num(entry.dead_token_count);
    r.ambiguous += num(entry.ambiguous_count);

    if (entry.path_skip_count === undefined) {
      // Pre-Phase-A events have no partition fields at all, so checking them
      // would report every old line as a restorer bug. They are already called
      // out as stale; the partition check is about what a current build emits.
      parsed.integrity.staleRestoreEvents++;
    } else {
      const partition =
        num(entry.hallucinated_count) +
        num(entry.unminted_token_count) +
        num(entry.dead_token_count) +
        num(entry.ambiguous_count);
      if (partition !== num(entry.unknown_token_count)) {
        parsed.integrity.partitionMismatches++;
      }
    }
    if (entry.session_id !== undefined) parsed.sessionsWithRestores.add(entry.session_id);
    return;
  }

  if (entry.event === "mask") {
    const m = group.mask;
    m.events++;
    m.minted += num(entry.minted_count);
    m.textLength += num(entry.text_length);
    m.maskedChars += num(entry.masked_char_count);
    if (entry.minted_count === undefined) parsed.integrity.staleMaskEvents++;
    for (const [category, count] of Object.entries(entry.categories ?? {})) {
      parsed.categories.set(category, (parsed.categories.get(category) ?? 0) + count);
    }
    if (entry.session_id !== undefined) parsed.sessionsWithMints.add(entry.session_id);
    return;
  }

  if (entry.event === "bypass") group.bypass++;
  else if (entry.event === "block") group.block++;
  else group.error++;
}

function readAll(files: readonly string[], args: Args): Parsed {
  const parsed: Parsed = {
    groups: new Map(),
    categories: new Map(),
    sessionsWithMints: new Set(),
    sessionsWithRestores: new Set(),
    integrity: { staleRestoreEvents: 0, staleMaskEvents: 0, partitionMismatches: 0 },
    lines: 0,
    malformed: 0,
    skippedByWindow: 0,
    firstTimestamp: null,
    lastTimestamp: null,
  };

  for (const file of files) {
    if (!existsSync(file)) fail(`no such file: ${file}`);
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      parsed.lines++;
      let entry: AuditEntry | null = null;
      try {
        entry = toEntry(JSON.parse(line));
      } catch {
        entry = null;
      }
      if (entry === null) {
        parsed.malformed++;
        continue;
      }
      if (args.since !== undefined && entry.timestamp < args.since) {
        parsed.skippedByWindow++;
        continue;
      }
      if (args.until !== undefined && entry.timestamp > args.until) {
        parsed.skippedByWindow++;
        continue;
      }
      if (parsed.firstTimestamp === null || entry.timestamp < parsed.firstTimestamp) {
        parsed.firstTimestamp = entry.timestamp;
      }
      if (parsed.lastTimestamp === null || entry.timestamp > parsed.lastTimestamp) {
        parsed.lastTimestamp = entry.timestamp;
      }
      accumulate(parsed, entry);
    }
  }
  return parsed;
}

// -------------------------------------------------------------- rendering

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length))
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  return [
    line(headers),
    `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`,
    ...rows.map(line),
  ].join("\n");
}

function totals(groups: ReadonlyMap<string, Group>): Group {
  const all = emptyGroup();
  for (const group of groups.values()) {
    for (const key of Object.keys(all.restore) as (keyof RestoreAgg)[]) {
      all.restore[key] += group.restore[key];
    }
    for (const key of Object.keys(all.mask) as (keyof MaskAgg)[]) {
      all.mask[key] += group.mask[key];
    }
    all.bypass += group.bypass;
    all.block += group.block;
    all.error += group.error;
  }
  return all;
}

function orderedGroups(parsed: Parsed): [string, Group][] {
  const rows = [...parsed.groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return [...rows, [TOTAL, totals(parsed.groups)]];
}

function restoreRows(rows: readonly [string, Group][]): string[][] {
  return rows.map(([provider, group]) => {
    const r = group.restore;
    const observed = observedOf(r);
    return [
      provider,
      String(r.events),
      String(observed),
      String(r.restored),
      pct(r.restored, observed),
      pct(r.unknown + r.pathSkip, observed),
      pct(r.partial, observed),
      pct(r.lenientRestored, r.partial),
      pct(r.repaired, observed),
      pct(r.residualEvents, r.events),
    ];
  });
}

function partitionRows(rows: readonly [string, Group][]): string[][] {
  return rows.map(([provider, group]) => {
    const r = group.restore;
    const observed = observedOf(r);
    return [
      provider,
      String(r.unknown),
      pct(r.hallucinated, observed),
      pct(r.unminted, observed),
      pct(r.dead, observed),
      pct(r.ambiguous, observed),
      pct(r.pathSkip, observed),
    ];
  });
}

function maskRows(rows: readonly [string, Group][]): string[][] {
  return rows.map(([provider, group]) => {
    const m = group.mask;
    const ingress = m.events + group.bypass + group.block;
    return [
      provider,
      String(m.events),
      String(m.minted),
      String(m.textLength),
      String(m.maskedChars),
      pct(m.maskedChars, m.textLength),
      String(group.bypass),
      String(group.block),
      pct(group.bypass, ingress),
    ];
  });
}

function integrityLines(parsed: Parsed): string[] {
  const out: string[] = [];
  if (parsed.malformed > 0) {
    out.push(`- ${parsed.malformed} line(s) were not parsable audit entries and were dropped.`);
  }
  if (parsed.integrity.staleRestoreEvents > 0) {
    out.push(
      `- **${parsed.integrity.staleRestoreEvents} restore event(s) predate Phase A** (no ` +
        "`path_skip_count`). Their observed-token denominator is incomplete — the rates " +
        "below understate misses. Re-collect on a current build before acting on them."
    );
  }
  if (parsed.integrity.staleMaskEvents > 0) {
    out.push(
      `- **${parsed.integrity.staleMaskEvents} mask event(s) predate Phase A** (no ` +
        "`minted_count`). `token_reference_rate` and `mask_density` are understated."
    );
  }
  if (parsed.integrity.partitionMismatches > 0) {
    out.push(
      `- **${parsed.integrity.partitionMismatches} restore event(s) fail the §4 partition check**: ` +
        "`hallucinated + unminted + dead + ambiguous ≠ unknown_token_count`. A miss cause " +
        "reaches `unknownTokenCount` without a bucket — fix the restorer before trusting §4."
    );
  }
  if (out.length === 0) out.push("- No schema problems found.");
  return out;
}

function renderMarkdown(parsed: Parsed, files: readonly string[]): string {
  const rows = orderedGroups(parsed);
  const all = totals(parsed.groups);
  const observed = observedOf(all.restore);
  const window =
    parsed.firstTimestamp === null
      ? "(no entries)"
      : `${parsed.firstTimestamp} → ${parsed.lastTimestamp}`;

  return [
    "# Audit report — QUALITY-MEASUREMENT-PLAN §3.1 / §4",
    "",
    `- files: ${files.length} (${parsed.lines} lines, ${parsed.skippedByWindow} outside the window)`,
    `- window: ${window}`,
    `- events: mask ${all.mask.events} · restore ${all.restore.events} · ` +
      `bypass ${all.bypass} · block ${all.block} · error ${all.error}`,
    `- sessions: ${parsed.sessionsWithMints.size} minted · ` +
      `${parsed.sessionsWithRestores.size} restored`,
    "",
    "## Schema integrity",
    "",
    ...integrityLines(parsed),
    "",
    "## §3.1 Restore metrics",
    "",
    "`observed = restored + unknown + path_skip` — tokens seen in model output, not tokens minted.",
    "",
    renderTable(
      [
        "provider",
        "events",
        "observed",
        "restored",
        "restore_rate",
        "unknown_rate",
        "lenient_rate",
        "lenient_recovery",
        "repair_rate",
        "unrestorable_surface",
      ],
      restoreRows(rows)
    ),
    "",
    "## §4 Unknown-token partition",
    "",
    "`hallucination_rate` counts model-authored text only; token-shaped strings in tool",
    "output or user messages land in `unminted_rate` (plan §4, `RestoreOptions.origin`).",
    "",
    renderTable(
      [
        "provider",
        "unknown",
        "hallucination_rate",
        "unminted_rate",
        "dead_token_rate",
        "ambiguous_rate",
        "path_skip_rate",
      ],
      partitionRows(rows)
    ),
    "",
    "## Mask metrics",
    "",
    renderTable(
      [
        "provider",
        "events",
        "minted",
        "text_chars",
        "masked_chars",
        "mask_density",
        "bypass",
        "block",
        "bypass_rate",
      ],
      maskRows(rows)
    ),
    "",
    `- \`token_reference_rate\`: **${pct(observed, all.mask.minted)}** ` +
      `(${observed} observed / ${all.mask.minted} minted)`,
    "",
    "### Minted by category",
    "",
    renderTable(
      ["category", "minted"],
      [...parsed.categories.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([category, count]) => [category, String(count)])
    ),
    "",
    "## Not computable from this log",
    "",
    "- **`leak_rate`** — plan §3.1 needs `residual_detection_count` (re-detect the masked",
    "  text and count surviving spans). The field does not exist in `audit/types.ts` and no",
    "  re-detection pass exists. This is the only §3.1 metric that measures *masking* rather",
    "  than *restoration*, and it is the one that is missing.",
    "- **per-category `mask_density`** — `masked_char_count` is a per-request total, so char",
    "  counts cannot be attributed to a category. The table above is whole-request density;",
    "  the per-category split needs a `masked_char_count` keyed by category.",
    "",
    "## Reading these numbers",
    "",
    "- `minted` sums per-request distinct tokens. Deterministic hashing (ADR-0020) means the",
    "  same PII re-minted in a later request is counted again, so `token_reference_rate` is a",
    "  reference *rate*, not distinct-token coverage.",
    "- `unrestorable_surface` counts restore calls whose output still matched the scanner —",
    "  including the loose repair pattern, which also matches ordinary token-like text. Treat",
    "  it as an upper bound.",
    "- The proxy shares one vault across providers, so per-provider rows split traffic, not",
    "  vaults. Compare providers for transport-level differences (plan §2 B1), not for",
    "  vault-level ones.",
  ].join("\n");
}

function toJson(parsed: Parsed, files: readonly string[]): unknown {
  const rows = orderedGroups(parsed);
  const all = totals(parsed.groups);
  return {
    files,
    lines: parsed.lines,
    malformed: parsed.malformed,
    skipped_by_window: parsed.skippedByWindow,
    window: { first: parsed.firstTimestamp, last: parsed.lastTimestamp },
    integrity: parsed.integrity,
    sessions: {
      with_mints: parsed.sessionsWithMints.size,
      with_restores: parsed.sessionsWithRestores.size,
    },
    token_reference_rate: ratio(observedOf(all.restore), all.mask.minted),
    unavailable: { leak_rate: "audit/types.ts has no residual_detection_count" },
    by_provider: Object.fromEntries(
      rows.map(([provider, group]) => {
        const r = group.restore;
        const observed = observedOf(r);
        const ingress = group.mask.events + group.bypass + group.block;
        return [
          provider,
          {
            counts: { ...r, observed, mask: { ...group.mask }, bypass: group.bypass, block: group.block, error: group.error },
            rates: {
              token_restore_rate: ratio(r.restored, observed),
              unknown_token_rate: ratio(r.unknown + r.pathSkip, observed),
              lenient_rate: ratio(r.partial, observed),
              lenient_recovery_rate: ratio(r.lenientRestored, r.partial),
              repair_rate: ratio(r.repaired, observed),
              unrestorable_surface_rate: ratio(r.residualEvents, r.events),
              hallucination_rate: ratio(r.hallucinated, observed),
              unminted_token_rate: ratio(r.unminted, observed),
              dead_token_rate: ratio(r.dead, observed),
              ambiguous_rate: ratio(r.ambiguous, observed),
              path_skip_rate: ratio(r.pathSkip, observed),
              mask_density: ratio(group.mask.maskedChars, group.mask.textLength),
              bypass_rate: ratio(group.bypass, ingress),
            },
          },
        ];
      })
    ),
    categories: Object.fromEntries(parsed.categories),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const files = await resolveInputs(args.inputs);
  const parsed = readAll(files, args);
  const output = args.json
    ? JSON.stringify(toJson(parsed, files), null, 2)
    : renderMarkdown(parsed, files);
  process.stdout.write(`${output}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`audit-report: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
