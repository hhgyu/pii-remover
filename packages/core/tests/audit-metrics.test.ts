/**
 * Phase A metric substrate (docs/QUALITY-MEASUREMENT-PLAN.md §2, §3.1).
 *
 * Locks the audit fields every online metric is derived from. The denominator
 * for restore rates is `restored + unknown + path_skip` — tokens OBSERVED in
 * model output — so a counter silently dropping to zero must fail here.
 */

import { describe, expect, test } from "bun:test";

import {
  AuditEmitter,
  type AuditEntry,
} from "../src/audit/index.js";
import { LocalRegexBackend } from "../src/backend/local-regex.js";
import { SingleStrategy } from "../src/backend/strategy.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { PIIRemover } from "../src/pii-remover.js";
import { formatToken } from "../src/token/format.js";

const EMAIL = "alice@example.com";
const NEVER_MINTED = formatToken("EMAIL", "zzzzzzzzzzzzzzzz");

interface Harness {
  remover: PIIRemover;
  entries: AuditEntry[];
}

async function makeHarness(sessionId: string): Promise<Harness> {
  const entries: AuditEntry[] = [];
  const remover = await PIIRemover.init({
    sessionId,
    config: { ...DEFAULT_CONFIG },
    env: {},
    warn: () => {},
    strategy: new SingleStrategy(new LocalRegexBackend()),
    audit: new AuditEmitter({ enabled: true, stream: (e) => entries.push(e) }),
  });
  return { remover, entries };
}

function eventsOf(entries: readonly AuditEntry[], event: string): AuditEntry[] {
  return entries.filter((e) => e.event === event);
}

describe("audit — mask events carry a denominator", () => {
  test("minted_count, text_length and masked_char_count describe the mask", async () => {
    const { remover, entries } = await makeHarness("metrics-mask");
    const text = `contact ${EMAIL} now`;

    await remover.mask(text);

    const mask = eventsOf(entries, "mask")[0];
    expect(mask?.minted_count).toBe(1);
    expect(mask?.text_length).toBe(text.length);
    expect(mask?.masked_char_count).toBe(EMAIL.length);
    remover.dispose();
  });

  test("the same PII twice mints one token, not two", async () => {
    const { remover, entries } = await makeHarness("metrics-dedup");

    await remover.mask(`a: ${EMAIL} b: ${EMAIL}`);

    const mask = eventsOf(entries, "mask")[0];
    expect(mask?.minted_count).toBe(1);
    expect(mask?.masked_char_count).toBe(EMAIL.length * 2);
    remover.dispose();
  });
});

describe("audit — restore events are comparable across transports", () => {
  test("token-free text emits no restore event", async () => {
    const { remover, entries } = await makeHarness("metrics-silent");

    remover.restore("just a sentence with no tokens");

    expect(eventsOf(entries, "restore")).toEqual([]);
    remover.dispose();
  });

  test("a resolved token reports every counter at rest", async () => {
    const { remover, entries } = await makeHarness("metrics-resolved");
    const masked = await remover.mask(`contact ${EMAIL} now`);

    remover.restore(masked.text);

    const restore = eventsOf(entries, "restore")[0];
    expect(restore).toMatchObject({
      restored_count: 1,
      unknown_token_count: 0,
      partial_match_count: 0,
      lenient_restored_count: 0,
      path_skip_count: 0,
      residual_token_count: 0,
    });
    remover.dispose();
  });

  test("one request id joins the mask event to its restore event", async () => {
    const { remover, entries } = await makeHarness("metrics-join");
    const masked = await remover.mask(`contact ${EMAIL} now`, {
      request_id: "req-join",
    });

    remover.restore(masked.text, { request_id: "req-join" });

    expect(eventsOf(entries, "mask")[0]?.request_id).toBe("req-join");
    expect(eventsOf(entries, "restore")[0]?.request_id).toBe("req-join");
    remover.dispose();
  });
});

describe("audit — blame follows provenance, not shape", () => {
  test("a never-minted token in MODEL text is a hallucination", async () => {
    const { remover, entries } = await makeHarness("origin-model");

    remover.restore(`the value is ${NEVER_MINTED}`, {
      origin: "model",
      warnOnUnknownToken: false,
    });

    const restore = eventsOf(entries, "restore")[0];
    expect(restore?.hallucinated_count).toBe(1);
    expect(restore?.unminted_token_count).toBeUndefined();
    remover.dispose();
  });

  test("the same token in TOOL output is not blamed on the model", async () => {
    const { remover, entries } = await makeHarness("origin-tool");

    remover.restore(`file contents: ${NEVER_MINTED}`, {
      origin: "tool",
      warnOnUnknownToken: false,
    });

    const restore = eventsOf(entries, "restore")[0];
    expect(restore?.unminted_token_count).toBe(1);
    expect(restore?.hallucinated_count).toBeUndefined();
    remover.dispose();
  });

  test("the same token typed by the USER is not blamed on the model", async () => {
    const { remover, entries } = await makeHarness("origin-user");

    remover.restore(`what is ${NEVER_MINTED}?`, {
      origin: "user",
      warnOnUnknownToken: false,
    });

    const restore = eventsOf(entries, "restore")[0];
    expect(restore?.unminted_token_count).toBe(1);
    expect(restore?.hallucinated_count).toBeUndefined();
    remover.dispose();
  });

  test("an omitted origin is attributed to the model, never silently excused", async () => {
    const { remover, entries } = await makeHarness("origin-default");

    remover.restore(`the value is ${NEVER_MINTED}`, {
      warnOnUnknownToken: false,
    });

    expect(eventsOf(entries, "restore")[0]?.hallucinated_count).toBe(1);
    remover.dispose();
  });
});

describe("audit — unresolved tokens stay visible", () => {
  test("a never-minted token counts as unknown and as residual surface", async () => {
    const { remover, entries } = await makeHarness("metrics-unknown");

    remover.restore(`the value is ${NEVER_MINTED} apparently`, {
      warnOnUnknownToken: false,
    });

    const restore = eventsOf(entries, "restore")[0];
    expect(restore?.unknown_token_count).toBe(1);
    expect(restore?.residual_token_count).toBe(1);
    remover.dispose();
  });

  test("a miss inside a filesystem path lands in path_skip_count, not unknown", async () => {
    const { remover, entries } = await makeHarness("metrics-path");

    remover.restore(`see D:\\Git\\${NEVER_MINTED}\\file.ts for details`);

    const restore = eventsOf(entries, "restore")[0];
    expect(restore?.path_skip_count).toBe(1);
    expect(restore?.unknown_token_count).toBe(0);
    remover.dispose();
  });

  test("a lenient match that resolves is counted apart from one that does not", async () => {
    const { remover, entries } = await makeHarness("metrics-lenient");
    const masked = await remover.mask(`contact ${EMAIL} now`);
    const token = masked.tokens[0]?.token ?? "";
    const mangled = token.toLowerCase().slice(0, -2);

    remover.restore(`he said ${mangled} earlier`, { warnOnPartial: false });

    const restore = eventsOf(entries, "restore")[0];
    expect(restore?.partial_match_count).toBe(1);
    expect(restore?.lenient_restored_count).toBe(1);
    expect(restore?.residual_token_count).toBe(0);
    remover.dispose();
  });
});
