"""Process-lifetime dependencies the proxy routes borrow from ``app.state``.

Three of them: the in-process detection pipeline, the per-session vault +
thinking pool, and the shared upstream HTTP client. They live here so
:mod:`server.api.proxy` stays about routing.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import HTTPException, status

from ..config import get_proxy_settings
from ..pii.session_pool import ProxySessionPool
from ..pii.token_hash import resolve_token_key
from ..pii.types import Detection

log = logging.getLogger(__name__)


def detect_in_process(app: Any, text: str) -> list[Detection]:
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
        if resolution.source == "env":
            log.info("proxy token key resolved from the environment")
        else:
            log.warning(
                "proxy token key resolved from %s, not PII_REMOVER_TOKEN_KEY. "
                "The key lives on the container filesystem and is lost when the "
                "container is recreated, so tokens minted now become "
                "unrestorable and will not match a host-side hook. Set "
                "PII_REMOVER_TOKEN_KEY to pin it.",
                resolution.source,
            )
        pool = ProxySessionPool(
            detect=lambda text: detect_in_process(app, text),
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
