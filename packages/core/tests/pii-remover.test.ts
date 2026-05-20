import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PIIRemover, applyTokens } from "../src/pii-remover.js";
import { LocalRegexBackend } from "../src/backend/local-regex.js";
import { SingleStrategy } from "../src/backend/strategy.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { FailClosedError } from "../src/policy/failure.js";
import { resetBypassCount, getBypassCount } from "../src/policy/bypass.js";
import type { BackendClient, BackendHealth } from "../src/backend/client.js";
import type {
  Detection,
  DetectOpts,
  DetectionResult,
  PIICategory,
} from "../src/types.js";

function mkConfig(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function silentWarn(): (msg: string) => void {
  return () => {};
}

beforeEach(() => {
  resetBypassCount();
});

afterEach(() => {
  resetBypassCount();
});

describe("applyTokens", () => {
  test("replaces multiple spans correctly (right-to-left)", () => {
    const text = "email user@example.com and 4242 4242 4242 4242";
    const out = applyTokens(text, [
      {
        start: 6,
        end: 22,
        category: "private_email",
        confidence: 0.9,
        text: "user@example.com",
        token: "__OPF_EMAIL_1__",
      },
      {
        start: 27,
        end: 46,
        category: "card",
        confidence: 0.99,
        text: "4242 4242 4242 4242",
        token: "__OPF_CARD_1__",
      },
    ]);
    expect(out).toBe("email __OPF_EMAIL_1__ and __OPF_CARD_1__");
  });

  test("returns unchanged text when there are no tokens", () => {
    expect(applyTokens("hello world", [])).toBe("hello world");
  });
});

describe("PIIRemover.mask — round trip (Phase 1)", () => {
  test("masks email with LocalRegexBackend via SingleStrategy", async () => {
    const env: NodeJS.ProcessEnv = {};
    const pii = await PIIRemover.init({
      sessionId: "s1",
      config: mkConfig(),
      env,
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const r = await pii.mask("contact user@example.com please");
    expect(r.bypassed).toBe(false);
    expect(r.text).toBe("contact __OPF_EMAIL_1__ please");
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0]!.token).toBe("__OPF_EMAIL_1__");
    expect(typeof r.vault_id).toBe("string");
    pii.dispose();
  });

  test("session isolation: same input in two sessions yields equal token strings but different vault ids", async () => {
    const env: NodeJS.ProcessEnv = {};
    const strategy = new SingleStrategy(new LocalRegexBackend());
    const a = await PIIRemover.init({
      sessionId: "A",
      config: mkConfig(),
      env,
      warn: silentWarn(),
      strategy,
    });
    const b = await PIIRemover.init({
      sessionId: "B",
      config: mkConfig(),
      env,
      warn: silentWarn(),
      strategy,
    });
    const ra = await a.mask("call alice@example.com");
    const rb = await b.mask("call bob@example.com");
    expect(ra.tokens[0]!.token).toBe("__OPF_EMAIL_1__");
    expect(rb.tokens[0]!.token).toBe("__OPF_EMAIL_1__");
    expect(ra.vault_id).not.toBe(rb.vault_id);
    a.dispose();
    b.dispose();
  });

  test("dedup across calls in the same session", async () => {
    const env: NodeJS.ProcessEnv = {};
    const pii = await PIIRemover.init({
      sessionId: "s1",
      config: mkConfig(),
      env,
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const r1 = await pii.mask("email user@example.com first");
    const r2 = await pii.mask("again user@example.com second");
    expect(r1.tokens[0]!.token).toBe(r2.tokens[0]!.token);
    expect(pii.vaultSize()).toBe(1);
    pii.dispose();
  });

  test("dispose prevents further use", async () => {
    const pii = await PIIRemover.init({
      sessionId: "s1",
      config: mkConfig(),
      env: {},
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    pii.dispose();
    await expect(pii.mask("anything")).rejects.toThrow(/disposed/);
  });
});

describe("PIIRemover.mask — bypass (ADR-0006)", () => {
  test("PII_REMOVER_BYPASS=1 short-circuits to passthrough", async () => {
    const pii = await PIIRemover.init({
      sessionId: "s1",
      config: mkConfig(),
      env: { PII_REMOVER_BYPASS: "1" },
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const r = await pii.mask("email user@example.com please");
    expect(r.bypassed).toBe(true);
    expect(r.text).toBe("email user@example.com please");
    expect(r.tokens).toEqual([]);
    expect(getBypassCount()).toBeGreaterThanOrEqual(1);
    pii.dispose();
  });

  test("custom bypass env name is honored", async () => {
    const pii = await PIIRemover.init({
      sessionId: "s1",
      config: { ...mkConfig(), bypass_env: "MY_BYPASS" },
      env: { MY_BYPASS: "true" },
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const r = await pii.mask("user@example.com");
    expect(r.bypassed).toBe(true);
    pii.dispose();
  });
});

describe("PIIRemover.mask — failure_policy (ADR-0006)", () => {
  function failingBackend(): BackendClient {
    return {
      name: "always-fails",
      trust_tier: "local",
      async detect(_t: string, _o: DetectOpts): Promise<DetectionResult> {
        throw new Error("backend down");
      },
      async healthCheck(): Promise<BackendHealth> {
        return { ok: false, latency_ms: 0 };
      },
    };
  }

  test("closed policy throws FailClosedError on failure", async () => {
    const pii = await PIIRemover.init({
      sessionId: "s1",
      config: mkConfig({ failure_policy: "closed" }),
      env: {},
      warn: silentWarn(),
      strategy: new SingleStrategy(failingBackend()),
    });
    await expect(pii.mask("user@example.com")).rejects.toThrow(FailClosedError);
    pii.dispose();
  });

  test("hybrid policy falls back to local regex on failure", async () => {
    const pii = await PIIRemover.init({
      sessionId: "s1",
      config: mkConfig({ failure_policy: "hybrid" }),
      env: {},
      warn: silentWarn(),
      strategy: new SingleStrategy(failingBackend()),
    });
    const r = await pii.mask("contact user@example.com please");
    expect(r.bypassed).toBe(false);
    expect(r.text).toContain("__OPF_EMAIL_1__");
    pii.dispose();
  });

  test("open policy passes through original text on failure", async () => {
    const pii = await PIIRemover.init({
      sessionId: "s1",
      config: mkConfig({ failure_policy: "open" }),
      env: {},
      warn: silentWarn(),
      strategy: new SingleStrategy(failingBackend()),
    });
    const r = await pii.mask("user@example.com");
    expect(r.text).toBe("user@example.com");
    expect(r.tokens).toEqual([]);
    pii.dispose();
  });
});

describe("PIIRemover.mask — multi-backend merge", () => {
  function fakeRemote(detections: Detection[]): BackendClient {
    return {
      name: "remote",
      trust_tier: "self_hosted",
      async detect(_t: string, _o: DetectOpts): Promise<DetectionResult> {
        return {
          detections: [...detections],
          backend_name: "remote",
          latency_ms: 0,
        };
      },
      async healthCheck(): Promise<BackendHealth> {
        return { ok: true, latency_ms: 0 };
      },
    };
  }

  test("merges local regex + remote backend results", async () => {
    const remote = fakeRemote([
      {
        start: 0,
        end: 5,
        category: "private_person" as PIICategory,
        confidence: 0.9,
        text: "Alice",
      },
    ]);
    const pii = await PIIRemover.init({
      sessionId: "s1",
      config: mkConfig(),
      env: {},
      warn: silentWarn(),
      backends: [new LocalRegexBackend(), remote],
    });
    const r = await pii.mask("Alice wrote user@example.com");
    const cats = r.tokens.map((t) => t.category).sort();
    expect(cats).toEqual(["private_email", "private_person"]);
    pii.dispose();
  });
});

describe("PIIRemover.mask — critical backend down + failure_policy (regression)", () => {
  function criticalRemoteDown(): BackendClient {
    return {
      name: "opf-http(simulated-docker)",
      trust_tier: "local",
      critical: true,
      async detect(): Promise<DetectionResult> {
        throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:8000");
      },
      async healthCheck(): Promise<BackendHealth> {
        return { ok: false, latency_ms: 0 };
      },
    };
  }

  test("Docker down + failure_policy=closed: throws FailClosedError (no silent local-only fallback)", async () => {
    const pii = await PIIRemover.init({
      sessionId: "s1",
      config: mkConfig({ failure_policy: "closed" }),
      env: {},
      warn: silentWarn(),
      backends: [new LocalRegexBackend(), criticalRemoteDown()],
    });
    await expect(
      pii.mask("Alice wrote user@example.com from 1600 Amphitheatre Pkwy")
    ).rejects.toThrow(FailClosedError);
    pii.dispose();
  });

  test("Docker down + failure_policy=hybrid: falls back to local-regex (hybrid contract)", async () => {
    const pii = await PIIRemover.init({
      sessionId: "s1",
      config: mkConfig({ failure_policy: "hybrid" }),
      env: {},
      warn: silentWarn(),
      backends: [new LocalRegexBackend(), criticalRemoteDown()],
    });
    const r = await pii.mask("contact user@example.com please");
    expect(r.bypassed).toBe(false);
    expect(r.text).toContain("__OPF_EMAIL_1__");
    pii.dispose();
  });

  test("Docker down + failure_policy=open: passes through (open contract)", async () => {
    const pii = await PIIRemover.init({
      sessionId: "s1",
      config: mkConfig({ failure_policy: "open" }),
      env: {},
      warn: silentWarn(),
      backends: [new LocalRegexBackend(), criticalRemoteDown()],
    });
    const r = await pii.mask("user@example.com");
    expect(r.text).toBe("user@example.com");
    expect(r.tokens).toEqual([]);
    pii.dispose();
  });
});

describe("PIIRemover.restore — round trip (Phase 2)", () => {
  test("mask → restore round-trip preserves the original text", async () => {
    const pii = await PIIRemover.init({
      sessionId: "rt-s1",
      config: mkConfig(),
      env: {},
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const original = "Contact alice@example.com or visit https://example.com";
    const masked = await pii.mask(original);
    expect(masked.text).not.toBe(original);
    expect(masked.text).toContain("__OPF_EMAIL_1__");
    expect(masked.text).toContain("__OPF_URL_1__");

    const restored = pii.restore(masked.text);
    expect(restored.text).toBe(original);
    expect(restored.restoredCount).toBe(2);
    expect(restored.unknownTokenCount).toBe(0);
    expect(restored.partialMatchCount).toBe(0);
    pii.dispose();
  });

  test("LLM-style case-folding (lowercase) still restores", async () => {
    const pii = await PIIRemover.init({
      sessionId: "rt-s2",
      config: mkConfig(),
      env: {},
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    await pii.mask("contact alice@example.com today");
    const restored = pii.restore("see __opf_email_1__ tomorrow");
    expect(restored.text).toBe("see alice@example.com tomorrow");
    expect(restored.restoredCount).toBe(1);
    expect(restored.partialMatchCount).toBeGreaterThan(0);
    pii.dispose();
  });

  test("LLM-style suffix-missing token still restores", async () => {
    const pii = await PIIRemover.init({
      sessionId: "rt-s3",
      config: mkConfig(),
      env: {},
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    await pii.mask("contact alice@example.com today");
    const restored = pii.restore("see __OPF_EMAIL_1 tomorrow");
    expect(restored.text).toBe("see alice@example.com tomorrow");
    expect(restored.restoredCount).toBe(1);
    expect(restored.partialMatchCount).toBe(1);
    pii.dispose();
  });

  test("hallucinated token preserves original + bumps unknownTokenCount", async () => {
    const pii = await PIIRemover.init({
      sessionId: "rt-s4",
      config: mkConfig(),
      env: {},
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const restored = pii.restore("see __OPF_FAKE_99__ here");
    expect(restored.text).toBe("see __OPF_FAKE_99__ here");
    expect(restored.restoredCount).toBe(0);
    expect(restored.unknownTokenCount).toBe(1);
    pii.dispose();
  });

  test("two consecutive tokens both round-trip", async () => {
    const pii = await PIIRemover.init({
      sessionId: "rt-s5",
      config: mkConfig(),
      env: {},
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const original = "email alice@example.com and bob@example.com";
    const masked = await pii.mask(original);
    const restored = pii.restore(masked.text);
    expect(restored.text).toBe(original);
    expect(restored.restoredCount).toBe(2);
    pii.dispose();
  });

  test("dedup: same PII restored consistently across multiple mask calls", async () => {
    const pii = await PIIRemover.init({
      sessionId: "rt-s6",
      config: mkConfig(),
      env: {},
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const m1 = await pii.mask("first ping alice@example.com");
    const m2 = await pii.mask("second ping alice@example.com");
    const r1 = pii.restore(m1.text);
    const r2 = pii.restore(m2.text);
    expect(r1.text).toBe("first ping alice@example.com");
    expect(r2.text).toBe("second ping alice@example.com");
    pii.dispose();
  });

  test("text without tokens is returned unchanged", async () => {
    const pii = await PIIRemover.init({
      sessionId: "rt-s7",
      config: mkConfig(),
      env: {},
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const restored = pii.restore("nothing to restore here");
    expect(restored.text).toBe("nothing to restore here");
    expect(restored.matches).toEqual([]);
    pii.dispose();
  });

  test("empty string yields empty result", async () => {
    const pii = await PIIRemover.init({
      sessionId: "rt-s8",
      config: mkConfig(),
      env: {},
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    const restored = pii.restore("");
    expect(restored.text).toBe("");
    expect(restored.restoredCount).toBe(0);
    pii.dispose();
  });

  test("restore() after dispose throws", async () => {
    const pii = await PIIRemover.init({
      sessionId: "rt-s9",
      config: mkConfig(),
      env: {},
      warn: silentWarn(),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    pii.dispose();
    expect(() => pii.restore("__OPF_EMAIL_1__")).toThrow(/disposed/);
  });

  test("session isolation: session A's tokens are unknown in session B", async () => {
    const strategy = new SingleStrategy(new LocalRegexBackend());
    const a = await PIIRemover.init({
      sessionId: "iso-A",
      config: mkConfig(),
      env: {},
      warn: silentWarn(),
      strategy,
    });
    const b = await PIIRemover.init({
      sessionId: "iso-B",
      config: mkConfig(),
      env: {},
      warn: silentWarn(),
      strategy,
    });
    const ma = await a.mask("Alice's email alice@example.com");
    const rb = b.restore(ma.text);
    expect(rb.text).toBe(ma.text);
    expect(rb.unknownTokenCount).toBe(1);
    a.dispose();
    b.dispose();
  });

  test("warn callback from init is wired into restore by default", async () => {
    const captured: string[] = [];
    const pii = await PIIRemover.init({
      sessionId: "warn-s",
      config: mkConfig(),
      env: {},
      warn: (m) => captured.push(m),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    pii.restore("__OPF_FAKE_99__ hello");
    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured.some((m) => /hallucinated/.test(m))).toBe(true);
    pii.dispose();
  });

  test("per-call warn callback overrides the init default", async () => {
    const initCaptured: string[] = [];
    const callCaptured: string[] = [];
    const pii = await PIIRemover.init({
      sessionId: "warn-override",
      config: mkConfig(),
      env: {},
      warn: (m) => initCaptured.push(m),
      strategy: new SingleStrategy(new LocalRegexBackend()),
    });
    pii.restore("__OPF_FAKE_1__", { warn: (m) => callCaptured.push(m) });
    expect(initCaptured).toEqual([]);
    expect(callCaptured.length).toBeGreaterThanOrEqual(1);
    pii.dispose();
  });
});
