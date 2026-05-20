# pyright: reportAny=false, reportExplicitAny=false, reportMissingImports=false, reportMissingTypeStubs=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnannotatedClassAttribute=false, reportUnusedCallResult=false
"""``openai/privacy-filter`` ONNX model loader and inference wrapper.

Production default is OPF INT8 ONNX (direct OpenAI-published artifact) with
BIOES + constrained Viterbi decoding. FP32 ONNX remains a fallback when present
or when ``OPF_VARIANT=fp32`` is selected. The public runner API intentionally
matches the original PyTorch implementation: ``detect()``, ``redact()``, and
``redact_many()`` signatures are unchanged.
"""

from __future__ import annotations

import json
import logging
import shutil
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Any, cast

import numpy as np

from .config import Settings, get_settings
from .schemas import Detection, OpfLabel, RedactResponse

log = logging.getLogger(__name__)

_VALID_LABELS: frozenset[str] = frozenset(
    {
        "account_number",
        "private_address",
        "private_email",
        "private_person",
        "private_phone",
        "private_url",
        "private_date",
        "secret",
    }
)

_NEG_INF = -1.0e9
_BIAS_BACKGROUND_STAY = "transition_bias_background_stay"
_BIAS_BACKGROUND_TO_START = "transition_bias_background_to_start"
_BIAS_END_TO_BACKGROUND = "transition_bias_end_to_background"
_BIAS_END_TO_START = "transition_bias_end_to_start"
_BIAS_INSIDE_TO_CONTINUE = "transition_bias_inside_to_continue"
_BIAS_INSIDE_TO_END = "transition_bias_inside_to_end"
_BIAS_NAMES = frozenset(
    {
        _BIAS_BACKGROUND_STAY,
        _BIAS_BACKGROUND_TO_START,
        _BIAS_END_TO_BACKGROUND,
        _BIAS_END_TO_START,
        _BIAS_INSIDE_TO_CONTINUE,
        _BIAS_INSIDE_TO_END,
    }
)

_COMMON_HF_FILES = (
    "tokenizer.json",
    "tokenizer_config.json",
    "config.json",
    "viterbi_calibration.json",
)
_ONNX_FILES_BY_VARIANT: dict[str, tuple[str, ...]] = {
    "int8": ("onnx/model_quantized.onnx", "onnx/model_quantized.onnx_data"),
    "fp32": (
        "onnx/model.onnx",
        "onnx/model.onnx_data",
        "onnx/model.onnx_data_1",
        "onnx/model.onnx_data_2",
    ),
}
_MODEL_FILENAME_BY_VARIANT = {"int8": "model_quantized.onnx", "fp32": "model.onnx"}


@dataclass(frozen=True)
class RawSpan:
    """Pipeline-agnostic span returned by the underlying model."""

    start: int
    end: int
    label: str
    score: float


def _normalise_label(raw_label: str) -> str:
    value = raw_label.strip().lower()
    for prefix in ("b-", "i-", "o-", "e-", "s-", "u-"):
        if value.startswith(prefix):
            value = value[len(prefix) :]
            break
    return value


def _cast_label(label: str) -> OpfLabel:
    """Promise type-checkers that a validated label is an OPF literal."""

    return cast(OpfLabel, label)


def _mask_text(text: str, spans: Sequence[RawSpan]) -> str:
    """Replace each span in ``text`` with ``[OPF:<LABEL>]`` placeholders."""

    if not spans:
        return text

    ordered = sorted(spans, key=lambda s: (s.start, -s.end))
    kept: list[RawSpan] = []
    last_end = -1
    for span in ordered:
        if span.start < last_end:
            continue
        kept.append(span)
        last_end = span.end

    out = text
    for span in reversed(kept):
        placeholder = f"[OPF:{span.label.upper()}]"
        out = out[: span.start] + placeholder + out[span.end :]
    return out


def _label_parts(label: str) -> tuple[str, str | None]:
    if label == "O":
        return "O", None
    if len(label) > 2 and label[1] == "-":
        return label[0].upper(), _normalise_label(label)
    return "O", None


