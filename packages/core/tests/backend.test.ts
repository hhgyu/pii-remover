import { describe, expect, test } from "bun:test";
import { LocalRegexBackend } from "../src/backend/local-regex.js";
import { OpfHttpBackend, type FetchLike } from "../src/backend/opf-http.js";
import type { DetectOpts } from "../src/types.js";

const opts: DetectOpts = { request_id: "test" };

describe("LocalRegexBackend — English-only PII (Phase 1)", () => {
  test("detects RFC-5322-style email", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect("hello user@example.com bye", opts);
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.category).toBe("private_email");
    expect(r.detections[0]!.text).toBe("user@example.com");
  });

  test("detects private http/https URLs and leaves public ones alone", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "see https://example.com/path?q=1 and http://api.test/x",
      opts
    );
    const urls = r.detections.filter((d) => d.category === "private_url");
    expect(urls).toHaveLength(1);
    expect(urls[0]!.text).toBe("http://api.test/x");
  });

  test("detects card number with valid LUHN", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect("paid with 4242 4242 4242 4242 yesterday", opts);
    const cards = r.detections.filter((d) => d.category === "card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toBe("4242 4242 4242 4242");
  });

  test("rejects card with invalid LUHN", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect("try 1234 5678 9012 3456", opts);
    const cards = r.detections.filter((d) => d.category === "card");
    expect(cards).toHaveLength(0);
  });

  test("detects English phone numbers (3-3-4 separator pattern)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect("call (555) 123-4567 or 555-987-6543", opts);
    const phones = r.detections.filter((d) => d.category === "private_phone");
    expect(phones.length).toBeGreaterThanOrEqual(2);
  });

  test("Phase 2: detects valid Korean RRN and BIZNUM (checksum) and KR phone", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "주민 920101-1234562 사업자 123-45-67891 연락처 010-1234-5678",
      opts
    );
    const rrns = r.detections.filter((d) => d.category === "rrn");
    const bizs = r.detections.filter((d) => d.category === "biz_num");
    const krPhones = r.detections.filter(
      (d) => d.category === "private_phone" && d.text.startsWith("010-")
    );
    expect(rrns).toHaveLength(1);
    expect(rrns[0]!.text).toBe("920101-1234562");
    expect(bizs).toHaveLength(1);
    expect(bizs[0]!.text).toBe("123-45-67891");
    expect(krPhones).toHaveLength(1);
    expect(krPhones[0]!.text).toBe("010-1234-5678");
  });

  test("Phase 2: rejects invalid-checksum RRN/BIZNUM in strict mode (default)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "주민 900101-1234567 사업자 123-45-67890",
      opts
    );
    const korean = r.detections.filter(
      (d) => d.category === "rrn" || d.category === "biz_num"
    );
    expect(korean).toHaveLength(0);
  });

  test("Phase 2: detects Korean person names via heuristic, filters stopwords", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect("저자는 김철수이고 박영희가 함께 작성했습니다", opts);
    const persons = r.detections.filter((d) => d.category === "private_person");
    const texts = persons.map((d) => d.text).sort();
    expect(texts).toContain("김철수");
    expect(texts).toContain("박영희");
    expect(texts).not.toContain("함께");
  });

  test("Phase 2: enable_korean_pii=false disables Korean detectors", async () => {
    const b = new LocalRegexBackend({ enable_korean_pii: false });
    const r = await b.detect(
      "김철수 주민 920101-1234562 010-1234-5678",
      opts
    );
    expect(r.detections.filter((d) => d.category === "rrn")).toHaveLength(0);
    expect(
      r.detections.filter((d) => d.category === "private_person")
    ).toHaveLength(0);
    const krPhones = r.detections.filter(
      (d) => d.category === "private_phone" && d.text.startsWith("010-")
    );
    expect(krPhones).toHaveLength(0);
  });

  test("Phase 2: enabled_categories without 'rrn' skips RRN detection", async () => {
    const b = new LocalRegexBackend({
      enabledCategories: ["private_email", "private_phone", "biz_num"],
    });
    const r = await b.detect(
      "주민 920101-1234562 사업자 123-45-67891 전화 010-1234-5678 user@example.com",
      opts
    );
    expect(r.detections.filter((d) => d.category === "rrn")).toHaveLength(0);
    expect(
      r.detections.filter((d) => d.category === "biz_num").length
    ).toBeGreaterThan(0);
    expect(
      r.detections.filter((d) => d.category === "private_email").length
    ).toBeGreaterThan(0);
  });

  test("Phase 2: union of English + Korean PII in mixed text", async () => {
    const b = new LocalRegexBackend();
    const text =
      "Contact 김철수 at user@example.com or 010-1234-5678. RRN: 920101-1234562. Card: 4242 4242 4242 4242.";
    const r = await b.detect(text, opts);
    const cats = new Set(r.detections.map((d) => d.category));
    expect(cats.has("private_email")).toBe(true);
    expect(cats.has("private_phone")).toBe(true);
    expect(cats.has("rrn")).toBe(true);
    expect(cats.has("card")).toBe(true);
    expect(cats.has("private_person")).toBe(true);
    for (const d of r.detections) {
      expect(text.slice(d.start, d.end)).toBe(d.text);
    }
  });

  test("Phase 2: strict_rrn_checksum=false accepts shape-valid RRNs", async () => {
    const b = new LocalRegexBackend({ strict_rrn_checksum: false });
    const r = await b.detect("주민 900101-1234567", opts);
    const rrns = r.detections.filter((d) => d.category === "rrn");
    expect(rrns).toHaveLength(1);
    expect(rrns[0]!.text).toBe("900101-1234567");
  });

  test("secret: detects AWS Access Key (AKIA prefix)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "aws key AKIAIOSFODNN7EXAMPLE is compromised",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(secrets[0]!.confidence).toBe(0.99);
  });

  test("secret: detects AWS Access Key at start of string", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect("AKIAIOSFODNN7EXAMPLE is my key", opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(secrets[0]!.start).toBe(0);
  });

  test("secret: detects Supabase publishable key (sb_publishable_ prefix)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "Publishable | sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toBe(
      "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH"
    );
    expect(secrets[0]!.confidence).toBe(0.99);
  });

  test("secret: detects Supabase secret key (sb_secret_ prefix)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "Secret | sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toBe("sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz");
  });

  test("secret: detects Supabase secret key at start of string", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz leaked",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toBe("sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz");
    expect(secrets[0]!.start).toBe(0);
  });

  test("secret: detects GitHub PAT (ghp_ prefix)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "export GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh123456",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toBe(
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh123456"
    );
  });

  test("secret: detects OpenAI API key (sk- prefix)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toBe(
      "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn"
    );
  });

  test("secret: detects multiple secrets in one text", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "aws=AKIAIOSFODNN7EXAMPLE openai=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn github=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh123456",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(3);
    const texts = secrets.map((d) => d.text);
    expect(texts).toContain("AKIAIOSFODNN7EXAMPLE");
    expect(texts).toContain(
      "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn"
    );
    expect(texts).toContain(
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh123456"
    );
  });

  test("secret: no false positive on short sk- prefix", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect("skip sk-test-short value", opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(0);
  });

  test("secret: no false positive on AKIA without 16 trailing chars", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect("AKIA is a prefix", opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(0);
  });

  test("secret: start/end offsets match text.slice()", async () => {
    const b = new LocalRegexBackend();
    const text = "key is AKIAIOSFODNN7EXAMPLE end";
    const r = await b.detect(text, opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(text.slice(secrets[0]!.start, secrets[0]!.end)).toBe(
      "AKIAIOSFODNN7EXAMPLE"
    );
  });

  test("secret: enabled_categories without 'secret' skips detection", async () => {
    const b = new LocalRegexBackend({
      enabledCategories: ["private_email", "private_phone"],
    });
    const r = await b.detect(
      "key=AKIAIOSFODNN7EXAMPLE user@example.com",
      opts
    );
    expect(r.detections.filter((d) => d.category === "secret")).toHaveLength(0);
    expect(
      r.detections.filter((d) => d.category === "private_email")
    ).toHaveLength(1);
  });

  test("secret: detects PEM private key block", async () => {
    const b = new LocalRegexBackend();
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7DdqN",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const r = await b.detect(`config:\n${pem}\nend`, opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toContain("BEGIN RSA PRIVATE KEY");
    expect(secrets[0]!.text).toContain("END RSA PRIVATE KEY");
  });

  test("secret: detects PEM EC private key block", async () => {
    const b = new LocalRegexBackend();
    const pem = [
      "-----BEGIN EC PRIVATE KEY-----",
      "MHQCAQEEIObR2SmWBEipCyV",
      "-----END EC PRIVATE KEY-----",
    ].join("\n");
    const r = await b.detect(pem, opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
  });

  test("secret: detects multiple PEM private key blocks", async () => {
    const b = new LocalRegexBackend();
    const text = [
      "key1:",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn",
      "-----END RSA PRIVATE KEY-----",
      "key2:",
      "-----BEGIN EC PRIVATE KEY-----",
      "MHQCAQEEIObR2SmWBEipCyV",
      "-----END EC PRIVATE KEY-----",
    ].join("\n");
    const r = await b.detect(text, opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(2);
  });

  test("secret: detects future/unknown PEM private key types", async () => {
    const b = new LocalRegexBackend();
    const pem = [
      "-----BEGIN POST-QUANTUM PRIVATE KEY-----",
      "ABCDEF123456",
      "-----END POST-QUANTUM PRIVATE KEY-----",
    ].join("\n");
    const r = await b.detect(pem, opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toContain("POST-QUANTUM PRIVATE KEY");
  });

  test("secret: detects bare PRIVATE KEY (PKCS#8)", async () => {
    const b = new LocalRegexBackend();
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvgIBADANBgkqhkiG9w0BAQEFAAS",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const r = await b.detect(pem, opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
  });

  test("secret: no false positive on PUBLIC KEY", async () => {
    const b = new LocalRegexBackend();
    const pem = [
      "-----BEGIN PUBLIC KEY-----",
      "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA",
      "-----END PUBLIC KEY-----",
    ].join("\n");
    const r = await b.detect(pem, opts);
    expect(r.detections.filter((d) => d.category === "secret")).toHaveLength(0);
  });

  test("secret: no false positive on CERTIFICATE", async () => {
    const b = new LocalRegexBackend();
    const pem = [
      "-----BEGIN CERTIFICATE-----",
      "MIIDXTCCAkWgAwIBAgIJAKL",
      "-----END CERTIFICATE-----",
    ].join("\n");
    const r = await b.detect(pem, opts);
    expect(r.detections.filter((d) => d.category === "secret")).toHaveLength(0);
  });

  test("secret: detects JWT token", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toContain("eyJ");
  });

  test("secret: detects connection string with password", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "DATABASE_URL=postgres://admin:s3cret@db.example.com:5432/mydb",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toContain("admin:s3cret@");
  });

  test("secret: detects mongodb+srv connection string with password", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "mongodb+srv://user:p@ssw0rd@cluster0.abc.mongodb.net/",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
  });

  test("secret: no false positive on connection string without password", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "DATABASE_URL=postgres://db.example.com:5432/mydb",
      opts
    );
    expect(r.detections.filter((d) => d.category === "secret")).toHaveLength(0);
  });

  test("secret: no false positive on plain https URL", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "visit https://example.com/path?q=test for details",
      opts
    );
    expect(r.detections.filter((d) => d.category === "secret")).toHaveLength(0);
  });

  test("secret: detects npm auth token", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "//registry.npmjs.org/:_authToken=npm_deadbeef12345678",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toContain("_authToken=");
  });

  test("secret: detects npm auth token without registry prefix", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect("_authToken=npm_xAbCdEf1234567890", opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
  });

  test("secret: detects Anthropic API key", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toContain("sk-ant-api03-");
  });

  test("secret: detects Google API key", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "GOOGLE_API_KEY=AIzaSyDaGkFNkZaBrOvJjMhHx5RTZKjDkDkDkDe",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toContain("AIza");
  });

  test("secret: detects Slack bot token", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "SLACK_TOKEN=xoxb-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toContain("xoxb-");
  });

  test("secret: detects Slack app token (xoxa-)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "token=xoxa-123456789012-abcdefghij",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
  });

  test("secret: detects Stripe secret key", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "STRIPE_KEY=sk_live_abcdefghijklmnopqrstuvwxyz",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toContain("sk_live_");
  });

  test("secret: detects Stripe restricted key", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "STRIPE_KEY=rk_live_abcdefghijklmnopqrstuvwxyz",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
  });

  test("secret: detects GitLab personal access token", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toContain("glpat-");
  });

  test("secret: detects Telegram bot token", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "TELEGRAM_BOT_TOKEN=123456789:AAHtG6kFNkZaBrOvJjMhHx5RTZKjDkDkDkD",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^\d{5,10}:/);
  });

  test("secret: detects GitHub fine-grained PAT (github_pat_)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "token=github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^github_pat_[A-Za-z0-9_]{20,}$/);
  });

  test("secret: detects GitHub OAuth token (gho_)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "GITHUB_TOKEN=gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ12",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^gho_[A-Za-z0-9]{20,}$/);
  });

  test("secret: detects GitHub user-to-server token (ghu_)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "token ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 here",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^ghu_[A-Za-z0-9]{20,}$/);
  });

  test("secret: detects GitHub server-to-server token (ghs_)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "token ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 end",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^ghs_[A-Za-z0-9]{20,}$/);
  });

  test("secret: detects GitHub refresh token (ghr_)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "token ghr_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 end",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^ghr_[A-Za-z0-9]{20,}$/);
  });

  test("secret: detects SendGrid API key", async () => {
    const b = new LocalRegexBackend();
    const token = "SG.ABCDEFGHIJKLMNOPQRST22." + "A".repeat(43);
    const r = await b.detect(`SENDGRID_API_KEY=${token}`, opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^SG\./);
  });

  test("secret: detects DigitalOcean token (dop_v1_)", async () => {
    const b = new LocalRegexBackend();
    const token = "dop_v1_" + "a".repeat(64);
    const r = await b.detect(`DO_TOKEN=${token}`, opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^dop_v1_[a-f0-9]{64}$/);
  });

  test("secret: detects Twilio Account SID (AC prefix)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "TWILIO_SID=ACabcdef0123456789abcdef01234567ab",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^AC[a-f0-9]{32}$/);
  });

  test("secret: detects Twilio API Key (SK prefix)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "TWILIO_KEY=SKABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^SK[a-zA-Z0-9]{32}$/);
  });

  test("secret: detects Shopify access token (shpat_)", async () => {
    const b = new LocalRegexBackend();
    const token = "shpat_" + "a".repeat(32);
    const r = await b.detect(`SHOPIFY_TOKEN=${token}`, opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^shpat_[a-f0-9]{32}$/);
  });

  test("secret: detects Shopify secret access token (shpss_)", async () => {
    const b = new LocalRegexBackend();
    const token = "shpss_" + "b".repeat(32);
    const r = await b.detect(`SHOPIFY_SECRET=${token}`, opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^shpss_[a-f0-9]{32}$/);
  });

  test("secret: detects Postman API key (PMAK-)", async () => {
    const b = new LocalRegexBackend();
    const token = "PMAK-" + "A".repeat(59);
    const r = await b.detect(`POSTMAN_KEY=${token}`, opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^PMAK-[A-Za-z0-9-]{59}$/);
  });

  test("secret: detects Discord bot token", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "DISCORD_TOKEN=MTIzNDU2Nzg5MDEyMzQ1Njc4.ABCdef.ABCDEFGHIJKLMNOPQRSTUVWxyza",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^[MNO][A-Za-z\d_-]+\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+$/);
  });

  test("secret: detects Databricks token (dapi prefix)", async () => {
    const b = new LocalRegexBackend();
    const token = "dapi" + "a".repeat(32);
    const r = await b.detect(`DATABRICKS_TOKEN=${token}`, opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^dapi[a-h0-9]{32}$/);
  });

  test("secret: detects PyPI API token", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "PYPI_TOKEN=pypi-AgEIcHlwa2VucyBhbmQgdG9rZW5zIG11c3QgYmUgbG9uZ2VyAAAAAAAA",
      opts
    );
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^pypi-AgEI[A-Za-z0-9_-]{50,}$/);
  });

  test("secret: detects Mailgun API key (key- prefix)", async () => {
    const b = new LocalRegexBackend();
    const token = "key-" + "a".repeat(32);
    const r = await b.detect(`MAILGUN_KEY=${token}`, opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.text).toMatch(/^key-[a-z0-9]{32}$/);
  });

  test("secret: no false positive on short key- prefix", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect("key-abc", opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(0);
  });

  test("secret: no false positive on random AC prefix (too short)", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect("AC1234 short", opts);
    const secrets = r.detections.filter((d) => d.category === "secret");
    expect(secrets).toHaveLength(0);
  });

  test("respects opts.categories filter", async () => {
    const b = new LocalRegexBackend();
    const r = await b.detect(
      "contact user@example.com or visit https://example.com",
      { request_id: "test", categories: ["private_email"] }
    );
    expect(r.detections.every((d) => d.category === "private_email")).toBe(
      true
    );
    expect(r.detections).toHaveLength(1);
  });

  test("healthCheck is always ok for local backend", async () => {
    const b = new LocalRegexBackend();
    const h = await b.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test("declares trust_tier 'local' (ADR-0005)", () => {
    const b = new LocalRegexBackend();
    expect(b.trust_tier).toBe("local");
  });
});

