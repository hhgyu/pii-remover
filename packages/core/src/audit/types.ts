export type AuditEvent = "mask" | "restore" | "bypass" | "block" | "error";

export interface AuditEntry {
  timestamp: string;
  event: AuditEvent;
  vault_id?: string;
  session_id?: string;
  request_id?: string;
  categories?: Record<string, number>;
  backend_name?: string;
  latency_ms?: number;
  policy_result?: "masked" | "blocked" | "bypassed" | "restored";
  restored_count?: number;
  unknown_token_count?: number;
  partial_match_count?: number;
  error?: string;
  provider?: string;
}

export type AuditEntryInput = Omit<AuditEntry, "timestamp">;

export interface AuditEmitterOptions {
  enabled?: boolean;
  logPath?: string | null;
  stream?: (entry: AuditEntry) => void;
}

export type MaskAuditData = Omit<AuditEntryInput, "event" | "policy_result"> & {
  policy_result?: "masked";
};

export type RestoreAuditData = Omit<AuditEntryInput, "event" | "policy_result"> & {
  policy_result?: "restored";
};

export type BypassAuditData = Omit<AuditEntryInput, "event" | "policy_result"> & {
  policy_result?: "bypassed";
};

export type BlockAuditData = Omit<AuditEntryInput, "event" | "policy_result"> & {
  policy_result?: "blocked";
};

export type ErrorAuditData = Omit<AuditEntryInput, "event">;
