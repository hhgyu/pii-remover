# pyright: reportAny=false, reportExplicitAny=false, reportMissingImports=false, reportMissingTypeStubs=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportImplicitStringConcatenation=false, reportUnusedCallResult=false
"""v1.x OPF ONNX PoC: 3-way ONNX Runtime benchmark.

Compares OpenAI-published ONNX artifacts for ``openai/privacy-filter`` against
the English PII corpus fixture:

    FP32 baseline       .poc/opf-fp32/model.onnx
    INT8 quantized      .poc/opf-int8/model_quantized.onnx
    INT4+FP16 quantized .poc/opf-int4fp16/model_q4f16.onnx

This script bypasses ``AutoConfig`` and ``optimum`` for ONNX variants. It loads
``tokenizer.json`` with ``PreTrainedTokenizerFast``, parses ``config.json`` as
raw JSON for ``id2label``, runs ``onnxruntime.InferenceSession`` directly, and
decodes OPF's BIOES tag sequence with constrained Viterbi decoding.

Usage:
    python scripts/poc-opf-benchmark.py
    $env:OPF_ONNX_SKIP_FP32 = "1"; python scripts/poc-opf-benchmark.py
    python scripts/poc-opf-benchmark.py --runs 100
"""

from __future__ import annotations

import argparse
import gc
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from transformers import PreTrainedTokenizerFast

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("poc-opf-benchmark")

ROOT = Path(__file__).resolve().parent.parent.parent.parent
BACKEND = ROOT / "packages" / "backend"
CORPUS = ROOT / "packages" / "core" / "tests" / "fixtures" / "english-pii-corpus.json"

OPF_CATEGORIES = frozenset(
    {
        "private_person",
        "private_email",
        "private_phone",
        "private_address",
        "private_url",
        "private_date",
        "account_number",
        "secret",
    }
)

NEG_INF = -1.0e9

BIAS_BACKGROUND_STAY = "transition_bias_background_stay"
BIAS_BACKGROUND_TO_START = "transition_bias_background_to_start"
BIAS_END_TO_BACKGROUND = "transition_bias_end_to_background"
BIAS_END_TO_START = "transition_bias_end_to_start"
BIAS_INSIDE_TO_CONTINUE = "transition_bias_inside_to_continue"
BIAS_INSIDE_TO_END = "transition_bias_inside_to_end"

GATE_OVERALL_F1_DROP_PP = 2.0
GATE_PER_CATEGORY_F1_DROP_PP = 5.0
GATE_MEMORY_REDUCTION_PCT = 30.0
GATE_LATENCY_RATIO_MAX = 1.05


@dataclass(frozen=True)
class VariantSpec:
    key: str
    title: str
    directory: Path
    model_filename: str


@dataclass
class BenchResult:
    variant: str
    tp: int
    fp: int
    fn: int
    precision: float
    recall: float
    f1: float
    per_cat_tp: dict[str, int]
    per_cat_fp: dict[str, int]
    per_cat_fn: dict[str, int]
    per_cat_precision: dict[str, float]
    per_cat_recall: dict[str, float]
    per_cat_f1: dict[str, float]
    avg_latency_ms: float
    peak_memory_mb: float
    model_size_mb: float


@dataclass(frozen=True)
class GateVerdict:
    key: str
    title: str
    passed: bool
    overall_drop_pp: float
    worst_category_drop_pp: float
    memory_reduction_pct: float
    latency_ratio: float
    failed: tuple[str, ...]


VARIANTS = {
    "fp32": VariantSpec("fp32", "FP32", BACKEND / ".poc" / "opf-fp32", "model.onnx"),
    "int8": VariantSpec("int8", "INT8", BACKEND / ".poc" / "opf-int8", "model_quantized.onnx"),
    "int4fp16": VariantSpec("int4fp16", "INT4+FP16", BACKEND / ".poc" / "opf-int4fp16", "model_q4f16.onnx"),
}


def _load_corpus() -> dict[str, Any]:
    if not CORPUS.exists():
        log.error("corpus not found: %s", CORPUS)
        sys.exit(2)
    return json.loads(CORPUS.read_text(encoding="utf-8"))


def _dir_size_mb(path: Path) -> float:
    if not path.exists():
        return 0.0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) / (1024 * 1024)


