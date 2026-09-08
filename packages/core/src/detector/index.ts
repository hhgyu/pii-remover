import { randomUUID } from "node:crypto";
import type {
  DetectOpts,
  DetectionResult,
  PIICategory,
} from "../types.js";
import type { BackendStrategy } from "../backend/strategy.js";
import { mergeDetections } from "../backend/strategy.js";
import { expandPersonWordBoundaries } from "./word-boundary.js";

export interface DetectorOptions {
  strategy: BackendStrategy;
  defaultCategories?: ReadonlyArray<PIICategory>;
}

export class Detector {
  private readonly strategy: BackendStrategy;
  private readonly defaultCategories?: ReadonlyArray<PIICategory>;

  constructor(opts: DetectorOptions) {
    this.strategy = opts.strategy;
    this.defaultCategories = opts.defaultCategories;
  }

  async detect(
    text: string,
    opts: Partial<DetectOpts> = {}
  ): Promise<DetectionResult> {
    const merged: DetectOpts = {
      request_id: opts.request_id ?? randomRequestId(),
    };
    const cats =
      opts.categories ??
      (this.defaultCategories ? [...this.defaultCategories] : undefined);
    if (cats) merged.categories = cats;
    if (typeof opts.timeout_ms === "number") merged.timeout_ms = opts.timeout_ms;
    const result = await this.strategy.resolve(text, merged);
    // Widening can create overlaps, which VaultManager.assign rejects.
    return {
      ...result,
      detections: mergeDetections(
        expandPersonWordBoundaries(text, result.detections)
      ),
    };
  }
}

function randomRequestId(): string {
  return `req_${randomUUID()}`;
}
