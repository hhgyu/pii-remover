"""Tesseract OCR wrapper for image PII redaction (ADR-0009 Phase 6).

Wraps ``pytesseract.image_to_data`` and converts its TSV/DICT output
into typed :class:`OcrWord` items plus a joined-text + character-offset
mapping that lets the regex pipeline's text spans be projected back
onto pixel regions.

Tesseract dict keys (verified against pytesseract 0.3.10+): ``level``,
``page_num``, ``block_num``, ``par_num``, ``line_num``, ``word_num``,
``left``, ``top``, ``width``, ``height``, ``conf``, ``text``. ``conf``
is an integer 0-100; ``-1`` is used for non-word levels (page/block/
paragraph/line entries) and occasionally for words Tesseract was
unsure about. We filter to ``level == 5`` (word-level entries with
non-empty text).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class OcrBox:
    """Pixel-space bounding box returned by Tesseract."""

    left: int
    top: int
    width: int
    height: int

    @property
    def right(self) -> int:
        return self.left + self.width

    @property
    def bottom(self) -> int:
        return self.top + self.height


@dataclass(frozen=True)
class OcrWord:
    """A single word-level OCR observation."""

    text: str
    bbox: OcrBox
    confidence: float
    word_index: int
    line_index: int


@dataclass(frozen=True)
class WordOffset:
    """Character offsets of one OCR word inside the joined OCR text."""

    word_index: int
    char_start: int
    char_end: int


class OcrError(RuntimeError):
    """Raised when the OCR backend (Tesseract) is unavailable or fails."""


def build_text_with_offsets(
    words: list[OcrWord],
) -> tuple[str, list[WordOffset]]:
    """Concatenate ``words`` with single-space separators and record offsets.

    The returned ``offsets`` list is in word order and contains the
    ``[char_start, char_end)`` range of each word inside the joined
    string, so a regex hit at ``text[a:b]`` can be mapped back to one
    or more word indices via :func:`map_span_to_word_indices`.
    """

    pieces: list[str] = []
    offsets: list[WordOffset] = []
    cursor = 0
    for w in words:
        if cursor > 0:
            pieces.append(" ")
            cursor += 1
        start = cursor
        pieces.append(w.text)
        cursor += len(w.text)
        offsets.append(
            WordOffset(
                word_index=w.word_index,
                char_start=start,
                char_end=cursor,
            )
        )
    return "".join(pieces), offsets


def map_span_to_word_indices(
    char_start: int,
    char_end: int,
    offsets: list[WordOffset],
) -> list[int]:
    """Return word indices whose char range overlaps ``[char_start, char_end)``.

    ``offsets`` is assumed sorted by ``char_start`` (the natural order
    produced by :func:`build_text_with_offsets`).
    """

    result: list[int] = []
    for off in offsets:
        if off.char_end <= char_start:
            continue
        if off.char_start >= char_end:
            break
        result.append(off.word_index)
    return result


class OcrPipeline:
    """Pytesseract wrapper. Stateless; safe to share across requests.

    Subclass or replace via :attr:`fastapi.FastAPI.state.ocr_pipeline`
    in tests to avoid requiring a real Tesseract binary.
    """

    def __init__(self, default_languages: str = "kor+eng") -> None:
        self.default_languages = default_languages

    def extract_words(
        self,
        image: Any,
        languages: str | None = None,
    ) -> list[OcrWord]:
        """Run Tesseract OCR and return word-level observations."""

        lang = languages or self.default_languages
        try:
            import pytesseract
            from pytesseract import Output
        except ImportError as exc:
            raise OcrError(
                "pytesseract not installed; cannot perform image redaction"
            ) from exc

        try:
            data: dict[str, list[Any]] = pytesseract.image_to_data(
                image, lang=lang, output_type=Output.DICT
            )
        except Exception as exc:
            log.exception("tesseract OCR call failed")
            raise OcrError("OCR backend invocation failed") from exc

        return _convert_tesseract_dict(data)


def _convert_tesseract_dict(data: dict[str, list[Any]]) -> list[OcrWord]:
    """Convert pytesseract ``Output.DICT`` into a list of :class:`OcrWord`.

    Filters to ``level == 5`` (word-level) entries with non-empty text.
    ``line_index`` is assigned in first-seen order over the
    ``(block_num, par_num, line_num)`` tuple so callers can group words
    by visual line for per-line bbox unions.
    """

    required = (
        "level",
        "block_num",
        "par_num",
        "line_num",
        "left",
        "top",
        "width",
        "height",
        "conf",
        "text",
    )
    for key in required:
        if key not in data:
            raise OcrError(f"tesseract output missing key {key!r}")

    line_id_to_index: dict[tuple[int, int, int], int] = {}
    words: list[OcrWord] = []
    word_index = 0

    n = len(data["text"])
    for i in range(n):
        try:
            level = int(data["level"][i])
        except (ValueError, TypeError):
            continue
        text = str(data["text"][i])
        if level != 5 or not text.strip():
            continue
        try:
            block = int(data["block_num"][i])
            par = int(data["par_num"][i])
            line = int(data["line_num"][i])
        except (ValueError, TypeError):
            continue
        line_key = (block, par, line)
        if line_key not in line_id_to_index:
            line_id_to_index[line_key] = len(line_id_to_index)
        line_idx = line_id_to_index[line_key]

        try:
            bbox = OcrBox(
                left=int(data["left"][i]),
                top=int(data["top"][i]),
                width=int(data["width"][i]),
                height=int(data["height"][i]),
            )
        except (ValueError, TypeError):
            continue

        try:
            conf = float(data["conf"][i])
        except (ValueError, TypeError):
            conf = -1.0

        words.append(
            OcrWord(
                text=text,
                bbox=bbox,
                confidence=conf,
                word_index=word_index,
                line_index=line_idx,
            )
        )
        word_index += 1

    return words
