"""Header hygiene for proxied requests — port of ``proxy/src/headers.ts``.

Hop-by-hop headers describe one TCP connection, not the message, so relaying
them corrupts the next hop: a forwarded ``Content-Length`` disagrees with the
re-serialised (masked) body, and a forwarded ``Transfer-Encoding`` makes the
client try to de-chunk an already-decoded stream.

``Content-Encoding`` is dropped from responses for the same class of reason:
the upstream body is decompressed before it reaches the transformers, so
announcing ``gzip`` would make the client decompress plaintext.

Credential headers are forwarded verbatim - the proxy never holds its own API
key, it relays the client's - but must never be logged. :func:`safe_header_log`
is the only sanctioned way to dump headers for diagnostics.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Final

HOP_BY_HOP: Final[frozenset[str]] = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
        "content-length",
    }
)

SENSITIVE_HEADER_NAMES: Final[frozenset[str]] = frozenset(
    {
        "authorization",
        "x-api-key",
        "anthropic-api-key",
        "openai-api-key",
        "cookie",
        "set-cookie",
        "proxy-authorization",
    }
)

_REDACTED: Final = "<redacted>"


def _items(headers: Mapping[str, str] | Iterable[tuple[str, str]]) -> Iterable[tuple[str, str]]:
    return headers.items() if isinstance(headers, Mapping) else headers


def forwardable_request_headers(
    headers: Mapping[str, str] | Iterable[tuple[str, str]],
) -> dict[str, str]:
    return {name: value for name, value in _items(headers) if name.lower() not in HOP_BY_HOP}


def forwardable_response_headers(
    headers: Mapping[str, str] | Iterable[tuple[str, str]],
) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, value in _items(headers):
        lower = name.lower()
        if lower in HOP_BY_HOP or lower == "content-encoding":
            continue
        out[name] = value
    return out


def is_sensitive_header_name(name: str) -> bool:
    return name.lower() in SENSITIVE_HEADER_NAMES


def safe_header_log(
    headers: Mapping[str, str] | Iterable[tuple[str, str]],
) -> dict[str, str]:
    """Header map with credential values replaced by ``<redacted>``."""
    return {
        name: (_REDACTED if is_sensitive_header_name(name) else value)
        for name, value in _items(headers)
    }
