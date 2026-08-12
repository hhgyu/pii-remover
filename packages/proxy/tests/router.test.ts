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
