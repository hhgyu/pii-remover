"""Session-scoped token vault - port of ``core/src/vault/manager.ts``.

Holds the token -> original-text mapping that makes redaction reversible.
In-memory only, never persisted: the vault lives for the process lifetime and
dies with it. A token that outlives its vault (persisted chat history replayed
after a restart) is *not* restorable, and :meth:`VaultManager.lookup` returning
``None`` is how the caller learns that.

Tokens are deterministic (:mod:`server.pii.token_hash`), so the same text under
the same key always maps to the same token - that is what lets the host-side
TypeScript hook and this process agree without sharing state.
"""

from __future__ import annotations

import secrets
import time
import uuid
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Final

from .token_format import canonicalize, category_to_token_label, format_token
from .token_hash import token_epoch, token_hash
from .types import AssignedToken, Detection

SCHEMA_VERSION: Final = "opf.reversible.v3"
"""Vault schema per ADR-0003. Any exported vault MUST carry this version."""

_MAX_ENTRIES_HARD: Final = 100_000
_MAX_ENTRIES_WARN: Final = 10_000

SyntheticGenerator = Callable[[str, int, str], str]
"""``(category, seed, text) -> synthetic replacement`` (ADR-0018)."""


@dataclass(slots=True)
class VaultEntry:
    """One token's backing record.

    ``canonical_text`` is the deduplication key alongside ``label`` - see
    :func:`server.pii.token_format.canonicalize` for the normalisation.
    """

    label: str
    text: str
    canonical_text: str
    id: str
    synthetic_value: str | None = None


@dataclass(slots=True)
class Vault:
    schema_version: str
    vault_id: str
    entries: dict[str, VaultEntry] = field(default_factory=dict)
    created_at: int = 0


def _dedup_key(label: str, canonical: str) -> str:
    return f"{label}\x00{canonical}"


def _hash_to_seed(token_hash_value: str) -> int:
    """Map a base36 hash to a stable positive integer seed (ADR-0018).

    Deterministic: same hash -> same synthetic value. The hash is ASCII base36,
    so :func:`ord` and JavaScript's ``charCodeAt`` agree on every character.
    """
    acc = 0
    for char in token_hash_value:
        acc = (acc * 31 + ord(char)) % 1_000_000_007
    return acc + 1


def _assert_no_overlap(detections: Sequence[Detection]) -> None:
    """Reject overlapping spans before any token is minted.

    Overlaps make the masked output order-dependent - two tokens would claim
    the same characters and the second substitution would corrupt the first.
    Fail loudly instead of emitting text that cannot be restored.
    """
    if len(detections) < 2:
        return
    ordered = sorted(detections, key=lambda d: (d.start, d.end))
    for previous, current in pairwise(ordered):
        if current.start < previous.end:
            raise ValueError(
                f"Overlapping spans: [{previous.start}, {previous.end}) "
                f"({previous.category}) and [{current.start}, {current.end}) "
                f"({current.category})"
            )


