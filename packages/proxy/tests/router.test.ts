import { describe, expect, test } from "bun:test";
import { resolveRoute } from "../src/router.js";

describe("resolveRoute — path prefix routing (ADR-0004)", () => {
  test("/health returns kind=health", () => {
    expect(resolveRoute("/health")).toEqual({ kind: "health" });
  });

  test("/anthropic/v1/messages → anthropic provider", () => {
    const r = resolveRoute("/anthropic/v1/messages");
    expect(r.kind).toBe("provider");
    expect(r.match?.provider).toBe("anthropic");
    expect(r.match?.upstreamPath).toBe("/v1/messages");
  });

  test("/openai/v1/chat/completions → openai provider", () => {
    const r = resolveRoute("/openai/v1/chat/completions");
    expect(r.kind).toBe("provider");
    expect(r.match?.provider).toBe("openai");
    expect(r.match?.upstreamPath).toBe("/v1/chat/completions");
  });

  test("/openai/v1/embeddings → passthrough_openai", () => {
    const r = resolveRoute("/openai/v1/embeddings");
    expect(r.kind).toBe("provider");
    expect(r.match?.provider).toBe("passthrough_openai");
    expect(r.match?.upstreamPath).toBe("/v1/embeddings");
  });

  test("/anthropic/api/oauth/profile → passthrough_anthropic", () => {
    const r = resolveRoute("/anthropic/api/oauth/profile");
    expect(r.kind).toBe("provider");
    expect(r.match?.provider).toBe("passthrough_anthropic");
    expect(r.match?.upstreamPath).toBe("/api/oauth/profile");
  });

  test("/anthropic/v1/messages/count_tokens stays on the masking branch", () => {
    const r = resolveRoute("/anthropic/v1/messages/count_tokens");
    expect(r.match?.provider).toBe("anthropic");
  });

  test("unknown path → not_found", () => {
    expect(resolveRoute("/random/path").kind).toBe("not_found");
    expect(resolveRoute("/anthropi/typo/v1/messages").kind).toBe("not_found");
    expect(resolveRoute("/").kind).toBe("not_found");
  });

  test("provider prefix with no trailing path → kept as /", () => {
    const r = resolveRoute("/anthropic");
    expect(r.kind).toBe("provider");
    expect(r.match?.upstreamPath).toBe("/");
  });
});

/**
 * `provider` alone cannot express `/openai/v1/responses`: it needs the Responses
 * transforms (which Codex owns), the OpenAI upstream base, and the `openai`
 * audit identity — three answers the single field used to collapse into one.
 * These tests pin the three apart.
 */
describe("resolveRoute — transform / upstream / audit-provider are separate", () => {
  test("/anthropic/v1/messages → anthropic_messages transform on the anthropic upstream", () => {
    const r = resolveRoute("/anthropic/v1/messages");
    expect(r.match?.transform).toBe("anthropic_messages");
    expect(r.match?.upstream).toBe("anthropic");
    expect(r.match?.provider).toBe("anthropic");
  });

  test("/anthropic/api/oauth/profile → passthrough transform on the anthropic upstream", () => {
    const r = resolveRoute("/anthropic/api/oauth/profile");
    expect(r.match?.transform).toBe("passthrough");
    expect(r.match?.upstream).toBe("anthropic");
  });

  test("/openai/v1/chat/completions keeps the Chat Completions transform", () => {
    const r = resolveRoute("/openai/v1/chat/completions");
    expect(r.match?.transform).toBe("openai_chat");
    expect(r.match?.upstream).toBe("openai");
    expect(r.match?.provider).toBe("openai");
  });

  test("/openai/v1/responses → Responses transform, OpenAI upstream, openai audit identity", () => {
    const r = resolveRoute("/openai/v1/responses");
    expect(r.kind).toBe("provider");
    expect(r.match?.transform).toBe("responses");
    expect(r.match?.upstream).toBe("openai");
    expect(r.match?.provider).toBe("openai");
    expect(r.match?.upstreamPath).toBe("/v1/responses");
  });

  test("/openai/v1/responses never falls through to passthrough", () => {
    const r = resolveRoute("/openai/v1/responses");
    expect(r.match?.transform).not.toBe("passthrough");
    expect(r.match?.provider).not.toBe("passthrough_openai");
  });

  test("/openai/v1/responses does not borrow the codex upstream", () => {
    const r = resolveRoute("/openai/v1/responses");
    expect(r.match?.upstream).not.toBe("codex");
    expect(r.match?.provider).not.toBe("codex");
  });

  test("/codex/v1/responses keeps the codex upstream and codex audit identity", () => {
    const r = resolveRoute("/codex/v1/responses");
    expect(r.match?.transform).toBe("responses");
    expect(r.match?.upstream).toBe("codex");
    expect(r.match?.provider).toBe("codex");
  });

  test("unrecognised openai/codex paths stay passthrough on their own upstream", () => {
    const embeddings = resolveRoute("/openai/v1/embeddings");
    expect(embeddings.match?.transform).toBe("passthrough");
    expect(embeddings.match?.upstream).toBe("openai");

    const codexModels = resolveRoute("/codex/v1/models");
    expect(codexModels.match?.transform).toBe("passthrough");
    expect(codexModels.match?.upstream).toBe("codex");
  });

  test("/CODEX/v1/responses is not a route (prefix match is case-sensitive)", () => {
    expect(resolveRoute("/CODEX/v1/responses").kind).toBe("not_found");
    expect(resolveRoute("/OPENAI/v1/responses").kind).toBe("not_found");
  });
});
