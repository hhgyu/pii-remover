/**
 * Cross-language regex parity test.
 *
 * Loads the shared fixture at tests/fixtures/regex-parity.json (project
 * root) and asserts that LocalRegexBackend produces the exact spans
 * listed in the fixture. The Python sibling test in
 * packages/backend/tests/test_regex_parity.py loads the same fixture and
 * must agree. This is the only mechanical guard against the TS regex
 * detector and the Python regex pipeline drifting apart.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LocalRegexBackend } from "../src/backend/local-regex.js";
import type { PIICategory } from "../src/types.js";

interface ExpectedSpan {
  category: string;
  text: string;
  start: number;
  end: number;
}

interface Sample {
  name: string;
  text: string;
  expected: ExpectedSpan[];
}

interface Fixture {
  samples: Sample[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "..", "..", "..", "tests", "fixtures", "regex-parity.json");

const PARITY_CATEGORIES: ReadonlyArray<PIICategory> = [
  "private_email",
  "private_phone",
  "private_url",
  "rrn",
  "biz_num",
  "card",
];

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
}

const backend = new LocalRegexBackend({
  enabledCategories: PARITY_CATEGORIES,
  enable_korean_pii: true,
  strict_rrn_checksum: true,
  name: "parity",
});

describe("regex parity — TS LocalRegexBackend vs Python regex_pipeline", () => {
  const fixture = loadFixture();

  for (const sample of fixture.samples) {
    test(sample.name, async () => {
      const result = await backend.detect(sample.text, {
        request_id: `parity:${sample.name}`,
      });
      const actual: ExpectedSpan[] = result.detections.map((d) => ({
        category: d.category,
        text: d.text,
        start: d.start,
        end: d.end,
      }));
      expect(actual).toEqual(sample.expected);
    });
  }
});
