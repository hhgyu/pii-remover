/**
 * Detect whether a token match sits inside a file-system path span.
 *
 * Extracts the surrounding non-whitespace segment and checks for strong path
 * evidence (drive-letter, UNC, POSIX absolute/relative, URL scheme, or
 * multiple separators). Intentionally conservative: it only suppresses
 * restoration when the token is clearly part of a path, so legitimate model
 * output like `"{{OPF:EMAIL:<hash>}}please respond"` is never blocked.
 */
export function isInsidePath(text: string, start: number, end: number): boolean {
  let spanStart = start;
  while (spanStart > 0 && !/\s/.test(text[spanStart - 1] ?? "")) spanStart--;
  let spanEnd = end;
  while (spanEnd < text.length && !/\s/.test(text[spanEnd] ?? "")) spanEnd++;

  const span = text.slice(spanStart, spanEnd);

  // Windows drive (C:\ D:/), UNC (\\server), POSIX absolute (/foo),
  // relative with separator (./ ../), or a URL scheme.
  if (/^[A-Za-z]:[\\/]/.test(span)) return true;
  if (/^\\\\/.test(span)) return true;
  if (/^\//.test(span)) return true;
  if (/^\.\.?[/\\]/.test(span)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(span)) return true;

  const charBefore = start > 0 ? text[start - 1] : "";
  const charAfter = end < text.length ? text[end] : "";
  const touchesSeparator =
    charBefore === "/" ||
    charBefore === "\\" ||
    charAfter === "/" ||
    charAfter === "\\";
  if (!touchesSeparator) return false;

  let separators = 0;
  for (let i = spanStart; i < spanEnd; i++) {
    const c = text[i];
    if (c === "/" || c === "\\") separators++;
  }
  return separators >= 2;
}
