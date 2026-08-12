"""Restore-side equivalence with the TypeScript implementation.

Companion to :mod:`tests.test_token_parity`, which pins minting. This pins
reading: scanning, edit-distance, miss classification, the filesystem-path
guard, and the end-to-end :class:`~server.pii.restorer.Restorer` counts.

Vectors are generated from the TypeScript source::

    bun run scripts/gen-restore-vectors.ts

Each section maps to one module, so a failure localises immediately.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from server.pii.path import is_inside_path
from server.pii.repair import (
    ObservedToken,
    RepairCandidate,
    Repaired,
    Unresolved,
    build_repair_index,
    is_within_one_edit,
    resolve_miss,
)
from server.pii.restorer import RestoreOptions, Restorer
from server.pii.scan import scan_tokens, scan_tokens_with_repair_candidates
from server.pii.token_hash import derive_token_key
from server.pii.types import Detection
from server.pii.vault import VaultManager

_FIXTURE = Path(__file__).parent / "fixtures" / "restore_vectors.json"

with _FIXTURE.open(encoding="utf-8") as _fh:
    VECTORS: dict[str, Any] = json.load(_fh)

SETUP: dict[str, Any] = VECTORS["setup"]


def _build_vault() -> VaultManager:
    """Rebuild the exact vault the generator used.

    Detections are laid out sequentially with a one-character gap, matching the
    generator. Offsets do not affect the minted token, but ``assign`` rejects
    overlaps, so some valid layout is required.
    """
    vault = VaultManager(token_key=derive_token_key(SETUP["secret"]))
    detections: list[Detection] = []
    cursor = 0
    for spec in SETUP["detections"]:
        text = spec["text"]
        detections.append(
            Detection(
                start=cursor,
                end=cursor + len(text),
                category=spec["category"],
                confidence=0.99,
                text=text,
            )
        )
        cursor += len(text) + 1
    vault.assign(SETUP["session_id"], detections)
    return vault


def test_setup_reproduces_the_same_tokens() -> None:
    """Guard the premise: if minting drifted, every case below is meaningless."""
    vault = _build_vault()
    assert vault.epoch() == SETUP["epoch"]
    assert vault.size(SETUP["session_id"]) == len(SETUP["tokens"])
    for text, expected_token in SETUP["tokens"].items():
        entry = vault.lookup(SETUP["session_id"], expected_token)
        assert entry is not None, f"token for {text!r} not in vault"
        assert entry.text == text


# --------------------------------------------------------------------------
# scan
# --------------------------------------------------------------------------


def _as_match_dicts(matches: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "start": m.start,
            "end": m.end,
            "token": m.token,
            "normalizedToken": m.normalized_token,
            "category": m.category,
            "hash": m.hash,
            "matchType": m.match_type,
        }
        for m in matches
    ]


@pytest.mark.parametrize("case", VECTORS["scan"], ids=lambda c: repr(c["text"])[:44] or "empty")
def test_scan_matches_typescript(case: dict[str, Any]) -> None:
    assert _as_match_dicts(scan_tokens(case["text"])) == case["strict_and_lenient"]
    assert _as_match_dicts(scan_tokens_with_repair_candidates(case["text"])) == case["with_repair"]


def test_scan_matches_token_adjacent_to_hangul() -> None:
    """JavaScript ``\\b`` is ASCII-only; Python's is Unicode-aware.

    ``김철수__OPF_...__입니다`` must still produce a match. A port that used
    Python's ``\\b`` would silently return nothing here, and every Korean
    sentence butting against a token would go unrestored.
    """
    person = SETUP["tokens"]["김철수"]
    matches = scan_tokens(f"김철수{person}입니다")
    assert len(matches) == 1
    assert matches[0].normalized_token == person


# --------------------------------------------------------------------------
# repair: edit distance + miss classification
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "case", VECTORS["is_within_one_edit"], ids=lambda c: f"{c['a']!r}-{c['b']!r}"
)
def test_is_within_one_edit_matches(case: dict[str, Any]) -> None:
    assert is_within_one_edit(case["a"], case["b"]) is case["within_one_edit"]
    assert is_within_one_edit(case["b"], case["a"]) is case["within_one_edit"]


@pytest.mark.parametrize("case", VECTORS["resolve_miss"], ids=lambda c: c["name"])
def test_resolve_miss_matches(case: dict[str, Any]) -> None:
    index = [
        RepairCandidate(category=c["category"], hash=c["hash"], token=c["token"])
        for c in case["index"]
    ]
    got = resolve_miss(
        ObservedToken(category=case["category"], hash=case["hash"]),
        case["epoch"],
        index,
    )
    expected = case["resolution"]
    assert got.kind == expected["kind"]
    if isinstance(got, Repaired):
        assert got.normalized_token == expected["normalizedToken"]
    else:
        assert isinstance(got, Unresolved)
        assert got.cause == expected["cause"]


def test_category_mismatch_never_repairs() -> None:
    """Hash-only repair returned a DIFFERENT entry's value 54 times across the
    tier-1 eval corpus. The vault key is category + hash, so both must match."""
    observed_hash = SETUP["repairable_token"][len("__OPF_PERSON__") : -2]
    vault = _build_vault()
    index = build_repair_index(vault.tokens(SETUP["session_id"]))

    with_matching_category = resolve_miss(
        ObservedToken(category="PERSON", hash=observed_hash), SETUP["epoch"], index
    )
    with_mismatched_category = resolve_miss(
        ObservedToken(category="EMAIL", hash=observed_hash), SETUP["epoch"], index
    )

    assert isinstance(with_matching_category, Repaired)
    assert isinstance(with_mismatched_category, Unresolved)


# --------------------------------------------------------------------------
# path guard
# --------------------------------------------------------------------------


@pytest.mark.parametrize("case", VECTORS["is_inside_path"], ids=lambda c: repr(c["text"])[:44])
def test_is_inside_path_matches(case: dict[str, Any]) -> None:
    assert is_inside_path(case["text"], case["start"], case["end"]) is case["inside_path"]


# --------------------------------------------------------------------------
# end-to-end restore
# --------------------------------------------------------------------------


def _opts_from(case: dict[str, Any]) -> RestoreOptions:
    raw = case["opts"]
    return RestoreOptions(
        lenient=raw["lenient"],
        repair=raw["repair"],
        skip_path_matches=raw["skip_path_matches"],
        warn=lambda _msg: None,
    )


@pytest.mark.parametrize("case", VECTORS["restore"], ids=lambda c: c["name"])
def test_restore_matches_typescript(case: dict[str, Any]) -> None:
    vault = _build_vault()
    restorer = Restorer(vault, RestoreOptions(warn=lambda _msg: None))
    result = restorer.restore(case["text"], SETUP["session_id"], _opts_from(case))

    expected = case["expected"]
    assert result.text == expected["text"]
    assert len(result.matches) == expected["match_count"]
    for field_name in (
        "restored_count",
        "partial_match_count",
        "lenient_restored_count",
        "repaired_count",
        "unknown_token_count",
        "foreign_count",
        "dead_token_count",
        "ambiguous_count",
        "path_skip_count",
        "residual_token_count",
    ):
        assert getattr(result, field_name) == expected[field_name], field_name


@pytest.mark.parametrize("case", VECTORS["restore"], ids=lambda c: c["name"])
def test_restore_count_partitions_hold(case: dict[str, Any]) -> None:
    """Two invariants documented on RestoreResult, checked on every case."""
    vault = _build_vault()
    restorer = Restorer(vault, RestoreOptions(warn=lambda _msg: None))
    r = restorer.restore(case["text"], SETUP["session_id"], _opts_from(case))
    assert r.unknown_token_count == (r.foreign_count + r.dead_token_count + r.ambiguous_count)
    assert r.repaired_count <= r.restored_count


def test_restore_rejects_empty_session_id() -> None:
    restorer = Restorer(_build_vault())
    with pytest.raises(TypeError):
        restorer.restore("anything", "")


def test_unknown_token_handler_replaces_span() -> None:
    """The handler is how a host neutralises dead tokens before the model copies
    them into a new tool call."""
    vault = _build_vault()
    restorer = Restorer(vault, RestoreOptions(warn=lambda _msg: None))
    result = restorer.restore(
        f"see {SETUP['foreign_token']} here",
        SETUP["session_id"],
        RestoreOptions(
            warn=lambda _msg: None,
            unknown_token_handler=lambda _tok, info: f"[UNRESTORABLE:{info.category}]",
        ),
    )
    assert result.text == "see [UNRESTORABLE:PERSON] here"
    assert result.unknown_token_count == 1
    assert result.residual_token_count == 0


def test_warnings_are_emitted_for_lenient_and_unresolved() -> None:
    vault = _build_vault()
    person = SETUP["tokens"]["김철수"]
    inner_hash = person[len("__OPF_PERSON__") : -2]
    seen: list[str] = []
    restorer = Restorer(vault, RestoreOptions(warn=seen.append))

    restorer.restore(f"see __OPF_person__{inner_hash}__ here", SETUP["session_id"])
    assert any("lenient match" in m for m in seen)

    seen.clear()
    restorer.restore(f"see {SETUP['foreign_token']} here", SETUP["session_id"])
    assert any("unresolved (foreign)" in m for m in seen)
