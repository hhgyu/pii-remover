"""Korean NER model loader and inference wrapper (Phase 7, ADR-0007 v2).

ONNX runtime backend — mirrors :mod:`server.opf_runner` architecture but
for a Korean named-entity-recognition model (default
``soddokayo/koelectra-base-klue-ner`` — Apache-2.0).

Why a separate runner?

- Different label set (KLUE NER: ``PS``/``LC``/``OG``/``DT``/``TI``/``QT``)
  vs OPF's English PII categories — no shared vocabulary.
- KLUE uses BIO tagging (B-/I-) only, unlike OPF's BIOES.
- Phase 7 v1 only consumes the ``PS`` (person) tag; the other KLUE tags
  ride along in the response for future use without changing the API.

Resolution order: ``KNER_ONNX_PATH`` (pre-baked in Docker) → HuggingFace
download into local cache.
"""

from __future__ import annotations

import json
import logging
import shutil
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Any

import numpy as np

from .config import KoreanNerSettings, get_korean_ner_settings

log = logging.getLogger(__name__)

#: Mapping from KLUE NER tag -> our internal category name.
#: ``PS`` (Person) is the only tag promoted to a PII category in v1; the
#: others are kept in the response as ``other`` entries for diagnostics.
KLUE_TAG_TO_CATEGORY: dict[str, str] = {
    "PS": "private_person",
}

#: Tag names KLUE NER emits. Anything outside this set is treated as
#: garbage and dropped from the response.
_KNOWN_KLUE_TAGS: frozenset[str] = frozenset(
    {"PS", "LC", "OG", "DT", "TI", "QT"}
)

_KLUE_ONNX_FILENAME = "model_quantized.onnx"
_KLUE_FP32_FILENAME = "model.onnx"
_KLUE_COMMON_FILES = (
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.txt",
    "config.json",
)


@dataclass(frozen=True)
class KoreanNerSpan:
    """A single NER span with the original KLUE tag and our mapped category.

    ``category`` is ``None`` when the tag is not promoted to a PII category
    (e.g., ``LC`` location); the API still returns it under ``other_spans``.
    """

    start: int
    end: int
    score: float
    klue_tag: str
    category: str | None
    text: str


def _normalise_tag(raw: str) -> str:
    """Strip BIO prefixes and uppercase. Defensive across model revisions."""

    value = raw.strip()
    for prefix in ("B-", "I-", "O-", "E-", "S-", "U-"):
        if value.startswith(prefix):
            value = value[len(prefix):]
            break
    return value.upper()


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=-1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=-1, keepdims=True)  # type: ignore[no-any-return]


def _label_parts(label: str) -> tuple[str, str | None]:
    """Split a BIO label into (boundary, category). Returns ('O', None) for 'O'."""

    if label == "O":
        return "O", None
    if len(label) > 2 and label[1] == "-":
        return label[0].upper(), _normalise_tag(label)
    return "O", None


def _is_valid_klue_tag(tag: str | None) -> bool:
    return tag is not None and tag in _KNOWN_KLUE_TAGS


def _decode_bio(
    pred_ids: np.ndarray,
    pred_scores: np.ndarray,
    offsets: np.ndarray,
    text: str,
    id2label: dict[int, str],
) -> list[KoreanNerSpan]:
    """Decode BIO-tagged predictions into spans.

    KLUE uses B-/I- tagging only (no E-/S-). B starts a new entity, I continues it.
    """
    spans: list[KoreanNerSpan] = []
    cur: dict[str, Any] | None = None
    token_scores = pred_scores.max(axis=-1)

    for token_index, (pred_id, (start_raw, end_raw)) in enumerate(
        zip(pred_ids, offsets, strict=True)
    ):
        start = int(start_raw)
        end = int(end_raw)
        label = id2label.get(int(pred_id), "O")
        boundary, category = _label_parts(label)

        # Skip special tokens (start==end) and unknown tags
        if start == end or not _is_valid_klue_tag(category):
            if cur is not None:
                spans.append(_finalize_span(cur, text))
                cur = None
            continue

        score = float(pred_scores[token_index, int(pred_id)])

        if boundary == "B":
            if cur is not None:
                spans.append(_finalize_span(cur, text))
            cur = {"start": start, "end": end, "klue_tag": category, "score": score, "n": 1}
        elif boundary == "I" and cur is not None and cur["klue_tag"] == category:
            cur["end"] = end
            cur["n"] += 1
            cur["score"] = float(cur["score"]) + float(token_scores[token_index])
        elif cur is not None:
            spans.append(_finalize_span(cur, text))
            cur = None

    if cur is not None:
        spans.append(_finalize_span(cur, text))

    spans.sort(key=lambda s: (s.start, s.end))
    return spans


