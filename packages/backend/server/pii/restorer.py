"""Token restoration — port of ``core/src/restorer/index.ts``.

Turns ``{{OPF:PERSON:<hash>}}`` back into the original text, using the vault
for one session.

Algorithm (ADR-0020 round-trip, ADR-0021 miss classification):

1. Scan with the strict regex, then the lenient regex minus overlaps.
2. Walk matches **right-to-left** so each substitution preserves the offsets of
   the matches still to come.
3. An exact vault hit wins. Otherwise classify the miss and, when repair finds
   exactly one live vault entry within a single edit, restore that.

Two partitions hold by construction and are worth relying on:

- ``unknown_token_count == foreign_count + dead_token_count + ambiguous_count``
- ``repaired_count`` is a subset of ``restored_count``
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Final, Literal

from .path import is_inside_path
from .repair import (
    MISS_CAUSE_EXPLANATION,
    MissCause,
    ObservedToken,
    RepairCandidate,
    Repaired,
    build_repair_index,
    resolve_miss,
)
from .scan import TokenMatch, scan_tokens, scan_tokens_with_repair_candidates
from .vault import VaultManager

RestoreOrigin = Literal["model", "tool", "user"]

_CAUSE_COUNTER: Final[dict[MissCause, str]] = {
    "foreign": "foreign_count",
    "expired": "dead_token_count",
    "ambiguous": "ambiguous_count",
}

_TOKEN_PROBE: Final = re.compile("opf", re.IGNORECASE)
"""Necessary condition for any of the three scan patterns to match.

Streaming calls :meth:`Restorer.restore` once per SSE delta and the vast
majority of deltas carry no token at all, yet still paid for three regex passes
(strict, lenient, repair). This probe short-circuits them.

Soundness: every pattern requires the letters ``OPF`` contiguously. Strict has
them literally; lenient is IGNORECASE over the same prefix; repair only makes
the *underscores* optionally backslash-escaped, never the letters. So text
without a case-insensitive ``OPF`` cannot produce a match, and skipping it
cannot change a result.
"""


@dataclass(frozen=True, slots=True)
class UnknownTokenInfo:
    category: str
    cause: MissCause


@dataclass(slots=True)
class RestoreOptions:
    """All fields default to ``None`` so option merging can mirror the
    TypeScript ``??`` chain: an explicit ``False`` overrides a default ``True``,
    while an omitted field falls through to the Restorer's defaults."""

    lenient: bool | None = None
    """Activate the lenient fallback regex for LLM-mangled tokens. Default true."""

    warn_on_partial: bool | None = None
    """Warn on every lenient (non-canonical) match. Default true."""

    warn_on_unknown_token: bool | None = None
    """Warn when a strict-form token is not in the vault. Default true."""

    repair: bool | None = None
    """Attempt vault-bounded repair of a mutated hash (ADR-0021). Only accepts a
    replacement when exactly ONE live vault entry lies within a single edit;
    two or more candidates fail closed. Default true."""

    origin: RestoreOrigin | None = None
    """Who wrote the text being restored.

    Only ``"model"`` text can hallucinate a token; a ``"tool"`` result (a file
    the agent read, shell stdout, a web page) or a ``"user"`` message carrying a
    token-shaped string is third-party data, and counting it as a model failure
    poisons the hallucination rate - the very number a prompt lever is chosen
    from. Defaults to ``"model"``, so a caller that forgets is attributed
    conservatively rather than silently exonerated."""

    partial_match_handler: Callable[[str, TokenMatch], str] | None = None
    unknown_token_handler: Callable[[str, UnknownTokenInfo], str] | None = None
    warn: Callable[[str], None] | None = None

    skip_path_matches: bool | None = None
    """Skip tokens sitting inside a filesystem path span. Default true."""


@dataclass(slots=True)
class RestoreResult:
    text: str
    matches: list[TokenMatch] = field(default_factory=list)
    restored_count: int = 0
    partial_match_count: int = 0
    lenient_restored_count: int = 0
    repaired_count: int = 0
    unknown_token_count: int = 0
    foreign_count: int = 0
    """Misses whose epoch shows this key never minted the token.

    That is a fact about the token, NOT blame: the model may have invented it,
    but a tool result, a file the agent read, or the user's own message can
    equally carry a token-shaped string."""
    dead_token_count: int = 0
    ambiguous_count: int = 0
    path_skip_count: int = 0
    """Vault MISSES suppressed because they sit inside a filesystem path. Vault
    hits inside paths restore normally."""
    residual_token_count: int = 0
    """Tokens still matchable in the OUTPUT text - the user-visible failure
    surface, which ``unknown_token_count`` stops describing once an
    unknown-token handler rewrites the span."""


def _merge_options(defaults: RestoreOptions, overrides: RestoreOptions) -> RestoreOptions:
    merged = replace(defaults)
    for name in RestoreOptions.__slots__:
        value = getattr(overrides, name)
        if value is not None:
            setattr(merged, name, value)
    return merged


def _splice(text: str, match: TokenMatch, replacement: str) -> str:
    return text[: match.start] + replacement + text[match.end :]


