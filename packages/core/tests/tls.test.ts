import { describe, expect, test } from "bun:test";
import {
  buildFetchTlsExtension,
  buildPinningCheckServerIdentity,
  fingerprintMatches,
  isBunRuntime,
  normalizeFingerprint,
  type FetchInitExtended,
  type TlsRuntimeConfig,
  type UndiciLike,
} from "../src/backend/tls.js";

const SAMPLE_FP_COLON =
  "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const SAMPLE_FP_LOWER = SAMPLE_FP_COLON.replace(/:/g, "").toLowerCase();
const SAMPLE_FP_UPPER = SAMPLE_FP_COLON.replace(/:/g, "");

function makeReadFile(map: Record<string, Buffer>): (path: string) => Buffer {
  return (path: string) => {
    const v = map[path];
    if (!v) {
      const err = new Error(`ENOENT: no such file '${path}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    }
    return v;
  };
}

function fakeUndici(record: { connect: unknown | null } = { connect: null }): {
  load: () => Promise<UndiciLike>;
  record: { connect: unknown | null };
} {
  const mod: UndiciLike = {
    Agent: class {
      readonly connect: unknown;
      constructor(opts: { connect?: Record<string, unknown> }) {
        this.connect = opts.connect ?? null;
        record.connect = this.connect;
      }
    },
  };
  return {
    load: async () => mod,
    record,
  };
}

describe("normalizeFingerprint", () => {
  test("strips colons and lowercases", () => {
    expect(normalizeFingerprint("AA:BB:CC")).toBe("aabbcc");
  });
  test("strips whitespace and is idempotent", () => {
    expect(normalizeFingerprint("  aa BB:cc  ")).toBe("aabbcc");
  });
});

describe("fingerprintMatches", () => {
  test("matches across colon and concatenated forms (security: pin compare)", () => {
    expect(fingerprintMatches(SAMPLE_FP_COLON, SAMPLE_FP_LOWER)).toBe(true);
    expect(fingerprintMatches(SAMPLE_FP_LOWER, SAMPLE_FP_COLON)).toBe(true);
    expect(fingerprintMatches(SAMPLE_FP_UPPER, SAMPLE_FP_LOWER)).toBe(true);
  });
  test("rejects mismatched fingerprints", () => {
    const other = SAMPLE_FP_COLON.replace(/AA/g, "11");
    expect(fingerprintMatches(SAMPLE_FP_COLON, other)).toBe(false);
  });
  test("rejects empty/whitespace inputs (no accidental match)", () => {
    expect(fingerprintMatches("", "")).toBe(false);
    expect(fingerprintMatches(":::", SAMPLE_FP_COLON)).toBe(false);
    expect(fingerprintMatches(SAMPLE_FP_COLON, "")).toBe(false);
  });
});

describe("buildPinningCheckServerIdentity — security contract", () => {
  test("returns undefined on match", () => {
    const fn = buildPinningCheckServerIdentity(SAMPLE_FP_COLON);
    expect(fn("host.example", { fingerprint256: SAMPLE_FP_COLON })).toBeUndefined();
    expect(fn("host.example", { fingerprint256: SAMPLE_FP_LOWER })).toBeUndefined();
  });
  test("returns Error on mismatch (does NOT throw)", () => {
    const fn = buildPinningCheckServerIdentity(SAMPLE_FP_COLON);
    const wrong = SAMPLE_FP_COLON.replace(/AA/g, "11");
    const r = fn("host.example", { fingerprint256: wrong });
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toContain("fingerprint mismatch");
  });
  test("returns Error when cert has no fingerprint", () => {
    const fn = buildPinningCheckServerIdentity(SAMPLE_FP_COLON);
    const r = fn("host.example", {});
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toContain("no SHA-256 fingerprint");
  });
});

describe("isBunRuntime", () => {
  test("returns true under bun test runtime", () => {
    expect(isBunRuntime()).toBe(true);
  });
});

describe("buildFetchTlsExtension — defaults", () => {
  test("returns null when cfg is undefined", async () => {
    const r = await buildFetchTlsExtension(undefined);
    expect(r).toBeNull();
  });

  test("returns null when cfg has nothing TLS-specific to set", async () => {
    const cfg: TlsRuntimeConfig = {
      verify: true,
      ca_bundle_path: null,
      pinning: { enabled: false, sha256_fingerprint: null },
    };
    const r = await buildFetchTlsExtension(cfg);
    expect(r).toBeNull();
  });
});

describe("buildFetchTlsExtension — Bun path", () => {
  test("emits { tls } block with rejectUnauthorized + pinning callback", async () => {
    const cfg: TlsRuntimeConfig = {
      verify: true,
      ca_bundle_path: null,
      pinning: { enabled: true, sha256_fingerprint: SAMPLE_FP_COLON },
    };
    const r = (await buildFetchTlsExtension(cfg, {
      isBun: () => true,
    })) as FetchInitExtended;
    expect(r).not.toBeNull();
    expect(r.tls).toBeDefined();
    const tls = r.tls as Record<string, unknown>;
    expect(tls.rejectUnauthorized).toBe(true);
    expect(typeof tls.checkServerIdentity).toBe("function");
    expect("dispatcher" in r).toBe(false);
    const cb = tls.checkServerIdentity as (
      h: string,
      c: { fingerprint256?: string }
    ) => Error | undefined;
    expect(cb("h", { fingerprint256: SAMPLE_FP_LOWER })).toBeUndefined();
    expect(cb("h", { fingerprint256: "wrong" })).toBeInstanceOf(Error);
  });

  test("loads CA bundle from disk via injected readFile", async () => {
    const cfg: TlsRuntimeConfig = {
      verify: true,
      ca_bundle_path: "/fake/ca.pem",
      pinning: { enabled: false, sha256_fingerprint: null },
    };
    const r = (await buildFetchTlsExtension(cfg, {
      isBun: () => true,
      readFile: makeReadFile({ "/fake/ca.pem": Buffer.from("-----BEGIN CERT-----") }),
    })) as FetchInitExtended;
    expect(r).not.toBeNull();
    const tls = r.tls as Record<string, unknown>;
    expect(Buffer.isBuffer(tls.ca)).toBe(true);
    expect((tls.ca as Buffer).toString()).toContain("BEGIN CERT");
  });

  test("loads mTLS cert/key/passphrase via injected readFile + env", async () => {
    const cfg: TlsRuntimeConfig = {
      verify: true,
      ca_bundle_path: null,
      pinning: { enabled: false, sha256_fingerprint: null },
      mtls: {
        cert_path: "/fake/client.crt",
        key_path: "/fake/client.key",
        passphrase_env: "FAKE_KEY_PASS",
      },
    };
    const r = (await buildFetchTlsExtension(cfg, {
      isBun: () => true,
      readFile: makeReadFile({
        "/fake/client.crt": Buffer.from("CERT"),
        "/fake/client.key": Buffer.from("KEY"),
      }),
      env: { FAKE_KEY_PASS: "p4ss" } as NodeJS.ProcessEnv,
    })) as FetchInitExtended;
    const tls = r.tls as Record<string, unknown>;
    expect((tls.cert as Buffer).toString()).toBe("CERT");
    expect((tls.key as Buffer).toString()).toBe("KEY");
    expect(tls.passphrase).toBe("p4ss");
  });

  test("verify=false maps to rejectUnauthorized=false", async () => {
    const cfg: TlsRuntimeConfig = {
      verify: false,
      ca_bundle_path: null,
      pinning: { enabled: false, sha256_fingerprint: null },
    };
    const r = (await buildFetchTlsExtension(cfg, {
      isBun: () => true,
    })) as FetchInitExtended;
    expect((r.tls as Record<string, unknown>).rejectUnauthorized).toBe(false);
  });
});

describe("buildFetchTlsExtension — Node path (mocked)", () => {
  test("emits { dispatcher } with undici.Agent containing connect options", async () => {
    const cfg: TlsRuntimeConfig = {
      verify: true,
      ca_bundle_path: "/fake/ca.pem",
      pinning: { enabled: true, sha256_fingerprint: SAMPLE_FP_COLON },
    };
    const captured: { connect: unknown | null } = { connect: null };
    const fake = fakeUndici(captured);
    const r = (await buildFetchTlsExtension(cfg, {
      isBun: () => false,
      readFile: makeReadFile({ "/fake/ca.pem": Buffer.from("CA") }),
      loadUndici: fake.load,
    })) as FetchInitExtended;
    expect("tls" in r).toBe(false);
    expect(r.dispatcher).toBeDefined();
    const cap = captured.connect as Record<string, unknown>;
    expect(cap.rejectUnauthorized).toBe(true);
    expect((cap.ca as Buffer).toString()).toBe("CA");
    expect(typeof cap.checkServerIdentity).toBe("function");
  });

  test("throws when undici fails to load (no insecure fallback)", async () => {
    const cfg: TlsRuntimeConfig = {
      verify: true,
      ca_bundle_path: null,
      pinning: { enabled: true, sha256_fingerprint: SAMPLE_FP_COLON },
    };
    await expect(
      buildFetchTlsExtension(cfg, {
        isBun: () => false,
        loadUndici: async () => {
          throw new Error("undici not installed");
        },
      })
    ).rejects.toThrow(/undici/i);
  });
});

describe("buildFetchTlsExtension — fail-closed init", () => {
  test("missing mTLS cert file throws at init (not at fetch)", async () => {
    const cfg: TlsRuntimeConfig = {
      verify: true,
      ca_bundle_path: null,
      pinning: { enabled: false, sha256_fingerprint: null },
      mtls: { cert_path: "/missing/client.crt", key_path: "/missing/client.key" },
    };
    await expect(
      buildFetchTlsExtension(cfg, {
        isBun: () => true,
        readFile: makeReadFile({}),
      })
    ).rejects.toThrow(/cert file not readable/i);
  });

  test("missing CA bundle throws at init with ENOENT code (not message)", async () => {
    const cfg: TlsRuntimeConfig = {
      verify: true,
      ca_bundle_path: "/nope/ca.pem",
      pinning: { enabled: false, sha256_fingerprint: null },
    };
    await expect(
      buildFetchTlsExtension(cfg, {
        isBun: () => true,
        readFile: makeReadFile({}),
      })
    ).rejects.toThrow(/CA bundle not readable.*code=ENOENT/i);
  });

  test("missing mTLS key throws separate error from missing cert", async () => {
    const cfg: TlsRuntimeConfig = {
      verify: true,
      ca_bundle_path: null,
      pinning: { enabled: false, sha256_fingerprint: null },
      mtls: { cert_path: "/fake/client.crt", key_path: "/missing/client.key" },
    };
    await expect(
      buildFetchTlsExtension(cfg, {
        isBun: () => true,
        readFile: makeReadFile({ "/fake/client.crt": Buffer.from("CERT") }),
      })
    ).rejects.toThrow(/key file not readable/i);
  });

  test("error messages do NOT leak file contents or passphrase", async () => {
    const cfg: TlsRuntimeConfig = {
      verify: true,
      ca_bundle_path: null,
      pinning: { enabled: false, sha256_fingerprint: null },
      mtls: {
        cert_path: "/missing/client.crt",
        key_path: "/missing/client.key",
        passphrase_env: "SECRET_PASS",
      },
    };
    try {
      await buildFetchTlsExtension(cfg, {
        isBun: () => true,
        readFile: makeReadFile({}),
        env: { SECRET_PASS: "this-must-not-appear" } as NodeJS.ProcessEnv,
      });
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("this-must-not-appear");
    }
  });
});

describe("buildFetchTlsExtension — pinning works regardless of verify flag", () => {
  test("verify=false still enables pinning callback", async () => {
    const cfg: TlsRuntimeConfig = {
      verify: false,
      ca_bundle_path: null,
      pinning: { enabled: true, sha256_fingerprint: SAMPLE_FP_COLON },
    };
    const r = (await buildFetchTlsExtension(cfg, {
      isBun: () => true,
    })) as FetchInitExtended;
    const tls = r.tls as Record<string, unknown>;
    expect(tls.rejectUnauthorized).toBe(false);
    expect(typeof tls.checkServerIdentity).toBe("function");
  });
});
