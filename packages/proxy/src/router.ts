import type { ProviderName } from "./providers/types.js";

/** Which base URL in `ResolvedProxyConfig.upstream` receives the request. */
export type UpstreamKey = ProviderName;

/**
 * Which request/response/SSE transform family owns the body.
 *
 * Kept separate from `provider` on purpose: `/openai/v1/responses` and
 * `/codex/v1/responses` carry the same OpenAI Responses API body — so they
 * share one transform family — while keeping different upstream bases and
 * different audit identities. Deriving the transform from `provider` collapsed
 * those three answers into one field, which dropped OpenCode's Responses
 * traffic onto the passthrough branch, i.e. upstream in the clear.
 */
export type RouteTransform =
  | "anthropic_messages"
  | "openai_chat"
  | "responses"
  | "passthrough";

export type PassthroughProvider =
  | "passthrough_anthropic"
  | "passthrough_openai"
  | "passthrough_codex";

export interface MaskedRouteMatch {
  transform: "anthropic_messages" | "openai_chat" | "responses";
  /** Audit identity. Never selects a transform or an upstream. */
  provider: ProviderName;
  upstream: UpstreamKey;
  upstreamPath: string;
}

export interface PassthroughRouteMatch {
  transform: "passthrough";
  provider: PassthroughProvider;
  upstream: UpstreamKey;
  upstreamPath: string;
}

export type RouteMatch = MaskedRouteMatch | PassthroughRouteMatch;

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
// One path reached under two prefixes: Codex CLI posts it at
// `/codex/v1/responses`, OpenCode's built-in OpenAI provider at
// `/openai/v1/responses`.
const RESPONSES_PATH = "/v1/responses";

export function resolveRoute(pathname: string): RouteResolution {
  if (pathname === "/health") return { kind: "health" };

  for (const { prefix, provider } of PROVIDER_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const upstreamPath = pathname.slice(prefix.length) || "/";
      return { kind: "provider", match: providerRoute(provider, upstreamPath) };
    }
  }

  return { kind: "not_found" };
}

function providerRoute(
  provider: ProviderName,
  upstreamPath: string
): RouteMatch {
  switch (provider) {
    case "anthropic":
      if (upstreamPath.startsWith(ANTHROPIC_PASSTHROUGH_PREFIX)) {
        return {
          transform: "passthrough",
          provider: "passthrough_anthropic",
          upstream: "anthropic",
          upstreamPath,
        };
      }
      return {
        transform: "anthropic_messages",
        provider: "anthropic",
        upstream: "anthropic",
        upstreamPath,
      };
    case "openai":
      if (upstreamPath === OPENAI_CHAT_PATH) {
        return {
          transform: "openai_chat",
          provider: "openai",
          upstream: "openai",
          upstreamPath,
        };
      }
      if (upstreamPath === RESPONSES_PATH) {
        return {
          transform: "responses",
          provider: "openai",
          upstream: "openai",
          upstreamPath,
        };
      }
      return {
        transform: "passthrough",
        provider: "passthrough_openai",
        upstream: "openai",
        upstreamPath,
      };
    case "codex":
      if (upstreamPath === RESPONSES_PATH) {
        return {
          transform: "responses",
          provider: "codex",
          upstream: "codex",
          upstreamPath,
        };
      }
      return {
        transform: "passthrough",
        provider: "passthrough_codex",
        upstream: "codex",
        upstreamPath,
      };
  }
}

export function isChatCompletion(match: RouteMatch): boolean {
  return match.transform !== "passthrough";
}

export const ROUTE_PATHS = {
  anthropicChat: ANTHROPIC_CHAT_PATH,
  openaiChat: OPENAI_CHAT_PATH,
  codexResponses: RESPONSES_PATH,
} as const;