def _finalize_span(cur: dict[str, Any], text: str) -> KoreanNerSpan:
    start = cur["start"]
    end = cur["end"]
    tag = cur["klue_tag"]
    n = cur.get("n", 1)
    return KoreanNerSpan(
        start=start,
        end=end,
        score=float(cur["score"]) / n,
        klue_tag=tag,
        category=KLUE_TAG_TO_CATEGORY.get(tag),
        text=text[start:end],
    )


def _coerce_pipeline_entity(
    entity: dict[str, Any], original_text: str
) -> KoreanNerSpan | None:
    """Coerce one entry from a HF token-classification pipeline dict.

    Preserved for backward-compatible unit tests. The ONNX runner uses
    ``_decode_bio`` instead, but this function validates the same tag/offset
    contract.
    """

    raw = entity.get("entity_group") or entity.get("entity") or ""
    tag = _normalise_tag(str(raw))
    if not tag or tag not in _KNOWN_KLUE_TAGS:
        return None
    try:
        start = int(entity["start"])
        end = int(entity["end"])
    except (KeyError, TypeError, ValueError):
        return None
    if end <= start or start < 0 or end > len(original_text):
        return None
    return KoreanNerSpan(
        start=start,
        end=end,
        score=float(entity.get("score", 0.0)),
        klue_tag=tag,
        category=KLUE_TAG_TO_CATEGORY.get(tag),
        text=original_text[start:end],
    )


def _filter_min_confidence(
    spans: Sequence[KoreanNerSpan], min_confidence: float
) -> list[KoreanNerSpan]:
    if min_confidence <= 0:
        return list(spans)
    return [s for s in spans if s.score >= min_confidence]


_MIN_PS_SPAN_LEN = 2


def _filter_short_person_spans(
    spans: Sequence[KoreanNerSpan],
) -> list[KoreanNerSpan]:
    return [s for s in spans if s.klue_tag != "PS" or (s.end - s.start) >= _MIN_PS_SPAN_LEN]


