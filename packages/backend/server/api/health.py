"""``GET /health`` endpoint.

Deliberately cheap: reports configuration + model-loaded flag without
forcing a load. The Docker ``HEALTHCHECK`` uses this — failing-to-load
should surface as ``model_loaded: false`` rather than a 500, so the
container restart policy can decide what to do.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from .. import __version__
from ..config import get_settings
from ..schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    settings = get_settings()
    runner = getattr(request.app.state, "opf_runner", None)
    return HealthResponse(
        ok=True,
        version=__version__,
        model=settings.model_id,
        device=settings.device,
        model_loaded=bool(runner and runner.is_loaded),
    )
