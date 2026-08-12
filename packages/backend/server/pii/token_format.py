"""Token grammar - port of ``core/src/token/format.ts`` + ``category-map.ts``.

Format (ADR-0020)::

    __OPF_<CATEGORY>__<HASH>__

- ``CATEGORY``: uppercase ASCII + underscores (``PERSON``, ``BIZ_NUM``)
- ``__`` delimiter separates CATEGORY from HASH (disambiguates ``BIZNUM``)
- ``HASH``: lowercase base36, fixed :data:`TOKEN_HASH_LENGTH` chars

Every consumer builds its regex from the ``*_PATTERN`` sources here instead of
hardcoding the hash length, so widening the hash cannot leave a stale matcher
behind.

Two JavaScript/Python divergences are corrected explicitly below. Both were
found by the golden vectors, not by reading:

1. **Word boundary.** JavaScript ``\\b`` is ASCII-only; Python's is Unicode-aware.
   For ``김__OPF_PERSON__...`` JS sees a boundary (``김`` is a non-word char) and
   matches, while Python sees word-to-word and does *not*. Korean text sits
   directly against tokens constantly, so ``\\b`` is replaced with explicit
   ASCII look-around.
2. **Whitespace.** ``canonicalize`` must use the JavaScript whitespace set:
   Python's ``str.strip()`` leaves U+FEFF (a BOM survives a copy-paste and would
   mint a different token), and Python's ``\\s`` additionally matches
   U+001C-U+001F, which JavaScript does not.
"""

from __future__ import annotations

import re
from typing import Final

from .token_hash import TOKEN_HASH_LENGTH

TOKEN_PREFIX: Final = "__OPF_"
TOKEN_SUFFIX: Final = "__"
TOKEN_DELIMITER: Final = "__"

CATEGORY_MAP: Final[dict[str, str]] = {
    "private_person": "PERSON",
    "private_email": "EMAIL",
    "private_phone": "PHONE",
    "private_address": "ADDRESS",
    "account_number": "ACCOUNT",
    "private_date": "DATE",
    "private_url": "URL",
    "secret": "SECRET",
    "rrn": "RRN",
    "biz_num": "BIZNUM",
    "card": "CARD",
}

REVERSE_CATEGORY_MAP: Final[dict[str, str]] = {v: k for k, v in CATEGORY_MAP.items()}

TOKEN_CATEGORY_PATTERN: Final = "[A-Z][A-Z0-9_]*?"
"""Lazy so it stops at the first ``__`` delimiter, which is what keeps
``BIZ_NUM`` from swallowing the delimiter into the category."""

TOKEN_HASH_PATTERN: Final = f"[a-z0-9]{{{TOKEN_HASH_LENGTH}}}"

MAX_CATEGORY_LABEL_LENGTH: Final = max(len(label) for label in CATEGORY_MAP.values())

MAX_TOKEN_LENGTH: Final = (
    len(TOKEN_PREFIX)
    + MAX_CATEGORY_LABEL_LENGTH
    + len(TOKEN_DELIMITER)
    + TOKEN_HASH_LENGTH
    + len(TOKEN_SUFFIX)
)
"""Longest token :func:`format_token` can emit.

A streaming consumer that looks back fewer characters than this cannot see an
in-progress token's ``__OPF_`` start and releases the tail raw.
"""

# JavaScript `\b` equivalents. JS word chars are exactly [A-Za-z0-9_].
_ASCII_WORD_BEFORE: Final = "(?<![A-Za-z0-9_])"
_ASCII_WORD_AFTER: Final = "(?![A-Za-z0-9_])"

TOKEN_STRICT_PATTERN: Final = (
    f"{TOKEN_PREFIX}({TOKEN_CATEGORY_PATTERN}){TOKEN_DELIMITER}({TOKEN_HASH_PATTERN}){TOKEN_SUFFIX}"
)

TOKEN_LENIENT_PATTERN: Final = (
    f"{_ASCII_WORD_BEFORE}{TOKEN_PREFIX}([A-Za-z][A-Za-z0-9_]*?){TOKEN_DELIMITER}"
    f"({TOKEN_HASH_PATTERN})(?:{TOKEN_SUFFIX})?{_ASCII_WORD_AFTER}"
)
"""Case-insensitive category and an optional trailing suffix, for tokens an
LLM has mangled. Always compile with :data:`re.IGNORECASE`."""


def _escapable_literal(literal: str) -> str:
    """Render a literal so each underscore may carry a preceding backslash.

    Markdown renderers escape our tokens as ``\\_\\_OPF\\_...``; without this the
    escaped form is invisible to the repair scanner.
    """
    return "".join("\\\\?_" if c == "_" else re.escape(c) for c in literal)


