/**
 * Unified PII detection E2E benchmark.
 *
 * Tests the FULL pipeline (OPF + Korean NER) against a unified corpus
 * containing Korean, English, and mixed PII patterns.
 *
 * Activation:
 *   PII_REMOVER_E2E=1              — run all languages (default)
 *   PII_REMOVER_E2E=korean         — run Korean-only cases
 *   PII_REMOVER_E2E=english        — run English-only cases
 *   PII_REMOVER_E2E=mixed          — run mixed-language cases
 *
 * Requires a running Docker container:
 *   docker run -p 8000:8000 pii-remover-backend
 *
 * Reports per-category and overall precision / recall / F1.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { OpfHttpBackend } from "../src/backend/opf-http.js";
import { LocalRegexBackend } from "../src/backend/local-regex.js";
import { MergeStrategy } from "../src/backend/strategy.js";
import { Detector } from "../src/detector/index.js";
import type { Detection } from "../src/types.js";

type Lang = "ko" | "en" | "mixed";

const E2E_RAW = process.env.PII_REMOVER_E2E ?? "";
const E2E_ENABLED = E2E_RAW === "1" || E2E_RAW === "korean" || E2E_RAW === "english" || E2E_RAW === "mixed";
const LANG_FILTER: Lang[] =
  E2E_RAW === "korean" ? ["ko"] :
  E2E_RAW === "english" ? ["en"] :
  E2E_RAW === "mixed" ? ["mixed"] :
  ["ko", "en", "mixed"];
const LANG_LABEL =
  E2E_RAW === "korean" ? "Korean" :
  E2E_RAW === "english" ? "English" :
  E2E_RAW === "mixed" ? "Mixed" :
  "All";
const ENDPOINT = process.env.PII_REMOVER_E2E_URL ?? "http://localhost:8000";

interface ExpectedSpan {
  text: string;
  category: string;
}

interface CorpusCase {
  text: string;
  lang: Lang;
  expected: ExpectedSpan[];
}

interface EdgeCase extends CorpusCase {
  $comment_edge?: string;
}

interface NegCase {
  text: string;
  lang: Lang;
}

interface Corpus {
  true_positives: CorpusCase[];
  true_negatives: NegCase[];
  edge_cases: EdgeCase[];
}

function loadCorpus(): Corpus {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "fixtures", "pii-corpus.json");
  return JSON.parse(readFileSync(path, "utf8")) as Corpus;
}

function spansMatch(det: Detection, exp: ExpectedSpan): boolean {
  return det.text === exp.text && det.category === exp.category;
}

function createDetector(): Detector {
  const opf = new OpfHttpBackend({
    endpoint: ENDPOINT,
    trust_tier: "self_hosted",
    timeout_ms: 10000,
    name: "opf",
  });
  const regex = new LocalRegexBackend({
    enable_korean_pii: true,
    name: "local-regex",
  });
  return new Detector({
    strategy: new MergeStrategy([opf, regex]),
  });
}

interface CatMetrics {
  tp: number;
  fp: number;
  fn: number;
}

function computeMetrics(byCat: Map<string, CatMetrics>) {
  let totalTP = 0;
  let totalFP = 0;
  let totalFN = 0;

  const lines: string[] = [""];
  lines.push("--- Per-category metrics ---");
  for (const [category, m] of [...byCat].sort()) {
    const p = m.tp / Math.max(1, m.tp + m.fp);
    const r = m.tp / Math.max(1, m.tp + m.fn);
    const f1 = (2 * p * r) / Math.max(0.0001, p + r);
    lines.push(
      `  ${category.padEnd(20)} TP=${m.tp} FP=${m.fp} FN=${m.fn} P=${p.toFixed(3)} R=${r.toFixed(3)} F1=${f1.toFixed(3)}`
    );
    totalTP += m.tp;
    totalFP += m.fp;
    totalFN += m.fn;
  }

  const overallP = totalTP / Math.max(1, totalTP + totalFP);
  const overallR = totalTP / Math.max(1, totalTP + totalFN);
  const overallF1 =
    (2 * overallP * overallR) / Math.max(0.0001, overallP + overallR);

  lines.push("");
  lines.push(
    `  ${"OVERALL".padEnd(20)} TP=${totalTP} FP=${totalFP} FN=${totalFN} P=${overallP.toFixed(3)} R=${overallR.toFixed(3)} F1=${overallF1.toFixed(3)}`
  );
  lines.push("");

  console.log(lines.join("\n"));
  return { overallP, overallR, totalTP, totalFP, totalFN };
}

function filterByLang<T extends { lang: Lang }>(cases: T[]): T[] {
  return cases.filter((c) => LANG_FILTER.includes(c.lang));
}

(E2E_ENABLED ? describe : describe.skip)(
  `PII E2E benchmark [${LANG_LABEL}] (PII_REMOVER_E2E=${E2E_RAW || "1"})`,
  () => {
    const corpus = loadCorpus();
    const detector = createDetector();

    test("computes precision/recall against corpus", async () => {
      const byCat = new Map<string, CatMetrics>();
      const cat = (c: string): CatMetrics => {
        if (!byCat.has(c)) byCat.set(c, { tp: 0, fp: 0, fn: 0 });
        return byCat.get(c)!;
      };

      const tpCases = filterByLang(corpus.true_positives);
      const edgeCases = filterByLang(corpus.edge_cases);
      const negCases = filterByLang(corpus.true_negatives);
      const allCases = [...tpCases, ...edgeCases];

      console.log(`\nCases: TP=${tpCases.length} Edge=${edgeCases.length} Neg=${negCases.length}`);

      for (const c of allCases) {
        const res = await detector.detect(c.text, { request_id: "e2e-bench" });
        const dets = res.detections;

        for (const exp of c.expected) {
          if (dets.find((d) => spansMatch(d, exp))) {
            cat(exp.category).tp++;
          } else {
            cat(exp.category).fn++;
          }
        }
        for (const det of dets) {
          if (!c.expected.find((e) => spansMatch(det, e))) {
            cat(det.category).fp++;
          }
        }
      }

      for (const c of negCases) {
        const res = await detector.detect(c.text, { request_id: "e2e-bench" });
        for (const det of res.detections) {
          cat(det.category).fp++;
        }
      }

      const { overallP, overallR } = computeMetrics(byCat);

      expect(overallP).toBeGreaterThanOrEqual(0.7);
      expect(overallR).toBeGreaterThanOrEqual(0.5);
    });
  }
);

describe("PII corpus fixture sanity", () => {
  const VALID_CATS = new Set([
    "account_number", "private_address", "private_email",
    "private_person", "private_phone", "private_url",
    "private_date", "secret", "rrn", "biz_num", "card",
  ]);
  const VALID_LANGS = new Set(["ko", "en", "mixed"]);

  test("loads and has expected sections", () => {
    const corpus = loadCorpus();
    expect(corpus.true_positives.length).toBeGreaterThan(0);
    expect(corpus.true_negatives.length).toBeGreaterThan(0);
    expect(corpus.edge_cases.length).toBeGreaterThan(0);
  });

  test("every case has a valid lang tag", () => {
    const corpus = loadCorpus();
    for (const c of corpus.true_positives) {
      expect(VALID_LANGS.has(c.lang)).toBe(true);
    }
    for (const c of corpus.true_negatives) {
      expect(VALID_LANGS.has(c.lang)).toBe(true);
    }
    for (const c of corpus.edge_cases) {
      expect(VALID_LANGS.has(c.lang)).toBe(true);
    }
  });

  test("each true_positive has expected spans with valid categories", () => {
    const corpus = loadCorpus();
    for (const c of corpus.true_positives) {
      expect(c.expected.length).toBeGreaterThan(0);
      for (const exp of c.expected) {
        expect(typeof exp.text).toBe("string");
        expect(exp.text.length).toBeGreaterThan(0);
        expect(VALID_CATS.has(exp.category)).toBe(true);
        expect(c.text).toContain(exp.text);
      }
    }
  });

  test("each true_negative has valid text", () => {
    const corpus = loadCorpus();
    for (const c of corpus.true_negatives) {
      expect(typeof c.text).toBe("string");
      expect(c.text.length).toBeGreaterThan(0);
    }
  });

  test("edge_cases have valid expected spans", () => {
    const corpus = loadCorpus();
    for (const c of corpus.edge_cases) {
      for (const exp of c.expected) {
        expect(VALID_CATS.has(exp.category)).toBe(true);
        expect(c.text).toContain(exp.text);
      }
    }
  });

  test("has sufficient coverage per language", () => {
    const corpus = loadCorpus();
    const koTP = corpus.true_positives.filter((c) => c.lang === "ko").length;
    const enTP = corpus.true_positives.filter((c) => c.lang === "en").length;
    const mixedTP = corpus.true_positives.filter((c) => c.lang === "mixed").length;
    expect(koTP).toBeGreaterThanOrEqual(40);
    expect(enTP).toBeGreaterThanOrEqual(40);
    expect(mixedTP).toBeGreaterThanOrEqual(10);
  });
});
