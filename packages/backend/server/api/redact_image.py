"""``POST /redact/image`` endpoint (ADR-0009 Phase 6).

Pipeline:

1. Decode base64 → raw bytes (8 MiB cap, fail-closed on malformed input).
2. PIL → :class:`PIL.Image.Image`.
3. Tesseract OCR via :class:`server.ocr_pipeline.OcrPipeline`.
4. Partition words by ``confidence_threshold`` → high-confidence text +
   low-confidence regions.
5. Regex pipeline finds PII spans in the high-confidence joined text.
6. Span char-offsets → word indices → per-line bbox unions.
7. ``policy_on_low_confidence`` decides what to do with low-confidence
   words: ``mask`` (mask conservatively), ``warn`` (don't mask, emit
   warning), ``block`` (return HTTP 422).
8. PIL ``ImageDraw`` paints rectangles for the chosen mask method.
9. Re-encode as PNG → base64.

Failure modes (fail-closed):

* Malformed base64 / undecodable image → HTTP 400.
* Image > 8 MiB → HTTP 413.
* Tesseract binary missing or invocation failed → HTTP 502.
* Unsupported mask method (``blur``/``pixelate`` in v1) → HTTP 501.
* policy=``block`` with any low-confidence word → HTTP 422.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import logging
import re
import time
from typing import Any, cast

from fastapi import APIRouter, HTTPException, Request, status

from ..image_masker import ImageMasker, MaskRegion
from ..ocr_pipeline import (
    OcrError,
    OcrPipeline,
    OcrWord,
    build_text_with_offsets,
    map_span_to_word_indices,
)
from ..regex_pipeline import ALL_REGEX_CATEGORIES, find_pii_spans
from ..schemas import (
    ImageDetection,
    ImageDimensions,
    ImageRedactRequest,
    ImageRedactResponse,
    PiiCategory,
    Region,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["redact-image"])

#: Hard cap on decoded image byte size, per ADR-0009 §Constraints.
MAX_IMAGE_BYTES = 8 * 1024 * 1024

#: Optional ``data:image/...;base64,`` URI prefix.
_DATA_URI_RE = re.compile(r"^data:image/[A-Za-z0-9.+\-]+;base64,")


def _decode_image_b64(b64: str) -> bytes:
    """Decode a base64 string into bytes (fail-closed on malformed input)."""

    cleaned = _DATA_URI_RE.sub("", b64.strip())
    try:
        raw = base64.b64decode(cleaned, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="invalid base64 image payload",
        ) from exc
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"image exceeds {MAX_IMAGE_BYTES} bytes",
        )
    if len(raw) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="empty image payload after base64 decode",
        )
    return raw


def _open_image(raw: bytes) -> Any:
    """Open ``raw`` as a PIL image; fail-closed with HTTP 400 on unknown formats."""

    from PIL import Image, UnidentifiedImageError

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="unable to decode image",
        ) from exc
    return img


def _languages_to_tesseract(langs: list[str] | None) -> str | None:
    if not langs:
        return None
    return "+".join(langs)


def _encode_image_png(image: Any) -> str:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _word_to_region(word: OcrWord) -> Region:
    return Region(
        left=word.bbox.left,
        top=word.bbox.top,
        width=max(1, word.bbox.width),
        height=max(1, word.bbox.height),
    )


def _union_per_line(words: list[OcrWord]) -> list[Region]:
    by_line: dict[int, list[OcrWord]] = {}
    for w in words:
        by_line.setdefault(w.line_index, []).append(w)

    regions: list[Region] = []
    for line_idx in sorted(by_line.keys()):
        line_words = by_line[line_idx]
        left = min(w.bbox.left for w in line_words)
        top = min(w.bbox.top for w in line_words)
        right = max(w.bbox.left + w.bbox.width for w in line_words)
        bottom = max(w.bbox.top + w.bbox.height for w in line_words)
        regions.append(
            Region(
                left=left,
                top=top,
                width=max(1, right - left),
                height=max(1, bottom - top),
            )
        )
    return regions


def _region_to_mask(r: Region) -> MaskRegion:
    return MaskRegion(left=r.left, top=r.top, width=r.width, height=r.height)


def _process_image_sync(
    image: Any,
    request: ImageRedactRequest,
    ocr_pipeline: OcrPipeline,
    masker: ImageMasker,
) -> ImageRedactResponse:
    start_ts = time.perf_counter()

    languages = _languages_to_tesseract(request.languages)

    try:
        ocr_words = ocr_pipeline.extract_words(image, languages=languages)
    except OcrError as exc:
        log.warning("OCR backend error: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="OCR backend unavailable",
        ) from exc

    threshold = request.confidence_threshold
    high_conf_words: list[OcrWord] = []
    low_conf_words: list[OcrWord] = []
    for w in ocr_words:
        if w.confidence >= threshold:
            high_conf_words.append(w)
        else:
            low_conf_words.append(w)

    low_conf_regions = [_word_to_region(w) for w in low_conf_words]

    if low_conf_words and request.policy_on_low_confidence == "block":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"{len(low_conf_words)} OCR word(s) below confidence "
                f"threshold {threshold}; policy_on_low_confidence='block'"
            ),
        )

    text, offsets = build_text_with_offsets(high_conf_words)

    categories_filter: frozenset[str] | None = None
    if request.categories:
        categories_filter = frozenset(
            c for c in request.categories if c in ALL_REGEX_CATEGORIES
        )

    spans = find_pii_spans(text, categories=categories_filter)

    word_lookup: dict[int, OcrWord] = {w.word_index: w for w in high_conf_words}

    detections: list[ImageDetection] = []
    mask_regions: list[MaskRegion] = []

    for span in spans:
        word_indices = map_span_to_word_indices(span.start, span.end, offsets)
        if not word_indices:
            continue
        span_words = [word_lookup[idx] for idx in word_indices if idx in word_lookup]
        if not span_words:
            continue
        regions = _union_per_line(span_words)
        detections.append(
            ImageDetection(
                label=cast(PiiCategory, span.category),
                score=span.confidence,
                text=span.text,
                regions=regions,
                text_start=span.start,
                text_end=span.end,
            )
        )
        for r in regions:
            mask_regions.append(_region_to_mask(r))

    warnings: list[str] = []

    if low_conf_words:
        if request.policy_on_low_confidence == "mask":
            for w in low_conf_words:
                mask_regions.append(
                    MaskRegion(
                        left=w.bbox.left,
                        top=w.bbox.top,
                        width=max(1, w.bbox.width),
                        height=max(1, w.bbox.height),
                    )
                )
        elif request.policy_on_low_confidence == "warn":
            warnings.append(
                f"{len(low_conf_words)} OCR word(s) below confidence threshold "
                f"{threshold} were not masked (policy='warn')"
            )

    if request.mask_method == "fill":
        masked_image = masker.apply_fill_mask(image, mask_regions)
    elif request.mask_method == "blur":
        try:
            masked_image = masker.apply_blur_mask(image, mask_regions)
        except NotImplementedError as exc:
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail=str(exc),
            ) from exc
    elif request.mask_method == "pixelate":
        try:
            masked_image = masker.apply_pixelate_mask(image, mask_regions)
        except NotImplementedError as exc:
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail=str(exc),
            ) from exc
    else:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=f"mask_method={request.mask_method!r} not supported",
        )

    redacted_b64 = _encode_image_png(masked_image)
    elapsed_ms = (time.perf_counter() - start_ts) * 1000.0

    return ImageRedactResponse(
        redacted_image_b64=redacted_b64,
        detections=detections,
        low_confidence_regions=low_conf_regions,
        ocr_text=text if text else None,
        image_dimensions=ImageDimensions(width=image.width, height=image.height),
        processing_time_ms=elapsed_ms,
        warnings=warnings,
    )


def _get_pipeline(request: Request) -> OcrPipeline:
    pipeline: OcrPipeline | None = getattr(request.app.state, "ocr_pipeline", None)
    if pipeline is None:
        pipeline = OcrPipeline()
        request.app.state.ocr_pipeline = pipeline
    return pipeline


def _get_masker(request: Request) -> ImageMasker:
    masker: ImageMasker | None = getattr(request.app.state, "image_masker", None)
    if masker is None:
        masker = ImageMasker()
        request.app.state.image_masker = masker
    return masker


@router.post("/redact/image", response_model=ImageRedactResponse)
async def redact_image(
    request: Request, body: ImageRedactRequest
) -> ImageRedactResponse:
    raw = _decode_image_b64(body.image_b64)
    image = _open_image(raw)

    ocr_pipeline = _get_pipeline(request)
    masker = _get_masker(request)

    return await asyncio.to_thread(
        _process_image_sync, image, body, ocr_pipeline, masker
    )
