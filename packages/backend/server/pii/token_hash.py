"""Deterministic token hashing - port of ``core/src/redaction/token-hash.ts``.

Same ``(key, category, canonical_text)`` always yields the same hash, in this
process, in the TypeScript hook, and after a restart. That property is what
lets a token minted by one process be restored by another.

Layout of a hash (``TOKEN_HASH_LENGTH`` chars, lowercase base36)::

    ┌───────────────┬──────────────────────────────────┐
    │ epoch (3)     │ body (13)                        │
    │ key           │ HMAC over CATEGORY\\0canonical    │
    │ fingerprint   │                                  │
    └───────────────┴──────────────────────────────────┘

The epoch is carved *out of* the total width, not appended, so the wire format,
every consumer regex, and the SSE boundary buffer stay byte-identical to the
pre-epoch format. It exists so a vault miss can distinguish "minted under a key
I no longer hold" (epoch matches, entry evicted) from "the model invented this"
(epoch differs) - two failures that need different fixes.

Node reference: ``crypto.hkdfSync("sha256", ikm, salt, info, 32)``. RFC 5869 is
reimplemented here with :mod:`hmac` rather than pulling in ``cryptography``:
for a 32-byte output the expand step is a single HMAC block, so the whole
construction is six lines and adds no dependency to the image.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

_HKDF_SALT = b"pii-remover-token-hash-v2"
_HKDF_INFO = b"deterministic-token-index"
_DERIVED_KEY_LENGTH = 32

_EPOCH_INFO = b"opf-key-epoch-v1"

TOKEN_HASH_LENGTH = 16
"""Total width of a token hash. Fixed, so the right boundary is unambiguous."""

TOKEN_EPOCH_LENGTH = 3
"""Leading chars derived from the key alone.

3 base36 chars = 46656 epochs, so two distinct keys collide on the epoch about
1 time in 46656 - that is the dead-token misclassification rate. The remaining
13 chars carry ~67 bits, keeping birthday collisions at the 100k vault ceiling
around 1e-11.
"""

_TOKEN_BODY_LENGTH = TOKEN_HASH_LENGTH - TOKEN_EPOCH_LENGTH

_DEFAULT_ENV_NAME = "PII_REMOVER_TOKEN_KEY"

_B36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

# Keyed by the key material itself rather than by object identity (the
# TypeScript side uses a WeakMap on the Buffer). Value-keyed memoisation is
# strictly better here: two equal keys share the entry.
_epoch_cache: dict[bytes, str] = {}


def _base36(n: int) -> str:
    """Lowercase base36, matching JavaScript ``BigInt.prototype.toString(36)``."""
    if n == 0:
        return "0"
    out: list[str] = []
    while n:
        n, rem = divmod(n, 36)
        out.append(_B36_ALPHABET[rem])
    return "".join(reversed(out))


def _base36_digest(digest: bytes, length: int) -> str:
    """Big-endian digest -> base36, truncated or left-padded to ``length``.

    The pad branch is unreachable for a 32-byte digest (base36 of a 256-bit
    integer is 50 chars unless the digest begins with ~5 zero bytes), but it
    mirrors the TypeScript source so a future change to the digest width cannot
    silently diverge between the two implementations.
    """
    rendered = _base36(int.from_bytes(digest, "big"))
    if len(rendered) >= length:
        return rendered[:length]
    return rendered.rjust(length, "0")


def _hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    """RFC 5869 HKDF-SHA256, equivalent to Node's ``hkdfSync("sha256", ...)``."""
    if length > 255 * hashlib.sha256().digest_size:
        raise ValueError("hkdf: requested length exceeds RFC 5869 maximum")
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm = b""
    block = b""
    counter = 1
    while len(okm) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]


def derive_token_key(secret: str) -> bytes:
    """Stretch a user-supplied secret into the 32-byte HMAC key."""
    if not isinstance(secret, str) or len(secret) == 0:
        raise ValueError("derive_token_key: secret must be a non-empty string")
    return _hkdf_sha256(
        secret.encode("utf-8"),
        _HKDF_SALT,
        _HKDF_INFO,
        _DERIVED_KEY_LENGTH,
    )


def token_epoch(key: bytes) -> str:
    """Stable fingerprint of ``key`` itself.

    Every hash minted with this key starts with it, so a restorer can tell
    "minted under a key I no longer hold" from "never minted at all".
    """
    cached = _epoch_cache.get(key)
    if cached is not None:
        return cached
    digest = hmac.new(key, _EPOCH_INFO, hashlib.sha256).digest()
    epoch = _base36_digest(digest, TOKEN_EPOCH_LENGTH)
    _epoch_cache[key] = epoch
    return epoch


def token_hash(key: bytes, category: str, canonical_text: str) -> str:
    """``token_epoch(key)`` followed by an HMAC over ``CATEGORY\\0canonical``.

    ``category`` is the *token label* (``PERSON``, ``BIZNUM``, ...), not the
    detection category (``private_person``, ``biz_num``). Passing the wrong one
    mints a token the TypeScript side will never reproduce.
    """
    digest = hmac.new(
        key,
        f"{category}\x00{canonical_text}".encode(),
        hashlib.sha256,
    ).digest()
    return token_epoch(key) + _base36_digest(digest, _TOKEN_BODY_LENGTH)


TokenKeySource = Literal["env", "file", "generated", "ephemeral"]


@dataclass(frozen=True)
class TokenKeyResolution:
    """Where the active token key came from, and whether that is a problem."""

    key: bytes
    source: TokenKeySource
    warning: str | None = None


def default_key_path() -> Path:
    return Path.home() / ".config" / "pii-remover" / "key"


def resolve_token_key(
    *,
    env: dict[str, str] | None = None,
    env_name: str | None = None,
    key_path: str | Path | None = None,
) -> TokenKeyResolution:
    """Resolve the token-hash key, in priority order.

    1. env var (``env_name``, default ``PII_REMOVER_TOKEN_KEY``)
    2. key file (``key_path``, default ``~/.config/pii-remover/key``)
    3. generate + persist a new key file
    4. ephemeral random key when persistence fails - process-local, safe but
       loses cross-process determinism, so it is reported via ``warning``

    In a container the file branch only works if the host key is mounted;
    otherwise every restart mints a fresh key and every token from the previous
    run becomes unrestorable. Prefer passing the secret through ``env_name``
    for containerised deployments.
    """
    resolved_env = os.environ if env is None else env
    resolved_env_name = env_name or _DEFAULT_ENV_NAME
    resolved_path = Path(key_path) if key_path is not None else default_key_path()

    env_value = resolved_env.get(resolved_env_name)
    if isinstance(env_value, str) and len(env_value) > 0:
        return TokenKeyResolution(key=derive_token_key(env_value), source="env")

    try:
        if resolved_path.exists():
            raw = resolved_path.read_text(encoding="utf-8").strip()
            if len(raw) > 0:
                return TokenKeyResolution(key=derive_token_key(raw), source="file")
    except OSError:
        pass  # fall through to generation

    generated = secrets.token_hex(32)
    try:
        resolved_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        resolved_path.write_text(generated, encoding="utf-8")
        os.chmod(resolved_path, 0o600)
        return TokenKeyResolution(key=derive_token_key(generated), source="generated")
    except OSError as err:
        return TokenKeyResolution(
            key=derive_token_key(generated),
            source="ephemeral",
            warning=(
                f"[pii-remover] could not persist token key to {resolved_path} "
                f"({err}); using a process-local ephemeral key - tokens are NOT "
                f"consistent across restarts. Set {resolved_env_name} or fix the "
                f"key path for deterministic tokens."
            ),
        )
