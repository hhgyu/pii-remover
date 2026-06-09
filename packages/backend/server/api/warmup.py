"""``POST /warmup`` endpoint.

Forces a synchronous lazy-reload of the OPF runner (and the Korean NER
runner when initialised). Returns once all required runners report
``is_loaded`` — or raises ``503`` for fatal OPF load failures and surfaces
non-fatal Korean NER failures via ``warnings``.

Designed for the TypeScript core's auto-start flow (ADR-0019): when the
container is up but the model has been idle-unloaded, the client calls
``/warmup`` with a generous timeout (``start_timeout_ms``, default 60s)
so the user's first ``/redact`` request hits a warm model and does not
pay cold-start cost under the default 5s request timeout.

Idempotent — already-loaded runners return immediately. Thread/coroutine
safe: model loads run on a worker thread via :func:`asyncio.to_thread`
and the runner's internal load lock serialises concurrent callers.

By design, ``/warmup`` does **not** count as ``/redact`` activity (just
like ``/health``). The middleware that bumps ``last_request_at`` keys on
``path.startswith("/redact")``; ``/warmup`` is excluded by virtue of its
path. The next genuine ``/redact`` will reset the idle clock as usual.
"""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, HTTPException, Request, status

from ..korean_ner_runner import KoreanNerRunner
from ..opf_runner import OpfRunner
from ..schemas import WarmupResponse

log = logging.getLogger(__name__)
router = APIRouter(tags=["warmup"])


@router.post("/warmup", response_model=WarmupResponse)
async def warmup(request: Request) -> WarmupResponse:
    t0 = time.monotonic()
    opf: OpfRunner | None = getattr(request.app.state, "opf_runner", None)
    kner: KoreanNerRunner | None = getattr(
        request.app.state, "korean_ner_runner", None
    )

    if opf is None:  # pragma: no cover - lifespan guarantees this
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OPF runner not initialised",
        )

    warnings: list[str] = []

    if not opf.is_loaded:
        try:
            await asyncio.to_thread(opf.load)
        except Exception as exc:
            log.exception("OPF warmup load failed")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"OPF load failed: {exc}",
            ) from exc

    if kner is not None and not kner.is_loaded:
        try:
            await asyncio.to_thread(kner.load)
        except Exception as exc:
            # Non-fatal: /redact will fall through to OPF + regex without
            # Korean NER, matching the silent-drop behaviour in
            # KoreanNerRunner.detect. We surface the failure as a warning
            # so the auto-start client can log it.
            log.warning("Korean NER warmup load failed: %s", exc)
            warnings.append(f"korean_ner_load_failed: {exc}")

    elapsed_ms = (time.monotonic() - t0) * 1000.0
    return WarmupResponse(
        ok=True,
        model_loaded=opf.is_loaded,
        korean_ner_loaded=bool(kner is not None and kner.is_loaded),
        elapsed_ms=elapsed_ms,
        warnings=warnings,
    )
