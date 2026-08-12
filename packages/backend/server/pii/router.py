"""Path-prefix routing — port of ``proxy/src/router.ts``.

One port, providers selected by URL prefix (ADR-0004)::

    POST /anthropic/v1/messages        -> api.anthropic.com   (masked)
    POST /openai/v1/chat/completions   -> api.openai.com      (masked)
    POST /codex/v1/responses           -> api.openai.com      (masked)

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
from typing import Final, Literal

ProviderName = Literal["anthropic", "openai", "codex"]
RouteTarget = Literal[
    "anthropic",
    "openai",
    "codex",
    "passthrough_anthropic",
    "passthrough_openai",
    "passthrough_codex",
]
RouteKind = Literal["provider", "health", "not_found"]

_PROVIDER_PREFIXES: Final[tuple[tuple[str, ProviderName], ...]] = (
    ("/anthropic", "anthropic"),
    ("/openai", "openai"),
    ("/codex", "codex"),
)

ANTHROPIC_CHAT_PATH: Final = "/v1/messages"
ANTHROPIC_PASSTHROUGH_PREFIX: Final = "/api/"
OPENAI_CHAT_PATH: Final = "/v1/chat/completions"
CODEX_RESPONSES_PATH: Final = "/v1/responses"

ROUTE_PATHS: Final[dict[str, str]] = {
    "anthropicChat": ANTHROPIC_CHAT_PATH,
    "openaiChat": OPENAI_CHAT_PATH,
    "codexResponses": CODEX_RESPONSES_PATH,
}


@dataclass(frozen=True, slots=True)
class RouteMatch:
    provider: RouteTarget
    upstream_path: str


@dataclass(frozen=True, slots=True)
class RouteResolution:
    kind: RouteKind
    match: RouteMatch | None = None


_NOT_FOUND: Final = RouteResolution(kind="not_found")
_HEALTH: Final = RouteResolution(kind="health")


def _provider_route(provider: ProviderName, upstream_path: str) -> RouteResolution:
    if provider == "anthropic":
        if upstream_path == ANTHROPIC_CHAT_PATH:
            return RouteResolution("provider", RouteMatch("anthropic", upstream_path))
        if upstream_path.startswith(ANTHROPIC_PASSTHROUGH_PREFIX):
            return RouteResolution("provider", RouteMatch("passthrough_anthropic", upstream_path))
        return RouteResolution("provider", RouteMatch("anthropic", upstream_path))

    if provider == "openai":
        target: RouteTarget = (
            "openai" if upstream_path == OPENAI_CHAT_PATH else "passthrough_openai"
        )
        return RouteResolution("provider", RouteMatch(target, upstream_path))

    codex_target: RouteTarget = (
        "codex" if upstream_path == CODEX_RESPONSES_PATH else "passthrough_codex"
    )
    return RouteResolution("provider", RouteMatch(codex_target, upstream_path))


def resolve_route(pathname: str) -> RouteResolution:
    if pathname == "/health":
        return _HEALTH

    for prefix, provider in _PROVIDER_PREFIXES:
        if pathname == prefix or pathname.startswith(f"{prefix}/"):
            upstream_path = pathname[len(prefix) :] or "/"
            return _provider_route(provider, upstream_path)

    return _NOT_FOUND


def is_chat_completion(match: RouteMatch) -> bool:
    return match.provider in ("anthropic", "openai", "codex")
