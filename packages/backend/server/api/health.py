"""``GET /health`` endpoint.

Deliberately cheap: reports configuration + model-loaded flag without
forcing a load. The Docker ``HEALTHCHECK`` uses this — failing-to-load
should surface as ``model_loaded: false`` rather than a 500, so the
container restart policy can decide what to do.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Request

from .. import __version__
from ..config import get_settings
from ..schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    settings = get_settings()
    runner = getattr(request.app.state, "opf_runner", None)
    model_loaded = bool(runner and runner.is_loaded)
    last_request_at: float | None = getattr(
        request.app.state, "last_request_at", None
    )
    seconds_since: float | None = (
        time.monotonic() - last_request_at if last_request_at is not None else None
    )
    idle_unloaded = bool(
        getattr(request.app.state, "idle_unloaded", False) and not model_loaded
    )
    return HealthResponse(
        ok=True,
        version=__version__,
        model=settings.model_id,
        device=settings.device,
        model_loaded=model_loaded,
        providers=list(runner.active_providers) if runner is not None else [],
        idle_unloaded=idle_unloaded,
        idle_timeout_seconds=max(0, int(settings.idle_timeout_seconds)),
        seconds_since_last_request=seconds_since,
    )