def _peak_memory_mb() -> float:
    try:
        import psutil

        return psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)
    except ImportError:
        return 0.0


def _normalise_label(raw: str) -> str:
    value = raw.strip().lower()
    for prefix in ("b-", "i-", "o-", "e-", "s-", "u-"):
        if value.startswith(prefix):
            value = value[len(prefix) :]
            break
    return value


def _load_id2label(variant_dir: Path) -> dict[int, str]:
    """Parse config.json directly without AutoConfig (bypasses model_type check)."""
    cfg_path = variant_dir / "config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    raw = cfg.get("id2label", {})
    if not isinstance(raw, dict) or not raw:
        raise ValueError(f"id2label missing in {cfg_path}")
    return {int(k): str(v) for k, v in raw.items()}


def _load_viterbi_biases(variant_dir: Path) -> dict[str, float]:
    """Load optional OPF transition calibration; missing file means vanilla Viterbi."""
    bias_names = {
        BIAS_BACKGROUND_STAY,
        BIAS_BACKGROUND_TO_START,
        BIAS_END_TO_BACKGROUND,
        BIAS_END_TO_START,
        BIAS_INSIDE_TO_CONTINUE,
        BIAS_INSIDE_TO_END,
    }
    out = {name: 0.0 for name in bias_names}
    path = variant_dir / "viterbi_calibration.json"
    if not path.exists():
        return out
    raw = json.loads(path.read_text(encoding="utf-8"))
    biases = raw.get("operating_points", {}).get("default", {}).get("biases", {})
    for name in bias_names:
        try:
            out[name] = float(biases.get(name, 0.0))
        except (TypeError, ValueError):
            out[name] = 0.0
    return out


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=-1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=-1, keepdims=True)


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
        return biases[BIAS_BACKGROUND_STAY]
    if prev_boundary == "O" and next_boundary in {"B", "S"}:
        return biases[BIAS_BACKGROUND_TO_START]
    if prev_boundary in {"E", "S"} and next_boundary == "O":
        return biases[BIAS_END_TO_BACKGROUND]
    if prev_boundary in {"E", "S"} and next_boundary in {"B", "S"}:
        return biases[BIAS_END_TO_START]
    if prev_boundary in {"B", "I"} and next_boundary == "I":
        return biases[BIAS_INSIDE_TO_CONTINUE]
    if prev_boundary in {"B", "I"} and next_boundary == "E":
        return biases[BIAS_INSIDE_TO_END]
    return 0.0


def _is_allowed_transition(prev_label: str, next_label: str) -> bool:
    prev_boundary, prev_category = _label_parts(prev_label)
    next_boundary, next_category = _label_parts(next_label)

    if prev_boundary == "O":
        return next_boundary == "O" or (next_boundary in {"B", "S"} and next_category in OPF_CATEGORIES)
    if prev_boundary in {"B", "I"}:
        return next_boundary in {"I", "E"} and prev_category == next_category and next_category in OPF_CATEGORIES
    if prev_boundary in {"E", "S"}:
        return next_boundary == "O" or (next_boundary in {"B", "S"} and next_category in OPF_CATEGORIES)
    return False


def _build_transition_matrix(id2label: dict[int, str], biases: dict[str, float]) -> np.ndarray:
    labels = [id2label[i] for i in range(len(id2label))]
    transitions = np.full((len(labels), len(labels)), NEG_INF, dtype=np.float32)
    for prev_idx, prev_label in enumerate(labels):
        for next_idx, next_label in enumerate(labels):
            if _is_allowed_transition(prev_label, next_label):
                transitions[prev_idx, next_idx] = _transition_bias(prev_label, next_label, biases)
    return transitions


