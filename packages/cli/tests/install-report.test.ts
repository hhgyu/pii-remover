import { describe, expect, test } from "bun:test";
import type { PIICategory } from "@pii-remover/core";
import {
  renderInstallReport,
  type FailedOutcome,
  type InstalledOutcome,
  type ReportContext,
} from "../src/commands/install-report.js";
import type { InstallResult } from "../src/commands/install.js";

const mockResult: InstallResult = {
  settings_path: "/home/user/.claude/settings.json",
  created: true,
  hook_already_present: false,
  patched_json: "{}",
  config_path: null,
  config_written: false,
  next_steps: ["Step 1", "Step 2"],
};

const mockPiiConfig = {
  endpoint: "http://localhost:8000/redact",
  categories: ["private_email"] as PIICategory[],
};

describe("renderInstallReport", () => {
  describe("Given: single failed target with idleTimeoutSeconds", () => {
    test("When: idleTimeoutSeconds=0, Then: returns idle guidance (disabled) on stdout", () => {
      // Given
      const failed: FailedOutcome = {
        kind: "failed",
        target: "claude-code",
        message: "connection refused",
      };
      const ctx: ReportContext = {
        dryRun: false,
        piiConfig: mockPiiConfig,
        idleTimeoutSeconds: 0,
      };

      // When
      const report = renderInstallReport([failed], ctx);

      // Then
      expect(report).not.toBe("");
      expect(report).toContain("Idle-unload timeout requested: 0s");
      expect(report).toContain("(0 = disabled; model stays loaded until container stops)");
      expect(report).toContain("OPF_IDLE_TIMEOUT_SECONDS=0 docker compose up -d");
    });

    test("When: idleTimeoutSeconds=300, Then: returns idle guidance (lazy-reload) on stdout", () => {
      // Given
      const failed: FailedOutcome = {
        kind: "failed",
        target: "opencode",
        message: "file not found",
      };
      const ctx: ReportContext = {
        dryRun: false,
        piiConfig: mockPiiConfig,
        idleTimeoutSeconds: 300,
      };

      // When
      const report = renderInstallReport([failed], ctx);

      // Then
      expect(report).not.toBe("");
      expect(report).toContain("Idle-unload timeout requested: 300s");
      expect(report).toContain("Next /redact after 300s idle lazy-reloads the model");
      expect(report).toContain("OPF_IDLE_TIMEOUT_SECONDS=300 docker compose up -d");
    });
  });

  describe("Given: single failed target without idleTimeoutSeconds", () => {
    test("When: idleTimeoutSeconds undefined, Then: returns empty string (stderr-only report)", () => {
      // Given
      const failed: FailedOutcome = {
        kind: "failed",
        target: "codex",
        message: "permission denied",
      };
      const ctx: ReportContext = {
        dryRun: false,
        piiConfig: mockPiiConfig,
        idleTimeoutSeconds: undefined,
      };

      // When
      const report = renderInstallReport([failed], ctx);

      // Then
      expect(report).toBe("");
    });
  });

  describe("Given: single successful target with idleTimeoutSeconds", () => {
    test("When: idleTimeoutSeconds=0, Then: returns outcome + idle guidance", () => {
      // Given
      const installed: InstalledOutcome = {
        kind: "installed",
        target: "claude-code",
        result: mockResult,
      };
      const ctx: ReportContext = {
        dryRun: false,
        piiConfig: mockPiiConfig,
        idleTimeoutSeconds: 0,
      };

      // When
      const report = renderInstallReport([installed], ctx);

      // Then
      expect(report).toContain(mockResult.settings_path);
      expect(report).toContain("Idle-unload timeout requested: 0s");
      expect(report).not.toContain("==="); // no header for single target
      expect(report).not.toContain("Summary:"); // no summary for single target
    });
  });

  describe("Given: multiple targets with mixed outcomes and idleTimeoutSeconds", () => {
    test("When: one installed + one failed + idleTimeoutSeconds=60, Then: includes header, summary, and idle guidance", () => {
      // Given
      const installed: InstalledOutcome = {
        kind: "installed",
        target: "claude-code",
        result: mockResult,
      };
      const failed: FailedOutcome = {
        kind: "failed",
        target: "opencode",
        message: "network error",
      };
      const ctx: ReportContext = {
        dryRun: false,
        piiConfig: mockPiiConfig,
        idleTimeoutSeconds: 60,
      };

      // When
      const report = renderInstallReport([installed, failed], ctx);

      // Then
      expect(report).toContain("=== claude-code ===");
      expect(report).toContain("=== opencode ===");
      expect(report).toContain("Summary:");
      expect(report).toContain("claude-code  installed");
      expect(report).toContain("FAILED — network error");
      expect(report).toContain("Idle-unload timeout requested: 60s");
      expect(report).toContain("Next /redact after 60s idle lazy-reloads the model");
    });
  });

  describe("Given: single failed target, Then: no failure/header/summary text on stdout", () => {
    test("When: rendering failed outcome with idle timeout, Then: only idle guidance (failure on stderr)", () => {
      // Given
      const failed: FailedOutcome = {
        kind: "failed",
        target: "codex",
        message: "test error",
      };
      const ctx: ReportContext = {
        dryRun: false,
        piiConfig: mockPiiConfig,
        idleTimeoutSeconds: 0,
      };

      // When
      const report = renderInstallReport([failed], ctx);

      // Then
      expect(report).not.toContain("install failed:");
      expect(report).not.toContain("===");
      expect(report).not.toContain("Summary:");
      expect(report).toContain("Idle-unload timeout requested: 0s");
      expect(report).toContain("(0 = disabled; model stays loaded until container stops)");
    });
  });
});
