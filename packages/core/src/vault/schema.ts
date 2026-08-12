/**
 * Vault schema per ADR-0003. The constant `SCHEMA_VERSION` enables future
 * migration: any persisted/exported vault MUST carry this version string.
 *
 * `canonical_text` is the deduplication key (alongside `label`). See
 * VaultManager.canonicalize for the normalization function.
 */

export const SCHEMA_VERSION = "opf.reversible.v3" as const;

export type VaultSchemaVersion = typeof SCHEMA_VERSION;

export interface VaultEntry {
  label: string;
  text: string;
  canonical_text: string;
  /** Deterministic base36 hash identifier (ADR-0020). */
  id: string;
  /** Populated only when `RestorationConfig.mode === "synthetic"` (ADR-0018). */
  synthetic_value?: string;
}

export interface Vault {
  schema_version: VaultSchemaVersion;
  vault_id: string;
  entries: Record<string, VaultEntry>;
  created_at: number;
}
