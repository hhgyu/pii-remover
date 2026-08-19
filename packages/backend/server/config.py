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
- ``OPF_DISABLED_CATEGORIES`` (unset): comma-separated PII categories to drop
  before they reach the vault, e.g. ``private_url,private_date``.

Detection policy (see :mod:`server.detection_policy`):

- ``PII_URL_POLICY`` (``heuristic``): ``heuristic`` masks only URLs that carry
  credentials, resolve inside a network, or name a tenant workspace.
  ``strict`` masks every URL, which is what the model alone used to do.
- ``PII_PRIVATE_URL_HOSTS`` (unset): comma-separated extra hosts to treat as
  private, e.g. ``acme.com,git.acme.io``. Subdomains are covered.

Phase 7 (Korean NER, ADR-0007 v2):

- ``KNER_MODEL_ID`` (``soddokayo/koelectra-base-klue-ner``): HF model id for
  the Korean NER endpoint. Defaults to an Apache-2.0 KLUE-NER fine-tune.
- ``KNER_MODEL_REVISION`` (unset): pin a specific HF revision/hash.
- ``KNER_HF_CACHE_DIR`` (unset): override HF cache (defaults to OPF's).
- ``KNER_MIN_CONFIDENCE`` (``0.3``): drop spans below this score.
- ``KNER_PRELOAD`` (``0``): set to ``1`` to load weights at app startup
  instead of lazily on first request.
- ``KNER_ONNX_PATH`` (set inside Docker, unset elsewhere): directory containing
  pre-baked ``model_quantized.onnx`` (INT8) or ``model.onnx`` (FP32) plus the
  tokenizer files. INT8 is tried first, then FP32, then a PyTorch+HF download.
  The CPU images bake INT8 per Phase 7 PoC verdict C (scripts/POC-INT8.md) and
  point here at ``/models/klue-ner-int8``; the GPU image bakes FP32 at
  ``/models/klue-ner-fp32``, because the quantised operators have no CUDA
  kernels and run slower there than on the CPU provider.

Centralised here so ``opf_runner`` and ``main`` share one source of truth.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal, get_args

from .schemas import PiiLabel

Device = Literal["cpu", "cuda", "mps"]
OpfVariant = Literal["int8", "fp32"]
UrlPolicy = Literal["heuristic", "strict"]

_PII_LABELS: frozenset[str] = frozenset(get_args(PiiLabel))


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
        raise ValueError(f"environment variable {name}={raw!r} is not a valid integer") from exc


def _normalise_device(raw: str) -> Device:
    lowered = raw.strip().lower()
    if lowered in ("cpu", "cuda", "mps"):
        return lowered  # type: ignore[return-value]
    raise ValueError(f"OPF_DEVICE must be one of cpu|cuda|mps, got {raw!r}")


def _normalise_opf_variant(raw: str) -> OpfVariant:
    lowered = raw.strip().lower()
    if lowered in ("int8", "fp32"):
        return lowered  # type: ignore[return-value]
    raise ValueError(f"OPF_VARIANT must be one of int8|fp32, got {raw!r}")


def _normalise_url_policy(raw: str) -> UrlPolicy:
    lowered = raw.strip().lower()
    if lowered in ("heuristic", "strict"):
        return lowered  # type: ignore[return-value]
    raise ValueError(f"PII_URL_POLICY must be one of heuristic|strict, got {raw!r}")


def _env_csv(name: str) -> tuple[str, ...]:
    raw = os.environ.get(name)
    if raw is None:
        return ()
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _env_disabled_categories(name: str) -> frozenset[str]:
    """Parse a comma-separated category list, rejecting unknown labels.

    A typo here silently leaves PII flowing to the LLM, which is the one
    failure mode this project cannot absorb quietly — so it fails startup
    instead.
    """

    labels = {value.lower() for value in _env_csv(name)}
    unknown = sorted(labels - _PII_LABELS)
    if unknown:
        raise ValueError(
            f"{name} contains unknown categories {unknown}; "
            f"valid categories are {sorted(_PII_LABELS)}"
        )
    return frozenset(labels)


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
    idle_timeout_seconds: int
    idle_check_interval_seconds: int
    url_policy: UrlPolicy
    private_url_hosts: tuple[str, ...]
    disabled_categories: frozenset[str]


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
        idle_timeout_seconds=_env_int("OPF_IDLE_TIMEOUT_SECONDS", 1800),
        idle_check_interval_seconds=_env_int("OPF_IDLE_CHECK_INTERVAL_SECONDS", 60),
        url_policy=_normalise_url_policy(_env_str("PII_URL_POLICY", "heuristic")),
        private_url_hosts=_env_csv("PII_PRIVATE_URL_HOSTS"),
        disabled_categories=_env_disabled_categories("OPF_DISABLED_CATEGORIES"),
    )


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"environment variable {name}={raw!r} is not a valid float") from exc


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_category_set(name: str) -> frozenset[str]:
    """Parse a comma-separated category list into a normalised set.

    Empty / unset yields an empty set, i.e. "exclude nothing" — the
    fail-closed default, since a typo in the variable must never silently
    widen what reaches the LLM.
    """
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return frozenset()
    return frozenset(part.strip().lower() for part in raw.split(",") if part.strip())


_SECONDS_A_LONG_LLM_STREAM_MAY_RUN = 600.0


@dataclass(frozen=True)
class ProxySettings:
    """LLM proxy configuration (ADR-0004), served from this same process."""

    enabled: bool
    anthropic_upstream: str
    openai_upstream: str
    codex_upstream: str
    buffer_window: int
    flush_on_close: bool
    timeout_seconds: float
    excluded_categories: frozenset[str]


@lru_cache(maxsize=1)
def get_proxy_settings() -> ProxySettings:
    """Return the proxy settings singleton.

    ``enabled`` defaults to **off**. This image is also deployed standalone as a
    shared detection backend (trust tier 2), and turning that into an outbound
    LLM proxy by default would be a posture change nobody asked for: it would
    start relaying callers' API keys to api.anthropic.com. The merged
    single-service compose opts in explicitly via ``PII_PROXY_ENABLED=1``.
    """

    return ProxySettings(
        enabled=_env_bool("PII_PROXY_ENABLED", False),
        anthropic_upstream=_env_str("PII_PROXY_ANTHROPIC_UPSTREAM", "https://api.anthropic.com"),
        openai_upstream=_env_str("PII_PROXY_OPENAI_UPSTREAM", "https://api.openai.com"),
        codex_upstream=_env_str("PII_PROXY_CODEX_UPSTREAM", "https://api.openai.com"),
        buffer_window=_env_int("PII_PROXY_BUFFER_WINDOW", 64),
        flush_on_close=_env_bool("PII_PROXY_FLUSH_ON_CLOSE", True),
        timeout_seconds=_env_float("PII_PROXY_TIMEOUT_SECONDS", _SECONDS_A_LONG_LLM_STREAM_MAY_RUN),
        excluded_categories=_env_category_set("PII_PROXY_EXCLUDED_CATEGORIES"),
    )


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
            os.environ.get("KNER_HF_CACHE_DIR") or os.environ.get("OPF_HF_CACHE_DIR") or None
        ),
        onnx_model_path=os.environ.get("KNER_ONNX_PATH") or None,
        device=_normalise_device(_env_str("OPF_DEVICE", "cpu")),
        min_confidence=_env_float("KNER_MIN_CONFIDENCE", 0.3),
        preload=_env_bool("KNER_PRELOAD", False),
    )
