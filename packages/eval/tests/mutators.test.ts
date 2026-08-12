import { describe, expect, test } from "bun:test";
import {
  scanTokens,
  scanTokensWithRepairCandidates,
  TOKEN_HASH_LENGTH,
  TOKEN_SUFFIX,
} from "@pii-remover/core";

import { loadCorpus, maskCorpus, vaultValues } from "../src/corpus/index.js";
import {
  HALLUCINATED_HASH,
  MUTATION_CLASSES,
  backtickWrap,
  caseFlip,
  categoryRename,
  categorySwap,
  codeFence,
  dropTrailingSuffix,
  hashCharSubstitution,
  hashLengthChange,
  hashSwap,
  inventedToken,
  jsonStringEscape,
  koreanParticle,
  markdownEscape,
  tripleRepeat,
  windowsPathEmbed,
} from "../src/mutators/index.js";
import type { MaskedEntry } from "../src/types.js";

const masked = maskCorpus(loadCorpus());

function entryById(id: string): MaskedEntry {
  const found = masked.entries.find((entry) => entry.id === id);
  if (!found) throw new Error(`fixture is missing entry ${id}`);
  return found;
}

const twoTokenEntry = entryById("en-prose-01");
const singleTokenEntry = entryById("en-prose-06");

describe("mutation catalog", () => {
  test("declares exactly the 16 plan classes with unique ids 1..16", () => {
    // Given the published catalog
    // When its ids are collected
    const ids = MUTATION_CLASSES.map((klass) => klass.id);
    // Then every plan number appears exactly once
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  test("names every class uniquely", () => {
    // Given the catalog
    // When class names are deduplicated
    const names = new Set(MUTATION_CLASSES.map((klass) => klass.name));
    // Then no two classes share a name
    expect(names.size).toBe(MUTATION_CLASSES.length);
  });

  test("marks only the pair-wise class as needing two tokens", () => {
    // Given the catalog
    // When classes requiring more than one token are selected
    const pairwise = MUTATION_CLASSES.filter((klass) => klass.minTokens > 1);
    // Then only the hash-swap probe requires a pair
    expect(pairwise.map((klass) => klass.id)).toEqual([13]);
  });

  test("produces byte-identical output when replayed", () => {
    // Given every class applied once to the same entry
    const first = MUTATION_CLASSES.map((klass) =>
      klass.mutate(twoTokenEntry.masked, twoTokenEntry.tokens).text,
    );
    // When the same classes run again
    const second = MUTATION_CLASSES.map((klass) =>
      klass.mutate(twoTokenEntry.masked, twoTokenEntry.tokens).text,
    );
    // Then the harness is deterministic
    expect(second).toEqual(first);
  });

  test("leaves an inert token lookalike untouched", () => {
    // Given an adversarial entry carrying a non-matching `__OPF_` string
    const adversarial = entryById("en-adv-01");
    // When the case-flip mutation runs
    const result = caseFlip(adversarial.masked, adversarial.tokens);
    // Then the lookalike survives verbatim because scanTokens never claimed it
    expect(result.text).toContain("_PERSON__short__");
  });
});

describe("surface mutations keep token identity", () => {
  test("case-flip inverts the token and stays matchable", () => {
    // Given a masked entry with two tokens
    // When the case is flipped
    const result = caseFlip(twoTokenEntry.masked, twoTokenEntry.tokens);
    // Then the surface changed but both tokens still normalize to their keys
    expect(result.text).not.toBe(twoTokenEntry.masked);
    expect(scanTokens(result.text).map((m) => m.normalizedToken)).toEqual(
      twoTokenEntry.tokens.map((t) => t.token),
    );
  });

  test("drop-trailing-suffix removes the closing delimiter", () => {
    // Given a masked entry
    // When the trailing delimiter is dropped
    const result = dropTrailingSuffix(twoTokenEntry.masked, twoTokenEntry.tokens);
    // Then the emitted tokens are lenient matches without the suffix
    const matches = scanTokens(result.text);
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => !m.token.endsWith(TOKEN_SUFFIX))).toBe(true);
  });

  test("backtick-wrap quotes the token without hiding it", () => {
    // Given a masked entry
    // When the token is wrapped in backticks
    const result = backtickWrap(singleTokenEntry.masked, singleTokenEntry.tokens);
    // Then the token is still discoverable inside the quotes
    expect(result.text).toContain("`");
    expect(scanTokens(result.text)).toHaveLength(1);
  });

  test("json-string-escape survives a JSON round trip", () => {
    // Given a masked entry
    // When it is escaped as a JSON string
    const result = jsonStringEscape(twoTokenEntry.masked, twoTokenEntry.tokens);
    // Then parsing the JSON returns the original masked text
    expect(JSON.parse(result.text)).toBe(twoTokenEntry.masked);
  });

  test("windows-path-embed puts the token inside a drive path", () => {
    // Given a masked entry
    // When the token is embedded in a Windows path
    const result = windowsPathEmbed(singleTokenEntry.masked, singleTokenEntry.tokens);
    // Then the path is present and the token is still matchable
    expect(result.text).toContain("D:\\Git\\");
    expect(scanTokens(result.text)).toHaveLength(1);
  });

  test("korean-particle agglutinates a suffix onto the token", () => {
    // Given a masked entry
    // When Korean particles are appended
    const result = koreanParticle(twoTokenEntry.masked, twoTokenEntry.tokens);
    // Then the particle follows the token and the token still resolves
    expect(result.text).toContain("님이");
    expect(scanTokens(result.text)).toHaveLength(2);
  });

  test("code-fence wraps the whole reply", () => {
    // Given a masked entry
    // When it is fenced
    const result = codeFence(singleTokenEntry.masked, singleTokenEntry.tokens);
    // Then the fence brackets the text and the token survives
    expect(result.text.startsWith("```txt\n")).toBe(true);
    expect(scanTokens(result.text)).toHaveLength(1);
  });

  test("triple-repeat emits each token three times", () => {
    // Given a masked entry with two tokens
    // When each token is tripled
    const result = tripleRepeat(twoTokenEntry.masked, twoTokenEntry.tokens);
    // Then six token occurrences are present
    expect(scanTokens(result.text)).toHaveLength(6);
  });

  test("markdown-escape hides the token from the restoration matchers", () => {
    // Given a masked entry
    // When every underscore is backslash-escaped
    const result = markdownEscape(twoTokenEntry.masked, twoTokenEntry.tokens);
    // Then the strict and lenient matchers see nothing, and only the
    // repair-only candidate scan still finds the spans
    expect(scanTokens(result.text)).toHaveLength(0);
    expect(scanTokensWithRepairCandidates(result.text)).toHaveLength(2);
    expect(result.expectedRecoverable).toBe(true);
  });
});

