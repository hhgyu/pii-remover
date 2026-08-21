import { describe, expect, test } from "bun:test";

import {
  classifyTokenResolution,
  falseRestorationRate,
  roundtripRate,
  scoreRoundtrip,
} from "../src/scoring/index.js";
import { buildToken } from "../src/mutators/index.js";
import type { TokenInfo } from "../src/types.js";

const PERSON: TokenInfo = {
  token: buildToken("PERSON", "aaaaaaaaaaaaaaaa"),
  category: "PERSON",
  hash: "aaaaaaaaaaaaaaaa",
  value: "John Smith",
  piiCategory: "private_person",
};

const EMAIL: TokenInfo = {
  token: buildToken("EMAIL", "bbbbbbbbbbbbbbbb"),
  category: "EMAIL",
  hash: "bbbbbbbbbbbbbbbb",
  value: "john.smith@example.com",
  piiCategory: "private_email",
};

const VAULT: readonly TokenInfo[] = [PERSON, EMAIL];

describe("roundtrip scoring", () => {
  test("counts each distinct expected value that came back", () => {
    // Given an output holding one of two expected values
    // When it is scored
    const score = scoreRoundtrip({
      restoredText: "Email John Smith at {{OPF:EMAIL:bbbbbbbbbbbbbbbb}}",
      expectedValues: [PERSON.value, EMAIL.value],
    });
    // Then only the present value counts as restored
    expect(score).toMatchObject({ expected: 2, restored: 1 });
  });

  test("collapses a repeated expected value into one denominator slot", () => {
    // Given the same value listed twice
    // When it is scored
    const score = scoreRoundtrip({
      restoredText: "John Smith and John Smith",
      expectedValues: [PERSON.value, PERSON.value],
    });
    // Then the denominator counts distinct values, not occurrences
    expect(score).toMatchObject({ expected: 1, restored: 1 });
  });

  test("reports tokens still matchable in the output as residual", () => {
    // Given an output that still carries a token
    // When it is scored
    const score = scoreRoundtrip({
      restoredText: `left ${PERSON.token} right`,
      expectedValues: [],
    });
    // Then the residual surface is counted
    expect(score.residualTokens).toBe(1);
  });

  test("reports no rate when nothing was owed", () => {
    // Given a probe class that owes no restoration
    // When its rate is computed
    const rate = roundtripRate({ expected: 0, restored: 0 });
    // Then the rate is absent rather than a slanderous 0%
    expect(rate).toBeNull();
  });
});

describe("token identity classification", () => {
  test("accepts a token that returned its own value", () => {
    // Given a token restored to the entry it names
    // When the resolution is classified
    const verdict = classifyTokenResolution({
      owner: PERSON,
      observedSurface: PERSON.token,
      restoredText: PERSON.value,
      vaultValues: VAULT,
    });
    // Then it is a rightful resolution with no category blindness
    expect(verdict).toEqual({
      outcome: "rightful-value",
      observedCategory: "PERSON",
      categoryBlindRepair: false,
    });
  });

  test("accepts a token that was withheld", () => {
    // Given an unresolvable token left verbatim in the output
    const surface = buildToken("PERSON", "cccccccccccccccc");
    // When the resolution is classified
    const verdict = classifyTokenResolution({
      owner: PERSON,
      observedSurface: surface,
      restoredText: surface,
      vaultValues: VAULT,
    });
    // Then nothing was restored, which is the fail-closed outcome
    expect(verdict.outcome).toBe("withheld");
  });

  test("flags a value belonging to another vault entry", () => {
    // Given a PERSON-labelled token that came back as an email address
    // When the resolution is classified
    const verdict = classifyTokenResolution({
      owner: PERSON,
      observedSurface: buildToken("PERSON", EMAIL.hash),
      restoredText: EMAIL.value,
      vaultValues: VAULT,
    });
    // Then it is a false restoration and the category was ignored
    expect(verdict.outcome).toBe("foreign-value");
    expect(verdict.categoryBlindRepair).toBe(true);
  });

  test("does not flag an exactly matching live key as foreign", () => {
    // Given a swap that happens to emit another token's exact vault key
    // When that key resolves to its own entry
    const verdict = classifyTokenResolution({
      owner: PERSON,
      observedSurface: EMAIL.token,
      restoredText: EMAIL.value,
      vaultValues: VAULT,
    });
    // Then it is rightful: exact-key resolution is the restorer's contract
    expect(verdict.outcome).toBe("rightful-value");
  });

  test("ignores a value the mutation itself had already emitted", () => {
    // Given an output whose foreign-looking value was present before restoring
    // When the resolution is classified
    const verdict = classifyTokenResolution({
      owner: PERSON,
      observedSurface: `${PERSON.token} ${EMAIL.value}`,
      restoredText: `${PERSON.value} ${EMAIL.value}`,
      vaultValues: VAULT,
    });
    // Then the pre-existing value is not counted as a restoration
    expect(verdict.outcome).toBe("rightful-value");
  });

  test("flags a repair that ignored a renamed category", () => {
    // Given a renamed category whose hash still resolved
    // When the resolution is classified
    const verdict = classifyTokenResolution({
      owner: PERSON,
      observedSurface: buildToken("NAME", PERSON.hash),
      restoredText: PERSON.value,
      vaultValues: VAULT,
    });
    // Then the value is the token's own but the category match was skipped
    expect(verdict.outcome).toBe("rightful-value");
    expect(verdict.categoryBlindRepair).toBe(true);
  });
});

describe("false restoration rate", () => {
  test("is zero when no probe ran", () => {
    // Given a class that produced no probes
    // When the rate is computed
    const rate = falseRestorationRate({ probes: 0, foreignValues: 0 });
    // Then it is 0 rather than NaN
    expect(rate).toBe(0);
  });

  test("divides foreign resolutions by probes", () => {
    // Given four probes of which one leaked
    // When the rate is computed
    const rate = falseRestorationRate({ probes: 4, foreignValues: 1 });
    // Then the rate reflects the leak share
    expect(rate).toBe(0.25);
  });
});
