import { describe, expect, test } from "bun:test";

import { MUTATION_CLASSES } from "../src/mutators/index.js";
import { runTier1 } from "../src/runners/tier1-mutation.js";
import {
  classStatus,
  isFailure,
  type MutationClassResult,
} from "../src/report/types.js";
import { formatBaselineMarkdown, formatTier1Table } from "../src/report/table.js";

const report = runTier1();

function byId(id: number): MutationClassResult {
  const found = report.classes.find((result) => result.id === id);
  if (!found) throw new Error(`report is missing mutation class ${id}`);
  return found;
}

describe("tier-1 runner", () => {
  test("scores every catalog class against the whole corpus", () => {
    // Given a full run
    // When the report is inspected
    // Then one result per class, each with cases, is present
    expect(report.classes.map((result) => result.id)).toEqual(
      MUTATION_CLASSES.map((klass) => klass.id),
    );
    expect(report.classes.every((result) => result.cases > 0)).toBe(true);
  });

  test("stays far inside the plan's 30-second Tier-1 budget", () => {
    // Given a full run
    // When its wall time is read
    // Then it finishes in well under the CI budget
    expect(report.durationMs).toBeLessThan(10_000);
  });

  test("mints one token per distinct synthetic value", () => {
    // Given the corpus
    // When the vault is counted
    // Then deduplication collapsed repeated values into single tokens
    expect(report.corpusTokens).toBeGreaterThanOrEqual(50);
    expect(report.totalCases).toBeGreaterThan(report.corpusEntries);
  });

  test("recovers every surface mutation that keeps token identity", () => {
    // Given the classes the restorer is expected to survive today
    const recoverable = report.classes.filter(
      (result) => result.kind !== "probe" && result.expectedRecoverable,
    );
    // When their roundtrip counts are compared
    const shortfalls = recoverable
      .filter((result) => result.restored !== result.expected)
      .map((result) => `${result.id}/${result.name}: ${result.restored}/${result.expected}`);
    // Then none of them lost a value
    expect(shortfalls).toEqual([]);
  });

  test("closes the corruption classes Phase C named as exit criteria", () => {
    // Given hash substitution, hash length change and markdown escaping —
    // the three the repair-only candidate scan was built for
    // When their roundtrip counts are read
    // Then every value comes back
    for (const id of [3, 4, 5]) {
      const result = byId(id);
      expect(result.expected).toBeGreaterThan(0);
      expect(result.restored).toBe(result.expected);
      expect(classStatus(result)).toBe("ok");
    }
  });

  test("leaves a hallucinated token unresolved in the output", () => {
    // Given the invented-token probe
    const invented = byId(14);
    // When its residual surface is read
    // Then one unresolved token per case is still visible to the user
    expect(invented.residualTokens).toBe(invented.cases);
    expect(invented.identity.foreignValue).toBe(0);
  });

  test("accounts for every identity probe in exactly one outcome bucket", () => {
    // Given the identity counters for each class
    // When the three outcome buckets are summed
    const unaccounted = report.classes
      .filter(
        (result) =>
          result.identity.rightfulValue +
            result.identity.withheld +
            result.identity.foreignValue !==
          result.identity.probes,
      )
      .map((result) => `${result.id}/${result.name}`);
    // Then no probe fell through, so a new outcome cannot be silently dropped
    expect(unaccounted).toEqual([]);
  });

  test("keeps every non-probe class free of foreign-value resolutions", () => {
    // Given the surface and corruption classes
    const nonProbe = report.classes.filter((result) => result.kind !== "probe");
    // When their identity probes are summed
    const leaking = nonProbe
      .filter((result) => result.identity.foreignValue > 0)
      .map((result) => `${result.id}/${result.name}`);
    // Then a mutation that preserves identity never crosses entities
    expect(leaking).toEqual([]);
  });

  test("fails the run when any class regresses or breaks the invariant", () => {
    // Given the report
    // When statuses are mapped to pass/fail
    const failing = report.classes.filter((result) => isFailure(classStatus(result)));
    // Then only classes with a foreign-value resolution or a shortfall are fatal
    for (const result of failing) {
      expect(
        result.identity.foreignValue > 0 || result.restored !== result.expected,
      ).toBe(true);
    }
  });
});

describe("tier-1 report rendering", () => {
  test("prints one table row per mutation class", () => {
    // Given the report
    // When the roundtrip table is rendered
    const lines = formatTier1Table(report).split("\n");
    // Then a header, a divider and 16 rows come out
    expect(lines).toHaveLength(MUTATION_CLASSES.length + 2);
    expect(lines[0]).toContain("roundtrip_after_mutation_rate");
  });

  test("writes the hard invariant into the baseline document", () => {
    // Given the report
    // When the baseline markdown is rendered
    const markdown = formatBaselineMarkdown(report);
    // Then it carries the rate, both tables and the corpus size
    expect(markdown).toContain("# Tier-1 mutation baseline");
    expect(markdown).toContain("`false_restoration_rate`");
    expect(markdown).toContain("## Token identity (invariant I1)");
    expect(markdown).toContain(`corpus entries: **${report.corpusEntries}**`);
  });

  test("renders the same document for the same report", () => {
    // Given one report
    // When it is rendered twice
    // Then the baseline is byte-stable and safe to commit
    expect(formatBaselineMarkdown(report)).toBe(formatBaselineMarkdown(report));
  });
});
