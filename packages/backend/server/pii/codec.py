"""Detection + vault wiring — the concrete :class:`~server.pii.providers.TokenCodec`.

Bridges the two halves that already exist in this process:

- **Detection** (``server.opf_runner``, ``server.regex_pipeline``,
  ``server.korean_ner_runner``) finds PII spans and returns stateless
  ``[OPF:LABEL]`` placeholders.
- **The vault** (:mod:`server.pii.vault`) turns those spans into reversible
  ``{{OPF:<CATEGORY>:<HASH>}}`` tokens.

The detection function is injected rather than imported so this module is
testable without loading a 5 GB ONNX model, and so the API layer keeps ownership
of the runner lifecycle (lazy load, idle unload).

Masking runs right-to-left. Substituting left-to-right would shift every span
still to be replaced by the length delta of the one just written - the classic
off-by-N that silently corrupts the tail of a long prompt.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Final

from .restorer import RestoreOptions, Restorer
from .types import Detection
from .vault import VaultManager

DetectFn = Callable[[str], Sequence[Detection]]
"""``text -> non-overlapping PII spans``, sorted or not."""

_EMPTY: Final[tuple[Detection, ...]] = ()


def apply_tokens(text: str, spans: Sequence[tuple[int, int, str]]) -> str:
    """Replace ``(start, end, replacement)`` spans, rightmost first."""
    out = text
    for start, end, replacement in sorted(spans, key=lambda s: s[0], reverse=True):
        out = out[:start] + replacement + out[end:]
    return out


def drop_overlapping(detections: Sequence[Detection]) -> list[Detection]:
    """Keep the leftmost-longest span of any overlapping run.

    The vault refuses overlapping spans outright, and rightly so - two tokens
    claiming the same characters cannot both survive substitution. Detection
    merges spans already, but it merges *per backend*; a caller that unions two
    detectors can still hand us an overlap, and dropping the loser here is
    better than failing the whole request.
    """
    ordered = sorted(detections, key=lambda d: (d.start, -(d.end - d.start)))
    kept: list[Detection] = []
    last_end = -1
    for detection in ordered:
        if detection.start < last_end:
            continue
        kept.append(detection)
        last_end = detection.end
    return kept


class VaultTokenCodec:
    """Session-scoped mask/restore pair backed by one vault.

    One instance per proxy session. ``mask`` is the request direction (PII out,
    tokens in), ``restore`` the response direction.
    """

    __slots__ = ("_detect", "_restorer", "_session_id", "_vault")

    def __init__(
        self,
        *,
        detect: DetectFn,
        vault: VaultManager,
        session_id: str,
        restore_options: RestoreOptions | None = None,
    ) -> None:
        self._detect = detect
        self._vault = vault
        self._session_id = session_id
        self._restorer = Restorer(
            vault, restore_options if restore_options is not None else RestoreOptions()
        )

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def vault(self) -> VaultManager:
        return self._vault

    def mask(self, text: str) -> str:
        if text == "":
            return text
        detections = self._detect(text) or _EMPTY
        if not detections:
            return text
        assigned = self._vault.assign(self._session_id, drop_overlapping(detections))
        if not assigned:
            return text
        return apply_tokens(text, [(a.start, a.end, a.token) for a in assigned])

    def restore(self, text: str) -> str:
        if text == "":
            return text
        return self._restorer.restore(text, self._session_id).text

    def dispose(self) -> None:
        self._vault.dispose(self._session_id)
