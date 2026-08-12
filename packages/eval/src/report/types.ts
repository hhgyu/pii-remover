import type { MutationKind } from "../types.js";

/** How the token-identity probes for one class came out (plan §8 I1). */
export interface IdentityResult {
  readonly probes: number;
  /** Resolved to the entry the emitted token is entitled to. */
  readonly rightfulValue: number;
  readonly withheld: number;
  /** Resolved to a vault entry that is NOT the token's own. Must be 0. */
  readonly foreignValue: number;
  /** Resolved despite a category mismatch — lever L4 forbids this. */
  readonly categoryBlindRepairs: number;
}

export interface MutationClassResult {
  readonly id: number;
  readonly name: string;
  readonly kind: MutationKind;
  readonly description: string;
  readonly cases: number;
  readonly expected: number;
  readonly restored: number;
  readonly residualTokens: number;
  readonly expectedRecoverable: boolean;
  readonly identity: IdentityResult;
  readonly notes: readonly string[];
}

/**
 * `ok`, `probe-withheld` and `baseline-gap` are passes. `baseline-gap` is a
 * recorded, expected shortfall (plan §9 Phase B: some classes score 0% today
 * and Phase C has to move them). `category-blind-repair` is a reported finding:
 * the value that came back was the token's own, so nothing crossed entities,
 * but the repair ignored the category match L4 requires. `regression` and
 * `invariant-violated` are failures and exit the runner non-zero.
 */
export type ClassStatus =
  | "ok"
  | "baseline-gap"
  | "probe-withheld"
  | "category-blind-repair"
  | "regression"
  | "invariant-violated";

export interface Tier1Report {
  readonly corpusEntries: number;
  readonly corpusTokens: number;
  readonly totalCases: number;
  readonly classes: readonly MutationClassResult[];
  readonly identity: IdentityResult;
  readonly falseRestorationRate: number;
  readonly durationMs: number;
}

export function classStatus(result: MutationClassResult): ClassStatus {
  if (result.identity.foreignValue > 0) return "invariant-violated";
  if (result.kind === "probe") {
    return result.identity.categoryBlindRepairs > 0
      ? "category-blind-repair"
      : "probe-withheld";
  }
  if (!result.expectedRecoverable) return "baseline-gap";
  return result.restored === result.expected ? "ok" : "regression";
}

export function isFailure(status: ClassStatus): boolean {
  return status === "regression" || status === "invariant-violated";
}

export function emptyIdentity(): IdentityResult {
  return {
    probes: 0,
    rightfulValue: 0,
    withheld: 0,
    foreignValue: 0,
    categoryBlindRepairs: 0,
  };
}

export function addIdentity(
  left: IdentityResult,
  right: IdentityResult,
): IdentityResult {
  return {
    probes: left.probes + right.probes,
    rightfulValue: left.rightfulValue + right.rightfulValue,
    withheld: left.withheld + right.withheld,
    foreignValue: left.foreignValue + right.foreignValue,
    categoryBlindRepairs: left.categoryBlindRepairs + right.categoryBlindRepairs,
  };
}
