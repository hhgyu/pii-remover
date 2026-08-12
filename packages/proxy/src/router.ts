import type { ProviderName } from "./providers/types.js";

export interface RouteMatch {
  provider:
    | ProviderName
    | "passthrough_anthropic"
    | "passthrough_openai"
    | "passthrough_codex";
  upstreamPath: string;
}

export interface RouteResolution {
  kind: "provider" | "health" | "not_found";
  match?: RouteMatch;
}

const PROVIDER_PREFIXES: ReadonlyArray<{
  prefix: string;
  provider: ProviderName;
}> = [
  { prefix: "/anthropic", provider: "anthropic" },
  { prefix: "/openai", provider: "openai" },
  { prefix: "/codex", provider: "codex" },
];

const ANTHROPIC_CHAT_PATH = "/v1/messages";
// Scoped to the account namespace on purpose: do NOT widen to all of
// `/anthropic`. `/v1/messages/count_tokens` posts the full conversation and
// must stay on the masking branch.
const ANTHROPIC_PASSTHROUGH_PREFIX = "/api/";
const OPENAI_CHAT_PATH = "/v1/chat/completions";
const CODEX_RESPONSES_PATH = "/v1/responses";

export function resolveRoute(pathname: string): RouteResolution {
  if (pathname === "/health") return { kind: "health" };

  for (const { prefix, provider } of PROVIDER_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const upstreamPath = pathname.slice(prefix.length) || "/";
      if (provider === "anthropic" && upstreamPath === ANTHROPIC_CHAT_PATH) {
        return {
          kind: "provider",
          match: { provider: "anthropic", upstreamPath },
        };
      }
      if (
        provider === "anthropic" &&
        upstreamPath.startsWith(ANTHROPIC_PASSTHROUGH_PREFIX)
      ) {
        return {
          kind: "provider",
          match: { provider: "passthrough_anthropic", upstreamPath },
        };
      }
      if (provider === "openai" && upstreamPath === OPENAI_CHAT_PATH) {
        return {
          kind: "provider",
          match: { provider: "openai", upstreamPath },
        };
      }
      if (provider === "codex" && upstreamPath === CODEX_RESPONSES_PATH) {
        return {
          kind: "provider",
          match: { provider: "codex", upstreamPath },
        };
      }
      if (provider === "openai") {
        return {
          kind: "provider",
          match: { provider: "passthrough_openai", upstreamPath },
        };
      }
      if (provider === "codex") {
        return {
          kind: "provider",
          match: { provider: "passthrough_codex", upstreamPath },
        };
      }
      return {
        kind: "provider",
        match: { provider, upstreamPath },
      };
    }
  }

  return { kind: "not_found" };
}

export function isChatCompletion(match: RouteMatch): boolean {
  return (
    match.provider === "anthropic" ||
    match.provider === "openai" ||
    match.provider === "codex"
  );
}

export const ROUTE_PATHS = {
  anthropicChat: ANTHROPIC_CHAT_PATH,
  openaiChat: OPENAI_CHAT_PATH,
  codexResponses: CODEX_RESPONSES_PATH,
} as const;
