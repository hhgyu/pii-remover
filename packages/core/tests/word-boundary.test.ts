import { describe, expect, test } from "bun:test";
import { expandPersonWordBoundaries } from "../src/detector/word-boundary.js";
import { Detector } from "../src/detector/index.js";
import { SingleStrategy } from "../src/backend/strategy.js";
import type { BackendClient, BackendHealth } from "../src/backend/client.js";
import type {
  Detection,
  DetectOpts,
  DetectionResult,
  PIICategory,
} from "../src/types.js";

function det(
  start: number,
  end: number,
  category: PIICategory,
  text: string
): Detection {
  return { start, end, category, confidence: 0.9, text };
}

function mockBackend(name: string, detections: Detection[]): BackendClient {
  return {
    name,
    trust_tier: "local",
    async detect(_t: string, _o: DetectOpts): Promise<DetectionResult> {
      return { detections: [...detections], backend_name: name, latency_ms: 0 };
    },
    async healthCheck(): Promise<BackendHealth> {
      return { ok: true, latency_ms: 0 };
    },
  };
}

describe("expandPersonWordBoundaries — mid-word NER spans", () => {
  test("expands a span whose end cuts a latin word", () => {
    // Given: KLUE NER tagged only "Graf" inside "Grafana"
    const text = "Grafana 스키마 검증";
    // When
    const out = expandPersonWordBoundaries(text, [
      det(0, 4, "private_person", "Graf"),
    ]);
    // Then: the span covers the whole word
    expect(out).toHaveLength(1);
    expect([out[0]!.start, out[0]!.end]).toEqual([0, 7]);
  });

  test("rewrites the detection text to the expanded slice", () => {
    const text = "Grafana 스키마 검증";
    const out = expandPersonWordBoundaries(text, [
      det(0, 4, "private_person", "Graf"),
    ]);
    expect(out[0]!.text).toBe("Grafana");
  });

  test("expands a span whose start cuts a latin word", () => {
    // Given: the span begins mid-word ("Graf" inside "preGraf")
    const text = "preGraf value";
    const out = expandPersonWordBoundaries(text, [
      det(3, 7, "private_person", "Graf"),
    ]);
    expect([out[0]!.start, out[0]!.end]).toEqual([0, 7]);
  });

  test("leaves a span that already sits on word boundaries untouched", () => {
    // Given: "Alice" is followed by a space — not a mid-word cut
    const text = "Alice went home";
    const input = det(0, 5, "private_person", "Alice");
    const out = expandPersonWordBoundaries(text, [input]);
    expect([out[0]!.start, out[0]!.end, out[0]!.text]).toEqual([0, 5, "Alice"]);
  });

  test("leaves a hangul span with a trailing honorific untouched", () => {
    // Given: the korean heuristic deliberately strips 님 to tighten the span
    // (strategy.ts mergeBackendDetections). Expanding it back would undo that.
    const text = "김철수님께 전달";
    const out = expandPersonWordBoundaries(text, [
      det(0, 3, "private_person", "김철수"),
    ]);
    expect([out[0]!.start, out[0]!.end, out[0]!.text]).toEqual([
      0,
      3,
      "김철수",
    ]);
  });

  test("leaves a hangul span abutting latin text untouched", () => {
    // Given: 수|a is a script transition, not a cut through one word
    const text = "김철수abc";
    const out = expandPersonWordBoundaries(text, [
      det(0, 3, "private_person", "김철수"),
    ]);
    expect([out[0]!.start, out[0]!.end]).toEqual([0, 3]);
  });

  test("leaves non-person categories untouched even when mid-word", () => {
    // Given: only private_person suffers the NER boundary defect
    const text = "Grafana 스키마";
    const out = expandPersonWordBoundaries(text, [det(0, 4, "secret", "Graf")]);
    expect([out[0]!.start, out[0]!.end, out[0]!.text]).toEqual([0, 4, "Graf"]);
  });

  test("returns an empty array for no detections", () => {
    expect(expandPersonWordBoundaries("Grafana", [])).toEqual([]);
  });
});

describe("Detector — word-boundary repair is wired into detect()", () => {
  test("repairs a mid-word person span returned by the backend", async () => {
    // Given: a backend that reproduces the observed Graf/ana split
    const text = "Grafana 스키마 검증";
    const detector = new Detector({
      strategy: new SingleStrategy(
        mockBackend("mock", [det(0, 4, "private_person", "Graf")])
      ),
    });
    // When
    const r = await detector.detect(text, { request_id: "t" });
    // Then
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.text).toBe("Grafana");
  });

  test("emits no overlapping spans when expansion collides with a neighbour", async () => {
    // Given: expanding "Graf"→"Grafana" runs into a span already at [4,7)
    const text = "Grafana";
    const detector = new Detector({
      strategy: new SingleStrategy(
        mockBackend("mock", [
          det(0, 4, "private_person", "Graf"),
          det(4, 7, "private_person", "ana"),
        ])
      ),
    });
    // When
    const r = await detector.detect(text, { request_id: "t" });
    // Then: vault assign() rejects overlaps, so detect() must not produce any
    const sorted = [...r.detections].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.start).toBeGreaterThanOrEqual(sorted[i - 1]!.end);
    }
  });
});
