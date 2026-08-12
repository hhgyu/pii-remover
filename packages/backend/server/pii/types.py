"""Shared value types - port of the vault-facing half of ``core/src/types.ts``.

Kept separate from :mod:`server.pii.vault` so the providers and the restorer can
depend on the shapes without importing the vault implementation.

These mirror the TypeScript interfaces field-for-field, including field *names*:
they are serialised into audit records and compared against fixtures generated
from the TypeScript side, so renaming ``canonical_text`` to something more
Pythonic would silently break the parity tests.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

PII_CATEGORIES: frozenset[str] = frozenset(
    {
        "private_person",
        "private_email",
        "private_phone",
        "private_address",
        "account_number",
        "private_date",
        "private_url",
        "secret",
        "rrn",
        "biz_num",
        "card",
    }
)
"""The 11 detection categories (ADR-0010): 8 OPF + 3 Korean."""


@dataclass(frozen=True, slots=True)
class Detection:
    """A single PII span located in some text.

    ``start``/``end`` are half-open offsets into the *original* string, in
    Python string indices. The TypeScript side indexes UTF-16 code units, so a
    span covering an astral character (emoji, rare CJK) has a different width
    on each side. Offsets never cross the process boundary - only the token
    does - so the difference is confined to whichever side produced the
    detection.
    """

    start: int
    end: int
    category: str
    confidence: float
    text: str


@dataclass(frozen=True, slots=True)
class AssignedToken:
    """A :class:`Detection` that has been given a vault token.

    ``synthetic_value`` is populated only under ``restoration.mode ==
    "synthetic"`` (ADR-0018); in token mode it stays ``None`` and the token
    itself is substituted into the text.
    """

    start: int
    end: int
    category: str
    confidence: float
    text: str
    token: str
    synthetic_value: str | None = None

    @classmethod
    def from_detection(
        cls,
        detection: Detection,
        token: str,
        synthetic_value: str | None = None,
    ) -> AssignedToken:
        return cls(
            start=detection.start,
            end=detection.end,
            category=detection.category,
            confidence=detection.confidence,
            text=detection.text,
            token=token,
            synthetic_value=synthetic_value,
        )

    def with_token(self, token: str) -> AssignedToken:
        return replace(self, token=token)
