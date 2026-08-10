import { describe, expect, test } from "bun:test";
import {
  MergeStrategy,
  SingleStrategy,
  mergeDetections,
} from "../src/backend/strategy.js";
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

function mockBackend(
  name: string,
  detections: Detection[],
  fail = false,
  critical = false
): BackendClient {
  return {
    name,
    trust_tier: "local",
    critical,
    async detect(_t: string, _o: DetectOpts): Promise<DetectionResult> {
      if (fail) throw new Error(`${name} backend down`);
      return { detections: [...detections], backend_name: name, latency_ms: 0 };
    },
    async healthCheck(): Promise<BackendHealth> {
      return { ok: !fail, latency_ms: 0 };
    },
  };
}

const opts: DetectOpts = { request_id: "test" };

describe("mergeDetections — ADR-0010 overlap resolution", () => {
  test("non-overlapping detections are all preserved", () => {
    const merged = mergeDetections([
      det(0, 5, "private_person", "Alice"),
      det(10, 15, "private_email", "a@b.c"),
    ]);
    expect(merged).toHaveLength(2);
  });

  test("on overlap, longer span wins", () => {
    const merged = mergeDetections([
      det(0, 5, "private_person", "Alice"),
      det(2, 12, "secret", "ice secret"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.category).toBe("secret");
    expect(merged[0]!.end - merged[0]!.start).toBe(10);
  });

  test("on equal-length overlap, first detector wins (FIFO)", () => {
    const merged = mergeDetections([
      det(0, 5, "private_person", "first"),
      det(0, 5, "secret", "first"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.category).toBe("private_person");
  });

  test("multiple overlaps collapse correctly", () => {
    const merged = mergeDetections([
      det(0, 4, "private_person", "AAAA"),
      det(2, 10, "private_email", "AAAAAAAA"),
      det(8, 12, "private_url", "AAAA"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.category).toBe("private_email");
  });

  test("empty input returns empty array", () => {
    expect(mergeDetections([])).toEqual([]);
  });

  test("on equal-length overlap, higher confidence wins over FIFO", () => {
    const lowFirst: Detection = {
      start: 0,
      end: 5,
      category: "private_person",
      confidence: 0.3,
      text: "first",
    };
    const highSecond: Detection = {
      start: 0,
      end: 5,
      category: "secret",
      confidence: 0.95,
      text: "first",
    };
    const merged = mergeDetections([lowFirst, highSecond]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.category).toBe("secret");
  });

  test("equal length and equal confidence still falls back to FIFO", () => {
    const merged = mergeDetections([
      det(0, 5, "private_person", "first"),
      det(0, 5, "secret", "first"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.category).toBe("private_person");
  });
});

describe("MergeStrategy — multi-backend union", () => {
  test("merges detections from multiple backends, longer-span wins", async () => {
    const a = mockBackend("a", [det(0, 5, "private_person", "Alice")]);
    const b = mockBackend("b", [det(0, 10, "secret", "Alice ext")]);
    const strat = new MergeStrategy([a, b]);
    const r = await strat.resolve("Alice ext mfa", opts);
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.category).toBe("secret");
    expect(r.backend_name).toBe("a+b");
  });

  test("survives partial failure when at least one backend succeeds", async () => {
    const good = mockBackend("good", [det(0, 5, "private_email", "a@b.c")]);
    const bad = mockBackend("bad", [], true);
    const strat = new MergeStrategy([good, bad]);
    const r = await strat.resolve("a@b.c", opts);
    expect(r.detections).toHaveLength(1);
  });

  test("throws AggregateError when all backends fail", async () => {
    const a = mockBackend("a", [], true);
    const b = mockBackend("b", [], true);
    const strat = new MergeStrategy([a, b]);
    await expect(strat.resolve("x", opts)).rejects.toThrow(AggregateError);
  });

  test("requires at least one backend", () => {
    expect(() => new MergeStrategy([])).toThrow();
  });

  test("throws AggregateError when a critical backend fails even if non-critical succeeds", async () => {
    const localOk = mockBackend(
      "local-regex",
      [det(0, 5, "private_email", "a@b.c")],
      false,
      false
    );
    const remoteCriticalDown = mockBackend("opf-http", [], true, true);
    const strat = new MergeStrategy([localOk, remoteCriticalDown]);
    await expect(strat.resolve("a@b.c", opts)).rejects.toThrow(AggregateError);
    await expect(strat.resolve("a@b.c", opts)).rejects.toThrow(
      /Critical backend\(s\) failed/
    );
  });

  test("tolerates non-critical backend failure when critical (or any) succeeds", async () => {
    const criticalOk = mockBackend(
      "opf-http",
      [det(0, 5, "private_email", "a@b.c")],
      false,
      true
    );
    const localFail = mockBackend("local-regex", [], true, false);
    const strat = new MergeStrategy([localFail, criticalOk]);
    const r = await strat.resolve("a@b.c", opts);
    expect(r.detections).toHaveLength(1);
  });

  test("backward-compat: undefined critical behaves as non-critical (partial failure tolerated)", async () => {
    const a: BackendClient = {
      name: "no-critical-flag",
      trust_tier: "local",
      async detect() {
        throw new Error("a down");
      },
      async healthCheck() {
        return { ok: false, latency_ms: 0 };
      },
    };
    const b = mockBackend("b", [det(0, 3, "private_url", "abc")], false, false);
    const strat = new MergeStrategy([a, b]);
    const r = await strat.resolve("abc", opts);
    expect(r.detections).toHaveLength(1);
  });
});

describe("SingleStrategy", () => {
  test("delegates to the single backend", async () => {
    const b = mockBackend("only", [det(0, 5, "private_person", "Alice")]);
    const strat = new SingleStrategy(b);
    const r = await strat.resolve("Alice", opts);
    expect(r.detections).toHaveLength(1);
    expect(r.backend_name).toBe("only");
  });
});
