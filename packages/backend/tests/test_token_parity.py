"""Byte-for-byte equivalence with the TypeScript token implementation.

This is the hard gate of the Python port. The hook (``packages/cli``, TypeScript,
runs on the host) and this backend must mint the *same* token for the same
``(key, category, text)``; if they drift, a token minted on one side becomes
unrestorable on the other and the user sees ``__OPF_PERSON__...`` in their output.

Vectors are generated from the TypeScript source::

    bun run scripts/gen-token-vectors.ts

A failure here means the wire format diverged. Regenerating the fixture to make
the test pass is only correct when the TypeScript grammar changed on purpose.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from server.pii.token_format import (
    CATEGORY_MAP,
    MAX_TOKEN_LENGTH,
    TOKEN_DELIMITER,
    TOKEN_PREFIX,
    TOKEN_SUFFIX,
    canonicalize,
    format_token,
    is_token,
    parse_token,
)
from server.pii.token_hash import (
    TOKEN_EPOCH_LENGTH,
    TOKEN_HASH_LENGTH,
    derive_token_key,
    token_epoch,
    token_hash,
)
from server.pii.types import Detection
from server.pii.vault import VaultManager

_FIXTURE = Path(__file__).parent / "fixtures" / "token_vectors.json"


def _load() -> dict[str, Any]:
    with _FIXTURE.open(encoding="utf-8") as fh:
        return json.load(fh)


VECTORS: dict[str, Any] = _load()


def test_fixture_is_present_and_populated() -> None:
    assert VECTORS["hashes"], "no hash vectors - regenerate the fixture"
    assert len(VECTORS["hashes"]) >= 700
    assert len(VECTORS["keys"]) >= 5
    assert len(VECTORS["canonicalize"]) >= 15


def test_constants_match_typescript() -> None:
    c = VECTORS["constants"]
    assert c["TOKEN_PREFIX"] == TOKEN_PREFIX
    assert c["TOKEN_SUFFIX"] == TOKEN_SUFFIX
    assert c["TOKEN_DELIMITER"] == TOKEN_DELIMITER
    assert c["TOKEN_HASH_LENGTH"] == TOKEN_HASH_LENGTH
    assert c["TOKEN_EPOCH_LENGTH"] == TOKEN_EPOCH_LENGTH
    assert c["MAX_TOKEN_LENGTH"] == MAX_TOKEN_LENGTH
    assert c["CATEGORY_MAP"] == CATEGORY_MAP


@pytest.mark.parametrize("vec", VECTORS["keys"], ids=lambda v: repr(v["secret"])[:32])
def test_hkdf_key_derivation_matches(vec: dict[str, Any]) -> None:
    """Node's ``hkdfSync("sha256", ikm, salt, info, 32)`` vs the RFC 5869 port."""
    key = derive_token_key(vec["secret"])
    assert key.hex() == vec["derived_key_hex"]


@pytest.mark.parametrize("vec", VECTORS["keys"], ids=lambda v: repr(v["secret"])[:32])
def test_token_epoch_matches(vec: dict[str, Any]) -> None:
    key = derive_token_key(vec["secret"])
    epoch = token_epoch(key)
    assert epoch == vec["epoch"]
    assert len(epoch) == TOKEN_EPOCH_LENGTH


@pytest.mark.parametrize(
    "vec",
    VECTORS["canonicalize"],
    ids=lambda v: "".join(f"u{cp:04x}" for cp in v["input_codepoints"][:6]) or "empty",
)
def test_canonicalize_matches_javascript_whitespace(vec: dict[str, Any]) -> None:
    """JS ``trim()``/``\\s`` vs Python ``strip()``/``\\s``.

    The divergences that matter: JavaScript trims U+FEFF (Python does not) and
    Python's ``\\s`` matches U+001C-U+001F (JavaScript does not). A naive port
    silently mints a different token for BOM-carrying text.
    """
    # Guard the fixture round-trip itself before trusting the comparison.
    assert [ord(c) for c in vec["input"]] == vec["input_codepoints"]

    out = canonicalize(vec["input"])
    assert out == vec["output"]
    assert [ord(c) for c in out] == vec["output_codepoints"]