class VaultManager:
    """Owns one vault per session id.

    ``token_key`` must be the key resolved by
    :func:`server.pii.token_hash.resolve_token_key`. Omitting it falls back to a
    process-local random key: tokens stay consistent within this process but
    nothing minted here can be restored by the TypeScript hook, which is almost
    never what you want outside tests.
    """

    __slots__ = (
        "_max_entries",
        "_on_warn",
        "_sessions",
        "_synthetic_generator",
        "_token_key",
    )

    def __init__(
        self,
        *,
        token_key: bytes | None = None,
        max_entries: int = _MAX_ENTRIES_HARD,
        on_warn: Callable[[str], None] | None = None,
        synthetic_generator: SyntheticGenerator | None = None,
    ) -> None:
        self._sessions: dict[str, Vault] = {}
        self._max_entries = max_entries
        self._on_warn: Callable[[str], None] = on_warn or (lambda _msg: None)
        self._synthetic_generator = synthetic_generator
        self._token_key = token_key if token_key is not None else secrets.token_bytes(32)

    # --- introspection -----------------------------------------------------

    def epoch(self) -> str:
        """Fingerprint of the active key; every token this vault mints starts
        with it. A miss whose epoch differs was minted under a different key."""
        return token_epoch(self._token_key)

    def entries(self, session_id: str) -> list[VaultEntry]:
        vault = self._sessions.get(session_id)
        return list(vault.entries.values()) if vault else []

    def tokens(self, session_id: str) -> list[str]:
        """Token keys of one session, for vault-bounded repair (ADR-0021)."""
        vault = self._sessions.get(session_id)
        return list(vault.entries.keys()) if vault else []

    def has(self, session_id: str) -> bool:
        return session_id in self._sessions

    def size(self, session_id: str) -> int:
        vault = self._sessions.get(session_id)
        return len(vault.entries) if vault else 0

    def lookup(self, session_id: str, token: str) -> VaultEntry | None:
        vault = self._sessions.get(session_id)
        if vault is None:
            return None
        return vault.entries.get(token)

    # --- lifecycle ---------------------------------------------------------

    def get_or_create(self, session_id: str) -> Vault:
        vault = self._sessions.get(session_id)
        if vault is None:
            vault = Vault(
                schema_version=SCHEMA_VERSION,
                vault_id=str(uuid.uuid4()),
                entries={},
                created_at=int(time.time() * 1000),
            )
            self._sessions[session_id] = vault
        return vault

    def dispose(self, session_id: str) -> bool:
        return self._sessions.pop(session_id, None) is not None

    def dispose_all(self) -> None:
        self._sessions.clear()

    # --- minting -----------------------------------------------------------

    def assign(self, session_id: str, detections: Iterable[Detection]) -> list[AssignedToken]:
        """Mint (or reuse) a token for every detection.

        Two detections whose text canonicalises to the same string under the
        same category share one token - that is what keeps ``김철수`` mentioned
        five times from consuming five vault slots and five different tokens.
        """
        pending = list(detections)
        if not pending:
            return []
        _assert_no_overlap(pending)
        vault = self.get_or_create(session_id)

        dedup_lookup = {
            _dedup_key(entry.label, entry.canonical_text): token
            for token, entry in vault.entries.items()
        }

        results: list[AssignedToken] = []
        for detection in pending:
            label = detection.category
            canonical = canonicalize(detection.text)
            key = _dedup_key(label, canonical)
            token = dedup_lookup.get(key)

            if token is None:
                token_label = category_to_token_label(label)
                hash_value = token_hash(self._token_key, token_label, canonical)
                token = format_token(token_label, hash_value)

                collision = vault.entries.get(token)
                if collision is not None and collision.canonical_text != canonical:
                    raise RuntimeError(
                        f"Vault {vault.vault_id}: token hash collision for {token} "
                        f"(existing label={collision.label}; new label={label}) "
                        "- fail-closed"
                    )

                entry = VaultEntry(
                    label=label,
                    text=detection.text,
                    canonical_text=canonical,
                    id=hash_value,
                )
                if self._synthetic_generator is not None:
                    entry.synthetic_value = self._synthetic_generator(
                        label, _hash_to_seed(hash_value), detection.text
                    )
                vault.entries[token] = entry
                dedup_lookup[key] = token

            existing = vault.entries[token]
            results.append(AssignedToken.from_detection(detection, token, existing.synthetic_value))

        self._enforce_limits(vault, minted_in_call=len(pending))
        return results

    def _enforce_limits(self, vault: Vault, *, minted_in_call: int) -> None:
        size = len(vault.entries)
        if size > self._max_entries:
            raise RuntimeError(
                f"Vault {vault.vault_id}: entries ({size}) exceeded hard limit "
                f"({self._max_entries})"
            )
        if size >= _MAX_ENTRIES_WARN and size - minted_in_call < _MAX_ENTRIES_WARN:
            self._on_warn(
                f"Vault {vault.vault_id}: entries reached soft limit ({_MAX_ENTRIES_WARN})"
            )
