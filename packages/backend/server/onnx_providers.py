"""Execution-provider selection, and telling the truth about what loaded.

``onnxruntime.get_available_providers()`` lists every provider compiled into
the wheel — not the ones whose shared libraries actually load. A CUDA 13 wheel
on a CUDA 12 base image passes that check, fails to ``dlopen``
``libonnxruntime_providers_cuda.so``, and then serves every request from the
CPU provider. The only trace is an ONNX Runtime warning on stderr at load time,
and ``/health`` echoes the *configured* device, so the GPU image cheerfully
reports ``device: cuda`` while running on the CPU.

``InferenceSession.get_providers()`` is the one call that reports what a
session actually got, so each session is checked against what it asked for and
the gap is logged where an operator will see it.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence

CUDA_PROVIDER = "CUDAExecutionProvider"
CPU_PROVIDER = "CPUExecutionProvider"

log = logging.getLogger(__name__)


def preferred_providers(device: str, available: Iterable[str]) -> list[str]:
    """Provider preference list for ``device``, CPU always last as a fallback."""

    if device == "cuda" and CUDA_PROVIDER in available:
        return [CUDA_PROVIDER, CPU_PROVIDER]
    return [CPU_PROVIDER]


def confirm_providers(
    session_providers: Sequence[str],
    requested: Sequence[str],
    *,
    component: str,
) -> None:
    """Warn when a session silently fell back to a provider it did not ask for."""

    if CUDA_PROVIDER in requested and CUDA_PROVIDER not in session_providers:
        log.warning(
            "%s requested the CUDA execution provider but the session is running "
            "on %s. The CUDA provider library failed to load — usually an "
            "onnxruntime-gpu built against a different CUDA major version than "
            "the image provides (check the ONNX Runtime warning above for the "
            "missing .so). Inference is running on the CPU.",
            component,
            ", ".join(session_providers) or "no provider",
        )
        return
    log.info("%s execution providers: %s", component, ", ".join(session_providers))
