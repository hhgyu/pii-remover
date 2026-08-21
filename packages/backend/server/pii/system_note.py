"""The one instruction every host injects into the system prompt.

Port of ``core/src/policy/system-note.ts``.

Masking tokens only survive a round trip if the model copies them verbatim.
Left uninstructed, models expand, translate, renumber, or invent them - invented
tokens are unrestorable by construction, and mangled ones cost a lenient match
at best.

The string is shared byte-for-byte with the OpenCode plugin, the TypeScript
proxy, and the CLI hook. Per-host wording drift would make host-to-host
hallucination rates incomparable, which is the number the prompt lever is chosen
from.
"""

from __future__ import annotations

from typing import Final

OPF_PLACEHOLDER_SYSTEM_NOTE: Final = (
    "Inputs may contain privacy-preserving placeholders matching the pattern "
    "{{OPF:<LABEL>:<HASH>}}. "
    "Treat them as the original semantic entity, but never generate, expand, or "
    "invent new placeholders. "
    "When summarizing or compressing conversation history, preserve every "
    "{{OPF:*__ token exactly as written."
)


def append_placeholder_note(existing: str | None) -> str:
    """Append the note unless it is already present.

    Appending rather than prepending keeps the cacheable prompt prefix intact
    for providers that cache on prefix.
    """
    if existing is None or existing == "":
        return OPF_PLACEHOLDER_SYSTEM_NOTE
    if OPF_PLACEHOLDER_SYSTEM_NOTE in existing:
        return existing
    return f"{existing}\n\n{OPF_PLACEHOLDER_SYSTEM_NOTE}"
