"""Redaction endpoints.

All inference happens on a worker thread via :func:`asyncio.to_thread` so
the event loop can keep accepting requests while ``torch`` holds the GIL.
"""

from __future__ import annotations

import asyncio
import re
from typing import cast

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import PlainTextResponse

from ..config import get_settings
from ..korean_ner_runner import KoreanNerRunner, KoreanNerSpan
from ..opf_runner import OpfRunner, RawSpan
from ..regex_pipeline import RegexSpan, find_pii_spans
from ..schemas import (
    Detection,
    PiiLabel,
    RedactBatchRequest,
    RedactBatchResponse,
    RedactRequest,
    RedactResponse,
)

router = APIRouter(tags=["redact"])

_HANGUL_RE = re.compile(r"[\uAC00-\uD7AF\u1100-\u11FF]")


def _runner(request: Request) -> OpfRunner:
    runner: OpfRunner | None = getattr(request.app.state, "opf_runner", None)
    if runner is None:  # pragma: no cover - lifespan guarantees this
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OPF runner not initialised",
        )
    return runner


def _kner_runner(request: Request) -> KoreanNerRunner | None:
    return getattr(request.app.state, "korean_ner_runner", None)


def _regex_to_raw_spans(regex_spans: list[RegexSpan]) -> list[RawSpan]:
    return [
        RawSpan(
            start=s.start,
            end=s.end,
            label=s.category,
            score=s.confidence,
        )
        for s in regex_spans
    ]


def _merge_spans_and_mask(
    text: str,
    opf_result: RedactResponse,
    kner_spans: list[KoreanNerSpan],
    regex_spans: list[RegexSpan],
) -> RedactResponse:
    if not kner_spans and not regex_spans:
        return opf_result

    all_spans: list[RawSpan] = []
    # Regex spans first: they are deterministic, checksum-validated, and
    # should win ties against OPF model output for the same span.
    all_spans.extend(_regex_to_raw_spans(regex_spans))
    for d in opf_result.detections:
        all_spans.append(
            RawSpan(start=d.start, end=d.end, label=d.label, score=d.score)
        )
    for s in kner_spans:
        if s.klue_tag == "PS" and s.category == "private_person":
            all_spans.append(
                RawSpan(start=s.start, end=s.end, label="private_person", score=s.score)
            )

    all_spans.sort(key=lambda s: (s.start, -(s.end - s.start)))
    merged: list[RawSpan] = []
    last_end = -1
    for span in all_spans:
        if span.start < last_end:
            continue
        merged.append(span)
        last_end = span.end

    detections = [
        Detection(
            start=s.start,
            end=s.end,
            label=cast(PiiLabel, s.label),
            score=s.score,
            text=text[s.start : s.end],
        )
        for s in merged
    ]

    out = text
    for span in reversed(merged):
        placeholder = f"[OPF:{span.label.upper()}]"
        out = out[: span.start] + placeholder + out[span.end :]

    return RedactResponse(detections=detections, redacted_text=out)


@router.post("/redact", response_model=RedactResponse)
async def redact(request: Request, body: RedactRequest) -> RedactResponse:
    runner = _runner(request)
    opf_result = await asyncio.to_thread(runner.redact, body.text)

    regex_spans = await asyncio.to_thread(find_pii_spans, body.text)

    has_korean = bool(_HANGUL_RE.search(body.text))
    kner = _kner_runner(request) if has_korean else None
    person_spans: list[KoreanNerSpan] = []
    if kner is not None and kner.is_loaded:
        kner_spans = await asyncio.to_thread(
            kner.detect, body.text, body.korean_ner_min_confidence
        )
        person_spans = [s for s in kner_spans if s.klue_tag == "PS"]

    if not regex_spans and not person_spans:
        return opf_result

    return _merge_spans_and_mask(body.text, opf_result, person_spans, regex_spans)


@router.post("/redact/text", response_class=PlainTextResponse)
async def redact_text(request: Request, body: RedactRequest) -> str:
    result = await redact(request, body)
    return result.redacted_text


@router.post("/redact/batch", response_model=RedactBatchResponse)
async def redact_batch(
    request: Request, body: RedactBatchRequest
) -> RedactBatchResponse:
    settings = get_settings()
    if len(body.texts) > settings.batch_max:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"batch size {len(body.texts)} exceeds OPF_BATCH_MAX="
                f"{settings.batch_max}"
            ),
        )

    runner = _runner(request)
    kner = _kner_runner(request)

    def _process_batch() -> list[RedactResponse]:
        results = []
        for text in body.texts:
            opf_result = runner.redact(text)
            regex_spans = find_pii_spans(text)
            person_spans: list[KoreanNerSpan] = []
            if kner and kner.is_loaded and _HANGUL_RE.search(text):
                person_spans = [s for s in kner.detect(text) if s.klue_tag == "PS"]
            if regex_spans or person_spans:
                opf_result = _merge_spans_and_mask(
                    text, opf_result, person_spans, regex_spans
                )
            results.append(opf_result)
        return results

    results = await asyncio.to_thread(_process_batch)
    return RedactBatchResponse(results=results)
