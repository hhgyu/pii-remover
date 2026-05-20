import { describe, expect, test } from "bun:test";
import {
  TieredStrategy,
  redactSpans,
} from "../src/backend/tiered-strategy.js";
import { LocalRegexBackend } from "../src/backend/local-regex.js";
import type { BackendClient, BackendHealth } from "../src/backend/client.js";
import type {
  Detection,
  DetectOpts,
  DetectionResult,
  PIICategory,
} from "../src/types.js";

const baseOpts: DetectOpts = { request_id: "tiered-test" };

interface MockRemote {
  backend: BackendClient;
  capturedText: string[];
  capturedOpts: DetectOpts[];
}

function mockRemoteBackend(args: {
  detections?: Detection[] | ((text: string) => Detection[]);
  fail?: boolean;
  name?: string;
}): MockRemote {
  const captured: string[] = [];
  const capturedOpts: DetectOpts[] = [];
  const backend: BackendClient = {
    name: args.name ?? "mock-remote",
    trust_tier: "self_hosted",
    async detect(text: string, opts: DetectOpts): Promise<DetectionResult> {
      captured.push(text);
      capturedOpts.push(opts);
      if (args.fail) throw new Error(`${this.name} backend down`);
      const det =
        typeof args.detections === "function"
          ? args.detections(text)
          : (args.detections ?? []);
      return {
        detections: det,
        backend_name: this.name,
        latency_ms: 0,
      };
    },
    async healthCheck(): Promise<BackendHealth> {
      return { ok: !args.fail, latency_ms: 0 };
    },
  };
  return { backend, capturedText: captured, capturedOpts };
}

function failingLocal(): BackendClient {
  return {
    name: "fail-local",
    trust_tier: "local",
    async detect(): Promise<DetectionResult> {
      throw new Error("local exploded");
    },
    async healthCheck(): Promise<BackendHealth> {
      return { ok: false, latency_ms: 0 };
    },
  };
}

function det(
  start: number,
  end: number,
  category: PIICategory,
  text: string,
  confidence = 0.9
): Detection {
  return { start, end, category, confidence, text };
}

describe("redactSpans", () => {
  test("replaces single span with placeholder × length (offset preserved)", () => {
    const text = "hello user@example.com world";
    const out = redactSpans(
      text,
      [det(6, 22, "private_email", "user@example.com")],
      "\u00B7"
    );
    expect(out.length).toBe(text.length);
    expect(out.slice(6, 22)).toBe("\u00B7".repeat(16));
    expect(out.slice(0, 6)).toBe("hello ");
    expect(out.slice(22)).toBe(" world");
    expect(out).not.toContain("user@example.com");
  });

  test("replaces multiple non-overlapping spans", () => {
    const text = "RRN 920101-1234562 phone 010-1234-5678 done";
    const out = redactSpans(
      text,
      [
        det(4, 18, "rrn", "920101-1234562"),
        det(25, 38, "private_phone", "010-1234-5678"),
      ],
      "\u00B7"
    );
    expect(out.length).toBe(text.length);
    expect(out).not.toContain("920101-1234562");
    expect(out).not.toContain("010-1234-5678");
  });

  test("returns input unchanged when detections empty", () => {
    const text = "no PII here";
    expect(redactSpans(text, [], "\u00B7")).toBe(text);
  });

  test("rejects multi-char replacement (offset preservation contract)", () => {
    expect(() =>
      redactSpans("hello", [det(0, 5, "private_email", "hello")], "XX")
    ).toThrow(/single code unit/);
  });

  test("handles overlapping detections via mergeDetections (longer wins)", () => {
    const text = "abcdefghij";
    const out = redactSpans(
      text,
      [
        det(0, 3, "private_person", "abc"),
        det(2, 7, "private_email", "cdefg"),
      ],
      "*"
    );
    expect(out.length).toBe(text.length);
    expect(out.slice(2, 7)).toBe("*****");
    expect(out.slice(0, 2)).toBe("ab");
  });
});

