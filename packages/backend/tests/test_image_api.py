"""End-to-end tests for ``POST /redact/image`` (ADR-0009 Phase 6).

A :class:`FakeOcrPipeline` returns pre-canned :class:`OcrWord` lists so
the tests don't require a real Tesseract install. A separate
``@pytest.mark.integration`` test exercises the real binary and is
skipped automatically when the binary is not on ``PATH``.
"""

from __future__ import annotations

import base64
import io
import shutil
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.api import redact_image as redact_image_api
from server.image_masker import ImageMasker
from server.ocr_pipeline import OcrBox, OcrPipeline, OcrWord

from .fixtures.image_helpers import image_to_b64, make_text_image


class FakeOcrPipeline(OcrPipeline):
    """OCR pipeline that returns a pre-canned word list."""

    def __init__(self, words: list[OcrWord]) -> None:
        super().__init__()
        self._words = words

    def extract_words(
        self, image: Any, languages: str | None = None
    ) -> list[OcrWord]:
        return list(self._words)


def _make_app(ocr_pipeline: OcrPipeline) -> FastAPI:
    app = FastAPI()
    app.include_router(redact_image_api.router)
    app.state.ocr_pipeline = ocr_pipeline
    app.state.image_masker = ImageMasker()
    return app


def _client(ocr_pipeline: OcrPipeline) -> TestClient:
    return TestClient(_make_app(ocr_pipeline))


def _png_b64() -> str:
    img = make_text_image(["hello"], width=400, height=80, font_size=24)
    return image_to_b64(img)


def _word(
    text: str,
    word_index: int,
    line_index: int = 0,
    *,
    left: int = 10,
    top: int = 10,
    width: int = 100,
    height: int = 30,
    confidence: float = 96.0,
) -> OcrWord:
    return OcrWord(
        text=text,
        bbox=OcrBox(left=left, top=top, width=width, height=height),
        confidence=confidence,
        word_index=word_index,
        line_index=line_index,
    )


def test_happy_path_single_email_detection() -> None:
    pipeline = FakeOcrPipeline(
        [
            _word("Contact", 0, left=10),
            _word("user@example.com", 1, left=130, width=180),
            _word("today", 2, left=320),
        ]
    )
    client = _client(pipeline)
    response = client.post("/redact/image", json={"image_b64": _png_b64()})
    assert response.status_code == 200, response.text
    body = response.json()

    assert len(body["detections"]) == 1
    det = body["detections"][0]
    assert det["label"] == "private_email"
    assert det["text"] == "user@example.com"
    assert len(det["regions"]) == 1

    assert body["image_dimensions"]["width"] > 0
    assert body["image_dimensions"]["height"] > 0
    assert body["processing_time_ms"] >= 0.0

    raw = base64.b64decode(body["redacted_image_b64"])
    assert raw[:8] == b"\x89PNG\r\n\x1a\n", "redacted image must be a valid PNG"


def test_multiple_pii_email_plus_rrn() -> None:
    pipeline = FakeOcrPipeline(
        [
            _word("Email", 0, left=10),
            _word("alice@example.com", 1, left=80, width=180),
            _word("RRN", 2, line_index=1, left=10, top=60),
            _word("900101-1023483", 3, line_index=1, left=80, top=60, width=160),
        ]
    )
    client = _client(pipeline)
    response = client.post("/redact/image", json={"image_b64": _png_b64()})
    assert response.status_code == 200, response.text
    body = response.json()

    labels = sorted(d["label"] for d in body["detections"])
    assert "private_email" in labels
    assert "rrn" in labels
    assert len(body["detections"]) == 2


def test_clean_image_zero_detections() -> None:
    pipeline = FakeOcrPipeline(
        [
            _word("The", 0),
            _word("quick", 1, left=60),
            _word("brown", 2, left=130),
            _word("fox", 3, left=210),
        ]
    )
    client = _client(pipeline)
    img_b64 = _png_b64()
    response = client.post("/redact/image", json={"image_b64": img_b64})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["detections"] == []
    assert body["low_confidence_regions"] == []

    from PIL import Image

    img_in = Image.open(io.BytesIO(base64.b64decode(img_b64)))
    img_out = Image.open(io.BytesIO(base64.b64decode(body["redacted_image_b64"])))
    assert img_in.size == img_out.size


