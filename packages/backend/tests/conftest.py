"""Shared proxy fixtures: a regex-driven OPF stand-in and a mock upstream.

The real model is ~5 GB, so proxy tests drive detection through a regex fake and
the upstream through :class:`httpx.MockTransport`. Nothing here touches torch or
the network.

Named ``proxy_*`` on purpose: :mod:`tests.test_proxy_api` predates this file and
defines its own ``app`` / ``client`` / ``upstream`` fixtures, which would shadow
same-named ones here and make it ambiguous which app a test is driving.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any, cast

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.api import health as health_api
from server.api import proxy as proxy_api
from server.api import redact as redact_api
from server.config import get_proxy_settings
from server.main import _track_redact_activity
from server.opf_runner import OpfRunner, RawSpan
from server.pii.codec import VaultTokenCodec
from server.pii.sse import StreamRestoreScope
from server.pii.token_hash import derive_token_key
from server.pii.types import Detection
from server.pii.vault import VaultManager

EMAIL = "alice@example.com"
PERSON = "John Smith"

_PATTERNS: dict[str, re.Pattern[str]] = {
    "private_email": re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
    "private_person": re.compile(r"\b(?:John Smith|Alice Lee)\b"),
}


class FakeOpfRunner(OpfRunner):
    """Regex stand-in for the ONNX detector, always 'loaded'."""

    def __init__(self) -> None:
        super().__init__()
        self._loaded = True

    @property
    def is_loaded(self) -> bool:
        return True

    def load(self) -> None:
        return None

    def _detect_raw(self, text: str) -> list[RawSpan]:
        spans: list[RawSpan] = []
        for label, pattern in _PATTERNS.items():
            for match in pattern.finditer(text):
                spans.append(RawSpan(start=match.start(), end=match.end(), label=label, score=0.99))
        spans.sort(key=lambda s: (s.start, s.end))
        return spans


class ProxyUpstream:
    """Records what the proxy forwarded and replies with a scripted body."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.responder: Callable[[httpx.Request], httpx.Response] | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        if self.responder is None:
            raise AssertionError("proxy upstream responder was not configured")
        return self.responder(request)

    @property
    def last_body(self) -> dict[str, Any]:
        parsed: object = json.loads(self.requests[-1].content)
        if not isinstance(parsed, dict) or not all(isinstance(key, str) for key in parsed):
            raise AssertionError("expected the forwarded body to be a JSON object")
        return cast(dict[str, Any], parsed)

    @property
    def last_body_text(self) -> str:
        return self.requests[-1].content.decode()


@pytest.fixture()
def proxy_upstream() -> ProxyUpstream:
    return ProxyUpstream()


@pytest.fixture()
def proxy_app(
    monkeypatch: pytest.MonkeyPatch, proxy_upstream: ProxyUpstream
) -> Iterator[FastAPI]:
    monkeypatch.setenv("PII_PROXY_ENABLED", "1")
    monkeypatch.setenv("PII_REMOVER_TOKEN_KEY", "thinking-parity-test-key")
    get_proxy_settings.cache_clear()

    application = FastAPI()
    application.middleware("http")(_track_redact_activity)
    application.include_router(health_api.router)
    application.include_router(redact_api.router)
    application.include_router(proxy_api.router)

    application.state.opf_runner = FakeOpfRunner()
    application.state.korean_ner_runner = None
    application.state.last_request_at = None
    application.state.idle_unloaded = False
    application.state.proxy_http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(proxy_upstream.handler)
    )

    yield application

    get_proxy_settings.cache_clear()


@pytest.fixture()
def proxy_client(proxy_app: FastAPI) -> Iterator[TestClient]:
    with TestClient(proxy_app) as test_client:
        yield test_client


@dataclass(frozen=True, slots=True)
class ThinkingPair:
    """The two copies of one thinking block that must never be conflated.

    ``raw`` is what Anthropic signed and what has to go back upstream;
    ``restored`` is what the user is shown. They differ by exactly the vault
    substitution, which is why a replay cannot just echo what was displayed.
    """

    codec: VaultTokenCodec
    scope: StreamRestoreScope
    raw: str
    restored: str


def _detect_email(text: str) -> list[Detection]:
    return [
        Detection(
            start=m.start(),
            end=m.end(),
            category="private_email",
            confidence=0.99,
            text=m.group(),
        )
        for m in _PATTERNS["private_email"].finditer(text)
    ]


@pytest.fixture()
def thinking_pair() -> ThinkingPair:
    codec = VaultTokenCodec(
        detect=_detect_email,
        vault=VaultManager(token_key=derive_token_key("thinking-unit-test-key")),
        session_id="proxy:thinking",
    )
    raw = codec.mask(f"Reply to {EMAIL} about the invoice.")
    return ThinkingPair(
        codec=codec,
        scope=StreamRestoreScope(codec.restore),
        raw=raw,
        restored=codec.restore(raw),
    )
