"""Reversible PII tokenisation, ported from ``@pii-remover/core`` (TypeScript).

The detection half of the system already lives in Python (``server.opf_runner``,
``server.regex_pipeline``, ``server.korean_ner_runner``) and emits stateless
``[OPF:LABEL]`` placeholders. This package adds the half that makes redaction
*reversible*: a vault that mints ``__OPF_<CATEGORY>__<HASH>__`` tokens and a
restorer that turns them back into the original text.

Why a port instead of a call into the TypeScript core: the proxy that needs
this runs in the same process as the model, so crossing a language boundary per
SSE delta is not affordable.

**Hard constraint** - the token wire format is shared with the TypeScript hook
that runs on the host (``packages/cli``) and with the OpenCode plugin. All three
must mint the *same* token for the same ``(key, category, text)`` or restoration
breaks across the process boundary. ``tests/test_token_parity.py`` pins this
against golden vectors generated from the TypeScript implementation by
``scripts/gen-token-vectors.ts``; a diff there is a wire-format break, not a
test failure to paper over.
"""

from __future__ import annotations

from .token_hash import (
    TOKEN_EPOCH_LENGTH,
    TOKEN_HASH_LENGTH,
    TokenKeyResolution,
    default_key_path,
    derive_token_key,
    resolve_token_key,
    token_epoch,
    token_hash,
)

__all__ = [
    "TOKEN_EPOCH_LENGTH",
    "TOKEN_HASH_LENGTH",
    "TokenKeyResolution",
    "default_key_path",
    "derive_token_key",
    "resolve_token_key",
    "token_epoch",
    "token_hash",
]
