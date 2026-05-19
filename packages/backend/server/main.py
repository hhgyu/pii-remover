"""FastAPI entrypoint for the pii-remover OPF backend.

Run via uvicorn:

    uvicorn server.main:app --host 0.0.0.0 --port 8000

The lifespan loads the OPF model once at startup so the first request
doesn't pay the model-load cost.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from . import __version__
from .api import health as health_api
from .api import redact as redact_api
from .api import redact_image as redact_image_api
from .config import get_korean_ner_settings, get_settings
from .korean_ner_runner import KoreanNerRunner
from .opf_runner import OpfRunner

log = logging.getLogger(__name__)


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

    log.info(
        "pii-remover backend %s starting model=%s device=%s kner_model=%s",
        __version__,
        settings.model_id,
        settings.device,
        kner_settings.model_id,
    )
    try:
        runner.load()
    except Exception:  # noqa: BLE001 - intentional broad catch
        # Surface as model_loaded=false in /health rather than crashing the
        # process so docker healthcheck/restart policy can react.
        log.exception("OPF model load failed; /health will report not-loaded")
    if kner_settings.preload:
        try:
            kner_runner.load()
        except Exception:  # noqa: BLE001 - same fail-soft policy as OPF
            log.exception(
                "Korean NER preload failed; /redact will lazy-load Korean NER"
            )
    try:
        yield
    finally:
        app.state.opf_runner = None
        app.state.korean_ner_runner = None
        app.state.ocr_pipeline = None
        app.state.image_masker = None


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
    app.include_router(health_api.router)
    app.include_router(redact_api.router)
    app.include_router(redact_image_api.router)
    return app


app = create_app()
