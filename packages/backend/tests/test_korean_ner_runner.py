"""Phase 7 Korean NER runner unit tests (ADR-0007 v2).

Tests the runner's BIO decoding, tag normalisation, and filtering logic
without hitting the network or loading real model weights.
"""

from __future__ import annotations

from server.korean_ner_runner import KoreanNerRunner, KoreanNerSpan


def test_runner_normalises_bio_prefix() -> None:
    from server.korean_ner_runner import _coerce_pipeline_entity

    span = _coerce_pipeline_entity(
        {
            "entity_group": "B-PS",
            "score": 0.91,
            "start": 0,
            "end": 3,
            "word": "김철수",
        },
        "김철수입니다",
    )
    assert span is not None
    assert span.klue_tag == "PS"
    assert span.category == "private_person"
    assert span.text == "김철수"


def test_runner_drops_unknown_tags() -> None:
    from server.korean_ner_runner import _coerce_pipeline_entity

    assert (
        _coerce_pipeline_entity(
            {"entity_group": "B-PERSON", "score": 1.0, "start": 0, "end": 3},
            "abc",
        )
        is None
    )
    assert (
        _coerce_pipeline_entity(
            {"entity_group": "MISC", "score": 1.0, "start": 0, "end": 3},
            "abc",
        )
        is None
    )


def test_runner_drops_out_of_range_spans() -> None:
    from server.korean_ner_runner import _coerce_pipeline_entity

    assert (
        _coerce_pipeline_entity(
            {"entity_group": "PS", "score": 0.9, "start": 5, "end": 100},
            "short",
        )
        is None
    )
    assert (
        _coerce_pipeline_entity(
            {"entity_group": "PS", "score": 0.9, "start": 5, "end": 5},
            "short text",
        )
        is None
    )


def test_runner_filter_min_confidence() -> None:
    from server.korean_ner_runner import _filter_min_confidence

    spans = [
        KoreanNerSpan(
            start=0, end=3, score=0.95, klue_tag="PS",
            category="private_person", text="김철수"
        ),
        KoreanNerSpan(
            start=4, end=7, score=0.45, klue_tag="PS",
            category="private_person", text="박영희"
        ),
    ]
    filtered = _filter_min_confidence(spans, 0.6)
    assert len(filtered) == 1
    assert filtered[0].text == "김철수"
