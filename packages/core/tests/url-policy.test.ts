import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPrivateUrl } from "../src/detector/url-policy.js";
import { LocalRegexBackend } from "../src/backend/local-regex.js";

/**
 * Shared with `packages/backend/tests/test_url_policy.py`. The fixture is the
 * only mechanical guard against the TS and Python URL policies drifting, so new
 * cases belong there rather than inline here.
 */
const FIXTURE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "url-policy.json",
);

interface Case {
  readonly name: string;
  readonly url: string;
  readonly private: boolean;
  readonly extra_private_suffixes?: readonly string[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as {
  cases: Case[];
  strict_policy_cases: Case[];
  extra_private_suffix_cases: Case[];
};

const KORAIL_REPO_URLS = [
  "https://github.com/GeunSam2/korail_KTX_macro_telegrambot",
  "https://github.com/yakisoba0728/korail-mobile-api",
  "https://github.com/ukkidokiyo/korail2",
  "https://github.com/hostkimjang/korail-auto-waitlist",
];

const opts = { request_id: "test" };

describe("isPrivateUrl", () => {
  for (const c of fixture.cases) {
    test(c.name, () => {
      expect(isPrivateUrl(c.url)).toBe(c.private);
    });
  }

  for (const c of fixture.strict_policy_cases) {
    test(`strict: ${c.name}`, () => {
      expect(isPrivateUrl(c.url, { policy: "strict" })).toBe(c.private);
    });
  }

  for (const c of fixture.extra_private_suffix_cases) {
    test(`extra suffixes: ${c.name}`, () => {
      expect(
        isPrivateUrl(c.url, {
          extraPrivateSuffixes: c.extra_private_suffixes ?? [],
        }),
      ).toBe(c.private);
    });
  }
});

describe("LocalRegexBackend private_url gating", () => {
  test("public repo URLs produce no detection", async () => {
    const backend = new LocalRegexBackend();
    const result = await backend.detect(KORAIL_REPO_URLS.join("\n"), opts);
    expect(result.detections).toEqual([]);
  });

  test("a credential-bearing URL is still detected", async () => {
    const backend = new LocalRegexBackend();
    const text = "see https://example.com/export?token=abc123 for the dump";
    const result = await backend.detect(text, opts);
    const urls = result.detections.filter((d) => d.category === "private_url");
    expect(urls).toHaveLength(1);
    expect(urls[0]?.text).toBe("https://example.com/export?token=abc123");
  });

  test("an internal host is still detected", async () => {
    const backend = new LocalRegexBackend();
    const result = await backend.detect(
      "runbook at https://wiki.acme.internal/runbooks",
      opts,
    );
    const urls = result.detections.filter((d) => d.category === "private_url");
    expect(urls).toHaveLength(1);
  });

  test("strict policy restores mask-every-URL behaviour", async () => {
    const backend = new LocalRegexBackend({ url_policy: "strict" });
    const result = await backend.detect(KORAIL_REPO_URLS[0] ?? "", opts);
    expect(
      result.detections.filter((d) => d.category === "private_url"),
    ).toHaveLength(1);
  });

  test("private_url_hosts extends the denylist", async () => {
    const backend = new LocalRegexBackend({ private_url_hosts: ["acme.com"] });
    const result = await backend.detect(
      "https://admin.acme.com/users/1 and https://github.com/acme/repo",
      opts,
    );
    const urls = result.detections.filter((d) => d.category === "private_url");
    expect(urls).toHaveLength(1);
    expect(urls[0]?.text).toBe("https://admin.acme.com/users/1");
  });
});
