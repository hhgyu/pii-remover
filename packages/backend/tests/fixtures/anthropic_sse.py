"""Builders for the Anthropic SSE shapes the thinking tests drive."""

from __future__ import annotations

import json
from typing import Any


def event(name: str, payload: dict[str, Any]) -> str:
    return f"event: {name}\ndata: {json.dumps(payload)}\n\n"


def delta(index: int, body: dict[str, str]) -> str:
    return event(
        "content_block_delta",
        {"type": "content_block_delta", "index": index, "delta": body},
    )


def thinking_delta(index: int, thinking: str) -> str:
    return delta(index, {"type": "thinking_delta", "thinking": thinking})


def signature_delta(index: int, signature: str) -> str:
    return delta(index, {"type": "signature_delta", "signature": signature})


def text_delta(index: int, text: str) -> str:
    return delta(index, {"type": "text_delta", "text": text})


def block_stop(index: int) -> str:
    return event("content_block_stop", {"type": "content_block_stop", "index": index})


def aggregate(sse: str) -> tuple[str, str]:
    """The thinking and signature the client received, each concatenated."""
    thinking = ""
    signature = ""
    for block in sse.split("\n\n"):
        line = next((ln for ln in block.split("\n") if ln.startswith("data: ")), None)
        if line is None:
            continue
        payload = json.loads(line[6:]).get("delta")
        if not isinstance(payload, dict):
            continue
        thinking += payload.get("thinking") or ""
        signature += payload.get("signature") or ""
    return thinking, signature
