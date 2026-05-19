"""HTTP API routers for the OPF backend.

Routers exposed:

- :mod:`server.api.health` — ``GET /health``
- :mod:`server.api.redact` — ``POST /redact``, ``POST /redact/text``,
  ``POST /redact/batch``
- :mod:`server.api.redact_image` — ``POST /redact/image`` (ADR-0009)
"""

from __future__ import annotations

from . import health, redact, redact_image

__all__ = ["health", "redact", "redact_image"]
