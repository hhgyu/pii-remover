"""Execution-provider selection and the fallback warning.

The bug these cover: ``onnxruntime-gpu`` 1.27+ is built against CUDA 13, the
GPU image ships CUDA 12.9, and the CUDA provider library therefore fails to
load. ``get_available_providers()`` still lists ``CUDAExecutionProvider``
because it is compiled into the wheel, so the old check passed and every
request ran on the CPU while ``/health`` reported ``device: cuda``.
"""

from __future__ import annotations

import logging

from server.onnx_providers import (
    CPU_PROVIDER,
    CUDA_PROVIDER,
    confirm_providers,
    preferred_providers,
)

ALL = (CUDA_PROVIDER, CPU_PROVIDER)


def test_cuda_requested_and_available() -> None:
    assert preferred_providers("cuda", ALL) == [CUDA_PROVIDER, CPU_PROVIDER]


def test_cuda_requested_but_not_compiled_in() -> None:
    assert preferred_providers("cuda", (CPU_PROVIDER,)) == [CPU_PROVIDER]


def test_cpu_never_asks_for_cuda() -> None:
    assert preferred_providers("cpu", ALL) == [CPU_PROVIDER]


def test_silent_cpu_fallback_is_warned(caplog: logging.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="server.onnx_providers"):
        confirm_providers(
            [CPU_PROVIDER],
            [CUDA_PROVIDER, CPU_PROVIDER],
            component="OPF",
        )
    assert any(r.levelno == logging.WARNING for r in caplog.records)
    message = caplog.text
    assert "OPF" in message
    assert "CPUExecutionProvider" in message
    assert "onnxruntime-gpu" in message


def test_cuda_actually_obtained_does_not_warn(
    caplog: logging.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.INFO, logger="server.onnx_providers"):
        confirm_providers(
            [CUDA_PROVIDER, CPU_PROVIDER],
            [CUDA_PROVIDER, CPU_PROVIDER],
            component="OPF",
        )
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_cpu_only_session_does_not_warn(caplog: logging.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger="server.onnx_providers"):
        confirm_providers([CPU_PROVIDER], [CPU_PROVIDER], component="Korean NER")
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
