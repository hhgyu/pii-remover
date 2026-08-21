"""Token scanning — port of ``core/src/restorer/scan.ts``.

Finds every OPF token in a string, in three passes of decreasing confidence:

1. **strict** - the canonical ``{{OPF:PERSON:<hash>}}`` form.
2. **lenient** - case-folded category, optional closing brace pair. What an LLM
   produces when it "helpfully" reformats a token.
3. **repair** - a hash one character short or long, or a dropped brace. A repair
   hit means nothing on its own; it must clear the vault-bounded checks in
   :mod:`server.pii.repair` before anything is substituted.

Later passes never overwrite an earlier one: a span already claimed by a strict
match is skipped, so the same token is never counted twice.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .token_format import (
    TOKEN_DELIMITER,
    TOKEN_LENIENT_REGEX,
    TOKEN_PREFIX,
    TOKEN_REPAIR_REGEX,
    TOKEN_STRICT_REGEX,
    TOKEN_SUFFIX,
)

MatchType = Literal["strict", "lenient", "repair"]


@dataclass(frozen=True, slots=True)
class TokenMatch:
    """A token detected in text.

    ``normalized_token`` is the canonical form used for vault lookup;
    ``token`` preserves the original surface form so a caller can attribute the
    transformation back to whoever produced the text.
    """

    start: int
    end: int
    token: str
    normalized_token: str
    category: str
    hash: str
    match_type: MatchType


def build_normalized(category: str, token_hash_value: str) -> str:
    return f"{TOKEN_PREFIX}{category}{TOKEN_DELIMITER}{token_hash_value}{TOKEN_SUFFIX}"


def _strip_escapes(value: str) -> str:
    return value.replace("\\", "")


def _overlaps_any(ranges: list[tuple[int, int]], start: int, end: int) -> bool:
    # Half-open intersection: [start, end) n [s, e) != {}
    return any(start < e and end > s for s, e in ranges)


def _scan_internal(text: str, include_repair: bool) -> list[TokenMatch]:
    if text == "":
        return []

    matches: list[TokenMatch] = []
    occupied: list[tuple[int, int]] = []

    passes: list[tuple[MatchType, object]] = [
        ("strict", TOKEN_STRICT_REGEX),
        ("lenient", TOKEN_LENIENT_REGEX),
    ]
    if include_repair:
        passes.append(("repair", TOKEN_REPAIR_REGEX))

    for match_type, pattern in passes:
        for m in pattern.finditer(text):  # type: ignore[attr-defined]
            start, end = m.start(), m.end()
            if _overlaps_any(occupied, start, end):
                continue
            category = _strip_escapes(m.group(1) or "").upper()
            token_hash_value = (m.group(2) or "").lower()
            occupied.append((start, end))
            matches.append(
                TokenMatch(
                    start=start,
                    end=end,
                    token=m.group(0),
                    normalized_token=build_normalized(category, token_hash_value),
                    category=category,
                    hash=token_hash_value,
                    match_type=match_type,
                )
            )

    matches.sort(key=lambda m: m.start)
    return matches


def scan_tokens(text: str) -> list[TokenMatch]:
    """Strict + lenient matches, sorted by start position."""
    return _scan_internal(text, include_repair=False)


def scan_tokens_with_repair_candidates(text: str) -> list[TokenMatch]:
    """As :func:`scan_tokens`, plus loose repair candidates.

    For the restorer only - never for callers that treat a match as proof that
    a token exists.
    """
    return _scan_internal(text, include_repair=True)
