"""End-to-end FastAPI tests using TestClient and a mocked OPF runner.

The real ``openai/privacy-filter`` model is ~5GB and far too heavy to load
in CI. We replace ``OpfRunner`` with a deterministic stub that scans inputs
for a handful of obvious tokens (email, phone, name, url, secret). The
stub covers enough of the OPF label space to exercise schema serialization
and HTTP plumbing.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Iterable
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server import __version__
from server.api import health as health_api
from server.api import redact as redact_api
from server.main import _idle_unload_monitor, _track_redact_activity
from server.opf_runner import OpfRunner, _mask_text
from server.schemas import Detection, RedactResponse

FIXTURES = Path(__file__).parent / "fixtures"

# Regex-based stand-ins for the real model — enough to drive the API tests.
_PATTERNS: dict[str, re.Pattern[str]] = {
    "private_email": re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
    "private_phone": re.compile(r"\+?\d[\d \-]{7,}\d"),
    "private_url": re.compile(r"https?://[^\s]+"),
    "secret": re.compile(r"sk_[a-z]+_[A-Za-z0-9]{16,}"),
    "private_person": re.compile(r"\b(?:John Smith|Mary Johnson|Alice Lee)\b"),
}


class FakeOpfRunner(OpfRunner):
    """A regex-driven OPF stand-in that never touches torch/transformers."""

    def __init__(self) -> None:
        self._loaded = True

    @property
    def is_loaded(self) -> bool:  # type: ignore[override]
        return True

    def load(self) -> None:  # type: ignore[override]
        return None

    def _detect_raw(self, text: str):  # type: ignore[override]
        from server.opf_runner import RawSpan

        spans: list[RawSpan] = []
        for label, pattern in _PATTERNS.items():
            for match in pattern.finditer(text):
                spans.append(
                    RawSpan(
                        start=match.start(),
                        end=match.end(),
                        label=label,
                        score=0.99,
                    )
                )
        spans.sort(key=lambda s: (s.start, s.end))
        return spans


@pytest.fixture()
def app() -> FastAPI:
    application = FastAPI()
    application.include_router(health_api.router)
    application.include_router(redact_api.router)
    application.state.opf_runner = FakeOpfRunner()
    return application


@pytest.fixture()
def client(app: FastAPI) -> Iterable[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


def _load_fixtures() -> list[dict]:
    return json.loads((FIXTURES / "sample_pii.json").read_text("utf-8"))["samples"]


# --- /health ------------------------------------------------------------------


def test_health_reports_runner_state(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["version"] == __version__
    assert body["model"] == "openai/privacy-filter"
    assert body["device"] in ("cpu", "cuda", "mps")
    assert body["model_loaded"] is True


# --- /redact ------------------------------------------------------------------


def test_redact_returns_detections_and_masked_text(client: TestClient) -> None:
    payload = {"text": "Email alice@example.com for details"}
    response = client.post("/redact", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert any(d["label"] == "private_email" for d in body["detections"])
    assert "alice@example.com" not in body["redacted_text"]
    assert "[OPF:PRIVATE_EMAIL]" in body["redacted_text"]


def test_redact_text_returns_plaintext_body(client: TestClient) -> None:
    payload = {"text": "Reach John Smith soon."}
    response = client.post("/redact/text", json=payload)
    assert response.status_code == 200
    assert "John Smith" not in response.text
    assert "[OPF:PRIVATE_PERSON]" in response.text


def test_redact_rejects_extra_fields(client: TestClient) -> None:
    response = client.post("/redact", json={"text": "hi", "evil": True})
    assert response.status_code == 422


def test_redact_handles_clean_text(client: TestClient) -> None:
    response = client.post(
        "/redact", json={"text": "The quick brown fox jumps over the lazy dog."}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["detections"] == []
    assert body["redacted_text"] == "The quick brown fox jumps over the lazy dog."


# --- /redact + regex pipeline -------------------------------------------------


def test_redact_detects_rrn_via_regex(client: TestClient) -> None:
    payload = {"text": "주민번호는 900101-1023483 입니다"}
    response = client.post("/redact", json=payload)
    assert response.status_code == 200
    body = response.json()
    labels = [d["label"] for d in body["detections"]]
    assert "rrn" in labels
    assert "900101-1023483" not in body["redacted_text"]
    assert "[OPF:RRN]" in body["redacted_text"]


def test_redact_detects_biznum_via_regex(client: TestClient) -> None:
    payload = {"text": "사업자 124-81-00998 등록"}
    response = client.post("/redact", json=payload)
    assert response.status_code == 200
    body = response.json()
    labels = [d["label"] for d in body["detections"]]
    assert "biz_num" in labels
    assert "[OPF:BIZ_NUM]" in body["redacted_text"]


def test_redact_detects_card_via_regex(client: TestClient) -> None:
    payload = {"text": "card 4111-1111-1111-1111 belongs to me"}
    response = client.post("/redact", json=payload)
    assert response.status_code == 200
    body = response.json()
    labels = {d["label"] for d in body["detections"]}
    assert "card" in labels
    assert "[OPF:CARD]" in body["redacted_text"]
    assert "4111-1111-1111-1111" not in body["redacted_text"]


def test_redact_regex_dedupes_with_opf_email(client: TestClient) -> None:
    # Both FakeOpfRunner and the regex pipeline detect email — the merge
    # must produce exactly one detection for the overlapping span.
    payload = {"text": "alice@example.com"}
    response = client.post("/redact", json=payload)
    assert response.status_code == 200
    body = response.json()
    email_dets = [d for d in body["detections"] if d["label"] == "private_email"]
    assert len(email_dets) == 1
    assert body["redacted_text"] == "[OPF:PRIVATE_EMAIL]"


def test_redact_batch_detects_regex_pii(client: TestClient) -> None:
    response = client.post(
        "/redact/batch",
        json={"texts": ["주민번호 900101-1023483", "card 4111111111111111"]},
    )
    assert response.status_code == 200
    body = response.json()
    rrn_labels = {d["label"] for d in body["results"][0]["detections"]}
    card_labels = {d["label"] for d in body["results"][1]["detections"]}
    assert "rrn" in rrn_labels
    assert "card" in card_labels


# --- /redact/batch ------------------------------------------------------------


def test_redact_batch_returns_per_input_results(client: TestClient) -> None:
    texts = [s["text"] for s in _load_fixtures()]
    response = client.post("/redact/batch", json={"texts": texts})
    assert response.status_code == 200
    body = response.json()
    assert len(body["results"]) == len(texts)
    for result, sample in zip(body["results"], _load_fixtures(), strict=True):
        labels_found = {d["label"] for d in result["detections"]}
        if "private_email" in sample["expected_labels"]:
            assert "private_email" in labels_found
        if "private_url" in sample["expected_labels"]:
            assert "private_url" in labels_found


def test_redact_batch_rejects_empty_input(client: TestClient) -> None:
    response = client.post("/redact/batch", json={"texts": []})
    assert response.status_code == 422


def test_redact_batch_enforces_size_limit(client: TestClient, monkeypatch) -> None:
    from server import config

    monkeypatch.setenv("OPF_BATCH_MAX", "2")
    config.get_settings.cache_clear()
    try:
        response = client.post(
            "/redact/batch",
            json={"texts": ["a@b.com", "c@d.com", "e@f.com"]},
        )
        assert response.status_code == 413
    finally:
        config.get_settings.cache_clear()


# --- pure helpers -------------------------------------------------------------


def test_mask_text_drops_overlapping_spans() -> None:
    from server.opf_runner import RawSpan

    text = "alice@example.com"
    overlap = [
        RawSpan(start=0, end=17, label="private_email", score=0.9),
        RawSpan(start=6, end=17, label="private_url", score=0.5),
    ]
    masked = _mask_text(text, overlap)
    assert masked == "[OPF:PRIVATE_EMAIL]"


def test_detection_schema_round_trip() -> None:
    detection = Detection(
        start=0, end=4, label="private_person", score=0.5, text="John"
    )
    response = RedactResponse(detections=[detection], redacted_text="[OPF:PRIVATE_PERSON]")
    dumped = response.model_dump()
    assert dumped["detections"][0]["label"] == "private_person"
    assert dumped["redacted_text"] == "[OPF:PRIVATE_PERSON]"


# --- Idle-unload monitor + activity tracking ----------------------------------


class UnloadableFakeOpfRunner(FakeOpfRunner):
    """Fake runner that supports unload/load lifecycle for idle tests."""

    def __init__(self) -> None:
        super().__init__()
        self._fake_loaded = True
        self.unload_calls = 0
        self.load_calls = 0

    @property
    def is_loaded(self) -> bool:  # type: ignore[override]
        return self._fake_loaded

    def load(self) -> None:  # type: ignore[override]
        self.load_calls += 1
        self._fake_loaded = True

    def unload(self) -> None:  # type: ignore[override]
        self.unload_calls += 1
        self._fake_loaded = False


def test_unloadable_runner_unload_is_idempotent() -> None:
    r = UnloadableFakeOpfRunner()
    assert r.is_loaded is True
    r.unload()
    assert r.is_loaded is False
    assert r.unload_calls == 1
    r.unload()
    assert r.unload_calls == 2
    assert r.is_loaded is False


def test_unloadable_runner_lazy_reload_after_unload() -> None:
    r = UnloadableFakeOpfRunner()
    r.unload()
    assert r.is_loaded is False
    r.load()
    assert r.is_loaded is True
    assert r.load_calls == 1


def test_health_reports_idle_unloaded_flag() -> None:
    app = FastAPI()
    app.include_router(health_api.router)
    runner = UnloadableFakeOpfRunner()
    app.state.opf_runner = runner
    app.state.last_request_at = time.monotonic() - 600
    app.state.idle_unloaded = True
    runner.unload()
    with TestClient(app) as c:
        body = c.get("/health").json()
        assert body["model_loaded"] is False
        assert body["idle_unloaded"] is True
        assert body["seconds_since_last_request"] is not None
        assert body["seconds_since_last_request"] >= 0


def test_health_does_NOT_report_idle_when_model_loaded() -> None:
    app = FastAPI()
    app.include_router(health_api.router)
    runner = UnloadableFakeOpfRunner()
    app.state.opf_runner = runner
    app.state.last_request_at = time.monotonic()
    app.state.idle_unloaded = True
    with TestClient(app) as c:
        body = c.get("/health").json()
        assert body["model_loaded"] is True
        assert body["idle_unloaded"] is False


def test_redact_activity_middleware_stamps_last_request_at() -> None:
    app = FastAPI()
    app.middleware("http")(_track_redact_activity)
    app.include_router(redact_api.router)
    app.state.opf_runner = FakeOpfRunner()
    app.state.last_request_at = None
    app.state.idle_unloaded = True

    with TestClient(app) as c:
        before = time.monotonic()
        c.post("/redact", json={"text": "user@example.com"})
        assert app.state.last_request_at is not None
        assert app.state.last_request_at >= before
        assert app.state.idle_unloaded is False


def test_health_probe_does_NOT_count_as_activity() -> None:
    app = FastAPI()
    app.middleware("http")(_track_redact_activity)
    app.include_router(health_api.router)
    app.state.opf_runner = FakeOpfRunner()
    app.state.last_request_at = None
    app.state.idle_unloaded = False

    with TestClient(app) as c:
        c.get("/health")
        assert app.state.last_request_at is None


def test_idle_monitor_disabled_when_timeout_zero(monkeypatch) -> None:
    from server import config

    monkeypatch.setenv("OPF_IDLE_TIMEOUT_SECONDS", "0")
    config.get_settings.cache_clear()
    try:
        app = FastAPI()
        app.state.opf_runner = UnloadableFakeOpfRunner()
        app.state.korean_ner_runner = None
        app.state.last_request_at = time.monotonic() - 9999
        asyncio.run(_idle_unload_monitor(app))
        assert app.state.opf_runner.is_loaded is True
        assert app.state.opf_runner.unload_calls == 0
    finally:
        config.get_settings.cache_clear()


def test_idle_monitor_unloads_after_timeout(monkeypatch) -> None:
    from server import config

    monkeypatch.setenv("OPF_IDLE_TIMEOUT_SECONDS", "1")
    monkeypatch.setenv("OPF_IDLE_CHECK_INTERVAL_SECONDS", "1")
    config.get_settings.cache_clear()

    async def runner() -> None:
        app = FastAPI()
        opf = UnloadableFakeOpfRunner()
        app.state.opf_runner = opf
        app.state.korean_ner_runner = None
        app.state.last_request_at = time.monotonic() - 10
        app.state.idle_unloaded = False
        task = asyncio.create_task(_idle_unload_monitor(app))
        await asyncio.sleep(1.8)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        assert opf.unload_calls >= 1
        assert opf.is_loaded is False
        assert app.state.idle_unloaded is True

    try:
        asyncio.run(runner())
    finally:
        config.get_settings.cache_clear()


def test_idle_monitor_does_NOT_unload_when_recently_active(monkeypatch) -> None:
    from server import config

    monkeypatch.setenv("OPF_IDLE_TIMEOUT_SECONDS", "5")
    monkeypatch.setenv("OPF_IDLE_CHECK_INTERVAL_SECONDS", "1")
    config.get_settings.cache_clear()

    async def runner() -> None:
        app = FastAPI()
        opf = UnloadableFakeOpfRunner()
        app.state.opf_runner = opf
        app.state.korean_ner_runner = None
        app.state.last_request_at = time.monotonic()
        app.state.idle_unloaded = False
        task = asyncio.create_task(_idle_unload_monitor(app))
        await asyncio.sleep(1.5)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        assert opf.unload_calls == 0
        assert opf.is_loaded is True

    try:
        asyncio.run(runner())
    finally:
        config.get_settings.cache_clear()
