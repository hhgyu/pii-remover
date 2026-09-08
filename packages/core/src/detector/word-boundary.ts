/**
 * Repair NER person spans that stop in the middle of a word.
 *
 * KLUE NER tags Korean text but is routinely fed English product names, and
 * it returns sub-word spans for them: "Grafana" comes back as "Graf". The
 * span is then tokenized verbatim, so the masked text reads
 * `{{OPF:PERSON:<hash>}}ana` — a corrupted word plus a token the user sees.
 *
 * A boundary is treated as a cut only when the characters on BOTH sides of it
 * are latin word characters. That distinguishes a genuine mid-word split
 * ("Graf|ana") from a script transition ("김철수|abc"), and it keeps the
 * korean-heuristic honorific stripping in `mergeBackendDetections` intact —
 * "김철수|님" never matches, because 수 is not a latin word character.
 *
 * Spans are widened, never dropped: a detection this module cannot vouch for
 * still masks at least as much text as before. Deciding that "Grafana" is not
 * PII at all is a policy question for the stopword list, not a boundary fix.
 */

import type { Detection } from "../types.js";

const WORD_CHAR = /[A-Za-z0-9_]/;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/**
 * Widen every `private_person` span that cuts a latin word to the full word.
 *
 * Other categories are returned untouched — the defect is specific to the
 * person NER path. Expansion can make two spans overlap (or coincide), so
 * callers MUST re-run `mergeDetections` before handing the result to
 * `VaultManager.assign`, which rejects overlapping spans.
 */
export function expandPersonWordBoundaries(
  text: string,
  detections: readonly Detection[]
): Detection[] {
  return detections.map((d) => {
    if (d.category !== "private_person") return d;
    let start = d.start;
    while (isWordChar(text[start - 1]) && isWordChar(text[start])) start -= 1;
    let end = d.end;
    while (isWordChar(text[end - 1]) && isWordChar(text[end])) end += 1;
    if (start === d.start && end === d.end) return d;
    return { ...d, start, end, text: text.slice(start, end) };
  });
}
