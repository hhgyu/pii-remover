import { describe, expect, test } from "bun:test";
import { PersonalDataBackend } from "../src/backend/personal-data.js";
import { PIIRemover } from "../src/pii-remover.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import type { PersonalDataEntry, PiiRemoverConfig } from "../src/config/schema.js";

const opts = { request_id: "test" };

function backend(entries: readonly PersonalDataEntry[]): PersonalDataBackend {
  return new PersonalDataBackend(entries);
}

describe("PersonalDataBackend - literal match", () => {
  test("matches a simple English value with default options (word_boundary on, case_insensitive)", async () => {
    const b = backend([{ value: "Phoenix", category: "secret" }]);
    const r = await b.detect("Project Phoenix is launching", opts);
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.start).toBe(8);
    expect(r.detections[0]!.end).toBe(15);
    expect(r.detections[0]!.category).toBe("secret");
    expect(r.detections[0]!.text).toBe("Phoenix");
  });

  test("matches multiple occurrences in the same text", async () => {
    const b = backend([{ value: "Phoenix", category: "secret" }]);
    const r = await b.detect("Phoenix is Phoenix is Phoenix", opts);
    expect(r.detections).toHaveLength(3);
  });

  test("returns empty detections when value is not present", async () => {
    const b = backend([{ value: "Phoenix", category: "secret" }]);
    const r = await b.detect("hello world", opts);
    expect(r.detections).toHaveLength(0);
  });

  test("matches a Korean value with default options", async () => {
    const b = backend([{ value: "김민재", category: "private_person" }]);
    const r = await b.detect("저자는 김민재입니다", opts);
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.text).toBe("김민재");
    expect(r.detections[0]!.category).toBe("private_person");
  });

  test("backend_name reports 'personal-data'", async () => {
    const b = backend([{ value: "x", category: "secret" }]);
    const r = await b.detect("nothing", opts);
    expect(r.backend_name).toBe("personal-data");
  });
});

describe("PersonalDataBackend - word_boundary", () => {
  test("word_boundary=true (default) does NOT match within a larger English word", async () => {
    const b = backend([{ value: "key", category: "secret" }]);
    const r = await b.detect("monkey business", opts);
    expect(r.detections).toHaveLength(0);
  });

  test("word_boundary=false matches substrings inside words", async () => {
    const b = backend([
      { value: "key", category: "secret", word_boundary: false },
    ]);
    const r = await b.detect("monkey business", opts);
    expect(r.detections.length).toBeGreaterThanOrEqual(1);
    expect(r.detections[0]!.text).toBe("key");
  });

  test("word_boundary=true does NOT match within a larger Hangul block (Korean explicit override)", async () => {
    const b = backend([
      { value: "민재", category: "private_person", word_boundary: true },
    ]);
    const r = await b.detect("김민재님이 오셨다", opts);
    expect(r.detections).toHaveLength(0);
  });

  test("Korean values default to word_boundary=false (matches inside Hangul context)", async () => {
    const b = backend([{ value: "민재", category: "private_person" }]);
    const r = await b.detect("김민재님이 오셨다", opts);
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.text).toBe("민재");
  });

  test("English values default to word_boundary=true", async () => {
    const b = backend([{ value: "key", category: "secret" }]);
    const r = await b.detect("monkey business", opts);
    expect(r.detections).toHaveLength(0);
  });

  test("word_boundary=false matches inside a Hangul block", async () => {
    const b = backend([
      { value: "민재", category: "private_person", word_boundary: false },
    ]);
    const r = await b.detect("김민재님이 오셨다", opts);
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.text).toBe("민재");
  });

  test("word_boundary respects non-word punctuation as boundary", async () => {
    const b = backend([{ value: "MAGI", category: "secret" }]);
    const r = await b.detect("[MAGI] system, MAGI-Core, foo-MAGI-bar", opts);
    expect(r.detections.length).toBe(3);
  });
});

describe("PersonalDataBackend - case_sensitive", () => {
  test("case_sensitive=false (default) matches regardless of case", async () => {
    const b = backend([{ value: "Phoenix", category: "secret" }]);
    const r = await b.detect("PHOENIX rises, phoenix falls", opts);
    expect(r.detections).toHaveLength(2);
  });

  test("case_sensitive=true matches only exact case", async () => {
    const b = backend([
      { value: "Phoenix", category: "secret", case_sensitive: true },
    ]);
    const r = await b.detect("PHOENIX rises, Phoenix exists", opts);
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.text).toBe("Phoenix");
  });
});

