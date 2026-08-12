import { describe, expect, test } from "bun:test";
import { Restorer } from "@pii-remover/core";

import { loadCorpus, maskCorpus, vaultValues } from "../src/corpus/index.js";
import { hashSwap } from "../src/mutators/index.js";
import { classifyTokenResolution } from "../src/scoring/index.js";
import { runTier1 } from "../src/runners/tier1-mutation.js";
import type { TokenInfo } from "../src/types.js";

/**
 * Invariant I1 (plan §8): a token must never resolve to a value other than its
 * own vault entry. Mutation 13 — the hash-swap probe — is how that is proven:
 * it emits `<category of A>/<hash of B>`, which names no vault entry whenever
 * the two tokens differ in category, so the only safe answer is to restore
 * nothing. Restoring B's value there puts one person's data in another's slot,
 * which the plan calls categorically worse than leaving `[UNRESTORABLE]`.
 */

const masked = maskCorpus(loadCorpus());
const values = vaultValues(masked);
const restorer = new Restorer(masked.vault, {
  warnOnPartial: false,
  warnOnUnknownToken: false,
  warn: () => {},
});

interface SwapProbe {
  readonly entryId: string;
  readonly owner: TokenInfo;
  readonly surface: string;
  readonly restored: string;
}

function hashSwapProbes(): readonly SwapProbe[] {
  const out: SwapProbe[] = [];
  for (const entry of masked.entries) {
    if (entry.tokens.length < 2) continue;
    for (const owner of entry.tokens) {
      const surface = hashSwap(owner.token, entry.tokens).text;
      out.push({
        entryId: entry.id,
        owner,
        surface,
        restored: restorer.restore(surface, masked.sessionId).text,
      });
    }
  }
  return out;
}

const probes = hashSwapProbes();

describe("mutation 13 — hash-swap false-restoration probe", () => {
  test("covers every multi-token corpus entry", () => {
    // Given the corpus
    // When hash-swap probes are built
    const entriesCovered = new Set(probes.map((probe) => probe.entryId));
    // Then every entry with a token pair contributes probes
    expect(entriesCovered.size).toBeGreaterThanOrEqual(20);
    expect(probes.length).toBeGreaterThanOrEqual(2 * entriesCovered.size);
  });

  test("emits a token that carries another token's hash", () => {
    // Given the probes
    // When each emitted surface is compared with its owner
    const unchanged = probes.filter((probe) => probe.surface === probe.owner.token);
    // Then no probe accidentally re-emitted the original token
    expect(unchanged).toEqual([]);
  });

  test("never resolves a token to a vault entry that is not its own", () => {
    // Given every hash-swap probe restored through the real Restorer
    // When each resolution is classified against the whole session vault
    const leaks = probes
      .map((probe) => ({
        probe,
        verdict: classifyTokenResolution({
          owner: probe.owner,
          observedSurface: probe.surface,
          restoredText: probe.restored,
          vaultValues: values,
        }),
      }))
      .filter(({ verdict }) => verdict.outcome === "foreign-value");
    // Then invariant I1 holds and nothing crossed entities
    expect(describeLeaks(leaks)).toEqual([]);
  });
});

describe("tier-1 hard invariant", () => {
  test("reports a false_restoration_rate of exactly zero", () => {
    // Given a full Tier-1 run over the corpus
    const report = runTier1();
    // When the hard invariant is read off the report
    // Then it is exactly 0 (plan §3.2, §8 I1)
    expect(report.falseRestorationRate).toBe(0);
  });
});

function describeLeaks(
  leaks: readonly { readonly probe: SwapProbe; readonly verdict: { readonly observedCategory: string } }[],
): readonly string[] {
  return leaks.map(
    ({ probe, verdict }) =>
      `${probe.entryId}: token owned by ${probe.owner.category}, emitted as ${verdict.observedCategory}, resolved to a vault entry it does not own`,
  );
}
