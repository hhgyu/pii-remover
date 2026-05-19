import { describe, expect, test } from "bun:test";
import { parseArgs, usage } from "../src/cli.js";

describe("parseArgs", () => {
  test("defaults to stdio transport with no other options", () => {
    const opts = parseArgs([]);
    expect(opts.transport).toBe("stdio");
    expect(opts.port).toBeUndefined();
    expect(opts.host).toBeUndefined();
    expect(opts.vaultPoolOptions).toBeUndefined();
  });

  test("--transport http sets transport correctly", () => {
    const opts = parseArgs(["--transport", "http"]);
    expect(opts.transport).toBe("http");
  });

  test("--transport invalid throws", () => {
    expect(() => parseArgs(["--transport", "ws"])).toThrow(/--transport/);
  });

  test("--port sets numeric port", () => {
    const opts = parseArgs(["--transport", "http", "--port", "9000"]);
    expect(opts.port).toBe(9000);
  });

  test("--port out of range throws", () => {
    expect(() => parseArgs(["--port", "0"])).toThrow(/--port/);
    expect(() => parseArgs(["--port", "70000"])).toThrow(/--port/);
    expect(() => parseArgs(["--port", "abc"])).toThrow(/--port/);
  });

  test("--host sets bind address", () => {
    const opts = parseArgs(["--transport", "http", "--host", "0.0.0.0"]);
    expect(opts.host).toBe("0.0.0.0");
  });

  test("--config sets configPath", () => {
    const opts = parseArgs(["--config", "/etc/pii.json"]);
    expect(opts.configPath).toBe("/etc/pii.json");
  });

  test("--max-vaults and --ttl-ms populate vaultPoolOptions", () => {
    const opts = parseArgs(["--max-vaults", "50", "--ttl-ms", "60000"]);
    expect(opts.vaultPoolOptions?.maxSize).toBe(50);
    expect(opts.vaultPoolOptions?.ttlMs).toBe(60000);
  });

  test("invalid --max-vaults throws", () => {
    expect(() => parseArgs(["--max-vaults", "0"])).toThrow(/--max-vaults/);
    expect(() => parseArgs(["--max-vaults", "1.5"])).toThrow(/--max-vaults/);
  });

  test("unknown argument throws", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});

describe("usage", () => {
  test("includes all documented flags", () => {
    const u = usage();
    expect(u).toContain("--transport");
    expect(u).toContain("--port");
    expect(u).toContain("--host");
    expect(u).toContain("--config");
    expect(u).toContain("--max-vaults");
    expect(u).toContain("--ttl-ms");
  });
});
