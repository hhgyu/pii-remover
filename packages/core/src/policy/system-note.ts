/**
 * The one instruction every host injects into the system prompt.
 *
 * Masking tokens only survive a round trip if the model copies them verbatim.
 * Left uninstructed, models expand, translate, renumber, or invent them —
 * invented tokens are unrestorable by construction, and mangled ones cost a
 * lenient match at best. This note is the cheapest lever against both.
 *
 * Shared from core so the OpenCode plugin, the local proxy and the Claude Code
 * / Codex CLI hook all send the SAME string: a per-host wording drift would
 * make host-to-host hallucination rates incomparable.
 */
export const OPF_PLACEHOLDER_SYSTEM_NOTE =
  "Inputs may contain privacy-preserving placeholders matching the pattern __OPF_<LABEL>__<HASH>__. " +
  "Treat them as the original semantic entity, but never generate, expand, or invent new placeholders. " +
  "When summarizing or compressing conversation history, preserve every __OPF_*__ token exactly as written.";

/**
 * Append the note to an existing system prompt unless it is already there.
 * Appending (rather than prepending) keeps the cacheable prompt prefix intact
 * for providers that cache on prefix.
 */
export function appendPlaceholderNote(existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) {
    return OPF_PLACEHOLDER_SYSTEM_NOTE;
  }
  if (existing.includes(OPF_PLACEHOLDER_SYSTEM_NOTE)) return existing;
  return `${existing}\n\n${OPF_PLACEHOLDER_SYSTEM_NOTE}`;
}
