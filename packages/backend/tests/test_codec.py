"""Detection-to-vault wiring.

No TypeScript counterpart exists: this module is specific to the merged Python
service, where detection and the vault live in one process instead of either
side of an HTTP boundary. It is therefore tested against its own invariants
rather than golden vectors.
"""

from __future__ import annotations

import pytest

from server.pii.codec import VaultTokenCodec, apply_tokens, drop_overlapping
from server.pii.token_hash import derive_token_key
from server.pii.types import Detection
from server.pii.vault import VaultManager

KEY = derive_token_key("codec-test-secret")


def _detector(*pii: tuple[str, str]):
    """Literal-match detector: finds every occurrence of each ``(text, category)``."""

    def detect(text: str) -> list[Detection]:
        found: list[Detection] = []
        for needle, category in pii:
            start = text.find(needle)
            while start != -1:
                found.append(
                    Detection(
                        start=start,
                        end=start + len(needle),
                        category=category,
                        confidence=0.99,
                        text=needle,
                    )
                )
                start = text.find(needle, start + len(needle))
        return found

    return detect


def _codec(*pii: tuple[str, str], session: str = "s") -> VaultTokenCodec:
    return VaultTokenCodec(
        detect=_detector(*pii),
        vault=VaultManager(token_key=KEY),
        session_id=session,
    )


def test_mask_restore_round_trip() -> None:
    codec = _codec(("김철수", "private_person"), ("alice@example.com", "private_email"))
    original = "김철수님께 alice@example.com 으로 보냈습니다"

    masked = codec.mask(original)
    assert "김철수" not in masked
    assert "alice@example.com" not in masked

    assert codec.restore(masked) == original


def test_substitution_is_right_to_left() -> None:
    """Left-to-right substitution shifts every span still to be replaced by the
    length delta of the one just written, corrupting the tail."""
    codec = _codec(("김철수", "private_person"), ("010-1234-5678", "private_phone"))
    original = "김철수 010-1234-5678 김철수"

    masked = codec.mask(original)

    assert masked.count("{{OPF:PERSON:") == 2
    assert masked.count("{{OPF:PHONE:") == 1
    assert codec.restore(masked) == original


def test_repeated_pii_shares_one_token_and_one_vault_entry() -> None:
    codec = _codec(("김철수", "private_person"))
    masked = codec.mask("김철수 김철수 김철수")

    tokens = {part for part in masked.split() if part.startswith("{{OPF:")}
    assert len(tokens) == 1
    assert codec.vault.size("s") == 1


def test_empty_and_clean_text_pass_through_untouched() -> None:
    codec = _codec(("김철수", "private_person"))
    assert codec.mask("") == ""
    assert codec.restore("") == ""
    assert codec.mask("no personal data here") == "no personal data here"
    assert codec.vault.size("s") == 0


def test_restore_leaves_unknown_tokens_alone() -> None:
    """A token minted by another key must not be invented into some value."""
    codec = _codec(("김철수", "private_person"))
    foreign = "{{OPF:PERSON:zzzzzzzzzzzzzzzz}}"
    assert codec.restore(f"see {foreign}") == f"see {foreign}"


def test_dispose_drops_the_session_vault() -> None:
    codec = _codec(("김철수", "private_person"))
    masked = codec.mask("김철수")
    assert codec.restore(masked) == "김철수"

    codec.dispose()
    assert codec.restore(masked) == masked


def test_sessions_do_not_share_a_vault() -> None:
    """Two sessions on one VaultManager must not restore each other's tokens."""
    vault = VaultManager(token_key=KEY)
    detect = _detector(("김철수", "private_person"))
    a = VaultTokenCodec(detect=detect, vault=vault, session_id="a")
    b = VaultTokenCodec(detect=detect, vault=vault, session_id="b")

    masked = a.mask("김철수")
    assert a.restore(masked) == "김철수"
    assert b.restore(masked) == masked


@pytest.mark.parametrize(
    ("spans", "expected"),
    [
        ([(0, 3, "X")], "Xdefghij"),
        ([(0, 3, "X"), (6, 9, "Y")], "XdefYj"),
        ([(6, 9, "Y"), (0, 3, "X")], "XdefYj"),
        ([(0, 10, "Z")], "Z"),
        ([], "abcdefghij"),
    ],
)
def test_apply_tokens_preserves_offsets(spans: list[tuple[int, int, str]], expected: str) -> None:
    assert apply_tokens("abcdefghij", spans) == expected


def test_apply_tokens_handles_replacements_longer_than_the_span() -> None:
    """The realistic case: a 3-char name becomes a 33-char token."""
    assert apply_tokens("ab cd", [(0, 2, "LONG_TOKEN"), (3, 5, "ANOTHER")]) == (
        "LONG_TOKEN ANOTHER"
    )


def test_drop_overlapping_keeps_leftmost_longest() -> None:
    long_span = Detection(0, 10, "private_person", 0.9, "0123456789")
    overlapping = Detection(5, 15, "private_email", 0.9, "56789abcde")
    disjoint = Detection(20, 25, "private_phone", 0.9, "01234")

    kept = drop_overlapping([overlapping, long_span, disjoint])

    assert kept == [long_span, disjoint]


def test_overlapping_detections_do_not_fail_the_request() -> None:
    """The vault rejects overlaps outright; dropping the loser beats a 500."""
    vault = VaultManager(token_key=KEY)

    def overlapping_detect(text: str) -> list[Detection]:
        return [
            Detection(0, 6, "private_person", 0.9, text[0:6]),
            Detection(3, 9, "private_email", 0.9, text[3:9]),
        ]

    codec = VaultTokenCodec(detect=overlapping_detect, vault=vault, session_id="s")
    masked = codec.mask("abcdefghij")

    assert masked.startswith("{{OPF:PERSON:")
    assert masked.endswith("ghij")
