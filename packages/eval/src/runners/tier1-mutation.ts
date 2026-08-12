import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { Restorer } from "@pii-remover/core";

import {
  PACKAGE_ROOT,
  loadCorpus,
  maskCorpus,
  vaultValues,
  type MaskedCorpus,
} from "../corpus/index.js";
import { MUTATION_CLASSES } from "../mutators/index.js";
import {
  classifyTokenResolution,
  falseRestorationRate,
  scoreRoundtrip,
} from "../scoring/index.js";
import { formatIdentityTable, formatTier1Table, formatBaselineMarkdown } from "../report/table.js";
import {
  addIdentity,
  classStatus,
  emptyIdentity,
  isFailure,
  type IdentityResult,
  type MutationClassResult,
  type Tier1Report,
} from "../report/types.js";
import type {
  MaskedEntry,
  MutationClass,
  MutationCorpus,
  MutationResult,
  TokenInfo,
} from "../types.js";

export const BASELINE_PATH = join(PACKAGE_ROOT, "baseline.md");

const MAX_NOTES_PER_CLASS = 3;

export interface Tier1Options {
  readonly corpus?: MutationCorpus;
  readonly classes?: readonly MutationClass[];
}

/**
 * Tier 1 (plan §5): every corpus entry crossed with every mutation class,
 * scored offline. No network, no Docker, no model — the corpus carries its own
 * ground truth and the vault is minted in-process from a fixed key.
 */
export function runTier1(options: Tier1Options = {}): Tier1Report {
  const startedAt = performance.now();
  const corpus = options.corpus ?? loadCorpus();
  const classes = options.classes ?? MUTATION_CLASSES;
  const masked = maskCorpus(corpus);
  const values = vaultValues(masked);
  const context = createScoringContext(masked, values);
  const results = classes.map((klass) => scoreClass(context, klass));
  const identity = results.reduce(
    (acc, result) => addIdentity(acc, result.identity),
    emptyIdentity(),
  );

  return {
    corpusEntries: masked.entries.length,
    corpusTokens: values.length,
    totalCases: results.reduce((n, result) => n + result.cases, 0),
    classes: results,
    identity,
    falseRestorationRate: falseRestorationRate({
      probes: identity.probes,
      foreignValues: identity.foreignValue,
    }),
    durationMs: performance.now() - startedAt,
  };
}

interface ScoringContext {
  readonly masked: MaskedCorpus;
  readonly values: readonly TokenInfo[];
  readonly restore: (mutation: MutationResult) => string;
}

export function createScoringContext(
  masked: MaskedCorpus,
  values: readonly TokenInfo[],
): ScoringContext {
  const restorer = new Restorer(masked.vault, {
    warnOnPartial: false,
    warnOnUnknownToken: false,
    warn: () => {},
  });
  return {
    masked,
    values,
    restore: (mutation) =>
      (mutation.deltas ?? [mutation.text])
        .map((unit) => restorer.restore(unit, masked.sessionId).text)
        .join(""),
  };
}

function scoreClass(
  context: ScoringContext,
  klass: MutationClass,
): MutationClassResult {
  const notes = new Set<string>();
  const totals = { cases: 0, expected: 0, restored: 0, residual: 0, recoverable: 0 };
  let identity = emptyIdentity();

  for (const entry of eligibleEntries(klass, context.masked.entries)) {
    const mutation = klass.mutate(entry.masked, entry.tokens);
    if (mutation.note !== undefined && notes.size < MAX_NOTES_PER_CLASS) {
      notes.add(mutation.note);
    }
    const roundtrip = scoreRoundtrip({
      restoredText: context.restore(mutation),
      expectedValues:
        klass.kind === "probe" ? [] : entry.tokens.map((token) => token.value),
    });

    totals.cases += 1;
    if (mutation.expectedRecoverable) totals.recoverable += 1;
    totals.expected += roundtrip.expected;
    totals.restored += roundtrip.restored;
    totals.residual += roundtrip.residualTokens;
    identity = addIdentity(identity, probeEntry(context, klass, entry));
  }

  return {
    id: klass.id,
    name: klass.name,
    kind: klass.kind,
    description: klass.description,
    cases: totals.cases,
    expected: totals.expected,
    restored: totals.restored,
    residualTokens: totals.residual,
    expectedRecoverable: totals.cases > 0 && totals.recoverable === totals.cases,
    identity,
    notes: [...notes],
  };
}

/**
 * One identity probe per minted token: mutate that token ALONE and restore it,
 * so the answer to "which vault entry did this token resolve to" needs no
 * positional inference. Mutation 13 swaps two tokens inside one sentence, and
 * a whole-sentence value count cannot tell a swap from a correct restoration.
 */
function probeEntry(
  context: ScoringContext,
  klass: MutationClass,
  entry: MaskedEntry,
): IdentityResult {
  let result = emptyIdentity();
  for (const owner of entry.tokens) {
    const mutation = klass.mutate(owner.token, entry.tokens);
    const verdict = classifyTokenResolution({
      owner,
      observedSurface: mutation.text,
      restoredText: context.restore(mutation),
      vaultValues: context.values,
    });
    result = addIdentity(result, {
      probes: 1,
      rightfulValue: verdict.outcome === "rightful-value" ? 1 : 0,
      withheld: verdict.outcome === "withheld" ? 1 : 0,
      foreignValue: verdict.outcome === "foreign-value" ? 1 : 0,
      categoryBlindRepairs: verdict.categoryBlindRepair ? 1 : 0,
    });
  }
  return result;
}

function eligibleEntries(
  klass: MutationClass,
  entries: readonly MaskedEntry[],
): readonly MaskedEntry[] {
  return entries.filter((entry) => entry.tokens.length >= klass.minTokens);
}

export function failingClasses(report: Tier1Report): readonly MutationClassResult[] {
  return report.classes.filter((result) => isFailure(classStatus(result)));
}

export function writeBaseline(report: Tier1Report, path: string = BASELINE_PATH): void {
  writeFileSync(path, formatBaselineMarkdown(report), "utf8");
}

if (import.meta.main) {
  const report = runTier1();
  writeBaseline(report);
  process.stdout.write(`${formatTier1Table(report)}\n\n${formatIdentityTable(report)}\n\n`);
  process.stdout.write(
    `${report.totalCases} cases / ${report.identity.probes} identity probes over ` +
      `${report.corpusEntries} entries in ${report.durationMs.toFixed(0)}ms — ` +
      `false_restoration_rate=${report.falseRestorationRate}\n`,
  );
  process.stdout.write(`baseline written to ${BASELINE_PATH}\n`);
  const failures = failingClasses(report);
  if (failures.length > 0) {
    process.stdout.write(
      `FAIL: ${failures.map((f) => `${f.id}/${f.name}`).join(", ")}\n`,
    );
    process.exitCode = 1;
  }
}