describe("OpfHttpBackend — HTTP contract (ADR-0008)", () => {
  test("POSTs to /redact with categories and request_id", async () => {
    let captured:
      | { url: string; body: unknown; headers: Record<string, string> }
      | null = null;
    const fakeFetch: FetchLike = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      captured = {
        url,
        body: JSON.parse(String(init?.body)),
        headers,
      };
      return new Response(
        JSON.stringify({
          detections: [
            {
              start: 14,
              end: 30,
              category: "private_email",
              confidence: 0.99,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const b = new OpfHttpBackend({
      endpoint: "http://localhost:8000",
      fetch_impl: fakeFetch,
    });
    const r = await b.detect("contact me at user@example.com please", {
      request_id: "req_x",
      categories: ["private_email"],
    });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("http://localhost:8000/redact");
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.category).toBe("private_email");
    expect(r.detections[0]!.text).toBe("user@example.com");
  });

  test("strips trailing /redact from endpoint to avoid /redact/redact", async () => {
    let capturedUrl = "";
    const fakeFetch: FetchLike = async (input) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ detections: [] }), { status: 200 });
    };
    const b = new OpfHttpBackend({
      endpoint: "http://localhost:8000/",
      fetch_impl: fakeFetch,
    });
    await b.detect("hi", { request_id: "x" });
    expect(capturedUrl).toBe("http://localhost:8000/redact");
  });

  test("adds Bearer header when auth.type=bearer", async () => {
    let headers: Record<string, string> = {};
    const fakeFetch: FetchLike = async (_input, init) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ detections: [] }), { status: 200 });
    };
    const b = new OpfHttpBackend({
      endpoint: "http://localhost:8000",
      auth: { type: "bearer", token: "secret-abc" },
      fetch_impl: fakeFetch,
    });
    await b.detect("hi", { request_id: "x" });
    expect(headers["authorization"]).toBe("Bearer secret-abc");
  });

  test("throws on non-2xx HTTP status", async () => {
    const fakeFetch: FetchLike = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });
    const b = new OpfHttpBackend({
      endpoint: "http://localhost:8000",
      fetch_impl: fakeFetch,
    });
    await expect(
      b.detect("hi", { request_id: "x" })
    ).rejects.toThrow(/HTTP 503/);
  });

  test("healthCheck reports ok=false on error without throwing", async () => {
    const fakeFetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const b = new OpfHttpBackend({
      endpoint: "http://localhost:8000",
      fetch_impl: fakeFetch,
    });
    const h = await b.healthCheck();
    expect(h.ok).toBe(false);
  });

  test("ignores invalid category strings from backend response", async () => {
    const fakeFetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          detections: [
            { start: 0, end: 5, category: "not-a-real-category" },
            { start: 6, end: 22, category: "private_email" },
          ],
        }),
        { status: 200 }
      );
    const b = new OpfHttpBackend({
      endpoint: "http://localhost:8000",
      fetch_impl: fakeFetch,
    });
    const r = await b.detect("hello user@example.com here", {
      request_id: "x",
    });
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.category).toBe("private_email");
  });

  test("parses gh0stkey/backend response with label+score (ADR-0008 wire format)", async () => {
    const fakeFetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          detections: [
            { start: 6, end: 22, label: "private_email", score: 0.97 },
            { start: 27, end: 30, label: "private_person", score: 0.88 },
          ],
          redacted_text: "hello <PRIVATE_EMAIL> and <PRIVATE_PERSON>",
        }),
        { status: 200 }
      );
    const b = new OpfHttpBackend({
      endpoint: "http://localhost:8000",
      fetch_impl: fakeFetch,
    });
    const r = await b.detect("hello user@example.com and Bob", {
      request_id: "x",
    });
    expect(r.detections).toHaveLength(2);
    expect(r.detections[0]!.category).toBe("private_email");
    expect(r.detections[0]!.confidence).toBeCloseTo(0.97, 5);
    expect(r.detections[1]!.category).toBe("private_person");
    expect(r.detections[1]!.confidence).toBeCloseTo(0.88, 5);
  });

  test("dual-key tolerance: category+confidence still works (mock test backends)", async () => {
    const fakeFetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          detections: [
            { start: 6, end: 22, category: "private_email", confidence: 0.95 },
          ],
        }),
        { status: 200 }
      );
    const b = new OpfHttpBackend({
      endpoint: "http://localhost:8000",
      fetch_impl: fakeFetch,
    });
    const r = await b.detect("hello user@example.com here", {
      request_id: "x",
    });
    expect(r.detections).toHaveLength(1);
    expect(r.detections[0]!.category).toBe("private_email");
    expect(r.detections[0]!.confidence).toBeCloseTo(0.95, 5);
  });
});
