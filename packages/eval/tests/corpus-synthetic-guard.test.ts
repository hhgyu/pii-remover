import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ALL_CATEGORIES, LocalRegexBackend, type PIICategory } from "@pii-remover/core";

import { FIXTURES_DIR, loadCorpus, locateSpans } from "../src/corpus/index.js";

/**
 * Invariant I4 (plan §5, §8): the evaluation corpus is synthetic only, and a
 * real user transcript must never be recorded into a fixture. CI enforces it.
 *
 * The guard is scoped to categories whose detection is checksum- or
 * pattern-backed. `private_person` is excluded on purpose: the Korean surname
 * heuristic reports 0.6 confidence and fires on ordinary vocabulary
 * (배포, 노출, 주세요), so including it would drown the signal in noise and
 * push contributors to allow-list words that are not PII at all. Person spans
 * are still covered by the declaration check below.
 */
const HIGH_CONFIDENCE_CATEGORIES: ReadonlySet<PIICategory> = new Set([
  "private_email",
  "private_phone",
  "private_url",
  "card",
  "rrn",
  "biz_num",
  "secret",
  "account_number",
]);

const corpus = loadCorpus();
const declared: readonly string[] = corpus.synthetic_values;
const backend = new LocalRegexBackend({ enabledCategories: ALL_CATEGORIES });

async function undeclaredDetections(text: string): Promise<readonly string[]> {
  const result = await backend.detect(text, { request_id: "eval-guard" });
  return result.detections
    .filter((detection) => HIGH_CONFIDENCE_CATEGORIES.has(detection.category))
    .filter((detection) => !declared.some((value) => value.includes(detection.text)))
    .map((detection) => `${detection.category}:${detection.text}`);
}

describe("fixture corpus is synthetic only (I4)", () => {
  test("declares every span value in synthetic_values", () => {
    // Given the corpus entries
    // When their span texts are compared with the declaration list
    const undeclared = corpus.entries
      .flatMap((entry) => entry.spans.map((span) => span.text))
      .filter((value) => !declared.includes(value));
    // Then nothing is masked that was not first declared synthetic
    expect([...new Set(undeclared)]).toEqual([]);
  });

  test("finds no high-confidence PII outside the declared set in any fixture", async () => {
    // Given every fixture file on disk
    const files = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    // When the local detector re-scans their raw contents
    const offenders: string[] = [];
    for (const name of files) {
      const raw = readFileSync(join(FIXTURES_DIR, name), "utf8");
      for (const hit of await undeclaredDetections(raw)) {
        offenders.push(`${name} -> ${hit}`);
      }
    }
    // Then every detected value traces back to a declared synthetic value
    expect(offenders).toEqual([]);
  });

  test("rejects an undeclared value, proving the guard can fail", async () => {
    // Given a fixture-shaped string carrying an address that was never declared
    const smuggled = '{"text":"mail me at undeclared.person@realmail.example"}';
    // When the same guard runs over it
    const offenders = await undeclaredDetections(smuggled);
    // Then the guard reports it instead of passing silently
    expect(offenders).toEqual([
      "private_email:undeclared.person@realmail.example",
    ]);
  });

  test("keeps every declared span locatable in its entry text", () => {
    // Given the corpus
    // When each entry's spans are resolved to offsets
    const failures: string[] = [];
    for (const entry of corpus.entries) {
      try {
        locateSpans(entry);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    // Then no declaration drifted away from the text it describes
    expect(failures).toEqual([]);
  });

  test("covers both languages and every declared surface form", () => {
    // Given the corpus strata
    // When languages and surface forms are collected
    const langs = new Set(corpus.entries.map((entry) => entry.lang));
    const surfaces = new Set(corpus.entries.map((entry) => entry.surface));
    // Then the plan's stratification is present
    expect([...langs].sort()).toEqual(["en", "ko"]);
    expect([...surfaces].sort()).toEqual([
      "adversarial",
      "code",
      "json",
      "markdown",
      "path",
      "prose",
    ]);
  });

  test("covers every PII category the token map can mint", () => {
    // Given the corpus spans
    // When their categories are collected
    const categories = new Set(
      corpus.entries.flatMap((entry) => entry.spans.map((span) => span.category)),
    );
    // Then all 11 ADR-0010 categories are exercised
    expect([...categories].sort()).toEqual([...ALL_CATEGORIES].sort());
  });
});