def _lenient_resolved_message(m: TokenMatch) -> str:
    return (
        f"[WARN] PII restore: lenient match '{m.token}' resolved as "
        f"'{m.normalized_token}' (LLM transformation suspected)"
    )


def _repaired_message(m: TokenMatch, resolved: str) -> str:
    return (
        f"[WARN] PII restore: repaired mutated token '{m.token}' to "
        f"'{resolved}' (single vault candidate within one edit)"
    )


def _unresolved_message(m: TokenMatch, cause: MissCause) -> str:
    return (
        f"[WARN] PII restore: token '{m.token}' unresolved ({cause}): "
        f"{MISS_CAUSE_EXPLANATION[cause]}"
    )


class Restorer:
    """Restores vault tokens in text. One instance per :class:`VaultManager`."""

    __slots__ = ("_default_opts", "_vault")

    def __init__(self, vault: VaultManager, default_opts: RestoreOptions | None = None) -> None:
        self._vault = vault
        self._default_opts = default_opts if default_opts is not None else RestoreOptions()

    def scan(self, text: str) -> list[TokenMatch]:
        return scan_tokens(text)

    def restore(
        self, text: str, session_id: str, opts: RestoreOptions | None = None
    ) -> RestoreResult:
        """Resolve every token in ``text`` using the vault for ``session_id``.

        Raises :class:`TypeError` if ``session_id`` is empty. A session that was
        never populated is allowed and yields all-unknown counts.
        """
        if not isinstance(session_id, str) or session_id == "":
            raise TypeError(
                f"Restorer.restore: session_id must be a non-empty string (got {session_id!r})"
            )
        if text == "" or _TOKEN_PROBE.search(text) is None:
            return RestoreResult(text=text)

        merged = _merge_options(self._default_opts, opts or RestoreOptions())
        warn = merged.warn if merged.warn is not None else _noop_warn
        warn_on_partial = merged.warn_on_partial is not False
        skip_paths = merged.skip_path_matches is not False
        repair_enabled = merged.repair is not False

        scan = scan_tokens_with_repair_candidates if repair_enabled else scan_tokens
        all_matches = scan(text)
        matches = (
            [m for m in all_matches if m.match_type == "strict"]
            if merged.lenient is False
            else all_matches
        )

        result = RestoreResult(text=text, matches=matches)
        result.partial_match_count = sum(1 for m in matches if m.match_type == "lenient")

        epoch = self._vault.epoch()
        repair_index: list[RepairCandidate] | None = None
        out = text

        for m in sorted(matches, key=lambda x: x.start, reverse=True):
            entry = self._vault.lookup(session_id, m.normalized_token)
            if entry is not None:
                out = _splice(out, m, entry.text)
                result.restored_count += 1
                if m.match_type == "lenient":
                    result.lenient_restored_count += 1
                    if warn_on_partial:
                        warn(_lenient_resolved_message(m))
                continue

            if repair_enabled and repair_index is None:
                repair_index = build_repair_index(self._vault.tokens(session_id))

            resolution = (
                resolve_miss(
                    ObservedToken(category=m.category, hash=m.hash),
                    epoch,
                    repair_index or [],
                )
                if repair_enabled
                else None
            )

            if isinstance(resolution, Repaired):
                repaired = self._vault.lookup(session_id, resolution.normalized_token)
                if repaired is not None:
                    out = _splice(out, m, repaired.text)
                    result.restored_count += 1
                    result.repaired_count += 1
                    warn(_repaired_message(m, resolution.normalized_token))
                    continue

            if skip_paths and is_inside_path(out, m.start, m.end):
                result.path_skip_count += 1
                continue

            cause: MissCause = (
                resolution.cause
                if resolution is not None and not isinstance(resolution, Repaired)
                else "expired"
            )
            result.unknown_token_count += 1
            counter = _CAUSE_COUNTER[cause]
            setattr(result, counter, getattr(result, counter) + 1)

            out = self._handle_unresolved(out, m, cause, merged)

        result.text = out
        result.residual_token_count = 0 if not matches else len(scan(out))
        return result

    def _handle_unresolved(
        self,
        text: str,
        match: TokenMatch,
        cause: MissCause,
        opts: RestoreOptions,
    ) -> str:
        warn = opts.warn if opts.warn is not None else _noop_warn

        # A repair candidate is a guess about what the span even is, so an
        # unresolved one is left byte-for-byte alone: rewriting it could destroy
        # ordinary text that merely resembles a token.
        if match.match_type == "repair":
            if opts.warn_on_unknown_token is not False:
                warn(_unresolved_message(match, cause))
            return text

        if match.match_type == "strict":
            if opts.warn_on_unknown_token is not False:
                warn(_unresolved_message(match, cause))
            handler = opts.unknown_token_handler
            if handler is not None:
                return _splice(
                    text,
                    match,
                    handler(match.token, UnknownTokenInfo(match.category, cause)),
                )
            return text

        if opts.warn_on_partial is not False:
            warn(_unresolved_message(match, cause))
        partial_handler = opts.partial_match_handler
        if partial_handler is not None:
            return _splice(text, match, partial_handler(match.token, match))
        return text


def _noop_warn(_msg: str) -> None:
    return None
