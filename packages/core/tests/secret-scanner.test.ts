import { describe, expect, test } from "bun:test";
import { findSecrets } from "../src/detector/secret-scanner.js";

function texts(detections: { text: string }[]): string[] {
  return detections.map((d) => d.text);
}

describe("findSecrets — provider-prefix patterns", () => {
  const cases: Array<[string, string]> = [
    [
      "huggingface",
      "token hf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here",
    ],
    ["vercel", "VERCEL_TOKEN=vcp_aB3dE6gH9jK2mN5pQ8sT next"],
    [
      "notion",
      "key ntn_11111111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcd done",
    ],
    [
      "linear",
      "lin_api_aB3dE6gH9jK2mN5pQ8sT1vW4xY7zA0bC3dE6gH9j x",
    ],
    ["npm-granular", "npm_abcdefghijklmnopqrstuvwxyz0123456789 ok"],
    [
      "cloudflare",
      "cfk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaadeadbeef y",
    ],
    ["stripe-test", "key sk_test_aB3dE6gH9jK2mN5pQ8sT1vW done"],
    ["stripe-prod", "key rk_prod_aB3dE6gH9jK2mN5pQ8sT1vW done"],
  ];

  for (const [name, input] of cases) {
    test(`detects ${name} key`, () => {
      const found = findSecrets(input).filter(
        (d) => d.category === "secret"
      );
      expect(found.length).toBeGreaterThanOrEqual(1);
    });
  }

  test("detects openai project key via existing sk- pattern", () => {
    const found = findSecrets(
      "OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij here"
    );
    expect(found.some((d) => d.category === "secret")).toBe(true);
  });
});

describe("findSecrets — Bearer tokens (default-on, entropy gate)", () => {
  test("masks high-entropy Bearer token", () => {
    const token = "aB3dE6gH9jK2mN5pQ8sT1vW4xY7zA0bC";
    const found = findSecrets(`Authorization: Bearer ${token}`);
    expect(texts(found)).toContain(token);
  });

  test("masks high-entropy hex Bearer token (>=32 hex)", () => {
    const token = "0123456789abcdef0123456789abcdef0123";
    const found = findSecrets(`bearer ${token}`);
    expect(texts(found)).toContain(token);
  });

  test("does NOT mask low-entropy / short Bearer value", () => {
    const found = findSecrets("Bearer tokenhere");
    expect(found.length).toBe(0);
  });

  test("does NOT mask placeholder Bearer value", () => {
    const found = findSecrets("Authorization: Bearer your-key-here");
    expect(found.length).toBe(0);
  });

  test("does NOT mask Bearer of an OPF token", () => {
    const found = findSecrets("Bearer __OPF_SECRET_1__");
    expect(found.length).toBe(0);
  });
});

describe("findSecrets — generic key=value (opt-in)", () => {
  const highEntropy = "aB3dE6gH9jK2mN5pQ8sT1vW4xY7z";

  test("does NOT detect generic key=value by default", () => {
    const found = findSecrets(`api_key = "${highEntropy}"`);
    expect(found.length).toBe(0);
  });

  test("detects generic api_key=value when generic enabled", () => {
    const found = findSecrets(`api_key = "${highEntropy}"`, {
      generic: true,
    });
    expect(texts(found)).toContain(highEntropy);
  });

  test("detects client_secret=value when generic enabled", () => {
    const found = findSecrets(`client_secret=${highEntropy}`, {
      generic: true,
    });
    expect(texts(found)).toContain(highEntropy);
  });

  test("does NOT detect password= even when generic enabled", () => {
    const found = findSecrets('password = "I forgot my password again"', {
      generic: true,
    });
    expect(found.length).toBe(0);
  });

  test("does NOT mask low-entropy generic value", () => {
    const found = findSecrets("access_token = nextPageToken", {
      generic: true,
    });
    expect(found.length).toBe(0);
  });

  test("does NOT mask placeholder generic value", () => {
    const found = findSecrets('api_key = "your-key-here-changeme"', {
      generic: true,
    });
    expect(found.length).toBe(0);
  });
});