def _viterbi_decode(logits: np.ndarray, id2label: dict[int, str], biases: dict[str, float]) -> np.ndarray:
    # OPF BIOES constrained decoding: HF model card + viterbi_calibration.json.
    """Constrained BIOES Viterbi with virtual O start and valid end states."""
    if logits.shape[0] == 0:
        return np.asarray([], dtype=np.int64)

    transitions = _build_transition_matrix(id2label, biases)
    labels = [id2label[i] for i in range(len(id2label))]
    o_idx = next((idx for idx, label in enumerate(labels) if label == "O"), 0)
    scores = logits.astype(np.float64, copy=True)

    dp = np.full_like(scores, NEG_INF, dtype=np.float64)
    back = np.zeros(scores.shape, dtype=np.int64)
    dp[0] = scores[0] + transitions[o_idx]

    for pos in range(1, scores.shape[0]):
        candidate = dp[pos - 1][:, None] + transitions
        back[pos] = candidate.argmax(axis=0)
        dp[pos] = candidate[back[pos], np.arange(scores.shape[1])] + scores[pos]

    valid_end = np.asarray([_label_parts(label)[0] in {"O", "E", "S"} for label in labels])
    final_scores = dp[-1].copy()
    final_scores[~valid_end] = NEG_INF
    if np.all(final_scores <= NEG_INF / 2):
        return logits.argmax(axis=-1).astype(np.int64)

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
) -> list[dict[str, Any]]:
    spans: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    token_scores = pred_scores.max(axis=-1)

    def append_span(span: dict[str, Any]) -> None:
        start = int(span["start"])
        end = int(span["end"])
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        if start >= end:
            return
        span["start"] = start
        span["end"] = end
        span["text"] = text[start:end]
        spans.append(span)

    for token_index, (pred_id, (start_raw, end_raw)) in enumerate(zip(pred_ids, offsets)):
        start = int(start_raw)
        end = int(end_raw)
        label = id2label.get(int(pred_id), "O")
        boundary, category = _label_parts(label)

        if start == end or category not in OPF_CATEGORIES:
            if cur is not None:
                append_span(cur)
                cur = None
            continue

        score = float(pred_scores[token_index, int(pred_id)])
        if boundary == "S":
            if cur is not None:
                append_span(cur)
            append_span({"start": start, "end": end, "category": category, "score": score, "text": text[start:end]})
            cur = None
        elif boundary == "B":
            if cur is not None:
                append_span(cur)
            cur = {"start": start, "end": end, "category": category, "score": score, "text": text[start:end]}
        elif boundary == "I" and cur is not None and cur["category"] == category:
            cur["end"] = end
            cur["score"] = min(float(cur["score"]), float(token_scores[token_index]))
            cur["text"] = text[int(cur["start"]):end]
        elif boundary == "E" and cur is not None and cur["category"] == category:
            cur["end"] = end
            cur["score"] = min(float(cur["score"]), float(token_scores[token_index]))
            cur["text"] = text[int(cur["start"]):end]
            append_span(cur)
            cur = None
        else:
            if cur is not None:
                append_span(cur)
                cur = None

    if cur is not None:
        append_span(cur)
    return spans


def _session_inputs(session: ort.InferenceSession, inputs: dict[str, Any]) -> dict[str, np.ndarray]:
    available = {i.name for i in session.get_inputs()}
    out: dict[str, np.ndarray] = {}
    for name in ("input_ids", "attention_mask", "token_type_ids"):
        if name in available and name in inputs:
            out[name] = np.asarray(inputs[name], dtype=np.int64)
    missing = available - set(out)
    if missing:
        raise ValueError(f"ONNX session requires unsupported inputs: {sorted(missing)}")
    return out


def _run_inference(
    text: str,
    session: ort.InferenceSession,
    tokenizer: PreTrainedTokenizerFast,
    id2label: dict[int, str],
    viterbi_biases: dict[str, float],
) -> list[dict[str, Any]]:
    if not text:
        return []
    encoded = tokenizer(
        text,
        return_tensors="np",
        truncation=True,
        max_length=512,
        return_offsets_mapping=True,
    )
    inputs = dict(encoded)
    offsets = np.asarray(inputs.pop("offset_mapping"))[0]
    outputs = session.run(None, _session_inputs(session, inputs))
    logits = np.asarray(outputs[0])[0]
    pred_ids = _viterbi_decode(logits, id2label, viterbi_biases)
    pred_scores = _softmax(logits)
    return _decode_bioes(pred_ids, pred_scores, offsets, text, id2label)