describe("hash-damage mutations", () => {
  test("substitution keeps the hash length and changes one character", () => {
    // Given a masked entry
    // When one hash character is substituted
    const result = hashCharSubstitution(twoTokenEntry.masked, twoTokenEntry.tokens);
    // Then the token is still well-formed but names a different hash
    const matches = scanTokens(result.text);
    expect(matches).toHaveLength(2);
    for (const [index, match] of matches.entries()) {
      const original = twoTokenEntry.tokens[index].hash;
      expect(match.hash).toHaveLength(TOKEN_HASH_LENGTH);
      expect(match.hash).not.toBe(original);
      expect(differingPositions(match.hash, original)).toBe(1);
    }
  });

  test("length change hides the token from the restoration matchers", () => {
    // Given a masked entry
    // When a hash character is inserted or deleted
    const result = hashLengthChange(twoTokenEntry.masked, twoTokenEntry.tokens);
    // Then the fixed-width hash pattern misses, and only the repair-only
    // candidate scan still finds the spans
    expect(scanTokens(result.text)).toHaveLength(0);
    expect(scanTokensWithRepairCandidates(result.text)).toHaveLength(2);
    expect(result.expectedRecoverable).toBe(true);
  });
});

describe("safety probes", () => {
  test("category-rename keeps the hash under a never-minted label", () => {
    // Given a masked entry
    // When the category is renamed
    const result = categoryRename(twoTokenEntry.masked, twoTokenEntry.tokens);
    // Then hashes are untouched and no emitted token is a live vault key
    const matches = scanTokens(result.text);
    expect(matches.map((m) => m.hash)).toEqual(
      twoTokenEntry.tokens.map((t) => t.hash),
    );
    expect(matches.some((m) => m.category === "NAME")).toBe(true);
    expectNoLiveKeys(matches.map((m) => m.normalizedToken));
  });

  test("category-swap reuses another live category label", () => {
    // Given a masked entry holding a PERSON and an EMAIL token
    // When categories are swapped
    const result = categorySwap(twoTokenEntry.masked, twoTokenEntry.tokens);
    // Then each hash now sits under the other token's category
    const matches = scanTokens(result.text);
    expect(matches.map((m) => m.category)).toEqual(["EMAIL", "PERSON"]);
    expectNoLiveKeys(matches.map((m) => m.normalizedToken));
  });

  test("hash-swap rotates hashes with no fixed point", () => {
    // Given a masked entry with two distinct tokens
    // When the hashes are swapped
    const result = hashSwap(twoTokenEntry.masked, twoTokenEntry.tokens);
    // Then no emitted token keeps its own hash
    const matches = scanTokens(result.text);
    expect(matches.map((m) => m.hash)).toEqual([
      twoTokenEntry.tokens[1].hash,
      twoTokenEntry.tokens[0].hash,
    ]);
  });

  test("invented-token appends a hash the vault never minted", () => {
    // Given the full corpus keyset
    const liveHashes = new Set(vaultValues(masked).map((token) => token.hash));
    // When the hallucination probe runs
    const result = inventedToken(singleTokenEntry.masked, singleTokenEntry.tokens);
    // Then it injects one extra token whose hash is absent from the vault
    expect(result.text).toContain(HALLUCINATED_HASH);
    expect(HALLUCINATED_HASH).toHaveLength(TOKEN_HASH_LENGTH);
    expect(liveHashes.has(HALLUCINATED_HASH)).toBe(false);
    expect(scanTokens(result.text)).toHaveLength(2);
  });
});

function differingPositions(left: string, right: string): number {
  let count = 0;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left.charAt(i) !== right.charAt(i)) count += 1;
  }
  return count;
}

function expectNoLiveKeys(tokens: readonly string[]): void {
  for (const token of tokens) {
    expect(masked.vault.lookup(masked.sessionId, token)).toBeNull();
  }
}