describe("TieredStrategy — local-only and remote-only", () => {
  test("returns local detections when remote returns empty", async () => {
    const local = new LocalRegexBackend();
    const remote = mockRemoteBackend({ detections: [] });
    const s = new TieredStrategy({ local, remote: remote.backend });
    const r = await s.resolve("contact user@example.com", baseOpts);
    const cats = r.detections.map((d) => d.category);
    expect(cats).toContain("private_email");
    expect(r.backend_name).toContain("local=");
    expect(r.backend_name).toContain("remote=");
  });

  test("merges local + remote detections", async () => {
    const local = new LocalRegexBackend();
    const remote = mockRemoteBackend({
      detections: () => [
        {
          start: 0,
          end: 5,
          category: "private_person",
          confidence: 0.9,
          text: "Alice",
        },
      ],
    });
    const s = new TieredStrategy({ local, remote: remote.backend });
    const r = await s.resolve("Alice wrote user@example.com", baseOpts);
    const cats = r.detections.map((d) => d.category).sort();
    expect(cats).toContain("private_email");
    expect(cats).toContain("private_person");
  });
});

describe("TieredStrategy — SECURITY: Korean PII never leaks to remote", () => {
  test("redacts RRN/BizNum/Card/Phone/Email before remote call (packet-capture proxy)", async () => {
    const local = new LocalRegexBackend();
    const remote = mockRemoteBackend({ detections: [] });
    const s = new TieredStrategy({ local, remote: remote.backend });
    const input =
      "주민 920101-1234562 사업자 123-45-67891 카드 4242 4242 4242 4242 전화 010-1234-5678 이메일 user@example.com 일반 문장";
    await s.resolve(input, baseOpts);
    expect(remote.capturedText).toHaveLength(1);
    const sent = remote.capturedText[0]!;
    expect(sent.length).toBe(input.length);
    expect(sent).not.toContain("920101-1234562");
    expect(sent).not.toContain("123-45-67891");
    expect(sent).not.toContain("4242 4242 4242 4242");
    expect(sent).not.toContain("010-1234-5678");
    expect(sent).not.toContain("user@example.com");
    expect(sent).toContain("\u00B7");
    expect(sent).toContain("주민");
    expect(sent).toContain("카드");
    expect(sent).toContain("이메일");
  });

  test("redacts Korean person name via local heuristic before remote call", async () => {
    const local = new LocalRegexBackend();
    const remote = mockRemoteBackend({ detections: [] });
    const s = new TieredStrategy({ local, remote: remote.backend });
    const input = "저자는 김철수이고 박영희가 작성했습니다";
    await s.resolve(input, baseOpts);
    const sent = remote.capturedText[0]!;
    expect(sent).not.toContain("김철수");
    expect(sent).not.toContain("박영희");
    expect(sent.length).toBe(input.length);
  });

  test("placeholder fills are exactly span length (offset preservation)", async () => {
    const local = new LocalRegexBackend();
    const remote = mockRemoteBackend({ detections: [] });
    const s = new TieredStrategy({ local, remote: remote.backend });
    const input = "card 4242 4242 4242 4242 done";
    await s.resolve(input, baseOpts);
    const sent = remote.capturedText[0]!;
    expect(sent.length).toBe(input.length);
    expect(sent.slice(0, 5)).toBe("card ");
    expect(sent.slice(24)).toBe(" done");
  });
});