def test_low_confidence_word_excluded_from_pii_detection() -> None:
    pipeline = FakeOcrPipeline(
        [
            _word("clean", 0, confidence=95.0),
            _word("user@example.com", 1, left=80, width=180, confidence=30.0),
        ]
    )
    client = _client(pipeline)
    response = client.post(
        "/redact/image",
        json={
            "image_b64": _png_b64(),
            "confidence_threshold": 60.0,
            "policy_on_low_confidence": "warn",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["detections"] == []
    assert len(body["low_confidence_regions"]) == 1


def test_policy_block_returns_422_on_low_confidence() -> None:
    pipeline = FakeOcrPipeline(
        [
            _word("low", 0, confidence=20.0),
            _word("high", 1, confidence=95.0, left=60),
        ]
    )
    client = _client(pipeline)
    response = client.post(
        "/redact/image",
        json={"image_b64": _png_b64(), "policy_on_low_confidence": "block"},
    )
    assert response.status_code == 422
    body = response.json()
    assert "block" in body["detail"]


def test_policy_warn_emits_response_warning() -> None:
    pipeline = FakeOcrPipeline([_word("low", 0, confidence=20.0)])
    client = _client(pipeline)
    response = client.post(
        "/redact/image",
        json={"image_b64": _png_b64(), "policy_on_low_confidence": "warn"},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["warnings"]) >= 1
    assert "warn" in body["warnings"][0]
    assert len(body["low_confidence_regions"]) == 1


def test_policy_mask_includes_low_confidence_regions_in_mask_set() -> None:
    pipeline = FakeOcrPipeline(
        [_word("possibly_pii", 0, confidence=20.0, left=50, width=200)]
    )
    client = _client(pipeline)
    response = client.post(
        "/redact/image",
        json={"image_b64": _png_b64(), "policy_on_low_confidence": "mask"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["warnings"] == []
    assert len(body["low_confidence_regions"]) == 1


def test_invalid_base64_returns_400() -> None:
    pipeline = FakeOcrPipeline([])
    client = _client(pipeline)
    response = client.post("/redact/image", json={"image_b64": "not!!base64==!!"})
    assert response.status_code == 400


def test_undecodable_image_bytes_returns_400() -> None:
    pipeline = FakeOcrPipeline([])
    client = _client(pipeline)
    junk_b64 = base64.b64encode(b"not an image at all").decode("ascii")
    response = client.post("/redact/image", json={"image_b64": junk_b64})
    assert response.status_code == 400


def test_unsupported_mask_method_blur_returns_501() -> None:
    pipeline = FakeOcrPipeline([_word("user@example.com", 0, width=180)])
    client = _client(pipeline)
    response = client.post(
        "/redact/image",
        json={"image_b64": _png_b64(), "mask_method": "blur"},
    )
    assert response.status_code == 501


def test_unsupported_mask_method_pixelate_returns_501() -> None:
    pipeline = FakeOcrPipeline([_word("user@example.com", 0, width=180)])
    client = _client(pipeline)
    response = client.post(
        "/redact/image",
        json={"image_b64": _png_b64(), "mask_method": "pixelate"},
    )
    assert response.status_code == 501


def test_image_size_limit_returns_413() -> None:
    pipeline = FakeOcrPipeline([])
    client = _client(pipeline)
    big = b"X" * (9 * 1024 * 1024)
    payload = base64.b64encode(big).decode("ascii")
    response = client.post("/redact/image", json={"image_b64": payload})
    assert response.status_code == 413


def test_data_uri_prefix_is_accepted() -> None:
    pipeline = FakeOcrPipeline([])
    client = _client(pipeline)
    img_b64 = _png_b64()
    response = client.post(
        "/redact/image",
        json={"image_b64": f"data:image/png;base64,{img_b64}"},
    )
    assert response.status_code == 200


def test_categories_filter_restricts_detection() -> None:
    pipeline = FakeOcrPipeline(
        [
            _word("alice@example.com", 0, width=180),
            _word("900101-1023483", 1, left=200, width=160),
        ]
    )
    client = _client(pipeline)
    response = client.post(
        "/redact/image",
        json={"image_b64": _png_b64(), "categories": ["rrn"]},
    )
    assert response.status_code == 200
    body = response.json()
    labels = {d["label"] for d in body["detections"]}
    assert labels == {"rrn"}


def test_extra_fields_rejected_with_422() -> None:
    pipeline = FakeOcrPipeline([])
    client = _client(pipeline)
    response = client.post(
        "/redact/image",
        json={"image_b64": _png_b64(), "evil": True},
    )
    assert response.status_code == 422


def test_ocr_error_returns_502() -> None:
    class BrokenPipeline(OcrPipeline):
        def extract_words(
            self, image: Any, languages: str | None = None
        ) -> list[OcrWord]:
            from server.ocr_pipeline import OcrError

            raise OcrError("tesseract not found")

    client = _client(BrokenPipeline())
    response = client.post("/redact/image", json={"image_b64": _png_b64()})
    assert response.status_code == 502


@pytest.mark.integration
def test_real_tesseract_on_clean_image() -> None:
    """Smoke test that exercises the real Tesseract binary if installed."""

    if shutil.which("tesseract") is None:
        pytest.skip("tesseract binary not installed")

    pipeline = OcrPipeline()
    app = _make_app(pipeline)
    with TestClient(app) as client:
        img = make_text_image(["hello world"], width=600, height=120, font_size=36)
        response = client.post(
            "/redact/image",
            json={"image_b64": image_to_b64(img), "languages": ["eng"]},
        )
        assert response.status_code == 200, response.text
