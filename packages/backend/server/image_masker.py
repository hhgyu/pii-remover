"""PIL-based image mask drawing for image PII redaction (ADR-0009 Phase 6).

v1 supports only ``fill``. ``blur`` and ``pixelate`` raise
:class:`NotImplementedError` so the API can return ``501 Not Implemented``
instead of silently falling back to the wrong masking strategy
(fail-closed, per ADR-0009 §Decision §3).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class MaskRegion:
    """Pixel rectangle to be masked."""

    left: int
    top: int
    width: int
    height: int

    @property
    def right(self) -> int:
        return self.left + self.width

    @property
    def bottom(self) -> int:
        return self.top + self.height


class ImageMasker:
    """Stateless PIL ``ImageDraw`` wrapper."""

    def apply_fill_mask(
        self,
        image: Any,
        regions: Sequence[MaskRegion],
        color: tuple[int, int, int] = (0, 0, 0),
    ) -> Any:
        """Return a copy of ``image`` with each region painted with ``color``."""

        from PIL import ImageDraw

        result = image.copy()
        if not regions:
            return result
        if result.mode not in ("RGB", "RGBA"):
            result = result.convert("RGB")
        draw = ImageDraw.Draw(result)
        for r in regions:
            right = max(r.left, r.right - 1)
            bottom = max(r.top, r.bottom - 1)
            draw.rectangle([r.left, r.top, right, bottom], fill=color)
        return result

    def apply_blur_mask(
        self,
        image: Any,
        regions: Sequence[MaskRegion],
        radius: float = 12.0,
    ) -> Any:
        raise NotImplementedError(
            "v1.x: blur mask not implemented; use mask_method='fill'"
        )

    def apply_pixelate_mask(
        self,
        image: Any,
        regions: Sequence[MaskRegion],
        block_size: int = 12,
    ) -> Any:
        raise NotImplementedError(
            "v1.x: pixelate mask not implemented; use mask_method='fill'"
        )