def _transition_bias(prev_label: str, next_label: str, biases: dict[str, float]) -> float:
    prev_boundary, _prev_category = _label_parts(prev_label)
    next_boundary, _next_category = _label_parts(next_label)
    if prev_boundary == "O" and next_boundary == "O":
        return biases[_BIAS_BACKGROUND_STAY]
    if prev_boundary == "O" and next_boundary in {"B", "S"}:
        return biases[_BIAS_BACKGROUND_TO_START]
    if prev_boundary in {"E", "S"} and next_boundary == "O":
        return biases[_BIAS_END_TO_BACKGROUND]
    if prev_boundary in {"E", "S"} and next_boundary in {"B", "S"}:
        return biases[_BIAS_END_TO_START]
    if prev_boundary in {"B", "I"} and next_boundary == "I":
        return biases[_BIAS_INSIDE_TO_CONTINUE]
    if prev_boundary in {"B", "I"} and next_boundary == "E":
        return biases[_BIAS_INSIDE_TO_END]
    return 0.0


def _is_allowed_transition(prev_label: str, next_label: str) -> bool:
    prev_boundary, prev_category = _label_parts(prev_label)
    next_boundary, next_category = _label_parts(next_label)

    if prev_boundary == "O":
        return next_boundary == "O" or (
            next_boundary in {"B", "S"} and next_category in _VALID_LABELS
        )
    if prev_boundary in {"B", "I"}:
        return (
            next_boundary in {"I", "E"}
            and prev_category == next_category
            and next_category in _VALID_LABELS
        )
    if prev_boundary in {"E", "S"}:
        return next_boundary == "O" or (
            next_boundary in {"B", "S"} and next_category in _VALID_LABELS
        )
    return False


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=-1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=-1, keepdims=True)  # type: ignore[no-any-return]


def _build_transition_matrix(
    id2label: dict[int, str], biases: dict[str, float]
) -> np.ndarray:
    labels = [id2label[i] for i in range(len(id2label))]
    transitions = np.full((len(labels), len(labels)), _NEG_INF, dtype=np.float32)
    for prev_idx, prev_label in enumerate(labels):
        for next_idx, next_label in enumerate(labels):
            if _is_allowed_transition(prev_label, next_label):
                transitions[prev_idx, next_idx] = _transition_bias(
                    prev_label, next_label, biases
                )
    return transitions


def _viterbi_decode(
    logits: np.ndarray, id2label: dict[int, str], biases: dict[str, float]
) -> np.ndarray:
    """OPF BIOES constrained decoding (HF model card + calibration JSON)."""

    if logits.shape[0] == 0:
        return np.asarray([], dtype=np.int64)

    transitions = _build_transition_matrix(id2label, biases)
    labels = [id2label[i] for i in range(len(id2label))]
    o_idx = next((idx for idx, label in enumerate(labels) if label == "O"), 0)
    scores = logits.astype(np.float64, copy=True)

    dp = np.full_like(scores, _NEG_INF, dtype=np.float64)
    back = np.zeros(scores.shape, dtype=np.int64)
    dp[0] = scores[0] + transitions[o_idx]

    for pos in range(1, scores.shape[0]):
        candidate = dp[pos - 1][:, None] + transitions
        back[pos] = candidate.argmax(axis=0)
        dp[pos] = candidate[back[pos], np.arange(scores.shape[1])] + scores[pos]

    valid_end = np.asarray([_label_parts(label)[0] in {"O", "E", "S"} for label in labels])
    final_scores = dp[-1].copy()
    final_scores[~valid_end] = _NEG_INF
    if np.all(final_scores <= _NEG_INF / 2):
        return logits.argmax(axis=-1).astype(np.int64)  # type: ignore[no-any-return]

    path = np.zeros(scores.shape[0], dtype=np.int64)
    path[-1] = int(final_scores.argmax())
    for pos in range(scores.shape[0] - 1, 0, -1):
        path[pos - 1] = back[pos, path[pos]]
    return path


