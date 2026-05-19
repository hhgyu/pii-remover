import { describe, expect, test } from "bun:test";
import { FailClosedError } from "@pii-remover/core";
import {
  VaultExpiredError,
  VaultNotFoundError,
  buildToolError,
  toToolErrorResult,
  withToolErrorMapping,
} from "../src/errors.js";

describe("VaultNotFoundError / VaultExpiredError", () => {
  test("constructor preserves vaultId and message", () => {
    const e1 = new VaultNotFoundError("v1");
    expect(e1.vaultId).toBe("v1");
    expect(e1.message).toContain("v1");
    const e2 = new VaultNotFoundError("v2", "custom");
    expect(e2.message).toBe("custom");
  });

  test("VaultExpiredError matches the same pattern", () => {
    const e = new VaultExpiredError("vX");
    expect(e.vaultId).toBe("vX");
    expect(e.message).toContain("vX");
  });
});

describe("toToolErrorResult mapping", () => {
  test("maps VaultNotFoundError to error_code='vault_not_found'", () => {
    const r = toToolErrorResult(new VaultNotFoundError("v1"));
    expect(r).not.toBeNull();
    expect(r!.isError).toBe(true);
    expect(r!.structuredContent.error_code).toBe("vault_not_found");
    expect(r!.structuredContent.vault_id).toBe("v1");
  });

  test("maps VaultExpiredError to error_code='vault_expired'", () => {
    const r = toToolErrorResult(new VaultExpiredError("v2"));
    expect(r!.structuredContent.error_code).toBe("vault_expired");
    expect(r!.structuredContent.vault_id).toBe("v2");
  });

  test("maps FailClosedError to error_code='fail_closed'", () => {
    const r = toToolErrorResult(
      new FailClosedError("detection failed", {
        backend: "local",
        bypass_env: "PII_REMOVER_BYPASS",
      }),
    );
    expect(r!.structuredContent.error_code).toBe("fail_closed");
    expect(r!.structuredContent.message).toContain("detection failed");
  });

  test("returns null for unknown errors so the SDK can map to JSON-RPC", () => {
    expect(toToolErrorResult(new Error("boom"))).toBeNull();
    expect(toToolErrorResult("string error")).toBeNull();
  });

  test("error result content is a [{ type: 'text' }] tuple", () => {
    const r = toToolErrorResult(new VaultNotFoundError("v"));
    expect(r!.content).toHaveLength(1);
    expect(r!.content[0]!.type).toBe("text");
    expect(r!.content[0]!.text.startsWith("[vault_not_found]")).toBe(true);
  });
});

describe("buildToolError", () => {
  test("omits vault_id field when not provided", () => {
    const r = buildToolError("invalid_input", "bad shape");
    expect(r.structuredContent.error_code).toBe("invalid_input");
    expect("vault_id" in r.structuredContent).toBe(false);
  });

  test("includes vault_id when provided", () => {
    const r = buildToolError("vault_expired", "expired", "v9");
    expect(r.structuredContent.vault_id).toBe("v9");
  });
});

describe("withToolErrorMapping", () => {
  test("returns the value when fn resolves", async () => {
    const r = await withToolErrorMapping(async () => ({ ok: true }));
    expect(r).toEqual({ ok: true });
  });

  test("returns a tool error result for known errors", async () => {
    const r = await withToolErrorMapping(async () => {
      throw new VaultNotFoundError("v");
    });
    expect((r as { isError?: boolean }).isError).toBe(true);
  });

  test("rethrows unknown errors so SDK maps them to JSON-RPC", async () => {
    await expect(
      withToolErrorMapping(async () => {
        throw new Error("internal panic");
      }),
    ).rejects.toThrow("internal panic");
  });
});
