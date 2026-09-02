"""Per-session state pool — port of ``proxy/src/session.ts``.

One vault per session id, so tokens minted for one project are not restorable
from another. The session id comes from the ``X-PII-Session`` request header;
without it every caller shares ``proxy:default``.

**The header is not a security boundary.** It is client-supplied and
unauthenticated: any caller can claim any session id and read that vault back
through a restore. The only real control on this surface is that the proxy is
reachable on loopback alone. Publishing the port beyond 127.0.0.1 turns the
pool into a cross-user PII disclosure, and no amount of session hygiene fixes
that - it needs authentication, which this layer does not have.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Final

from .codec import DetectFn, VaultTokenCodec
from .restorer import RestoreOptions
from .thinking_cache import ThinkingCache
from .vault import VaultManager

DEFAULT_SESSION_ID: Final = "proxy:default"
SESSION_HEADER: Final = "x-pii-session"
_MAX_SESSION_ID_LENGTH: Final = 128


@dataclass(frozen=True, slots=True)
class ProxySession:
    """Everything one session owns, with one lifetime.

    The thinking cache is scoped exactly like the vault: a signature minted for
    one session's masked bytes must never resolve against another session's, or
    a replay would hand the wrong conversation's thinking to upstream. Both die
    together in :meth:`ProxySessionPool.dispose_all`.
    """

    codec: VaultTokenCodec
    thinking_cache: ThinkingCache


def read_session_header(headers: Mapping[str, str]) -> str | None:
    """Extract a namespaced session id, or ``None`` when absent or unusable."""
    raw = headers.get(SESSION_HEADER) or headers.get(SESSION_HEADER.title())
    if not isinstance(raw, str):
        return None
    trimmed = raw.strip()
    if not trimmed or len(trimmed) > _MAX_SESSION_ID_LENGTH:
        return None
    return f"proxy:{trimmed}"


class ProxySessionPool:
    """Caches one :class:`ProxySession` per session id.

    The vault is shared across providers within a session on purpose: a token
    minted while talking to Anthropic must restore when the same session later
    talks to OpenAI, otherwise a multi-provider agent sees raw tokens.
    """

    __slots__ = ("_detect", "_restore_options", "_sessions", "_vault")

    def __init__(
        self,
        *,
        detect: DetectFn,
        token_key: bytes,
        warn: Callable[[str], None] | None = None,
    ) -> None:
        self._detect = detect
        self._vault = VaultManager(token_key=token_key, on_warn=warn)
        self._restore_options = RestoreOptions(warn=warn) if warn else RestoreOptions()
        self._sessions: dict[str, ProxySession] = {}

    def get(self, headers: Mapping[str, str]) -> ProxySession:
        session_id = read_session_header(headers) or DEFAULT_SESSION_ID
        session = self._sessions.get(session_id)
        if session is None:
            session = ProxySession(
                codec=VaultTokenCodec(
                    detect=self._detect,
                    vault=self._vault,
                    session_id=session_id,
                    restore_options=self._restore_options,
                ),
                thinking_cache=ThinkingCache(),
            )
            self._sessions[session_id] = session
        return session

    def size(self) -> int:
        return len(self._sessions)

    def dispose_all(self) -> None:
        for session in self._sessions.values():
            session.thinking_cache.clear()
            session.codec.dispose()
        self._sessions.clear()