def test_canonicalize_strips_bom_like_javascript() -> None:
    """Pinned separately: this is the single most likely silent divergence."""
    assert canonicalize("\ufeff김철수\ufeff") == "김철수"
    assert "\ufeff김철수\ufeff".strip() != "김철수", (
        "Python str.strip() is expected NOT to strip U+FEFF - if this ever "
        "changes, canonicalize() can be simplified"
    )


def test_canonicalize_keeps_javascript_only_control_chars() -> None:
    """U+001C-U+001F are whitespace to Python's ``\\s`` but not to JavaScript's.

    They must survive canonicalisation, otherwise text containing a field
    separator maps to a different token than the TypeScript side produces.
    """
    for cp in range(0x1C, 0x20):
        raw = f"a{chr(cp)}b"
        assert canonicalize(raw) == raw, f"U+{cp:04X} must not be collapsed"


@pytest.mark.parametrize(
    "vec",
    VECTORS["hashes"],
    ids=lambda v: f"{v['category']}-{repr(v['canonical_text'])[:24]}",
)
def test_token_hash_and_format_match(vec: dict[str, Any]) -> None:
    key = derive_token_key(vec["secret"])
    got = token_hash(key, vec["category"], vec["canonical_text"])
    assert got == vec["hash"]
    assert len(got) == TOKEN_HASH_LENGTH
    assert got.startswith(token_epoch(key))
    assert format_token(vec["category"], got) == vec["token"]


def test_base36_pad_probe_if_present() -> None:
    """The left-pad branch is unreachable for a 32-byte digest.

    ``gen-token-vectors.ts`` scans 200k inputs for a hash whose body starts with
    ``0``. If it ever finds one, honour it here rather than leaving the branch
    untested.
    """
    probe = VECTORS.get("base36_pad_probe")
    if probe is None:
        pytest.skip("no short-digest vector found (expected: unreachable branch)")
    key = derive_token_key(probe["secret"])
    assert token_hash(key, probe["category"], probe["canonical_text"]) == probe["hash"]


@pytest.mark.parametrize("vec", VECTORS["parse"], ids=lambda v: repr(v["text"])[:40] or "empty")
def test_parse_token_matches(vec: dict[str, Any]) -> None:
    parsed = parse_token(vec["text"])
    expected = vec["parsed"]
    if expected is None:
        assert parsed is None
    else:
        assert parsed is not None
        category, hash_value = parsed
        assert category == expected["category"]
        assert hash_value == expected["hash"]
    assert is_token(vec["text"]) == vec["is_token"]


def test_format_token_rejects_malformed_input() -> None:
    valid_hash = "a" * TOKEN_HASH_LENGTH
    for bad_category in ["person", "1PERSON", "", "PER-SON", "PERSON1"]:
        with pytest.raises(TypeError):
            format_token(bad_category, valid_hash)
    for bad_hash in ["A" * TOKEN_HASH_LENGTH, "a" * (TOKEN_HASH_LENGTH - 1), "", "a-b"]:
        with pytest.raises(TypeError):
            format_token("PERSON", bad_hash)


def test_token_hash_is_deterministic_and_input_sensitive() -> None:
    key = derive_token_key("determinism-probe")
    base = token_hash(key, "PERSON", "김철수")
    assert base == token_hash(key, "PERSON", "김철수")
    assert base != token_hash(key, "EMAIL", "김철수")
    assert base != token_hash(derive_token_key("other-secret"), "PERSON", "김철수")