def _decode_bioes(
    pred_ids: np.ndarray,
    pred_scores: np.ndarray,
    offsets: np.ndarray,
    text: str,
    id2label: dict[int, str],
) -> list[RawSpan]:
    spans: list[RawSpan] = []
    cur: dict[str, Any] | None = None
    token_scores = pred_scores.max(axis=-1)

    def append_span(span: dict[str, Any]) -> None:
        start = int(span["start"])
        end = int(span["end"])
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        label = str(span["label"])
        if start >= end or label not in _VALID_LABELS:
            return
        spans.append(
            RawSpan(
                start=start,
                end=end,
                label=label,
                score=float(span["score"]),
            )
        )

    for token_index, (pred_id, (start_raw, end_raw)) in enumerate(
        zip(pred_ids, offsets, strict=True)
    ):
        start = int(start_raw)
        end = int(end_raw)
        label = id2label.get(int(pred_id), "O")
        boundary, category = _label_parts(label)

        if start == end or category not in _VALID_LABELS:
            if cur is not None:
                append_span(cur)
                cur = None
            continue

        score = float(pred_scores[token_index, int(pred_id)])
        if boundary == "S":
            if cur is not None:
                append_span(cur)
            append_span({"start": start, "end": end, "label": category, "score": score})
            cur = None
        elif boundary == "B":
            if cur is not None:
                append_span(cur)
            cur = {"start": start, "end": end, "label": category, "score": score}
        elif boundary == "I" and cur is not None and cur["label"] == category:
            cur["end"] = end
            cur["score"] = min(float(cur["score"]), float(token_scores[token_index]))
        elif boundary == "E" and cur is not None and cur["label"] == category:
            cur["end"] = end
            cur["score"] = min(float(cur["score"]), float(token_scores[token_index]))
            append_span(cur)
            cur = None
        elif cur is not None:
            append_span(cur)
            cur = None

    if cur is not None:
        append_span(cur)
    spans.sort(key=lambda s: (s.start, s.end))
    return spans


