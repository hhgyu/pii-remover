"""Dynamic PIL image fixtures for ``test_image_api.py``.

Binary fixtures are intentionally not committed — each test image is
synthesised at runtime via ``PIL.Image.new`` + ``ImageDraw.text`` using
the bundled default font. This keeps the repo light and avoids cross-
platform font/font-discovery issues.
"""

from __future__ import annotations

import base64
import io
from typing import Any


def make_text_image(
    lines: list[str],
    width: int = 800,
    height: int = 200,
    font_size: int = 30,
    background: tuple[int, int, int] = (255, 255, 255),
    text_color: tuple[int, int, int] = (0, 0, 0),
) -> Any:
    """Return a synthetic RGB image with ``lines`` drawn on it."""

    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(img)

    font: Any
    try:
        font = ImageFont.load_default(font_size)
    except (TypeError, AttributeError):
        font = ImageFont.load_default()

    y = 10
    line_height = font_size + 8
    for line in lines:
        draw.text((10, y), line, fill=text_color, font=font)
        y += line_height
    return img


def image_to_b64(img: Any, fmt: str = "PNG") -> str:
    """Encode a PIL image to a bare base64 string (no data URI prefix)."""

    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("ascii")
