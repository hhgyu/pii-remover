"""Unit tests for :mod:`server.regex_pipeline` (ADR-0009 Phase 6).

Covers checksum implementations (RRN, BIZNUM, LUHN) and span detection
behaviour, including overlap dedup and category filtering. The TS
reference values come from packages/core/src/detector/regex/* tests.
"""

from __future__ import annotations

from server.regex_pipeline import (
    find_pii_spans,
    is_valid_biznum_checksum,
    is_valid_luhn,
    is_valid_rrn_checksum,
)


def test_rrn_checksum_accepts_valid() -> None:
    # 900101-1023483: digits weighted sum 107, (11 - 107%11) % 10 == 3.
    assert is_valid_rrn_checksum("900101-1023483")
    assert is_valid_rrn_checksum("9001011023483")


def test_rrn_checksum_rejects_invalid() -> None:
    assert not is_valid_rrn_checksum("900101-1234567")
    assert not is_valid_rrn_checksum("900101-1023482")
    assert not is_valid_rrn_checksum("123456")
    assert not is_valid_rrn_checksum("abc")


def test_biznum_checksum_round_trip() -> None:
    # 1208147521 is a publicly known valid Korean BIZNUM checksum
    # (Samsung Electronics, used widely in NTS examples).
    assert is_valid_biznum_checksum("124-81-00998")
    assert not is_valid_biznum_checksum("124-81-00999")


def test_luhn_accepts_known_valid() -> None:
    assert is_valid_luhn("4111111111111111")
    assert is_valid_luhn("4111-1111-1111-1111")


def test_luhn_rejects_invalid() -> None:
    assert not is_valid_luhn("4111111111111112")
    assert not is_valid_luhn("123")


def test_find_pii_spans_email_and_korean_phone() -> None:
    text = "contact alice@example.com or 010-1234-5678 today"
    spans = find_pii_spans(text)
    cats = sorted(s.category for s in spans)
    assert cats == ["private_email", "private_phone"]


def test_find_pii_spans_filters_by_category() -> None:
    text = "alice@example.com 010-1234-5678"
    spans = find_pii_spans(text, categories=frozenset({"private_phone"}))
    cats = [s.category for s in spans]
    assert cats == ["private_phone"]


def test_find_pii_spans_rrn_outranks_card_on_overlap() -> None:
    # 900101-1023483 is a valid RRN. The credit-card regex would also
    # candidate-match (13 stripped digits) but LUHN sum is 36, so the
    # CC detector drops it cleanly, leaving the RRN detection alone.
    spans = find_pii_spans("900101-1023483")
    cats = [s.category for s in spans]
    assert cats == ["rrn"]


def test_find_pii_spans_clean_text_no_detections() -> None:
    assert find_pii_spans("the quick brown fox jumps over the lazy dog") == []