class OpfRunner:
    """Thread-safe ONNX OPF runner.

    Resolution order is controlled by ``OPF_VARIANT`` and local availability:
    INT8 ONNX (default) -> FP32 ONNX fallback. If ``OPF_ONNX_PATH`` is unset,
    the selected artifacts are downloaded from HuggingFace into the cache.
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings: Settings = settings or get_settings()
        self._session: Any | None = None
        self._tokenizer: Any | None = None
        self._id2label: dict[int, str] | None = None
        self._viterbi_biases: dict[str, float] | None = None
        self._loaded_variant: str | None = None
        self._load_lock = RLock()

    @property
    def is_loaded(self) -> bool:
        return self._session is not None

    @property
    def loaded_variant(self) -> str | None:
        return self._loaded_variant

    def load(self) -> None:
        """Load the first available ONNX variant."""

        if self._session is not None:
            return
        with self._load_lock:
            if self._session is not None:
                return

            errors: list[str] = []
            for variant in self._variant_order():
                try:
                    model_dir = self._resolve_model_dir(variant)
                    self._load_onnx_variant(model_dir, variant)
                    log.info(
                        "OPF ONNX model loaded variant=%s path=%s",
                        variant,
                        model_dir,
                    )
                    return
                except Exception as exc:
                    errors.append(f"{variant}: {exc}")
                    log.warning("failed to load OPF ONNX variant=%s: %s", variant, exc)
            raise RuntimeError("failed to load OPF ONNX model; " + "; ".join(errors))

    def unload(self) -> None:
        """Release ONNX session + tokenizer references so the GC can reclaim memory.

        Used by the idle-timeout monitor to free OPF weights when the
        backend has been inactive. ``detect()`` will lazy-reload on the
        next request via ``load()``. Idempotent and thread-safe.
        """

        if self._session is None:
            return
        with self._load_lock:
            if self._session is None:
                return
            self._session = None
            self._tokenizer = None
            self._id2label = None
            self._viterbi_biases = None
            self._loaded_variant = None
            log.info("OPF ONNX model unloaded (idle)")

    def detect(self, text: str) -> list[Detection]:
        """Run OPF on a single text and return Pydantic detections."""

        return [
            Detection(
                start=s.start,
                end=s.end,
                label=_cast_label(s.label),
                score=s.score,
                text=text[s.start : s.end],
            )
            for s in self._detect_raw(text)
        ]

    def redact(self, text: str) -> RedactResponse:
        """Return spans + masked text for one input."""

        spans = self._detect_raw(text)
        detections = [
            Detection(
                start=s.start,
                end=s.end,
                label=_cast_label(s.label),
                score=s.score,
                text=text[s.start : s.end],
            )
            for s in spans
        ]
        return RedactResponse(
            detections=detections,
            redacted_text=_mask_text(text, spans),
        )

    def redact_many(self, texts: Iterable[str]) -> list[RedactResponse]:
        """Batched convenience wrapper."""

        return [self.redact(t) for t in texts]

    def _detect_raw(self, text: str) -> list[RawSpan]:
        if not text:
            return []
        if self._session is None:
            self.load()
        assert self._session is not None
        assert self._tokenizer is not None
        assert self._id2label is not None
        assert self._viterbi_biases is not None

        import os
        from time import perf_counter
        profile = os.environ.get("OPF_PROFILE", "0") == "1"

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
        pred_ids = _viterbi_decode(logits, self._id2label, self._viterbi_biases)
        pred_scores = _softmax(logits)
        spans = _decode_bioes(pred_ids, pred_scores, offsets, text, self._id2label)
        t3 = perf_counter() if profile else 0.0
        if profile:
            log.info(
                "OPF_PROFILE tokenize=%.2fms inference=%.2fms decode=%.2fms "
                "total=%.2fms text_len=%d providers=%s",
                (t1 - t0) * 1000.0,
                (t2 - t1) * 1000.0,
                (t3 - t2) * 1000.0,
                (t3 - t0) * 1000.0,
                len(text),
                self._session.get_providers() if self._session else "N/A",
            )
        return spans

    def _variant_order(self) -> tuple[str, str]:
        if self._settings.opf_variant == "fp32":
            return ("fp32", "int8")
        return ("int8", "fp32")

    def _resolve_model_dir(self, variant: str) -> Path:
        configured = self._settings.onnx_model_path
        if configured:
            return Path(configured)
        return self._download_onnx_variant(variant)

    def _download_onnx_variant(self, variant: str) -> Path:
        from huggingface_hub import hf_hub_download

        cache_root = Path(
            self._settings.hf_cache_dir
            or Path.home() / ".cache" / "pii-remover" / "opf-onnx"
        )
        target = cache_root / variant
        target.mkdir(parents=True, exist_ok=True)
        for filename in (*_ONNX_FILES_BY_VARIANT[variant], *_COMMON_HF_FILES):
            downloaded = Path(
                hf_hub_download(
                    repo_id=self._settings.model_id,
                    filename=filename,
                    revision=self._settings.model_revision,
                    cache_dir=self._settings.hf_cache_dir,
                )
            )
            destination = target / Path(filename).name
            if not destination.exists() or destination.stat().st_size != downloaded.stat().st_size:
                shutil.copyfile(downloaded, destination)
        return target

    def _load_onnx_variant(self, model_dir: Path, variant: str) -> None:
        import onnxruntime as ort
        from transformers import PreTrainedTokenizerFast

        model_path = model_dir / _MODEL_FILENAME_BY_VARIANT[variant]
        tokenizer_path = model_dir / "tokenizer.json"
        config_path = model_dir / "config.json"
        if not model_path.is_file():
            raise FileNotFoundError(model_path)
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
        self._viterbi_biases = self._load_viterbi_biases(model_dir / "viterbi_calibration.json")
        self._loaded_variant = variant

    @staticmethod
    def _load_id2label(config_path: Path) -> dict[int, str]:
        cfg = json.loads(config_path.read_text(encoding="utf-8"))
        raw = cfg.get("id2label", {})
        if not isinstance(raw, dict) or not raw:
            raise ValueError(f"id2label missing in {config_path}")
        return {int(k): str(v) for k, v in raw.items()}

    @staticmethod
    def _load_viterbi_biases(path: Path) -> dict[str, float]:
        out = {name: 0.0 for name in _BIAS_NAMES}
        if not path.exists():
            return out
        raw = json.loads(path.read_text(encoding="utf-8"))
        biases = raw.get("operating_points", {}).get("default", {}).get("biases", {})
        for name in _BIAS_NAMES:
            try:
                out[name] = float(biases.get(name, 0.0))
            except (TypeError, ValueError):
                out[name] = 0.0
        return out

    def _session_inputs(self, inputs: dict[str, Any]) -> dict[str, np.ndarray]:
        assert self._session is not None
        available = {i.name for i in self._session.get_inputs()}
        out: dict[str, np.ndarray] = {}
        for name in ("input_ids", "attention_mask", "token_type_ids"):
            if name in available and name in inputs:
                out[name] = np.asarray(inputs[name], dtype=np.int64)
        missing = available - set(out)
        if missing:
            raise ValueError(f"ONNX session requires unsupported inputs: {sorted(missing)}")
        return out
