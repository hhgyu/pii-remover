"""Path-prefix routing — port of ``proxy/src/router.ts``.

One port, providers selected by URL prefix (ADR-0004)::

    POST /anthropic/v1/messages        -> api.anthropic.com   (masked)
    POST /openai/v1/chat/completions   -> api.openai.com      (masked)
    POST /openai/v1/responses          -> api.openai.com      (masked)
    POST /codex/v1/responses           -> api.openai.com      (masked)

A match answers three separate questions, and collapsing them is what shipped
OpenCode's Responses traffic upstream in the clear:

``transform``
    Which request/response/SSE family owns the body. ``/openai/v1/responses``
    and ``/codex/v1/responses`` carry the same Responses API body, so they share
    one transform.
``upstream``
    Which base URL in the proxy settings receives the request. The two
    Responses routes keep separate, separately configurable bases.
``provider``
    Route identity metadata. It selects neither of the above: the
    TypeScript reference proxy consumes it as audit identity, while this
    backend retains it on the match only for TS/vector parity.

Anything else under a provider prefix is relayed untouched, with one deliberate
exception: an unrecognised ``/anthropic`` path stays on the **masking** branch
rather than falling through to passthrough. ``/v1/messages/count_tokens`` posts
the entire conversation, so defaulting that direction to "relay verbatim" would
ship the whole transcript upstream in the clear. Only the account namespace
``/anthropic/api/`` is explicitly passthrough.

``/health`` is resolved here for parity with the TypeScript proxy, but the
merged FastAPI app does not use that branch: the backend already owns
``/health``, and its ``model_loaded`` field is what the auto-start probe polls.
Two different ``/health`` payloads on one port would break that probe.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal, assert_never

ProviderName = Literal["anthropic", "openai", "codex"]
PassthroughProvider = Literal[
    "passthrough_anthropic",
    "passthrough_openai",
    "passthrough_codex",
]
UpstreamKey = ProviderName
MaskedTransform = Literal["anthropic_messages", "openai_chat", "responses"]
RouteTransform = MaskedTransform | Literal["passthrough"]
RouteKind = Literal["provider", "health", "not_found"]

_PROVIDER_PREFIXES: Final[tuple[tuple[str, ProviderName], ...]] = (
    ("/anthropic", "anthropic"),
    ("/openai", "openai"),
    ("/codex", "codex"),
)

ANTHROPIC_CHAT_PATH: Final = "/v1/messages"
ANTHROPIC_PASSTHROUGH_PREFIX: Final = "/api/"
OPENAI_CHAT_PATH: Final = "/v1/chat/completions"
# One path reached under two prefixes: Codex CLI posts it at
# ``/codex/v1/responses``, OpenCode's built-in OpenAI provider at
# ``/openai/v1/responses``.
RESPONSES_PATH: Final = "/v1/responses"

ROUTE_PATHS: Final[dict[str, str]] = {
    "anthropicChat": ANTHROPIC_CHAT_PATH,
    "openaiChat": OPENAI_CHAT_PATH,
    "codexResponses": RESPONSES_PATH,
}


@dataclass(frozen=True, slots=True)
class MaskedRouteMatch:
    transform: MaskedTransform
    provider: ProviderName
    upstream: UpstreamKey
    upstream_path: str


@dataclass(frozen=True, slots=True)
class PassthroughRouteMatch:
    provider: PassthroughProvider
    upstream: UpstreamKey
    upstream_path: str
    transform: Literal["passthrough"] = "passthrough"


RouteMatch = MaskedRouteMatch | PassthroughRouteMatch


@dataclass(frozen=True, slots=True)
class RouteResolution:
    kind: RouteKind
    match: RouteMatch | None = None


_NOT_FOUND: Final = RouteResolution(kind="not_found")
_HEALTH: Final = RouteResolution(kind="health")


def _provider_route(provider: ProviderName, upstream_path: str) -> RouteMatch:
    match provider:
        case "anthropic":
            if upstream_path.startswith(ANTHROPIC_PASSTHROUGH_PREFIX):
                return PassthroughRouteMatch("passthrough_anthropic", "anthropic", upstream_path)
            return MaskedRouteMatch("anthropic_messages", "anthropic", "anthropic", upstream_path)
        case "openai":
            if upstream_path == OPENAI_CHAT_PATH:
                return MaskedRouteMatch("openai_chat", "openai", "openai", upstream_path)
            if upstream_path == RESPONSES_PATH:
                return MaskedRouteMatch("responses", "openai", "openai", upstream_path)
            return PassthroughRouteMatch("passthrough_openai", "openai", upstream_path)
        case "codex":
            if upstream_path == RESPONSES_PATH:
                return MaskedRouteMatch("responses", "codex", "codex", upstream_path)
            return PassthroughRouteMatch("passthrough_codex", "codex", upstream_path)
        case unreachable:
            assert_never(unreachable)


def resolve_route(pathname: str) -> RouteResolution:
    if pathname == "/health":
        return _HEALTH

    for prefix, provider in _PROVIDER_PREFIXES:
        if pathname == prefix or pathname.startswith(f"{prefix}/"):
            upstream_path = pathname[len(prefix) :] or "/"
            return RouteResolution("provider", _provider_route(provider, upstream_path))

    return _NOT_FOUND


def is_chat_completion(match: RouteMatch) -> bool:
    return match.transform != "passthrough"
