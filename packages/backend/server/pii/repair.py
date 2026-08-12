"""Vault-bounded token repair — port of ``core/src/restorer/repair.ts``.

Classifies why a well-formed token failed to resolve, and repairs single-character
damage when — and only when — the answer is unambiguous.

The token key is persistent (``~/.config/pii-remover/key``), so the epoch is
stable across restarts. That makes the causes cleanly separable:

``foreign``
    The epoch does not match this key, so this key never minted the token. The
    model invented it, or the key was replaced.
``expired``
    The epoch matches, so this key *did* mint it, but the in-memory vault no
    longer holds it. A session was resumed or disposed.
``ambiguous``
    Repair found more than one live vault entry within one edit, so restoring
    would be a guess. Fails closed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .token_format import parse_token
from .token_hash import TOKEN_EPOCH_LENGTH

MissCause = Literal["foreign", "expired", "ambiguous"]

MISS_CAUSE_EXPLANATION: dict[MissCause, str] = {
    "foreign": (
        "not minted by this token key - possibly hallucinated by the model, or the key was replaced"
    ),
    "expired": (
        "minted by this token key but absent from the vault - dead token, "
        "likely from a previous process"
    ),
    "ambiguous": (
        "repair found more than one vault entry within a single edit - "
        "failing closed rather than guessing"
    ),
}


@dataclass(frozen=True, slots=True)
class RepairCandidate:
    category: str
    hash: str
    token: str


@dataclass(frozen=True, slots=True)
class ObservedToken:
    category: str
    hash: str


@dataclass(frozen=True, slots=True)
class Repaired:
    normalized_token: str
    kind: Literal["repaired"] = "repaired"


@dataclass(frozen=True, slots=True)
class Unresolved:
    cause: MissCause
    kind: Literal["unresolved"] = "unresolved"


MissResolution = Repaired | Unresolved


def build_repair_index(vault_tokens: list[str]) -> list[RepairCandidate]:
    """Flatten a session's vault keys once per restore call.

    Repair is bounded by this set: a mutated token can only ever resolve to a
    token that was actually minted, never to a value derived from the mutation
    itself.
    """
    out: list[RepairCandidate] = []
    for token in vault_tokens:
        parsed = parse_token(token)
        if parsed is not None:
            category, token_hash_value = parsed
            out.append(RepairCandidate(category=category, hash=token_hash_value, token=token))
    return out


def is_within_one_edit(a: str, b: str) -> bool:
    """Levenshtein distance <= 1, in O(n) without a matrix.

    Equal lengths reduce to "at most one differing position"; a length gap of
    one reduces to a single skip in the longer string.
    """
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False

    if len(a) == len(b):
        differences = 0
        for char_a, char_b in zip(a, b, strict=True):
            if char_a == char_b:
                continue
            differences += 1
            if differences > 1:
                return False
        return True

    short, long = (a, b) if len(a) < len(b) else (b, a)
    i = j = 0
    skipped = False
    while i < len(short) and j < len(long):
        if short[i] == long[j]:
            i += 1
            j += 1
            continue
        if skipped:
            return False
        skipped = True
        j += 1
    return True


def resolve_miss(
    observed: ObservedToken,
    current_epoch: str,
    index: list[RepairCandidate],
) -> MissResolution:
    """Repair requires the *category* to match as well as the hash.

    Resolving on the hash alone looks tempting - the hash is
    ``HMAC(key, category || text)``, so it denotes exactly one entry - but the
    eval harness measured the consequence: when the model swaps or renames a
    category, hash-only repair hands back a DIFFERENT entry's value, 54 times
    across the tier-1 corpus. The vault key is ``category + hash``, so "its own
    entry" means both.

    Repair runs BEFORE the epoch comparison on purpose. The epoch occupies the
    first ``TOKEN_EPOCH_LENGTH`` of 16 hash characters, so gating on it first
    threw away every corruption that happened to land there - roughly a fifth
    of all single-character damage - by calling it foreign. The epoch is a
    classification aid, not a safety check.
    """
    candidate: str | None = None
    for entry in index:
        if entry.category != observed.category:
            continue
        if not is_within_one_edit(entry.hash, observed.hash):
            continue
        if candidate is not None:
            return Unresolved(cause="ambiguous")
        candidate = entry.token

    if candidate is not None:
        return Repaired(normalized_token=candidate)

    matches_epoch = observed.hash[:TOKEN_EPOCH_LENGTH] == current_epoch
    return Unresolved(cause="expired" if matches_epoch else "foreign")
