"""Local LLM proxy routes (ADR-0004), served from the detection process.

Path-prefix routing on the same port as ``/redact``::

    POST /anthropic/v1/messages       -> api.anthropic.com   (masked)
    POST /openai/v1/chat/completions  -> api.openai.com      (masked)
    POST /openai/v1/responses         -> api.openai.com      (masked)
    POST /codex/v1/responses          -> api.openai.com      (masked)

Threading model, which is the load-bearing decision here:

- **Request masking runs on a worker thread** (:func:`asyncio.to_thread`).
  Masking calls the ONNX detector, which holds the GIL for milliseconds; doing
  that inline would stall every other in-flight stream on the event loop.
- **Response restoration runs inline.** Restoring touches no model - it is a
  regex sweep plus dict lookups, measured at ~48us for a 10-token payload - and
  streaming calls it once per SSE delta, where a thread hop per delta would
  cost more than the work itself.

Disabled by default; the merged compose opts in with ``PII_PROXY_ENABLED=1``.
See :func:`server.config.get_proxy_settings` for why.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Final, assert_never

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse

from ..config import get_proxy_settings
from ..pii.headers import forwardable_request_headers, forwardable_response_headers
from ..pii.pipeline import (
    StreamContext,
    create_stream_transformer,
    mask_request,
    replay_request,
    restore_response,
)
from ..pii.router import (
    MaskedRouteMatch,
    MaskedTransform,
    PassthroughRouteMatch,
    UpstreamKey,
    resolve_route,
)
from ..pii.session_pool import ProxySession
from ..pii.sse import StreamRestoreScope, js_json_dumps
from ..pii.thinking_replay import THINKING_REPLAY_REJECTION, ThinkingUnresolvable
from .proxy_deps import get_http_client, get_session_pool

log = logging.getLogger(__name__)
router = APIRouter(tags=["proxy"])

PROXY_PATH_PREFIXES: Final = ("/anthropic", "/openai", "/codex")


@dataclass(frozen=True, slots=True)
class _UpstreamCall:
    url: str
    headers: dict[str, str]
    payload: dict[str, Any]


def _upstream_base(target: UpstreamKey) -> str:
    settings = get_proxy_settings()
    base = {
        "anthropic": settings.anthropic_upstream,
        "openai": settings.openai_upstream,
        "codex": settings.codex_upstream,
    }[target]
    return base.rstrip("/")


async def _relay_passthrough(
    request: Request, match: PassthroughRouteMatch, raw_body: bytes
) -> Response:
    url = f"{_upstream_base(match.upstream)}{match.upstream_path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"

    client = get_http_client(request.app)
    try:
        upstream = await client.request(
            request.method,
            url,
            headers=forwardable_request_headers(request.headers.items()),
            content=raw_body or None,
        )
    except httpx.HTTPError as exc:
        log.warning("proxy passthrough failed: %s", exc)
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"error": "bad_gateway", "message": "Upstream call failed."},
        )
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=forwardable_response_headers(upstream.headers.items()),
    )


def _stream_upstream(
    request: Request,
    call: _UpstreamCall,
    session: ProxySession,
    transform: MaskedTransform,
) -> StreamingResponse:
    settings = get_proxy_settings()
    transformer = create_stream_transformer(
        transform,
        StreamContext(
            scope=StreamRestoreScope(session.codec.restore),
            session=session,
            buffer_window=settings.buffer_window,
            flush_on_close=settings.flush_on_close,
        ),
    )
    client = get_http_client(request.app)

    async def body() -> AsyncIterator[bytes]:
        try:
            async with client.stream(
                "POST",
                call.url,
                headers=call.headers,
                content=js_json_dumps(call.payload).encode(),
            ) as upstream:
                if upstream.status_code >= 400:
                    await upstream.aread()
                    yield upstream.content
                    return
                async for chunk in upstream.aiter_text():
                    out = transformer.push(chunk)
                    if out:
                        yield out.encode()
                tail = transformer.flush()
                if tail:
                    yield tail.encode()
        except httpx.HTTPError as exc:
            log.warning("proxy stream failed: %s", exc)

    return StreamingResponse(body(), media_type="text/event-stream")


def _invalid_json(message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"error": "invalid_json", "message": message},
    )


async def _relay_masked(
    request: Request, match: MaskedRouteMatch, raw_body: bytes
) -> Response:
    transform_kind = match.transform
    try:
        body: Any = json.loads(raw_body) if raw_body else {}
    except ValueError as exc:
        log.warning("proxy received invalid JSON: %s", exc)
        return _invalid_json("Request body must be JSON.")
    if not isinstance(body, dict):
        return _invalid_json("Request body must be a JSON object.")

    session = get_session_pool(request.app).get(request.headers)
    replay = replay_request(transform_kind, body, session)
    # Refused here rather than sent on: a turn missing one of its thinking
    # blocks draws an opaque 400 from upstream, and the restored text the client
    # replayed is the user's plaintext PII.
    if isinstance(replay, ThinkingUnresolvable):
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST, content=THINKING_REPLAY_REJECTION
        )
    masked = await asyncio.to_thread(mask_request, transform_kind, replay.body, session.codec)

    url = f"{_upstream_base(match.upstream)}{match.upstream_path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"
    headers = forwardable_request_headers(request.headers.items())
    headers["content-type"] = "application/json"
    call = _UpstreamCall(url=url, headers=headers, payload=masked)

    if masked.get("stream") is True:
        return _stream_upstream(request, call, session, transform_kind)

    client = get_http_client(request.app)
    try:
        upstream = await client.post(
            call.url, headers=call.headers, content=js_json_dumps(call.payload).encode()
        )
    except httpx.HTTPError as exc:
        log.warning("proxy upstream call failed: %s", exc)
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"error": "bad_gateway", "message": "Upstream call failed."},
        )

    response_headers = forwardable_response_headers(upstream.headers.items())
    if upstream.status_code >= 400:
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            headers=response_headers,
        )

    try:
        upstream_body = upstream.json()
    except ValueError:
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            headers=response_headers,
        )

    restored = restore_response(transform_kind, upstream_body, session)
    response_headers.pop("content-type", None)
    return Response(
        content=js_json_dumps(restored).encode(),
        status_code=upstream.status_code,
        media_type="application/json",
        headers=response_headers,
    )


@router.api_route(
    "/{provider_prefix:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
async def proxy_entrypoint(request: Request, provider_prefix: str) -> Response:
    """Catch-all for the three provider prefixes.

    Registered last so the app's own routes (``/health``, ``/redact*``,
    ``/warmup``) always win: this must never shadow the detection API that the
    auto-start probe and the hook depend on.
    """
    pathname = request.url.path
    if not pathname.startswith(PROXY_PATH_PREFIXES):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")

    if not get_proxy_settings().enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="proxy disabled (set PII_PROXY_ENABLED=1)",
        )

    resolution = resolve_route(pathname)
    if resolution.kind != "provider" or resolution.match is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")

    route_match = resolution.match
    raw_body = await request.body()

    match route_match:
        case PassthroughRouteMatch():
            return await _relay_passthrough(request, route_match, raw_body)
        case MaskedRouteMatch():
            if request.method != "POST":
                return JSONResponse(
                    status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
                    content={
                        "error": "method_not_allowed",
                        "message": "Only POST is supported on provider chat routes.",
                    },
                )
            return await _relay_masked(request, route_match, raw_body)
        case unreachable:
            assert_never(unreachable)