TOKEN_REPAIR_PATTERN: Final = (
    f"{_escapable_literal(TOKEN_PREFIX)}([A-Za-z][A-Za-z0-9_\\\\]*?)"
    f"{_escapable_literal(TOKEN_DELIMITER)}"
    f"([a-z0-9]{{{TOKEN_HASH_LENGTH - 1},{TOKEN_HASH_LENGTH + 1}}})"
    f"(?:{_escapable_literal(TOKEN_SUFFIX)})?"
)
"""Deliberately looser than the matchers above, and NOT a restoration matcher.

A hit here is only ever a *candidate*: it tolerates a hash one character short
or long and a backslash before any underscore, so length-corrupted and
Markdown-escaped tokens become visible at all. Every candidate must still clear
the vault-bounded checks in :mod:`server.pii.restorer` - matching epoch,
matching category, exactly one live vault entry within one edit - before a
single character is substituted.
"""

TOKEN_STRICT_REGEX: Final = re.compile(TOKEN_STRICT_PATTERN)
TOKEN_LENIENT_REGEX: Final = re.compile(TOKEN_LENIENT_PATTERN, re.IGNORECASE)
TOKEN_REPAIR_REGEX: Final = re.compile(TOKEN_REPAIR_PATTERN, re.IGNORECASE)
"""Case-insensitive to match the TypeScript ``"gi"`` flags. Without IGNORECASE
an uppercased hash never reaches the repair path, so a token the model
case-folded is reported foreign instead of being repaired."""

_STRICT_FULL: Final = re.compile(f"^{TOKEN_STRICT_PATTERN}$")
_HASH_FULL: Final = re.compile(f"^{TOKEN_HASH_PATTERN}$")
_VALID_CATEGORY: Final = re.compile(r"^[A-Z][A-Z_]*$")

# The JavaScript whitespace set, used by both String.prototype.trim() and `\s`.
# Differs from Python's `\s` in both directions: JS includes U+FEFF, Python
# includes U+001C-U+001F.
_JS_WHITESPACE: Final = (
    "\t\n\x0b\x0c\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_JS_WS_CLASS: Final = f"[{re.escape(_JS_WHITESPACE)}]"
_JS_WS_RUN: Final = re.compile(f"{_JS_WS_CLASS}+")
_JS_WS_EDGES: Final = re.compile(f"^{_JS_WS_CLASS}+|{_JS_WS_CLASS}+$")


def is_js_whitespace(char: str) -> bool:
    """Whether JavaScript's ``\\s`` would match ``char``.

    Exported because the path heuristic in :mod:`server.pii.path` splits on
    whitespace and must agree with the TypeScript original about where a
    filesystem path segment ends.
    """
    return char in _JS_WHITESPACE


def js_trim(text: str) -> str:
    """``String.prototype.trim()`` semantics.

    Differs from :meth:`str.strip` at both ends of the whitespace set, so any
    field parsed out of a wire format (SSE ``event:`` names, for one) has to use
    this to agree with the TypeScript side.
    """
    return _JS_WS_EDGES.sub("", text)


def canonicalize(text: str) -> str:
    """Trim and collapse whitespace, with JavaScript semantics.

    Mirrors the private ``canonicalize()`` in ``core/src/vault/manager.ts``.
    Lives here rather than in :mod:`server.pii.vault` because it is part of the
    wire contract: it decides which inputs map to the same token, so the two
    implementations must agree character for character.
    """
    return _JS_WS_RUN.sub(" ", _JS_WS_EDGES.sub("", text))


def category_to_token_label(category: str) -> str:
    """Detection category (``private_person``) -> token label (``PERSON``)."""
    label = CATEGORY_MAP.get(category)
    if label is None:
        raise KeyError(f"Unknown PII category: {category!r}")
    return label


def token_label_to_category(label: str) -> str | None:
    return REVERSE_CATEGORY_MAP.get(label)


def format_token(category: str, token_hash_value: str) -> str:
    if not isinstance(category, str) or not _VALID_CATEGORY.match(category):
        raise TypeError(
            f"Invalid token category: {category!r} (must be uppercase ASCII letters + underscores)"
        )
    if not isinstance(token_hash_value, str) or not _HASH_FULL.match(token_hash_value):
        raise TypeError(
            f"Invalid token hash: {token_hash_value!r} "
            f"(must be {TOKEN_HASH_LENGTH} lowercase base36 chars)"
        )
    return f"{TOKEN_PREFIX}{category}{TOKEN_DELIMITER}{token_hash_value}{TOKEN_SUFFIX}"


def parse_token(text: str) -> tuple[str, str] | None:
    """Return ``(category, hash)`` for an exact token, else ``None``."""
    m = _STRICT_FULL.match(text)
    if m is None:
        return None
    return m.group(1), m.group(2)


def is_token(text: str) -> bool:
    return _STRICT_FULL.match(text) is not None
