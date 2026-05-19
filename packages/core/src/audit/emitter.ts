import { appendFileSync } from "node:fs";
import type {
  AuditEmitterOptions,
  AuditEntry,
  AuditEntryInput,
  BlockAuditData,
  BypassAuditData,
  ErrorAuditData,
  MaskAuditData,
  RestoreAuditData,
} from "./types.js";

export class AuditEmitter {
  private readonly enabled: boolean;
  private readonly logPath: string | null;
  private readonly stream?: (entry: AuditEntry) => void;
  private disposed = false;

  constructor(opts: AuditEmitterOptions = {}) {
    this.enabled = opts.enabled ?? false;
    this.logPath = opts.logPath ?? null;
    this.stream = opts.stream;
  }

  emit(entry: AuditEntryInput): void {
    if (!this.enabled || this.disposed) return;
    if (!this.logPath && !this.stream) return;

    const fullEntry = sanitizeAuditEntry({
      ...entry,
      timestamp: new Date().toISOString(),
    });

    if (this.stream) {
      try {
        this.stream(fullEntry);
      } catch {
        // Audit must never break PII processing.
      }
    }

    if (this.logPath) {
      try {
        appendFileSync(this.logPath, `${JSON.stringify(fullEntry)}\n`, "utf8");
      } catch {
        // Audit must never break PII processing.
      }
    }
  }

  maskEvent(data: MaskAuditData): void {
    this.emit({ ...data, event: "mask", policy_result: data.policy_result ?? "masked" });
  }

  restoreEvent(data: RestoreAuditData): void {
    this.emit({
      ...data,
      event: "restore",
      policy_result: data.policy_result ?? "restored",
    });
  }

  bypassEvent(data: BypassAuditData): void {
    this.emit({
      ...data,
      event: "bypass",
      policy_result: data.policy_result ?? "bypassed",
    });
  }

  blockEvent(data: BlockAuditData): void {
    this.emit({ ...data, event: "block", policy_result: data.policy_result ?? "blocked" });
  }

  errorEvent(data: ErrorAuditData): void {
    this.emit({ ...data, event: "error" });
  }

  dispose(): void {
    this.disposed = true;
  }
}

export function aggregateAuditCategories(
  items: readonly { category: string }[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.category] = (counts[item.category] ?? 0) + 1;
  }
  return counts;
}

function sanitizeAuditEntry(entry: AuditEntry): AuditEntry {
  if (!entry.error) return entry;
  return { ...entry, error: redactPotentialPii(entry.error) };
}

function redactPotentialPii(message: string): string {
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\b\d{6}-?[1-4]\d{6}\b/g, "[REDACTED_RRN]")
    .replace(/\b01[016789]-?\d{3,4}-?\d{4}\b/g, "[REDACTED_PHONE]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[REDACTED_NUMBER]");
}
