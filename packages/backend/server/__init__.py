"""pii-remover backend server package.

FastAPI service wrapping the ``openai/privacy-filter`` token-classification
model. API surface is compatible with the gh0stkey OPF HTTP API so that the
two backends are drop-in interchangeable (see ADR-0008).
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.0.1"
