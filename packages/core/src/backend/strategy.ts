import type { Detection, DetectOpts, DetectionResult } from "../types.js";
import type { BackendClient } from "./client.js";

export interface BackendStrategy {
  resolve(text: string, opts: DetectOpts): Promise<DetectionResult>;
}

export class SingleStrategy implements BackendStrategy {
  constructor(public readonly backend: BackendClient) {}

  async resolve(text: string, opts: DetectOpts): Promise<DetectionResult> {
    return this.backend.detect(text, opts);
  }
}

/**
 * Merge multiple backend results.
 *
 * Per ADR-0010 §implementation: overlapping spans resolve as
 *   1. longer span wins
 *   2. tie → first detector in order wins
 * (caller controls "first" by ordering `backends`).
 *
 * When a remote (non-first) backend returns `private_person` detections,
 * the local (first) backend's `private_person` detections are dropped.
 * This prevents the Korean name heuristic from adding false-positive
 * person spans when the ML model provides authoritative person detection.
 */
export class MergeStrategy implements BackendStrategy {
  public readonly backends: readonly BackendClient[];

  constructor(backends: readonly BackendClient[]) {
    if (backends.length === 0) {
      throw new Error("MergeStrategy requires at least one backend");
    }
    this.backends = backends;
  }

  async resolve(text: string, opts: DetectOpts): Promise<DetectionResult> {
    const t0 = performance.now();
    const settled = await Promise.allSettled(
      this.backends.map((b) => b.detect(text, opts))
    );
    const errors: Error[] = [];
    const results: DetectionResult[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") {
        results.push(r.value);
      } else {
        errors.push(
          r.reason instanceof Error ? r.reason : new Error(String(r.reason))
        );
      }
    }
    if (errors.length === this.backends.length) {
      const summary = errors.map((e) => e.message).join("; ");
      throw new AggregateError(errors, `All backends failed: ${summary}`);
    }
    const all = mergeBackendDetections(results);
    return {
      detections: mergeDetections(all),
      backend_name: this.backends.map((b) => b.name).join("+"),
      latency_ms: performance.now() - t0,
    };
  }
}

/**
 * Merge detections from multiple backend results.
 *
 * The first backend is treated as "local" (typically local-regex); all
 * subsequent backends are treated as "remote" (ML model). When a remote
 * backend responds successfully, its `private_person` verdict is treated
 * as authoritative — all local heuristic `private_person` detections are
 * dropped, regardless of whether the remote found any persons or not.
 * This prevents the Korean name heuristic from producing false positives
 * ("전화번호", "나이저", "하고", etc.) that the ML model correctly rejects.
 *
 * However, when a local heuristic person detection is a strictly shorter
 * span that overlaps a remote person detection (e.g., local finds "김철수"
 * at [3,6] while remote returns "김철수님" at [3,7]), the local span is
 * preferred — the Korean heuristic strips trailing honorifics/particles
 * (님, 씨, 이, 가, etc.) to produce tighter, more accurate name spans.
 *
 * Categories other than `private_person` are merged normally from all
 * backends regardless.
 */
export function mergeBackendDetections(
  results: readonly DetectionResult[]
): Detection[] {
  if (results.length <= 1) {
    return results[0]?.detections ?? [];
  }

  const local = results[0]!;
  const remotes = results.slice(1);

  const remoteResponded = remotes.length > 0;

  if (!remoteResponded) {
    return local.detections;
  }

  const localPersons = local.detections.filter(
    (d) => d.category === "private_person"
  );
  const localNonPerson = local.detections.filter(
    (d) => d.category !== "private_person"
  );

  const remotePersons = remotes.flatMap((r) =>
    r.detections.filter((d) => d.category === "private_person")
  );

  // Remote responded successfully — its person verdict is authoritative.
  // If remote found no persons, drop local heuristic persons entirely
  // (they are false positives the ML model correctly rejected).
  // Only fall back to local persons when ALL remotes failed (no results).
  const anyRemoteSucceeded = remotes.some((r) => r.detections !== undefined);
  let mergedPersons: Detection[];
  if (remotePersons.length === 0 && !anyRemoteSucceeded) {
    mergedPersons = localPersons;
  } else if (remotePersons.length === 0) {
    mergedPersons = [];
  } else {
    mergedPersons = remotePersons.map((rp) => {
      const overlapping = localPersons.filter(
        (lp) =>
          lp.start >= rp.start &&
          lp.end <= rp.end &&
          lp.end - lp.start < rp.end - rp.start
      );
      return overlapping.length === 1 ? overlapping[0]! : rp;
    });
  }

  const remoteNonPerson = remotes.flatMap((r) =>
    r.detections.filter((d) => d.category !== "private_person")
  );

  return [localNonPerson, ...mergedPersons, ...remoteNonPerson].flat();
}

/**
 * Resolve overlap with longer-span priority, FIFO on ties.
 * Stable across calls: sort uses (start asc, length desc, original index asc).
 */
export function mergeDetections(detections: readonly Detection[]): Detection[] {
  if (detections.length <= 1) return [...detections];
  const indexed = detections.map((d, i) => ({ d, i }));
  indexed.sort((a, b) => {
    if (a.d.start !== b.d.start) return a.d.start - b.d.start;
    const lenA = a.d.end - a.d.start;
    const lenB = b.d.end - b.d.start;
    if (lenA !== lenB) return lenB - lenA;
    return a.i - b.i;
  });
  const result: Detection[] = [];
  for (const { d } of indexed) {
    const last = result[result.length - 1];
    if (!last || d.start >= last.end) {
      result.push(d);
      continue;
    }
    const lastLen = last.end - last.start;
    const curLen = d.end - d.start;
    if (curLen > lastLen) {
      result[result.length - 1] = d;
    }
  }
  return result;
}
