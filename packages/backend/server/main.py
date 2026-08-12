"""FastAPI entrypoint for the pii-remover OPF backend.

Run via uvicorn:

    uvicorn server.main:app --host 0.0.0.0 --port 8000

The lifespan loads the OPF model once at startup so the first request
doesn't pay the model-load cost. A background idle-timeout monitor
unloads model weights after ``OPF_IDLE_TIMEOUT_SECONDS`` of inactivity
on ``/redact*`` endpoints; the next request lazy-reloads.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response

from . import __version__
from .api import health as health_api
from .api import proxy as proxy_api
from .api import redact as redact_api
from .api import redact_image as redact_image_api
from .api import warmup as warmup_api
from .config import get_korean_ner_settings, get_settings
from .korean_ner_runner import KoreanNerRunner
from .opf_runner import OpfRunner

log = logging.getLogger(__name__)


async def _idle_unload_monitor(app: FastAPI) -> None:
    """Background task: unload models when idle > ``idle_timeout_seconds``.

    Polls every ``idle_check_interval_seconds``. Disabled when timeout is 0.
    Idempotent against already-unloaded runners.
    """

    settings = get_settings()
    timeout = max(0, int(settings.idle_timeout_seconds))
    interval = max(1, int(settings.idle_check_interval_seconds))
    if timeout <= 0:
        log.info("idle-unload monitor disabled (OPF_IDLE_TIMEOUT_SECONDS=0)")
        return
    log.info("idle-unload monitor running timeout=%ds interval=%ds", timeout, interval)
    try:
        while True:
            await asyncio.sleep(interval)
            last = getattr(app.state, "last_request_at", None)
            if last is None:
                continue
            elapsed = time.monotonic() - last
            if elapsed < timeout:
                continue
            opf = getattr(app.state, "opf_runner", None)
            kner = getattr(app.state, "korean_ner_runner", None)
            any_unloaded = False
            if opf is not None and getattr(opf, "is_loaded", False):
                try:
                    opf.unload()
                    any_unloaded = True
                except Exception:
                    log.exception("OPF unload failed in idle monitor")
            if kner is not None and getattr(kner, "is_loaded", False):
                try:
                    kner.unload()
                    any_unloaded = True
                except Exception:
                    log.exception("Korean NER unload failed in idle monitor")
            if any_unloaded:
                app.state.idle_unloaded = True
                log.info(
                    "models unloaded after %.0fs idle (timeout=%ds)",
                    elapsed,
                    timeout,
                )
    except asyncio.CancelledError:
        log.info("idle-unload monitor cancelled")
        raise


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Load OPF model once at startup, release reference at shutdown."""

    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    runner = OpfRunner(settings=settings)
    app.state.opf_runner = runner

    kner_settings = get_korean_ner_settings()
    kner_runner = KoreanNerRunner(settings=kner_settings)
    app.state.korean_ner_runner = kner_runner

    app.state.last_request_at = None
    app.state.idle_unloaded = False

    log.info(
        "pii-remover backend %s starting model=%s device=%s kner_model=%s",
        __version__,
        settings.model_id,
        settings.device,
        kner_settings.model_id,
    )
    try:
        runner.load()
    except Exception:
        log.exception("OPF model load failed; /health will report not-loaded")
    if kner_settings.preload:
        try:
            kner_runner.load()
        except Exception:
            log.exception("Korean NER preload failed; /redact will lazy-load Korean NER")

    monitor_task: asyncio.Task[None] | None = None
    if settings.idle_timeout_seconds > 0:
        monitor_task = asyncio.create_task(_idle_unload_monitor(app))

    try:
        yield
    finally:
        if monitor_task is not None:
            monitor_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await monitor_task
        client = getattr(app.state, "proxy_http_client", None)
        if client is not None:
            with contextlib.suppress(Exception):
                await client.aclose()
            app.state.proxy_http_client = None
        pool = getattr(app.state, "proxy_session_pool", None)
        if pool is not None:
            with contextlib.suppress(Exception):
                pool.dispose_all()
            app.state.proxy_session_pool = None
        app.state.opf_runner = None
        app.state.korean_ner_runner = None
        app.state.ocr_pipeline = None
        app.state.image_masker = None


async def _track_redact_activity(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Middleware: stamp ``last_request_at`` for ``/redact*`` endpoints.

    /health probes do NOT count as activity — otherwise Docker healthchecks
    would keep the model loaded forever.
    """

    response = await call_next(request)
    path = request.url.path
    if path.startswith("/redact") or path.startswith(proxy_api.PROXY_PATH_PREFIXES):
        request.app.state.last_request_at = time.monotonic()
        if getattr(request.app.state, "idle_unloaded", False):
            request.app.state.idle_unloaded = False
    return response


def create_app() -> FastAPI:
    """Application factory.

    Kept as a function so tests can build isolated apps with mocked runners.
    """

    app = FastAPI(
        title="pii-remover OPF backend",
        version=__version__,
        description=(
            "Self-built OPF HTTP API for the pii-remover project. "
            "Compatible with the gh0stkey OPF API surface (see ADR-0008)."
        ),
        lifespan=lifespan,
    )
    app.middleware("http")(_track_redact_activity)
    app.include_router(health_api.router)
    app.include_router(warmup_api.router)
    app.include_router(redact_api.router)
    app.include_router(redact_image_api.router)
    # MUST stay last: catch-all, shadows /health and /redact if moved up.
    app.include_router(proxy_api.router)
    return app


app = create_app()


__all__ = [
    "_idle_unload_monitor",
    "_track_redact_activity",
    "app",
    "create_app",
    "lifespan",
]
