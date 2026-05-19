import { randomUUID } from "node:crypto";
import type {
  DetectOpts,
  DetectionResult,
  PIICategory,
} from "../types.js";
import type { BackendStrategy } from "../backend/strategy.js";

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
    return this.strategy.resolve(text, merged);
  }
}

function randomRequestId(): string {
  return `req_${randomUUID()}`;
}
