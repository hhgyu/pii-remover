"""Detection policy: which URLs are PII, and which categories are switched off.

The URL cases come from ``tests/fixtures/url-policy.json``, shared with
``packages/core/tests/url-policy.test.ts``. That fixture is the only mechanical
guard against the two implementations drifting, so new cases belong there
rather than here.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from server.config import get_settings
from server.detection_policy import (
    is_category_enabled,
    is_private_url,
    should_keep_span,
    should_mask_url,
)
from server.regex_pipeline import find_pii_spans

FIXTURE_PATH = (
    Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "url-policy.json"
)

_FIXTURE: dict[str, Any] = json.loads(FIXTURE_PATH.read_text("utf-8"))

KOREAIL_REPO_URLS = (
    "https://github.com/GeunSam2/korail_KTX_macro_telegrambot",
    "https://github.com/yakisoba0728/korail-mobile-api",
    "https://github.com/ukkidokiyo/korail2",
    "https://github.com/hostkimjang/korail-auto-waitlist",
)


@pytest.fixture(autouse=True)
def _clear_settings_cache() -> Any:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _cases(key: str) -> list[dict[str, Any]]:
    return list(_FIXTURE[key])


@pytest.mark.parametrize("case", _cases("cases"), ids=lambda c: c["name"])
def test_default_policy_matches_fixture(case: dict[str, Any]) -> None:
    assert is_private_url(case["url"]) is case["private"]


@pytest.mark.parametrize(
    "case", _cases("strict_policy_cases"), ids=lambda c: c["name"]
)
def test_strict_policy_matches_fixture(case: dict[str, Any]) -> None:
    assert is_private_url(case["url"], policy="strict") is case["private"]


@pytest.mark.parametrize(
    "case", _cases("extra_private_suffix_cases"), ids=lambda c: c["name"]
)
def test_extra_private_suffixes_match_fixture(case: dict[str, Any]) -> None:
    assert (
        is_private_url(
            case["url"], extra_private_suffixes=case["extra_private_suffixes"]
        )
        is case["private"]
    )


@pytest.mark.parametrize("url", KOREAIL_REPO_URLS)
def test_public_repo_urls_survive_the_span_filter(url: str) -> None:
    """The reported regression, asserted at the layer the OPF runner calls."""

    assert should_keep_span("private_url", url) is False


def test_private_url_span_is_still_kept() -> None:
    assert should_keep_span("private_url", "https://acme.atlassian.net/browse/X-1")


def test_non_url_categories_are_untouched_by_url_policy() -> None:
    assert should_keep_span("private_email", "alice@example.com")
    assert should_keep_span("rrn", "900101-1234567")


def test_strict_policy_env_masks_public_urls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PII_URL_POLICY", "strict")
    get_settings.cache_clear()
    assert should_mask_url("https://github.com/openai/whisper") is True


def test_private_url_hosts_env_extends_the_denylist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PII_PRIVATE_URL_HOSTS", "acme.com, *.acme.io")
    get_settings.cache_clear()
    assert should_mask_url("https://admin.acme.com/users/1") is True
    assert should_mask_url("https://git.acme.io/team/repo") is True
    assert should_mask_url("https://github.com/acme/repo") is False


def test_invalid_url_policy_fails_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PII_URL_POLICY", "permissive")
    get_settings.cache_clear()
    with pytest.raises(ValueError, match="PII_URL_POLICY"):
        get_settings()


def test_disabled_categories_drop_spans(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPF_DISABLED_CATEGORIES", "private_url,private_date")
    get_settings.cache_clear()
    assert is_category_enabled("private_url") is False
    assert is_category_enabled("private_date") is False
    assert is_category_enabled("private_email") is True
    assert should_keep_span("private_url", "https://acme.atlassian.net/browse/X-1") is False


def test_disabled_categories_reach_the_regex_pipeline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    text = "mail alice@example.com and call 010-1234-5678"
    monkeypatch.setenv("OPF_DISABLED_CATEGORIES", "private_email")
    get_settings.cache_clear()
    categories = {span.category for span in find_pii_spans(text)}
    assert "private_email" not in categories
    assert "private_phone" in categories


def test_unknown_disabled_category_fails_startup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPF_DISABLED_CATEGORIES", "private_urls")
    get_settings.cache_clear()
    with pytest.raises(ValueError, match="unknown categories"):
        get_settings()