describe("PersonalDataBackend - dedup & validation", () => {
  test("dedups identical entries (same value/category/options)", () => {
    const b = backend([
      { value: "Phoenix", category: "secret" },
      { value: "Phoenix", category: "secret" },
      { value: "phoenix", category: "secret" },
    ]);
    expect(b.size()).toBe(1);
  });

  test("keeps entries that differ in category", () => {
    const b = backend([
      { value: "Acme", category: "secret" },
      { value: "Acme", category: "private_person" },
    ]);
    expect(b.size()).toBe(2);
  });

  test("keeps entries that differ in case_sensitive", () => {
    const b = backend([
      { value: "Acme", category: "secret", case_sensitive: true },
      { value: "Acme", category: "secret", case_sensitive: false },
    ]);
    expect(b.size()).toBe(2);
  });

  test("throws on empty value (fail-closed)", () => {
    expect(() => backend([{ value: "", category: "secret" }])).toThrow(/non-empty/);
    expect(() => backend([{ value: "   ", category: "secret" }])).toThrow(/non-empty/);
  });

  test("throws on unknown category (fail-closed)", () => {
    expect(() =>
      backend([{ value: "x", category: "not_a_category" as never }]),
    ).toThrow(/PIICategory/);
  });
});

describe("PersonalDataBackend - integration via PIIRemover", () => {
  function localOnlyConfigWithEntries(
    entries: readonly PersonalDataEntry[],
  ): PiiRemoverConfig {
    return {
      ...DEFAULT_CONFIG,
      backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
      personal_data: { enabled: true, entries },
    };
  }

  test("PIIRemover.mask uses personal data entries alongside LocalRegexBackend", async () => {
    const pii = await PIIRemover.init({
      config: localOnlyConfigWithEntries([
        { value: "Project-Phoenix", category: "secret" },
      ]),
      warn: () => {},
    });
    const r = await pii.mask("Project-Phoenix delayed, contact user@example.com");
    expect(r.text).toMatch(/__OPF_SECRET_\d+__/);
    expect(r.text).toMatch(/__OPF_EMAIL_\d+__/);
    expect(r.tokens.find((t) => t.category === "secret")?.text).toBe(
      "Project-Phoenix",
    );
    pii.dispose();
  });

  test("personal data masking dedupes the same value across calls in one vault", async () => {
    const pii = await PIIRemover.init({
      config: localOnlyConfigWithEntries([
        { value: "MAGI-Core", category: "secret" },
      ]),
      warn: () => {},
    });
    const r1 = await pii.mask("MAGI-Core is offline");
    const r2 = await pii.mask("Restart MAGI-Core now");
    const tok1 = r1.tokens.find((t) => t.text === "MAGI-Core")?.token;
    const tok2 = r2.tokens.find((t) => t.text === "MAGI-Core")?.token;
    expect(tok1).toBeDefined();
    expect(tok2).toBe(tok1);
    pii.dispose();
  });

  test("personal_data.enabled=false disables the backend entirely", async () => {
    const pii = await PIIRemover.init({
      config: {
        ...DEFAULT_CONFIG,
        backend: { ...DEFAULT_CONFIG.backend, endpoint: "" },
        personal_data: {
          enabled: false,
          entries: [{ value: "Phoenix", category: "secret" }],
        },
      },
      warn: () => {},
    });
    const r = await pii.mask("Phoenix project is secret");
    expect(r.tokens.find((t) => t.text === "Phoenix")).toBeUndefined();
    pii.dispose();
  });

  test("personal data round-trip via restore", async () => {
    const pii = await PIIRemover.init({
      config: localOnlyConfigWithEntries([
        { value: "위석호", category: "private_person" },
      ]),
      warn: () => {},
    });
    const masked = await pii.mask("저자 위석호가 작성");
    expect(masked.text).toMatch(/__OPF_PERSON_\d+__/);
    const restored = pii.restore(masked.text);
    expect(restored.text).toBe("저자 위석호가 작성");
    pii.dispose();
  });

  test("longer-span priority: personal data span subsumes shorter Korean heuristic match", async () => {
    const pii = await PIIRemover.init({
      config: localOnlyConfigWithEntries([
        { value: "김민재컴퍼니", category: "secret", word_boundary: false },
      ]),
      warn: () => {},
    });
    const r = await pii.mask("그 회사는 김민재컴퍼니 입니다");
    const secretTok = r.tokens.find((t) => t.category === "secret");
    expect(secretTok?.text).toBe("김민재컴퍼니");
    pii.dispose();
  });
});
