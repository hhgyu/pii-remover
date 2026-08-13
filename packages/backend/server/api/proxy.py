"""Local LLM proxy routes (ADR-0004), served from the detection process.

Path-prefix routing on the same port as ``/redact``::

    POST /anthropic/v1/messages       -> api.anthropic.com   (masked)
    POST /openai/v1/chat/completions  -> api.openai.com      (masked)
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
from collections.abc import AsyncIterator, Callable
from typing import Any, Final

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse

from ..config import get_proxy_settings
from ..pii.codec import VaultTokenCodec
from ..pii.headers import forwardable_request_headers, forwardable_response_headers
from ..pii.providers import (
    restore_anthropic_response,
    restore_codex_response,
    restore_openai_response,
    transform_anthropic_request,
    transform_codex_request,
    transform_openai_request,
)
from ..pii.router import RouteMatch, resolve_route
from ..pii.session_pool import ProxySessionPool
from ..pii.sse import StreamRestoreScope, js_json_dumps
from ..pii.stream_transformers import (
    AnthropicSseTransformer,
    CodexSseTransformer,
    OpenAISseTransformer,
)
from ..pii.token_hash import resolve_token_key
from ..pii.types import Detection

log = logging.getLogger(__name__)
router = APIRouter(tags=["proxy"])

PROXY_PATH_PREFIXES: Final = ("/anthropic", "/openai", "/codex")

_REQUEST_TRANSFORMS: Final[dict[str, Callable[..., dict[str, Any]]]] = {
    "anthropic": transform_anthropic_request,
    "openai": transform_openai_request,
    "codex": transform_codex_request,
}
_RESPONSE_RESTORES: Final[dict[str, Callable[..., dict[str, Any]]]] = {
    "anthropic": restore_anthropic_response,
    "openai": restore_openai_response,
    "codex": restore_codex_response,
}
_TRANSFORMERS: Final[dict[str, Any]] = {
    "anthropic": AnthropicSseTransformer,
    "openai": OpenAISseTransformer,
    "codex": CodexSseTransformer,
}
_PASSTHROUGH_TARGET: Final[dict[str, str]] = {
    "passthrough_anthropic": "anthropic",
    "passthrough_openai": "openai",
    "passthrough_codex": "codex",
}


def _detect_in_process(app: Any, text: str) -> list[Detection]:
    """Run the same detection pipeline ``/redact`` uses, synchronously.

    Reuses ``redact._merge_spans_and_mask`` rather than reimplementing the
    merge: if the proxy and ``/redact`` disagreed about what counts as PII, the
    hook's fail-closed gate and the proxy's masking would apply different rules
    to the same prompt.
    """
    from ..regex_pipeline import find_pii_spans
    from . import redact as redact_api

    opf = getattr(app.state, "opf_runner", None)
    if opf is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OPF runner not initialised",
        )

    opf_result = opf.redact(text)
    regex_spans = find_pii_spans(text)

    person_spans = []
    kner = getattr(app.state, "korean_ner_runner", None)
    if kner is not None and redact_api._HANGUL_RE.search(text):
        person_spans = [s for s in kner.detect(text) if s.klue_tag == "PS"]

    # MUST run before the merge: the merge keeps the widest overlapping span,
    # so an over-extended OPF span (private_url swallowing an adjacent email)
    # would drag the narrower detections out with it and leak them to the LLM.
    # `/redact` and the hook's fail-closed gate still see every detection.
    excluded = get_proxy_settings().excluded_categories
    if excluded:
        opf_result = opf_result.model_copy(
            update={
                "detections": [
                    d for d in opf_result.detections if d.label.lower() not in excluded
                ]
            }
        )
        regex_spans = [s for s in regex_spans if s.category.lower() not in excluded]
        person_spans = [s for s in person_spans if s.category.lower() not in excluded]

    merged = (
        redact_api._merge_spans_and_mask(text, opf_result, person_spans, regex_spans)
        if (regex_spans or person_spans)
        else opf_result
    )
    return [
        Detection(
            start=d.start,
            end=d.end,
            category=d.label,
            confidence=d.score,
            text=d.text,
        )
        for d in merged.detections
    ]


def get_session_pool(app: Any) -> ProxySessionPool:
    pool = getattr(app.state, "proxy_session_pool", None)
    if pool is None:
        resolution = resolve_token_key()
        if resolution.warning:
            log.warning("%s", resolution.warning)
        log.info("proxy token key resolved from %s", resolution.source)
        pool = ProxySessionPool(
            detect=lambda text: _detect_in_process(app, text),
            token_key=resolution.key,
            warn=lambda message: log.warning("%s", message),
        )
        app.state.proxy_session_pool = pool
    return pool


def get_http_client(app: Any) -> httpx.AsyncClient:
    client = getattr(app.state, "proxy_http_client", None)
    if client is None or client.is_closed:
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(get_proxy_settings().timeout_seconds),
            follow_redirects=False,
        )
        app.state.proxy_http_client = client
    return client


def _upstream_base(target: str) -> str:
    settings = get_proxy_settings()
    base = {
        "anthropic": settings.anthropic_upstream,
        "openai": settings.openai_upstream,
        "codex": settings.codex_upstream,
    }[target]
    return base.rstrip("/")


async def _relay_passthrough(request: Request, match: RouteMatch, raw_body: bytes) -> Response:
    target = _PASSTHROUGH_TARGET[match.provider]
    url = f"{_upstream_base(target)}{match.upstream_path}"
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
    url: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    codec: VaultTokenCodec,
    provider: str,
) -> StreamingResponse:
    settings = get_proxy_settings()
    scope = StreamRestoreScope(codec.restore)
    transformer = _TRANSFORMERS[provider](
        scope,
        buffer_window=settings.buffer_window,
        flush_on_close=settings.flush_on_close,
    )
    client = get_http_client(request.app)

    async def body() -> AsyncIterator[bytes]:
        try:
            async with client.stream(
                "POST", url, headers=headers, content=js_json_dumps(payload).encode()
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


async def _relay_masked(request: Request, match: RouteMatch, raw_body: bytes) -> Response:
    provider = match.provider
    try:
        body: Any = json.loads(raw_body) if raw_body else {}
    except ValueError as exc:
        log.warning("proxy received invalid JSON: %s", exc)
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"error": "invalid_json", "message": "Request body must be JSON."},
        )
    if not isinstance(body, dict):
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"error": "invalid_json", "message": "Request body must be a JSON object."},
        )

    codec = get_session_pool(request.app).get(request.headers)
    transform = _REQUEST_TRANSFORMS[provider]
    masked = await asyncio.to_thread(transform, body, codec)

    url = f"{_upstream_base(provider)}{match.upstream_path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"
    headers = forwardable_request_headers(request.headers.items())
    headers["content-type"] = "application/json"

    if masked.get("stream") is True:
        return _stream_upstream(request, url, headers, masked, codec, provider)

    client = get_http_client(request.app)
    try:
        upstream = await client.post(url, headers=headers, content=js_json_dumps(masked).encode())
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

    restored = _RESPONSE_RESTORES[provider](upstream_body, codec)
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

    match = resolution.match
    raw_body = await request.body()

    if match.provider in _PASSTHROUGH_TARGET:
        return await _relay_passthrough(request, match, raw_body)

    if request.method != "POST":
        return JSONResponse(
            status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
            content={
                "error": "method_not_allowed",
                "message": "Only POST is supported on provider chat routes.",
            },
        )
    return await _relay_masked(request, match, raw_body)