class KoreanNerRunner:
    """Thread-safe ONNX Korean NER runner.

    Mirrors the public lifecycle shape of :class:`server.opf_runner.OpfRunner`:
    lazy load, thread-safe ``detect()``, ``is_loaded`` / ``model_id`` properties.

    Resolution order: ``KNER_ONNX_PATH`` env (Docker pre-bake) → HuggingFace
    download into local cache.
    """

    def __init__(self, settings: KoreanNerSettings | None = None) -> None:
        self._settings: KoreanNerSettings = (
            settings if settings is not None else get_korean_ner_settings()
        )
        self._session: Any | None = None
        self._tokenizer: Any | None = None
        self._id2label: dict[int, str] | None = None
        self._load_lock = RLock()

    @property
    def is_loaded(self) -> bool:
        return self._session is not None

    @property
    def model_id(self) -> str:
        return self._settings.model_id

    def load(self) -> None:
        """Idempotent, thread-safe ONNX model load."""

        if self._session is not None:
            return
        with self._load_lock:
            if self._session is not None:
                return
            log.info(
                "loading Korean NER ONNX model id=%s device=%s",
                self._settings.model_id,
                self._settings.device,
            )
            model_dir = self._resolve_model_dir()
            self._load_onnx(model_dir)
            log.info("Korean NER ONNX model loaded from %s", model_dir)

    def unload(self) -> None:
        """Release ONNX session + tokenizer references (idle-timeout hook).

        ``detect()`` lazy-reloads on the next request via ``load()``.
        Idempotent and thread-safe.
        """

        if self._session is None:
            return
        with self._load_lock:
            if self._session is None:
                return
            self._session = None
            self._tokenizer = None
            self._id2label = None
            log.info("Korean NER ONNX model unloaded (idle)")

    def detect(
        self, text: str, min_confidence: float | None = None
    ) -> list[KoreanNerSpan]:
        """Run NER on a single text. Empty/whitespace inputs short-circuit.

        Args:
            text: Korean text to NER-tag.
            min_confidence: Per-request override for the server-side
                ``min_confidence``.  When ``None``, the runner falls back to
                ``self._settings.min_confidence``.
        """

        if not text or not text.strip():
            return []
        if self._session is None:
            try:
                self.load()
            except Exception:
                log.exception(
                    "Korean NER lazy-load failed; returning empty detections "
                    "(this call is dropped, future calls will retry)"
                )
                return []
        assert self._session is not None
        assert self._tokenizer is not None
        assert self._id2label is not None

        import os
        from time import perf_counter
        profile = os.environ.get("KNER_PROFILE", "0") == "1"

        threshold = (
            min_confidence
            if min_confidence is not None
            else self._settings.min_confidence
        )

        t0 = perf_counter() if profile else 0.0
        encoded = self._tokenizer(
            text,
            return_tensors="np",
            truncation=True,
            max_length=512,
            return_offsets_mapping=True,
        )
        inputs = dict(encoded)
        offsets = np.asarray(inputs.pop("offset_mapping"))[0]
        t1 = perf_counter() if profile else 0.0
        outputs = self._session.run(None, self._session_inputs(inputs))
        t2 = perf_counter() if profile else 0.0
        logits = np.asarray(outputs[0])[0]
        pred_ids = logits.argmax(axis=-1)
        pred_scores = _softmax(logits)
        spans = _filter_min_confidence(
            _filter_short_person_spans(
                _decode_bio(pred_ids, pred_scores, offsets, text, self._id2label),
            ),
            threshold,
        )
        t3 = perf_counter() if profile else 0.0
        if profile:
            log.info(
                "KNER_PROFILE tokenize=%.2fms inference=%.2fms decode=%.2fms "
                "total=%.2fms text_len=%d providers=%s",
                (t1 - t0) * 1000.0,
                (t2 - t1) * 1000.0,
                (t3 - t2) * 1000.0,
                (t3 - t0) * 1000.0,
                len(text),
                self._session.get_providers() if self._session else "N/A",
            )
        return spans

    def _resolve_model_dir(self) -> Path:
        configured = self._settings.onnx_model_path
        if configured:
            return Path(configured)
        return self._download_model()

    def _download_model(self) -> Path:
        from huggingface_hub import hf_hub_download

        cache_root = Path(
            self._settings.hf_cache_dir
            or Path.home() / ".cache" / "pii-remover" / "klue-ner-onnx"
        )
        target = cache_root / "int8"
        target.mkdir(parents=True, exist_ok=True)

        all_files = (_KLUE_ONNX_FILENAME, *_KLUE_COMMON_FILES)
        for filename in all_files:
            try:
                downloaded = Path(
                    hf_hub_download(
                        repo_id=self._settings.model_id,
                        filename=filename,
                        revision=self._settings.model_revision,
                        cache_dir=self._settings.hf_cache_dir,
                    )
                )
            except Exception:
                continue
            destination = target / Path(filename).name
            if not destination.exists() or destination.stat().st_size != downloaded.stat().st_size:
                shutil.copyfile(downloaded, destination)
        return target

    def _load_onnx(self, model_dir: Path) -> None:
        import onnxruntime as ort
        from transformers import PreTrainedTokenizerFast

        model_path = model_dir / _KLUE_ONNX_FILENAME
        if not model_path.is_file():
            model_path = model_dir / _KLUE_FP32_FILENAME
        if not model_path.is_file():
            raise FileNotFoundError(f"No ONNX model found in {model_dir}")

        tokenizer_path = model_dir / "tokenizer.json"
        config_path = model_dir / "config.json"
        if not tokenizer_path.is_file():
            raise FileNotFoundError(tokenizer_path)
        if not config_path.is_file():
            raise FileNotFoundError(config_path)

        providers = ["CPUExecutionProvider"]
        if (
            self._settings.device == "cuda"
            and "CUDAExecutionProvider" in ort.get_available_providers()
        ):
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]

        self._session = ort.InferenceSession(str(model_path), providers=providers)
        self._tokenizer = PreTrainedTokenizerFast(  # type: ignore[unused-ignore, no-untyped-call]
            tokenizer_file=str(tokenizer_path)
        )
        self._id2label = self._load_id2label(config_path)

    @staticmethod
    def _load_id2label(config_path: Path) -> dict[int, str]:
        cfg = json.loads(config_path.read_text(encoding="utf-8"))
        raw = cfg.get("id2label", {})
        if not isinstance(raw, dict) or not raw:
            raise ValueError(f"id2label missing in {config_path}")
        return {int(k): str(v) for k, v in raw.items()}

    def _session_inputs(self, inputs: dict[str, Any]) -> dict[str, np.ndarray]:
        assert self._session is not None
        available = {i.name for i in self._session.get_inputs()}
        out: dict[str, np.ndarray] = {}
        for name in ("input_ids", "attention_mask", "token_type_ids"):
            if name not in available:
                continue
            if name in inputs:
                out[name] = np.asarray(inputs[name], dtype=np.int64)
            elif name == "token_type_ids":
                seq_len = inputs["input_ids"].shape[-1]
                out[name] = np.zeros((1, seq_len), dtype=np.int64)
        missing = available - set(out)
        if missing:
            raise ValueError(f"ONNX session requires unsupported inputs: {sorted(missing)}")
        return out