describe("TieredStrategy — failure handling", () => {
  test("local fails (skip_remote default): returns empty, warns, does NOT call remote", async () => {
    const warns: string[] = [];
    const remote = mockRemoteBackend({ detections: [] });
    const s = new TieredStrategy({
      local: failingLocal(),
      remote: remote.backend,
      warn: (m) => warns.push(m),
    });
    const r = await s.resolve("주민 920101-1234562", baseOpts);
    expect(r.detections).toEqual([]);
    expect(remote.capturedText).toHaveLength(0);
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns.join("\n")).toMatch(/local backend.*failed/i);
    expect(r.backend_name).toContain("FAILED");
    expect(r.backend_name).toContain("SKIPPED");
  });

  test("local fails (throw policy): raises AggregateError", async () => {
    const remote = mockRemoteBackend({ detections: [] });
    const s = new TieredStrategy({
      local: failingLocal(),
      remote: remote.backend,
      on_local_failure: "throw",
      warn: () => {},
    });
    await expect(s.resolve("주민 920101-1234562", baseOpts)).rejects.toBeInstanceOf(
      AggregateError
    );
    expect(remote.capturedText).toHaveLength(0);
  });

  test("remote (non-critical) fails after local succeeds: keeps local-only result + warns", async () => {
    const warns: string[] = [];
    const local = new LocalRegexBackend();
    const remote = mockRemoteBackend({ fail: true });
    const s = new TieredStrategy({
      local,
      remote: remote.backend,
      warn: (m) => warns.push(m),
    });
    const r = await s.resolve("contact user@example.com", baseOpts);
    const cats = r.detections.map((d) => d.category);
    expect(cats).toContain("private_email");
    expect(warns.join("\n")).toMatch(/remote backend.*failed/i);
    expect(r.backend_name).toContain("FAILED");
  });

  test("remote (critical) fails after local succeeds: throws AggregateError — fail-closed", async () => {
    const local = new LocalRegexBackend();
    const remoteCritical: BackendClient = {
      name: "critical-remote",
      trust_tier: "self_hosted",
      critical: true,
      async detect() {
        throw new Error("docker down");
      },
      async healthCheck() {
        return { ok: false, latency_ms: 0 };
      },
    };
    const s = new TieredStrategy({
      local,
      remote: remoteCritical,
      warn: () => {},
    });
    await expect(
      s.resolve("contact user@example.com", baseOpts)
    ).rejects.toBeInstanceOf(AggregateError);
    await expect(
      s.resolve("contact user@example.com", baseOpts)
    ).rejects.toThrow(/critical remote backend.*failed/i);
  });

  test("both fail (with on_local_failure=throw): AggregateError", async () => {
    const s = new TieredStrategy({
      local: failingLocal(),
      remote: mockRemoteBackend({ fail: true }).backend,
      on_local_failure: "throw",
      warn: () => {},
    });
    await expect(s.resolve("anything", baseOpts)).rejects.toBeInstanceOf(AggregateError);
  });
});

describe("TieredStrategy — merge semantics", () => {
  test("longer-span priority on remote+local overlap", async () => {
    const local = new LocalRegexBackend();
    const remote = mockRemoteBackend({
      detections: () => [
        {
          start: 7,
          end: 24,
          category: "secret",
          confidence: 0.99,
          text: " user@example.co",
        },
      ],
    });
    const s = new TieredStrategy({ local, remote: remote.backend });
    const r = await s.resolve("Alice: user@example.com Bob", baseOpts);
    const longest = r.detections.find((d) => d.end - d.start >= 16);
    expect(longest).toBeDefined();
    expect(longest!.category).toBe("secret");
  });
});

describe("TieredStrategy — validation", () => {
  test("rejects missing local backend", () => {
    const remote = mockRemoteBackend({ detections: [] });
    expect(
      () =>
        new TieredStrategy({
          local: null as unknown as BackendClient,
          remote: remote.backend,
        })
    ).toThrow(/local backend is required/);
  });

  test("rejects missing remote backend", () => {
    expect(
      () =>
        new TieredStrategy({
          local: new LocalRegexBackend(),
          remote: null as unknown as BackendClient,
        })
    ).toThrow(/remote backend is required/);
  });

  test("rejects multi-char placeholder (offset corruption)", () => {
    expect(
      () =>
        new TieredStrategy({
          local: new LocalRegexBackend(),
          remote: mockRemoteBackend({ detections: [] }).backend,
          placeholder_char: "XX",
        })
    ).toThrow(/single UTF-16 code unit/);
  });

  test("custom placeholder_char is honored", async () => {
    const local = new LocalRegexBackend();
    const remote = mockRemoteBackend({ detections: [] });
    const s = new TieredStrategy({
      local,
      remote: remote.backend,
      placeholder_char: "X",
    });
    await s.resolve("email user@example.com", baseOpts);
    const sent = remote.capturedText[0]!;
    expect(sent).toContain("XXXX");
    expect(sent).not.toContain("\u00B7");
  });
});
