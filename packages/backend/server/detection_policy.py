"""Detection policy — what the model finds vs. what we actually mask.

Both knobs here were born from the same failure: the OPF model labels public
documentation and repository links as ``private_url``. A public GitHub repo
scores as low as 0.15 and still wins, so the assistant is handed
``[OPF:PRIVATE_URL]`` instead of the link it was asked to read.

**URL policy.** ``private_url`` means *private* URL. Whether a link is private
is not a function of how famous its domain is — it is a function of whether a
stranger can open it. Enumerating the public web would be unmaintainable and
every host missing from that list would be a fresh false positive, so we
enumerate the opposite: what makes a URL non-public. Credentials baked into it,
a host that only resolves inside a network, or a tenant workspace that demands
a login. Everything else passes through unmasked.

The cost of that inversion, stated plainly: an internal URL on an ordinary
public-looking domain (``https://admin.example.com/users/1234``) is no longer
masked by default. ``PII_PRIVATE_URL_HOSTS`` adds such domains, and
``PII_URL_POLICY=strict`` restores the previous mask-every-URL behaviour for
environments that want it.

**Category policy.** ``OPF_DISABLED_CATEGORIES`` drops whole categories before
they reach the vault — the blunt escape hatch for anyone who wants
``private_url`` (or any other category) off entirely. It is the deeper of the
two exclusion knobs: ``PII_PROXY_EXCLUDED_CATEGORIES``
(:mod:`server.api.proxy`) only stops the proxy rewriting those spans, leaving
the detection intact so the hook's fail-closed gate still counts them as PII.
Disabling here removes the detection itself, gate included.

The URL rules are mirrored in ``packages/core/src/detector/url-policy.ts`` and
locked by ``tests/fixtures/url-policy.json``. Change one side, change both.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Final

from .config import get_settings

#: Hosts whose content is gated behind a login, or that never leave a private
#: network. Matched as an exact host or as a parent suffix, so ``atlassian.net``
#: also covers ``acme.atlassian.net``.
PRIVATE_HOST_SUFFIXES: Final[frozenset[str]] = frozenset(
    {
        # Reserved / internal-only namespaces (RFC 6762, RFC 8375, RFC 2606).
        "internal",
        "intranet",
        "corp",
        "lan",
        "local",
        "localdomain",
        "home.arpa",
        "test",
        "invalid",
        "localhost",
        # Tunnels: a public hostname pointing at someone's laptop.
        "ngrok.io",
        "ngrok.app",
        "ngrok-free.app",
        "trycloudflare.com",
        "loca.lt",
        "localtunnel.me",
        "serveo.net",
        "pagekite.me",
        "telebit.io",
        "devtunnels.ms",
        "github.dev",
        # Tenant workspaces: the hostname itself names the organisation, and
        # the content behind it needs an account.
        "atlassian.net",
        "sharepoint.com",
        "onedrive.live.com",
        "teams.microsoft.com",
        "slack.com",
        "okta.com",
        "oktapreview.com",
        "auth0.com",
        "service-now.com",
        "servicenow.com",
        "zendesk.com",
        "freshdesk.com",
        "lightning.force.com",
        "my.salesforce.com",
        "notion.so",
        "docs.google.com",
        "drive.google.com",
        "dropbox.com",
        "box.com",
    }
)

#: Query parameters that carry a credential or a signature. Their presence
#: makes a URL private regardless of host — a presigned S3 link lives on
#: ``amazonaws.com``, which is as public a domain as they come.
CREDENTIAL_QUERY_KEYS: Final[frozenset[str]] = frozenset(
    {
        "token",
        "access_token",
        "refresh_token",
        "id_token",
        "api_key",
        "apikey",
        "key",
        "secret",
        "client_secret",
        "password",
        "passwd",
        "pwd",
        "auth",
        "authorization",
        "session",
        "sessionid",
        "sig",
        "signature",
        "x-amz-signature",
        "x-amz-credential",
        "x-amz-security-token",
        "sas",
    }
)

_URL_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?P<scheme>[A-Za-z][A-Za-z0-9+.\-]*)://"
    r"(?P<authority>[^/?#]*)"
    r"(?P<path>[^?#]*)"
    r"(?:\?(?P<query>[^#]*))?"
)

_IPV4_RE: Final[re.Pattern[str]] = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")


def normalise_host_suffix(raw: str) -> str:
    """Fold a user-supplied host pattern into the form the matcher expects.

    Accepts ``*.acme.com``, ``.acme.com``, ``ACME.com`` and ``acme.com.``
    because operators write all four, and they all mean the same thing.
    """

    return raw.strip().lower().lstrip("*").strip(".")


def host_matches(host: str, suffixes: Iterable[str]) -> bool:
    """True when ``host`` is one of ``suffixes`` or a subdomain of one."""

    return any(host == s or host.endswith(f".{s}") for s in suffixes if s)


def _has_credential_param(query: str) -> bool:
    for pair in query.split("&"):
        if not pair:
            continue
        key = pair.split("=", 1)[0].strip().lower()
        if key in CREDENTIAL_QUERY_KEYS:
            return True
    return False


def is_private_url(
    url: str,
    *,
    policy: str = "heuristic",
    extra_private_suffixes: Iterable[str] = (),
) -> bool:
    """True when ``url`` should be treated as PII and masked.

    Pure — the settings-aware entry point is :func:`should_mask_url`. Rules are
    evaluated in the order documented in ``url-policy.ts``; every one of them
    is an independent reason to consider the URL private.
    """

    match = _URL_RE.match(url.strip())
    if match is None:
        return False
    if match.group("scheme").lower() not in ("http", "https"):
        return False
    if policy == "strict":
        return True

    authority = match.group("authority")
    # userinfo — https://user:pass@host/… is a credential in plain sight.
    if "@" in authority:
        return True
    # Bracketed IPv6 literal. No public site is addressed this way in prose.
    if authority.startswith("["):
        return True

    host = authority.split(":", 1)[0].lower().rstrip(".")
    if not host:
        return True
    if _IPV4_RE.match(host):
        return True
    # A single-label host resolves only through a local search domain or
    # /etc/hosts: http://jenkins/job/deploy, http://localhost:3000.
    if "." not in host:
        return True
    if host_matches(host, PRIVATE_HOST_SUFFIXES):
        return True
    if host_matches(host, (normalise_host_suffix(s) for s in extra_private_suffixes)):
        return True

    return _has_credential_param(match.group("query") or "")


def should_mask_url(url: str) -> bool:
    """:func:`is_private_url` bound to the process settings."""

    settings = get_settings()
    return is_private_url(
        url,
        policy=settings.url_policy,
        extra_private_suffixes=settings.private_url_hosts,
    )


def is_category_enabled(label: str) -> bool:
    """False when ``OPF_DISABLED_CATEGORIES`` lists ``label``."""

    return label not in get_settings().disabled_categories


def enabled_categories(candidates: Iterable[str]) -> frozenset[str]:
    """Filter ``candidates`` down to the categories still switched on."""

    return frozenset(c for c in candidates if is_category_enabled(c))


def should_keep_span(label: str, text: str) -> bool:
    """The single predicate every detector funnels its spans through."""

    if not is_category_enabled(label):
        return False
    if label == "private_url":
        return should_mask_url(text)
    return True
