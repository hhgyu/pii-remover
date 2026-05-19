"""Runtime configuration loaded from environment variables.

Environment variables (with defaults):

- ``OPF_DEVICE`` (``cpu`` | ``cuda`` | ``mps``): inference device.
- ``OPF_HOST``  (``0.0.0.0``): bind address.
- ``OPF_PORT``  (``8000``): bind port.
- ``OPF_MODEL_ID`` (``openai/privacy-filter``): HuggingFace model id.
- ``OPF_BATCH_MAX`` (``32``): max texts per ``/redact/batch`` call.
- ``OPF_LOG_LEVEL`` (``info``): uvicorn / app log level.
- ``OPF_MODEL_REVISION`` (unset): pin a specific HF revision/hash.
- ``OPF_HF_CACHE_DIR`` (unset): override transformers/HF cache directory.
- ``OPF_ONNX_PATH`` (``/models/opf-int8`` inside Docker, unset elsewhere):
  directory containing OPF ONNX artifacts + tokenizer/config files.
- ``OPF_VARIANT`` (``int8``): preferred ONNX variant (``int8`` | ``fp32``).

Phase 7 (Korean NER, ADR-0007 v2):

- ``KNER_MODEL_ID`` (``soddokayo/koelectra-base-klue-ner``): HF model id for
  the Korean NER endpoint. Defaults to an Apache-2.0 KLUE-NER fine-tune.
- ``KNER_MODEL_REVISION`` (unset): pin a specific HF revision/hash.
- ``KNER_HF_CACHE_DIR`` (unset): override HF cache (defaults to OPF's).
- ``KNER_MIN_CONFIDENCE`` (``0.3``): drop spans below this score.
- ``KNER_PRELOAD`` (``0``): set to ``1`` to load weights at app startup
  instead of lazily on first request.
- ``KNER_ONNX_PATH`` (``/models/klue-ner-int8`` inside Docker, unset elsewhere):
  directory containing pre-baked ``model_quantized.onnx`` (INT8) or
  ``model.onnx`` (FP32) plus the tokenizer files. Phase 7 PoC verdict C
  (see scripts/POC-INT8.md) selects INT8 by default; falls back to FP32
  if the INT8 file is missing and to PyTorch+HF download if neither
  ONNX file is present.

Centralised here so ``opf_runner`` and ``main`` share one source of truth.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

Device = Literal["cpu", "cuda", "mps"]
OpfVariant = Literal["int8", "fp32"]


def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(
            f"environment variable {name}={raw!r} is not a valid integer"
        ) from exc


def _normalise_device(raw: str) -> Device:
    lowered = raw.strip().lower()
    if lowered in ("cpu", "cuda", "mps"):
        return lowered  # type: ignore[return-value]
    raise ValueError(
        f"OPF_DEVICE must be one of cpu|cuda|mps, got {raw!r}"
    )


def _normalise_opf_variant(raw: str) -> OpfVariant:
    lowered = raw.strip().lower()
    if lowered in ("int8", "fp32"):
        return lowered  # type: ignore[return-value]
    raise ValueError(
        f"OPF_VARIANT must be one of int8|fp32, got {raw!r}"
    )


@dataclass(frozen=True)
class Settings:
    """Immutable runtime configuration."""

    device: Device
    host: str
    port: int
    model_id: str
    model_revision: str | None
    hf_cache_dir: str | None
    onnx_model_path: str | None
    opf_variant: OpfVariant
    batch_max: int
    log_level: str


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide settings singleton.

    ``lru_cache`` ensures we parse the environment once. Tests can override
    by clearing the cache via ``get_settings.cache_clear()``.
    """

    return Settings(
        device=_normalise_device(_env_str("OPF_DEVICE", "cpu")),
        host=_env_str("OPF_HOST", "0.0.0.0"),
        port=_env_int("OPF_PORT", 8000),
        model_id=_env_str("OPF_MODEL_ID", "openai/privacy-filter"),
        model_revision=os.environ.get("OPF_MODEL_REVISION") or None,
        hf_cache_dir=os.environ.get("OPF_HF_CACHE_DIR") or None,
        onnx_model_path=os.environ.get("OPF_ONNX_PATH") or None,
        opf_variant=_normalise_opf_variant(_env_str("OPF_VARIANT", "int8")),
        batch_max=_env_int("OPF_BATCH_MAX", 32),
        log_level=_env_str("OPF_LOG_LEVEL", "info"),
    )


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(
            f"environment variable {name}={raw!r} is not a valid float"
        ) from exc


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class KoreanNerSettings:
    """Immutable Korean NER (Phase 7) configuration."""

    model_id: str
    model_revision: str | None
    hf_cache_dir: str | None
    onnx_model_path: str | None
    device: Device
    min_confidence: float
    preload: bool


@lru_cache(maxsize=1)
def get_korean_ner_settings() -> KoreanNerSettings:
    """Return the Korean NER settings singleton (Phase 7)."""

    return KoreanNerSettings(
        model_id=_env_str("KNER_MODEL_ID", "soddokayo/koelectra-base-klue-ner"),
        model_revision=os.environ.get("KNER_MODEL_REVISION") or None,
        hf_cache_dir=(
            os.environ.get("KNER_HF_CACHE_DIR")
            or os.environ.get("OPF_HF_CACHE_DIR")
            or None
        ),
        onnx_model_path=os.environ.get("KNER_ONNX_PATH") or None,
        device=_normalise_device(_env_str("OPF_DEVICE", "cpu")),
        min_confidence=_env_float("KNER_MIN_CONFIDENCE", 0.3),
        preload=_env_bool("KNER_PRELOAD", False),
    )
