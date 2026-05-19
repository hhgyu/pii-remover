"""Deterministic regex-based PII detector for OCR text (ADR-0009 Phase 6).

Python port of ``packages/core/src/detector/regex/*`` (TypeScript). Covers
Korean RRN, business registration number, Korean mobile phone, generic
email, and credit card numbers (LUHN). Reused by the image redaction
pipeline for fast, deterministic span detection without depending on
the OPF token-classification model.

The OPF model can produce false positives on noisy OCR output, so
Phase 6 image redaction uses only regex/checksum detectors. English PII
categories owned exclusively by OPF (``private_person``,
``private_address``, ``private_url``, ``secret``, ``private_date``,
``account_number``) are deferred to a later phase (see ADR-0009 §Phase 7
KLUE-NER integration). Korean given-name heuristics are *intentionally*
excluded here per the Phase 6 plan to avoid OCR-driven false positives.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final, Literal

#: Categories detectable by the regex pipeline. Subset of the broader
#: ``server.schemas.PiiCategory`` Literal — values are intentionally the
#: same strings so a successful match is assignable to ``PiiCategory``.
RegexCategory = Literal[
    "private_email",
    "private_phone",
    "rrn",
    "biz_num",
    "card",
]

ALL_REGEX_CATEGORIES: Final[frozenset[str]] = frozenset(
    {
        "private_email",
        "private_phone",
        "rrn",
        "biz_num",
        "card",
    }
)


@dataclass(frozen=True)
class RegexSpan:
    """A single PII span detected in text."""

    start: int
    end: int
    category: RegexCategory
    confidence: float
    text: str


# --- patterns ---------------------------------------------------------------

#: Email regex aligned byte-for-byte with the TS core detector
#: (``packages/core/src/backend/local-regex.ts`` ``EMAIL_REGEX``). The
#: leading/trailing ``\b`` anchors are required for TS↔Python parity.
_EMAIL_RE: Final[re.Pattern[str]] = re.compile(
    r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"
)

#: Korean mobile-phone pattern from ``packages/core/.../korean-phone.ts``.
_KR_PHONE_RE: Final[re.Pattern[str]] = re.compile(
    r"\b01[016-9]-?\d{3,4}-?\d{4}\b"
)

#: Korean RRN shape from ``packages/core/.../korean-rrn.ts``.
_RRN_RE: Final[re.Pattern[str]] = re.compile(r"\b\d{6}-?[1-4]\d{6}\b")

#: Korean BIZNUM shape from ``packages/core/.../korean-biznum.ts``.
_BIZNUM_RE: Final[re.Pattern[str]] = re.compile(r"\b\d{3}-?\d{2}-?\d{5}\b")

#: Credit-card shape: exactly 16 digits in 4-4-4-4 groups, optional ``-``
#: or space separators. Matches ``CARD_REGEX`` in
#: ``packages/core/src/backend/local-regex.ts`` for strict TS↔Python parity.
#: Non-Visa/MC layouts (15-digit Amex, 14-digit Diners) are intentionally
#: NOT matched here to avoid false positives on plain numeric content.
_CARD_RE: Final[re.Pattern[str]] = re.compile(r"\b(?:\d{4}[- ]?){3}\d{4}\b")


_RRN_WEIGHTS: Final[tuple[int, ...]] = (2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5)
_BIZNUM_WEIGHTS: Final[tuple[int, ...]] = (1, 3, 7, 1, 3, 7, 1, 3, 5)


def _strip_non_digits(s: str) -> str:
    return re.sub(r"\D", "", s)


def is_valid_rrn_checksum(value: str) -> bool:
    """Return True if ``value`` (digits, optional ``-``) passes the RRN checksum."""

    digits = _strip_non_digits(value)
    if len(digits) != 13:
        return False
    total = sum(int(digits[i]) * _RRN_WEIGHTS[i] for i in range(12))
    expected = (11 - (total % 11)) % 10
    return expected == int(digits[12])


def is_valid_biznum_checksum(value: str) -> bool:
    """Return True if ``value`` passes the Korean BIZNUM checksum (NTS spec)."""

    digits = _strip_non_digits(value)
    if len(digits) != 10:
        return False
    total = sum(int(digits[i]) * _BIZNUM_WEIGHTS[i] for i in range(9))
    total += (int(digits[8]) * 5) // 10
    expected = (10 - (total % 10)) % 10
    return expected == int(digits[9])


def is_valid_luhn(value: str) -> bool:
    """Return True if ``value`` is a 13-19 digit number satisfying LUHN."""

    digits = _strip_non_digits(value)
    if len(digits) < 13 or len(digits) > 19:
        return False
    total = 0
    parity = len(digits) % 2
    for i, ch in enumerate(digits):
        d = int(ch)
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def find_pii_spans(
    text: str,
    categories: frozenset[str] | None = None,
) -> list[RegexSpan]:
    """Run all enabled regex detectors against ``text``.

    ``categories`` filters which detectors run; ``None`` means "all
    regex-implementable categories". Returns a deterministically sorted
    list of non-overlapping spans (right-most-wins on overlap, matching
    :func:`server.opf_runner._mask_text`).
    """

    active: frozenset[str] = (
        categories if categories is not None else ALL_REGEX_CATEGORIES
    )
    spans: list[RegexSpan] = []

    if "private_email" in active:
        for m in _EMAIL_RE.finditer(text):
            spans.append(
                RegexSpan(
                    start=m.start(),
                    end=m.end(),
                    category="private_email",
                    confidence=0.99,
                    text=m.group(0),
                )
            )

    if "private_phone" in active:
        for m in _KR_PHONE_RE.finditer(text):
            digits = _strip_non_digits(m.group(0))
            if len(digits) not in (10, 11):
                continue
            spans.append(
                RegexSpan(
                    start=m.start(),
                    end=m.end(),
                    category="private_phone",
                    confidence=0.95,
                    text=m.group(0),
                )
            )

    if "rrn" in active:
        for m in _RRN_RE.finditer(text):
            if not is_valid_rrn_checksum(m.group(0)):
                continue
            spans.append(
                RegexSpan(
                    start=m.start(),
                    end=m.end(),
                    category="rrn",
                    confidence=0.99,
                    text=m.group(0),
                )
            )

    if "biz_num" in active:
        for m in _BIZNUM_RE.finditer(text):
            if not is_valid_biznum_checksum(m.group(0)):
                continue
            spans.append(
                RegexSpan(
                    start=m.start(),
                    end=m.end(),
                    category="biz_num",
                    confidence=0.95,
                    text=m.group(0),
                )
            )

    if "card" in active:
        for m in _CARD_RE.finditer(text):
            if not is_valid_luhn(m.group(0)):
                continue
            spans.append(
                RegexSpan(
                    start=m.start(),
                    end=m.end(),
                    category="card",
                    confidence=0.99,
                    text=m.group(0),
                )
            )

    # Sort by (start, -end) so the longest span at a given start wins. The
    # priority order (rrn > biz_num > card > phone > email) is encoded
    # by the order in which spans are added; Python's sort is stable so ties
    # preserve that order.
    spans.sort(key=lambda s: (s.start, -s.end))
    return _dedupe_overlapping(spans)


def _dedupe_overlapping(spans: list[RegexSpan]) -> list[RegexSpan]:
    """Drop spans that start inside a previously kept span.

    Mirrors :func:`server.opf_runner._mask_text` behaviour.
    """

    kept: list[RegexSpan] = []
    last_end = -1
    for span in spans:
        if span.start < last_end:
            continue
        kept.append(span)
        last_end = span.end
    return kept
