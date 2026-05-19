"""Cross-language regex parity test.

Loads the shared fixture at ``tests/fixtures/regex-parity.json`` (project
root) and asserts that :func:`server.regex_pipeline.find_pii_spans`
produces the exact spans listed in the fixture. The TS sibling test in
``packages/core/tests/regex-parity.test.ts`` loads the same fixture and
must agree. This is the only mechanical guard against the TS regex
detector and the Python regex pipeline drifting apart.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from server.regex_pipeline import find_pii_spans

FIXTURE_PATH = (
    Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "regex-parity.json"
)


@dataclass(frozen=True)
class ExpectedSpan:
    category: str
    text: str
    start: int
    end: int


@dataclass(frozen=True)
class Sample:
    name: str
    text: str
    expected: tuple[ExpectedSpan, ...]


def _load_samples() -> list[Sample]:
    raw = json.loads(FIXTURE_PATH.read_text("utf-8"))
    out: list[Sample] = []
    for s in raw["samples"]:
        expected = tuple(
            ExpectedSpan(
                category=e["category"],
                text=e["text"],
                start=e["start"],
                end=e["end"],
            )
            for e in s["expected"]
        )
        out.append(Sample(name=s["name"], text=s["text"], expected=expected))
    return out


@pytest.mark.parametrize("sample", _load_samples(), ids=lambda s: s.name)
def test_regex_parity_python_side(sample: Sample) -> None:
    spans = find_pii_spans(sample.text)
    actual = tuple(
        ExpectedSpan(
            category=s.category,
            text=s.text,
            start=s.start,
            end=s.end,
        )
        for s in spans
    )
    assert actual == sample.expected
