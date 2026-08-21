"""Filesystem-path detection — port of ``core/src/restorer/path.ts``.

Restoring a token that sits inside a path rewrites the path. When the model
composes ``D:\\Git\\{{OPF:PERSON:<hash>}}Plugin`` out of masked context, putting
the real name back produces a path that does not exist; leaving the token alone
at least fails visibly.

Deliberately conservative: it suppresses restoration only when the token is
clearly part of a path, so ordinary output like
``{{OPF:EMAIL:<hash>}} please respond`` is never blocked.
"""

from __future__ import annotations

import re
from typing import Final

from .token_format import is_js_whitespace

_WINDOWS_DRIVE: Final = re.compile(r"^[A-Za-z]:[\\/]")
_UNC: Final = re.compile(r"^\\\\")
_POSIX_ABSOLUTE: Final = re.compile(r"^/")
_RELATIVE: Final = re.compile(r"^\.\.?[/\\]")
_URL_SCHEME: Final = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)

_MIN_SEPARATORS: Final = 2


def is_inside_path(text: str, start: int, end: int) -> bool:
    """Whether ``text[start:end)`` sits inside a filesystem path span.

    Extracts the surrounding non-whitespace segment and checks for strong path
    evidence: drive letter, UNC, POSIX absolute, relative prefix, URL scheme,
    or a token that touches a separator inside a segment carrying at least two.

    Whitespace is decided by :func:`server.pii.token_format.is_js_whitespace`,
    not Python's ``str.isspace()`` - the two disagree on U+FEFF and
    U+001C-U+001F, which would move the segment boundary and change the verdict.
    """
    span_start = start
    while span_start > 0 and not is_js_whitespace(text[span_start - 1]):
        span_start -= 1
    span_end = end
    while span_end < len(text) and not is_js_whitespace(text[span_end]):
        span_end += 1

    span = text[span_start:span_end]

    if (
        _WINDOWS_DRIVE.match(span)
        or _UNC.match(span)
        or _POSIX_ABSOLUTE.match(span)
        or _RELATIVE.match(span)
        or _URL_SCHEME.match(span)
    ):
        return True

    char_before = text[start - 1] if start > 0 else ""
    char_after = text[end] if end < len(text) else ""
    if char_before not in ("/", "\\") and char_after not in ("/", "\\"):
        return False

    separators = sum(1 for c in text[span_start:span_end] if c in ("/", "\\"))
    return separators >= _MIN_SEPARATORS