def test_nul_separator_ambiguity_is_shared_with_typescript_and_unreachable() -> None:
    """The ``CATEGORY\\0text`` separator is ambiguous - deliberately unfixed.

    ``token_hash(key, "PERSON", "A\\0B")`` and
    ``token_hash(key, "PERSON\\0A", "B")`` both HMAC over ``PERSON\\0A\\0B``, so
    they collide. TypeScript collides identically (verified against
    ``core/src/redaction/token-hash.ts``: both yield ``1xmfysbmgcxeix5x`` for
    this key), which is what matters - a port that "fixed" the ambiguity would
    mint tokens the host-side hook could never restore.

    The collision is unreachable in practice because a category only ever comes
    from ``CATEGORY_MAP`` and :func:`format_token` rejects anything outside
    ``^[A-Z][A-Z_]*$``, so no NUL-bearing category can reach a token.
    """
    key = derive_token_key("determinism-probe")
    collide_a = token_hash(key, "PERSON", "A\x00B")
    collide_b = token_hash(key, "PERSON\x00A", "B")
    assert collide_a == collide_b, "divergence from TypeScript, not an improvement"
    assert collide_a == "1xmfysbmgcxeix5x", "cross-language value pinned from TS"

    with pytest.raises(TypeError):
        format_token("PERSON\x00A", "a" * TOKEN_HASH_LENGTH)
    assert all("\x00" not in label for label in CATEGORY_MAP.values())


def _rebuild_assign_detections(raw: list[dict[str, Any]]) -> list[Detection]:
    """Lay the fixture's ``(category, text)`` pairs out as non-overlapping spans.

    The generator recorded no offsets because a token depends on neither - only
    on category and canonicalised text. ``assign()`` does reject overlaps, so
    the test has to supply *some* valid layout; any gap-separated one yields
    identical tokens.
    """
    detections: list[Detection] = []
    cursor = 0
    for item in raw:
        text = item["text"]
        detections.append(
            Detection(
                start=cursor,
                end=cursor + len(text),
                category=item["category"],
                confidence=0.99,
                text=text,
            )
        )
        cursor += len(text) + 1
    return detections


def test_vault_assign_matches_typescript_tokens() -> None:
    """End-to-end: canonicalize + category map + hash + format, in one call."""
    vec = VECTORS["assign"]
    vault = VaultManager(token_key=derive_token_key(vec["secret"]))
    assert vault.epoch() == vec["epoch"]

    assigned = vault.assign("vector-session", _rebuild_assign_detections(vec["detections"]))
    assert [a.token for a in assigned] == vec["tokens"]


def test_vault_assign_dedups_whitespace_variants() -> None:
    """``"김철수"`` and ``"  김철수 "`` must resolve to one token, one entry.

    The fixture's last detection is a whitespace-padded repeat of its first.
    Without dedup the vault grows one slot per mention and the LLM sees two
    different tokens for the same person.
    """
    vec = VECTORS["assign"]
    assert vec["dedup_holds"] is True, "fixture no longer exercises dedup"

    vault = VaultManager(token_key=derive_token_key(vec["secret"]))
    detections = _rebuild_assign_detections(vec["detections"])
    assigned = vault.assign("vector-session", detections)

    assert assigned[0].token == assigned[-1].token
    assert vault.size("vector-session") == len(detections) - 1


def test_vault_lookup_and_dispose_round_trip() -> None:
    vec = VECTORS["assign"]
    vault = VaultManager(token_key=derive_token_key(vec["secret"]))
    assigned = vault.assign("vector-session", _rebuild_assign_detections(vec["detections"]))

    first = assigned[0]
    entry = vault.lookup("vector-session", first.token)
    assert entry is not None
    assert entry.text == first.text
    assert entry.canonical_text == canonicalize(first.text)

    assert vault.dispose("vector-session") is True
    assert vault.lookup("vector-session", first.token) is None
    assert vault.dispose("vector-session") is False


def test_vault_rejects_overlapping_spans() -> None:
    """Overlaps make substitution order-dependent - fail before minting."""
    vault = VaultManager(token_key=derive_token_key("overlap-probe"))
    with pytest.raises(ValueError, match="Overlapping spans"):
        vault.assign(
            "s",
            [
                Detection(0, 10, "private_person", 0.9, "김철수"),
                Detection(5, 15, "private_email", 0.9, "a@b.com"),
            ],
        )


def test_vault_tokens_differ_across_keys() -> None:
    """A vault built on another key must not produce restorable-looking hits."""
    detections = [Detection(0, 3, "private_person", 0.99, "김철수")]
    a = VaultManager(token_key=derive_token_key("key-a")).assign("s", detections)
    b = VaultManager(token_key=derive_token_key("key-b")).assign("s", detections)
    assert a[0].token != b[0].token
