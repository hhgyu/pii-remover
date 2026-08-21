"""Pydantic v2 request/response schemas for the OPF HTTP API.

Schema shapes intentionally mirror the gh0stkey OPF HTTP API surface so that
clients can swap between backends (see ADR-0008). Labels follow the OPF
8-category taxonomy (see ADR-0010), extended with Korean-specific
categories (``rrn``, ``biz_num``, ``card``) for the Phase 6 image
redaction endpoint (ADR-0009).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

#: PII taxonomy returned by ``/redact``: OPF 8 categories (ADR-0010) plus
#: the Korean regex categories (``rrn``, ``biz_num``, ``card``) supplied by
#: :mod:`server.regex_pipeline`. ``OpfLabel`` is preserved as a backward-
#: compat alias; ``PiiLabel`` is the preferred name for new code.
PiiLabel = Literal[
    "account_number",
    "private_address",
    "private_email",
    "private_person",
    "private_phone",
    "private_url",
    "private_date",
    "secret",
    "rrn",
    "biz_num",
    "card",
]

OpfLabel = PiiLabel


class Detection(BaseModel):
    """A single PII span detected in an input text."""

    model_config = ConfigDict(extra="forbid")

    start: int = Field(..., ge=0, description="Inclusive UTF-16 code unit offset")
    end: int = Field(..., ge=0, description="Exclusive UTF-16 code unit offset")
    label: PiiLabel = Field(
        ...,
        description=(
            "PII category. OPF 8 categories (ADR-0010) plus Korean regex "
            "extensions: rrn, biz_num, card."
        ),
    )
    score: float = Field(..., ge=0.0, le=1.0, description="Aggregate confidence")
    text: str = Field(..., description="Original PII surface form")


class RedactRequest(BaseModel):
    """Single-text redaction request body."""

    model_config = ConfigDict(extra="forbid")

    text: str = Field(..., description="Free-form text to redact")
    korean_ner_min_confidence: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "Override the server-side Korean NER min_confidence for this "
            "request. When omitted the server default (KNER_MIN_CONFIDENCE) "
            "is used."
        ),
    )


class RedactResponse(BaseModel):
    """Single-text redaction response body.

    ``redacted_text`` substitutes each detected span with a placeholder of the
    form ``[OPF:<LABEL>]``. The TypeScript core re-tokenises into the
    ``{{OPF:<CATEGORY>:<INDEX>__`` form (ADR-0002) with a vault index — this
    server is intentionally stateless and does not track indices.
    """

    model_config = ConfigDict(extra="forbid")

    detections: list[Detection] = Field(default_factory=list)
    redacted_text: str = Field(..., description="Text with PII spans masked")


class RedactBatchRequest(BaseModel):
    """Batched redaction request body."""

    model_config = ConfigDict(extra="forbid")

    texts: list[str] = Field(..., min_length=1)
    korean_ner_min_confidence: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "Override the server-side Korean NER min_confidence for this "
            "request. When omitted the server default (KNER_MIN_CONFIDENCE) "
            "is used."
        ),
    )


class RedactBatchResponse(BaseModel):
    """Batched redaction response body."""

    model_config = ConfigDict(extra="forbid")

    results: list[RedactResponse]


class HealthResponse(BaseModel):
    """Health probe response body."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    version: str
    model: str
    device: Literal["cpu", "cuda", "mps"]
    model_loaded: bool = Field(
        ...,
        description=(
            "True once the OPF model weights and tokenizer are loaded in memory."
        ),
    )
    providers: list[str] = Field(
        default_factory=list,
        description=(
            "ONNX Runtime execution providers the loaded OPF session actually "
            "holds, most-preferred first. Empty while the model is unloaded. "
            "``device`` above is what was *requested*; when a GPU image is "
            "missing a matching CUDA runtime, ONNX Runtime falls back to "
            "CPUExecutionProvider without failing, and only this field shows it."
        ),
    )
    idle_unloaded: bool = Field(
        default=False,
        description=(
            "True when the model has been released from memory due to "
            "inactivity. The next request lazy-reloads the model."
        ),
    )
    idle_timeout_seconds: int = Field(
        default=0,
        ge=0,
        description=(
            "Configured idle-unload timeout in seconds. 0 means disabled."
        ),
    )
    seconds_since_last_request: float | None = Field(
        default=None,
        description=(
            "Wall-clock seconds since the last successful /redact request, "
            "or null if no request has been served yet."
        ),
    )


class WarmupResponse(BaseModel):
    """Response body for ``POST /warmup``.

    The ``/warmup`` endpoint forces a synchronous lazy-reload of the OPF
    runner (and the Korean NER runner when initialised). It is intended
    for the TypeScript core's auto-start flow (ADR-0019): when the
    container is already up but the model has been idle-unloaded, the
    client calls ``/warmup`` with a generous timeout so the user's first
    ``/redact`` request hits a warm model and does not pay cold-start
    cost under the default 5s request timeout.

    OPF failures map to ``503``. Korean NER failures are non-fatal and
    are surfaced via ``warnings`` so the client can log them — this
    mirrors the silent fall-through in ``KoreanNerRunner.detect``.
    """

    model_config = ConfigDict(extra="forbid")

    ok: bool = Field(
        ...,
        description="True when the OPF runner is loaded after the call.",
    )
    model_loaded: bool = Field(
        ...,
        description="True when the OPF runner is loaded after the call.",
    )
    korean_ner_loaded: bool = Field(
        ...,
        description=(
            "True when the Korean NER runner is loaded after the call. "
            "False when the runner is not initialised or its load failed."
        ),
    )
    elapsed_ms: float = Field(
        ..., ge=0.0, description="Wall-clock duration of the warmup call."
    )
    warnings: list[str] = Field(
        default_factory=list,
        description=(
            "Non-fatal issues surfaced during warmup (e.g. Korean NER "
            "load failure). Each entry is a short tagged string."
        ),
    )


# ---------------------------------------------------------------------------
# Phase 6 / ADR-0009: image redaction schemas
# ---------------------------------------------------------------------------

#: ``PiiCategory`` is retained as a public alias for the image endpoint; it
#: shares the 11-category taxonomy with :data:`PiiLabel`.
PiiCategory = PiiLabel


MaskMethod = Literal["fill", "blur", "pixelate"]
LowConfidencePolicy = Literal["mask", "warn", "block"]


class Region(BaseModel):
    """Pixel-space rectangle."""

    model_config = ConfigDict(extra="forbid")

    left: int = Field(..., ge=0)
    top: int = Field(..., ge=0)
    width: int = Field(..., gt=0)
    height: int = Field(..., gt=0)


class ImageDimensions(BaseModel):
    """Width/height of the input (and redacted output) image, in pixels."""

    model_config = ConfigDict(extra="forbid")

    width: int = Field(..., gt=0)
    height: int = Field(..., gt=0)


class ImageDetection(BaseModel):
    """A PII span detected in OCR text, with pixel regions for masking.

    A span may cover multiple OCR words on different lines; in that case
    ``regions`` contains one entry per visual line (bbox union of the
    line's covered words) so the renderer can draw separate rectangles
    rather than a single oversized one.
    """

    model_config = ConfigDict(extra="forbid")

    label: PiiCategory
    score: float = Field(..., ge=0.0, le=1.0)
    text: str
    regions: list[Region] = Field(..., min_length=1)
    text_start: int = Field(
        ..., ge=0, description="Char offset of the span in the joined OCR text."
    )
    text_end: int = Field(
        ..., ge=0, description="Char-exclusive end offset in the joined OCR text."
    )


class ImageRedactRequest(BaseModel):
    """Request body for ``POST /redact/image``.

    All fields except ``image_b64`` are optional with conservative
    defaults. The payload is the base64-encoded image bytes (a
    ``data:image/...;base64,`` URI prefix is also accepted).
    """

    model_config = ConfigDict(extra="forbid")

    image_b64: str = Field(..., min_length=1)
    languages: list[str] | None = Field(
        default=None,
        description=(
            "Tesseract language codes (e.g. ['kor','eng']). When None, "
            "falls back to the server default 'kor+eng'."
        ),
    )
    mask_method: MaskMethod = Field(default="fill")
    confidence_threshold: float = Field(
        default=60.0,
        ge=0.0,
        le=100.0,
        description="OCR confidence below which a word is 'low confidence'.",
    )
    policy_on_low_confidence: LowConfidencePolicy = Field(default="mask")
    categories: list[PiiCategory] | None = Field(
        default=None,
        description="Restrict detection to these PII categories.",
    )


class ImageRedactResponse(BaseModel):
    """Response body for ``POST /redact/image``."""

    model_config = ConfigDict(extra="forbid")

    redacted_image_b64: str
    detections: list[ImageDetection] = Field(default_factory=list)
    low_confidence_regions: list[Region] = Field(default_factory=list)
    ocr_text: str | None = None
    image_dimensions: ImageDimensions
    processing_time_ms: float = Field(..., ge=0.0)
    warnings: list[str] = Field(default_factory=list)
