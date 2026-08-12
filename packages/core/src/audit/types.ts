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
  // Restore-event counters. The denominator for every restore rate is
  // `restored_count + unknown_token_count + path_skip_count` — tokens actually
  // OBSERVED in the model output — not `minted_count`, because a minted token
  // the model never mentions is not a restore failure.
  restored_count?: number;
  unknown_token_count?: number;
  partial_match_count?: number;
  path_skip_count?: number;
  lenient_restored_count?: number;
  residual_token_count?: number;
  repaired_count?: number;
  // Partition of unknown_token_count (ADR-0021). `hallucinated_count` and
  // `unminted_token_count` are the SAME failure — this key never minted the
  // token — split by who wrote the text. Only model-authored text can
  // hallucinate; a token-shaped string in a file the agent read belongs in
  // `unminted_token_count` and must stay out of hallucination_rate.
  hallucinated_count?: number;
  unminted_token_count?: number;
  dead_token_count?: number;
  ambiguous_count?: number;
  // Mask-event counters.
  minted_count?: number;
  text_length?: number;
  masked_char_count?: number;
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
