import type { Detection, DetectOpts, DetectionResult } from "../types.js";
import type { BackendClient } from "./client.js";
import { mergeDetections, mergeBackendDetections, type BackendStrategy } from "./strategy.js";

export type OnLocalFailure = "skip_remote" | "throw";

export interface TieredStrategyOptions {
  local: BackendClient;
  remote: BackendClient;
  /**
   * Policy when the local detector fails BEFORE we can redact PII:
   *  - `skip_remote` (default): suppress remote call entirely, return
   *    empty detections + warn. Prevents Korean PII leaking through
   *    the remote backend when local detection is unavailable.
   *  - `throw`: surface an `AggregateError`. Safer for strict CI.
   */
  on_local_failure?: OnLocalFailure;
  warn?: (msg: string) => void;
  /**
   * Single codepoint used to replace PII characters before sending the
   * text to the remote backend. MUST be the same byte length as the
   * span it replaces (offset preservation). Default: `\u00B7` (middle
   * dot) which is visibly distinct from ASCII whitespace in dev logs.
   */
  placeholder_char?: string;
}

/**
 * Tiered backend strategy — Phase 5 core security feature.
 *
 * Pipeline:
 *  1. Run the *local* backend over the original text.
 *  2. Build a *redacted* copy where every detected span is replaced
 *     with `placeholder_char` × (span length). Offsets are preserved
 *     so subsequent detections remain comparable.
 *  3. Run the *remote* backend over the redacted text only.
 *  4. Merge L ∪ R via `mergeDetections` (longer-span wins, FIFO ties).
 *
 * Security invariant: Korean PII (and any other category caught by the
 * local detector) is NEVER forwarded to the remote endpoint. Step 2 is
 * the security boundary; tests assert that no PII substring survives.
 *
 * Failure handling:
 *  - Remote fails after local succeeds → return local-only result, warn.
 *  - Local fails first → `on_local_failure` policy decides.
 *  - Both fail → `AggregateError`.
 */
export class TieredStrategy implements BackendStrategy {
  readonly local: BackendClient;
  readonly remote: BackendClient;
  private readonly onLocalFailure: OnLocalFailure;
  private readonly warn: (msg: string) => void;
  private readonly placeholderChar: string;

  constructor(opts: TieredStrategyOptions) {
    if (!opts.local) throw new TypeError("TieredStrategy: local backend is required");
    if (!opts.remote) throw new TypeError("TieredStrategy: remote backend is required");
    this.local = opts.local;
    this.remote = opts.remote;
    this.onLocalFailure = opts.on_local_failure ?? "skip_remote";
    this.warn = opts.warn ?? defaultWarn;
    const p = opts.placeholder_char ?? "\u00B7";
    if (p.length !== 1) {
      throw new TypeError(
        "TieredStrategy: placeholder_char MUST be a single UTF-16 code unit to preserve offsets"
      );
    }
    this.placeholderChar = p;
  }

  async resolve(text: string, opts: DetectOpts): Promise<DetectionResult> {
    const t0 = performance.now();
    let localResult: DetectionResult | null = null;
    let localErr: Error | null = null;
    try {
      localResult = await this.local.detect(text, opts);
    } catch (e) {
      localErr = e instanceof Error ? e : new Error(String(e));
    }

    if (localErr) {
      return this.handleLocalFailure(localErr, opts, t0);
    }

    const redacted = redactSpans(text, localResult!.detections, this.placeholderChar);
    let remoteResult: DetectionResult | null = null;
    let remoteErr: Error | null = null;
    try {
      remoteResult = await this.remote.detect(redacted, opts);
    } catch (e) {
      remoteErr = e instanceof Error ? e : new Error(String(e));
    }

    if (remoteErr) {
      this.warn(
        `[WARN] TieredStrategy: remote backend '${this.remote.name}' failed; ` +
          `falling back to local-only detections. reason=${remoteErr.message}`
      );
      return {
        detections: mergeDetections(localResult!.detections),
        backend_name: `tiered(local=${this.local.name}+remote=FAILED:${this.remote.name})`,
        latency_ms: performance.now() - t0,
      };
    }

    const remotePersons = remoteResult!.detections.filter(
      (d) => d.category === "private_person"
    );
    const localPersons = localResult!.detections.filter(
      (d) => d.category === "private_person"
    );

    let mergedPersons: Detection[];
    if (remotePersons.length > 0) {
      mergedPersons = remotePersons.map((rp) => {
        const overlapping = localPersons.filter(
          (lp) =>
            lp.start >= rp.start &&
            lp.end <= rp.end &&
            lp.end - lp.start < rp.end - rp.start
        );
        return overlapping.length === 1 ? overlapping[0]! : rp;
      });
    } else {
      mergedPersons = [];
    }

    const localNonPerson = localResult!.detections.filter(
      (d) => d.category !== "private_person"
    );
    const remoteNonPerson = remoteResult!.detections.filter(
      (d) => d.category !== "private_person"
    );

    const all: Detection[] = [
      ...localNonPerson,
      ...mergedPersons,
      ...remoteNonPerson,
    ];

    return {
      detections: mergeDetections(all),
      backend_name: `tiered(local=${this.local.name}+remote=${this.remote.name})`,
      latency_ms: performance.now() - t0,
    };
  }

  private async handleLocalFailure(
    localErr: Error,
    opts: DetectOpts,
    t0: number
  ): Promise<DetectionResult> {
    if (this.onLocalFailure === "throw") {
      throw new AggregateError(
        [localErr],
        `TieredStrategy: local backend '${this.local.name}' failed (on_local_failure=throw)`
      );
    }
    this.warn(
      `[WARN] TieredStrategy: local backend '${this.local.name}' failed; ` +
        `skipping remote call to avoid leaking unredacted PII. reason=${localErr.message}`
    );
    return {
      detections: [],
      backend_name: `tiered(local=FAILED:${this.local.name}+remote=SKIPPED:${this.remote.name})`,
      latency_ms: performance.now() - t0,
    };
  }
}

/**
 * Replace each `[start, end)` span in `text` with `replacement`
 * repeated `(end - start)` times. MUST preserve length so downstream
 * offsets (remote detections) match the original text.
 */
export function redactSpans(
  text: string,
  detections: readonly Detection[],
  replacement: string
): string {
  if (detections.length === 0) return text;
  if (replacement.length !== 1) {
    throw new TypeError("redactSpans: replacement MUST be a single code unit");
  }
  const merged = mergeDetections(detections);
  const sorted = [...merged].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const d of sorted) {
    if (d.start < cursor) {
      continue;
    }
    out += text.slice(cursor, d.start);
    const span = d.end - d.start;
    out += replacement.repeat(span);
    cursor = d.end;
  }
  out += text.slice(cursor);
  return out;
}

function defaultWarn(msg: string): void {
  process.stderr.write(`${msg}\n`);
}