def _expected_spans(case: dict[str, Any], text: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    cursor = 0
    for exp in case.get("expected", []):
        expected_text = str(exp["text"])
        category = str(exp["category"]).lower()
        idx = text.find(expected_text, cursor)
        if idx < 0:
            idx = text.find(expected_text)
        if idx < 0:
            log.warning("expected text not found in case: %r", expected_text)
            continue
        if category not in OPF_CATEGORIES:
            log.warning("expected category not in OPF set: %s", category)
            continue
        out.append({"start": idx, "end": idx + len(expected_text), "text": expected_text, "category": category})
        cursor = idx + len(expected_text)
    return out


def _f1(precision: float, recall: float) -> float:
    return 2 * precision * recall / max(1e-9, precision + recall)


def _build_session(spec: VariantSpec) -> tuple[ort.InferenceSession, PreTrainedTokenizerFast, dict[int, str], dict[str, float]]:
    model_path = spec.directory / spec.model_filename
    if not model_path.exists():
        raise FileNotFoundError(model_path)
    tokenizer_path = spec.directory / "tokenizer.json"
    tokenizer = PreTrainedTokenizerFast(tokenizer_file=str(tokenizer_path))
    id2label = _load_id2label(spec.directory)
    viterbi_biases = _load_viterbi_biases(spec.directory)
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    return session, tokenizer, id2label, viterbi_biases


def _benchmark(spec: VariantSpec, corpus: dict[str, Any], runs: int) -> BenchResult:
    log.info("loading variant=%s from %s", spec.key, spec.directory)
    gc.collect()
    session, tokenizer, id2label, viterbi_biases = _build_session(spec)

    _run_inference("Email warmup@example.com before calling Alice Smith.", session, tokenizer, id2label, viterbi_biases)

    tp = fp = fn = 0
    per_cat_tp = {c: 0 for c in OPF_CATEGORIES}
    per_cat_fp = {c: 0 for c in OPF_CATEGORIES}
    per_cat_fn = {c: 0 for c in OPF_CATEGORIES}
    latencies: list[float] = []
    peak = _peak_memory_mb()

    def _evaluate_case(text: str, expected: list[dict[str, Any]]) -> None:
        nonlocal tp, fp, fn, peak
        preds: list[dict[str, Any]] = []
        for _ in range(runs):
            t0 = time.perf_counter()
            preds = _run_inference(text, session, tokenizer, id2label, viterbi_biases)
            latencies.append((time.perf_counter() - t0) * 1000.0)
            peak = max(peak, _peak_memory_mb())

        matched_pred_indices: set[int] = set()
        for exp in expected:
            hit_idx = next(
                (
                    idx
                    for idx, pred in enumerate(preds)
                    if idx not in matched_pred_indices
                    and pred["start"] == exp["start"]
                    and pred["end"] == exp["end"]
                    and pred["category"] == exp["category"]
                ),
                None,
            )
            if hit_idx is not None:
                tp += 1
                per_cat_tp[exp["category"]] += 1
                matched_pred_indices.add(hit_idx)
            else:
                fn += 1
                per_cat_fn[exp["category"]] += 1

        for idx, pred in enumerate(preds):
            if idx in matched_pred_indices:
                continue
            fp += 1
            per_cat_fp[pred["category"]] += 1

    try:
        for case in corpus.get("true_positives", []):
            _evaluate_case(case["text"], _expected_spans(case, case["text"]))
        for case in corpus.get("edge_cases", []):
            _evaluate_case(case["text"], _expected_spans(case, case["text"]))
        for case in corpus.get("true_negatives", []):
            _evaluate_case(case["text"], [])
    finally:
        del session
        del tokenizer
        gc.collect()

    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    f1 = _f1(precision, recall)
    per_cat_precision = {c: per_cat_tp[c] / max(1, per_cat_tp[c] + per_cat_fp[c]) for c in OPF_CATEGORIES}
    per_cat_recall = {c: per_cat_tp[c] / max(1, per_cat_tp[c] + per_cat_fn[c]) for c in OPF_CATEGORIES}
    per_cat_f1 = {c: _f1(per_cat_precision[c], per_cat_recall[c]) for c in OPF_CATEGORIES}
    avg_latency = sum(latencies) / max(1, len(latencies))
    return BenchResult(
        variant=spec.key,
        tp=tp,
        fp=fp,
        fn=fn,
        precision=precision,
        recall=recall,
        f1=f1,
        per_cat_tp=per_cat_tp,
        per_cat_fp=per_cat_fp,
        per_cat_fn=per_cat_fn,
        per_cat_precision=per_cat_precision,
        per_cat_recall=per_cat_recall,
        per_cat_f1=per_cat_f1,
        avg_latency_ms=avg_latency,
        peak_memory_mb=peak,
        model_size_mb=_dir_size_mb(spec.directory),
    )


def _worst_category_f1(result: BenchResult) -> float:
    measured = [c for c in OPF_CATEGORIES if result.per_cat_tp[c] + result.per_cat_fn[c] > 0]
    return min((result.per_cat_f1[c] for c in measured), default=0.0)


def _measured_categories(fp32: BenchResult) -> list[str]:
    return sorted(c for c in OPF_CATEGORIES if fp32.per_cat_tp[c] + fp32.per_cat_fn[c] > 0)


def _compare_to_fp32(fp32: BenchResult, quant: BenchResult, title: str) -> GateVerdict:
    overall_drop = (fp32.f1 - quant.f1) * 100.0
    mem_red = (1.0 - quant.peak_memory_mb / max(1.0, fp32.peak_memory_mb)) * 100.0
    latency_ratio = quant.avg_latency_ms / max(0.001, fp32.avg_latency_ms)
    measured = _measured_categories(fp32)
    worst_cat_drop = max(((fp32.per_cat_f1[c] - quant.per_cat_f1[c]) * 100.0 for c in measured), default=0.0)

    failed: list[str] = []
    if overall_drop > GATE_OVERALL_F1_DROP_PP:
        failed.append(f"G1 overall F1 drop {overall_drop:.2f}pp > {GATE_OVERALL_F1_DROP_PP}pp")
    if worst_cat_drop > GATE_PER_CATEGORY_F1_DROP_PP:
        failed.append(f"G2 worst category F1 drop {worst_cat_drop:.2f}pp > {GATE_PER_CATEGORY_F1_DROP_PP}pp")
    if mem_red < GATE_MEMORY_REDUCTION_PCT:
        failed.append(f"G3 memory reduction {mem_red:.1f}% < {GATE_MEMORY_REDUCTION_PCT}%")
    if latency_ratio > GATE_LATENCY_RATIO_MAX:
        failed.append(f"G4 latency ratio {latency_ratio:.2f}x > {GATE_LATENCY_RATIO_MAX}x")
    return GateVerdict(quant.variant, title, not failed, overall_drop, worst_cat_drop, mem_red, latency_ratio, tuple(failed))


def _fmt(result: BenchResult | None, attr: str, unit: str = "", decimals: int = 2) -> str:
    if result is None:
        return "(missing)"
    value = float(getattr(result, attr))
    return f"{value:.{decimals}f} {unit}".strip()


def _print_metric_table(results: dict[str, BenchResult]) -> None:
    fp32 = results.get("fp32")
    int8 = results.get("int8")
    int4 = results.get("int4fp16")
    print(f"  {'metric':22s} {'FP32':>14s} {'INT8':>14s} {'INT4+FP16':>14s}")
    print("-" * 72)
    print(f"  {'overall precision':22s} {_fmt(fp32, 'precision'):>14s} {_fmt(int8, 'precision'):>14s} {_fmt(int4, 'precision'):>14s}")
    print(f"  {'overall recall':22s} {_fmt(fp32, 'recall'):>14s} {_fmt(int8, 'recall'):>14s} {_fmt(int4, 'recall'):>14s}")
    print(f"  {'overall F1':22s} {_fmt(fp32, 'f1'):>14s} {_fmt(int8, 'f1'):>14s} {_fmt(int4, 'f1'):>14s}")
    print(f"  {'worst category F1':22s} {(_worst_category_f1(fp32) if fp32 else 0.0):>14.2f} {(_worst_category_f1(int8) if int8 else 0.0):>14.2f} {(_worst_category_f1(int4) if int4 else 0.0):>14.2f}")
    print(f"  {'peak memory':22s} {_fmt(fp32, 'peak_memory_mb', 'MB', 1):>14s} {_fmt(int8, 'peak_memory_mb', 'MB', 1):>14s} {_fmt(int4, 'peak_memory_mb', 'MB', 1):>14s}")
    print(f"  {'model size on disk':22s} {_fmt(fp32, 'model_size_mb', 'MB', 1):>14s} {_fmt(int8, 'model_size_mb', 'MB', 1):>14s} {_fmt(int4, 'model_size_mb', 'MB', 1):>14s}")
    print(f"  {'avg latency':22s} {_fmt(fp32, 'avg_latency_ms', 'ms', 1):>14s} {_fmt(int8, 'avg_latency_ms', 'ms', 1):>14s} {_fmt(int4, 'avg_latency_ms', 'ms', 1):>14s}")


def _print_per_category(results: dict[str, BenchResult]) -> None:
    print()
    print("Per-category F1:")
    print(f"  {'category':22s} {'FP32':>14s} {'INT8':>14s} {'INT4+FP16':>14s}")
    print("-" * 72)
    for cat in sorted(OPF_CATEGORIES):
        values = []
        for key in ("fp32", "int8", "int4fp16"):
            result = results.get(key)
            values.append("(missing)" if result is None else f"{result.per_cat_f1.get(cat, 0.0):.2f}")
        print(f"  {cat:22s} {values[0]:>14s} {values[1]:>14s} {values[2]:>14s}")


def _print_gate_verdicts(verdicts: list[GateVerdict], results: dict[str, BenchResult]) -> None:
    if not verdicts:
        print()
        print("Gate verdict: skipped (FP32 baseline unavailable; absolute F1 only).")
        return
    print()
    print("Gate verdicts vs FP32:")
    for verdict in verdicts:
        status = "PASS" if verdict.passed else "FAIL"
        print(
            f"  {verdict.title:10s} {status:4s} | "
            f"F1 drop={verdict.overall_drop_pp:.2f}pp, "
            f"worst-cat drop={verdict.worst_category_drop_pp:.2f}pp, "
            f"memory reduction={verdict.memory_reduction_pct:.1f}%, "
            f"latency={verdict.latency_ratio:.2f}x"
        )
        for failure in verdict.failed:
            print(f"    - {failure}")

    passing = [v for v in verdicts if v.passed]
    if not passing:
        print("  FINAL RECOMMENDATION: B (FP32 ONNX only) — quantized variants failed gates")
        return
    if len(passing) == 1:
        print(f"  FINAL RECOMMENDATION: Candidate C-{passing[0].title} (only passing quantized variant)")
        return

    def _tie_break(v: GateVerdict) -> tuple[float, float]:
        result = results[v.key]
        return (result.model_size_mb, result.avg_latency_ms)

    best = min(passing, key=_tie_break)
    print(f"  FINAL RECOMMENDATION: Candidate C-{best.title} (both pass; smaller/faster tiebreaker)")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=10, help="latency runs per case (higher = lower noise)")
    args = parser.parse_args()

    skip_fp32 = os.environ.get("OPF_ONNX_SKIP_FP32") == "1"
    desired = ["int8", "int4fp16"] if skip_fp32 else ["fp32", "int8", "int4fp16"]
    if not skip_fp32 and not VARIANTS["fp32"].directory.exists():
        log.error("FP32 model missing: %s", VARIANTS["fp32"].directory)
        log.error("run: python scripts/poc-opf-onnx.py")
        log.error("or set OPF_ONNX_SKIP_FP32=1 to benchmark quantized variants only")
        return 2

    corpus = _load_corpus()
    results: dict[str, BenchResult] = {}
    for key in desired:
        spec = VARIANTS[key]
        if not spec.directory.exists():
            log.warning("%s dir missing: %s — skipping", spec.title, spec.directory)
            continue
        results[key] = _benchmark(spec, corpus, args.runs)

    if not results:
        log.error("no ONNX variants available under %s", BACKEND / ".poc")
        return 2

    print()
    print("=" * 72)
    print(f"OPF ONNX PoC benchmark — corpus={CORPUS.name} runs={args.runs}")
    print("=" * 72)
    _print_metric_table(results)
    print("-" * 72)
    for key in ("fp32", "int8", "int4fp16"):
        result = results.get(key)
        if result is not None:
            print(f"  {VARIANTS[key].title:10s} TP={result.tp} FP={result.fp} FN={result.fn}")

    _print_per_category(results)

    verdicts: list[GateVerdict] = []
    fp32 = results.get("fp32")
    if fp32 is not None:
        for key in ("int8", "int4fp16"):
            quant = results.get(key)
            if quant is not None:
                verdicts.append(_compare_to_fp32(fp32, quant, VARIANTS[key].title))
    _print_gate_verdicts(verdicts, results)
    print()
    print("Record this output in scripts/POC-OPF-ONNX.md §Results before deciding.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
