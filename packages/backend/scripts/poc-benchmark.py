"""Phase 7 INT8 PoC: precision/recall + memory + latency benchmark.

Compares FP32 baseline vs INT8 attempt against the Korean name corpus
fixture (packages/core/tests/fixtures/korean-name-corpus.json). Produces
a verdict against four gates from POC-INT8.md:

    G1 overall F1 drop      <= 2.0 pp
    G2 PS-only F1 drop      <= 3.0 pp
    G3 memory reduction     >= 50%
    G4 inference speed      >= same as FP32

Usage:
    python scripts/poc-benchmark.py
    python scripts/poc-benchmark.py --skip-int8       # FP32-only (option B baseline)
    python scripts/poc-benchmark.py --runs 100        # higher-confidence latency
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

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
)
log = logging.getLogger("poc-benchmark")

ROOT = Path(__file__).resolve().parent.parent.parent.parent
BACKEND = ROOT / "packages" / "backend"
CORPUS = ROOT / "packages" / "core" / "tests" / "fixtures" / "korean-name-corpus.json"
FP32_DIR = BACKEND / ".poc" / "klue-fp32"
INT8_DIR = BACKEND / ".poc" / "klue-int8"


# Gate thresholds — keep in sync with POC-INT8.md §"PoC pass criteria".
GATE_OVERALL_F1_DROP_PP = 2.0
GATE_PS_F1_DROP_PP = 3.0
GATE_MEMORY_REDUCTION_PCT = 50.0
GATE_LATENCY_RATIO_MAX = 1.05  # INT8 may not be more than 5% slower than FP32


@dataclass
class BenchResult:
    variant: str
    tp: int
    fp: int
    fn: int
    precision: float
    recall: float
    f1: float
    ps_tp: int
    ps_fp: int
    ps_fn: int
    ps_precision: float
    ps_recall: float
    ps_f1: float
    avg_latency_ms: float
    peak_memory_mb: float
    model_size_mb: float


def _load_corpus() -> dict[str, Any]:
    if not CORPUS.exists():
        log.error("corpus not found: %s", CORPUS)
        sys.exit(2)
    return json.loads(CORPUS.read_text(encoding="utf-8"))


def _dir_size_mb(p: Path) -> float:
    if not p.exists():
        return 0.0
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) / (1024 * 1024)


def _peak_memory_mb() -> float:
    try:
        import psutil

        return psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)
    except ImportError:
        return 0.0


def _normalise_tag(raw: str) -> str:
    value = raw.strip()
    for prefix in ("B-", "I-", "O-", "E-", "S-", "U-"):
        if value.startswith(prefix):
            value = value[len(prefix):]
            break
    return value.upper()


def _run_inference(pipeline: Any, text: str) -> list[dict[str, Any]]:
    if not text:
        return []
    raw = pipeline(text)
    out: list[dict[str, Any]] = []
    for entity in raw:
        tag = _normalise_tag(
            str(entity.get("entity_group") or entity.get("entity") or "")
        )
        if tag != "PS":
            continue
        try:
            start = int(entity["start"])
            end = int(entity["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if end <= start:
            continue
        out.append(
            {
                "start": start,
                "end": end,
                "text": text[start:end],
                "score": float(entity.get("score", 0.0)),
            }
        )
    return out


def _build_pipeline(model_dir: Path) -> Any:
    from optimum.onnxruntime import ORTModelForTokenClassification
    from transformers import AutoTokenizer, pipeline

    tok = AutoTokenizer.from_pretrained(str(model_dir))
    model = ORTModelForTokenClassification.from_pretrained(str(model_dir))
    return pipeline(
        task="token-classification",
        model=model,
        tokenizer=tok,
        aggregation_strategy="simple",
    )


def _benchmark(variant: str, model_dir: Path, corpus: dict[str, Any], runs: int) -> BenchResult:
    log.info("loading variant=%s from %s", variant, model_dir)
    gc.collect()
    pipeline = _build_pipeline(model_dir)

    # Warm-up to exclude one-time JIT / cache costs from the latency mean.
    pipeline("워밍업 텍스트 입니다")

    tp = fp = fn = 0
    ps_tp = ps_fp = ps_fn = 0
    latencies: list[float] = []
    peak = 0.0

    def _evaluate_case(text: str, expected: list[dict[str, Any]]) -> None:
        nonlocal tp, fp, fn, ps_tp, ps_fp, ps_fn, peak
        for _ in range(runs):
            t0 = time.perf_counter()
            preds = _run_inference(pipeline, text)
            latencies.append((time.perf_counter() - t0) * 1000.0)
            peak = max(peak, _peak_memory_mb())

        # Score only one set per case (last one) — runs are for latency only.
        matched = set()
        for exp in expected:
            hit = next(
                (p for p in preds if p["start"] == exp["start"] and p["end"] == exp["end"]),
                None,
            )
            if hit:
                tp += 1
                ps_tp += 1
                matched.add((exp["start"], exp["end"]))
            else:
                fn += 1
                ps_fn += 1
        for p in preds:
            if (p["start"], p["end"]) not in matched:
                fp += 1
                ps_fp += 1

    for case in corpus.get("true_positives", []):
        _evaluate_case(case["text"], case["expected_persons"])
    for case in corpus.get("edge_cases", []):
        _evaluate_case(case["text"], case["expected_persons"])
    for case in corpus.get("true_negatives", []):
        _evaluate_case(case["text"], [])

    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    f1 = 2 * precision * recall / max(1e-9, precision + recall)
    ps_precision = ps_tp / max(1, ps_tp + ps_fp)
    ps_recall = ps_tp / max(1, ps_tp + ps_fn)
    ps_f1 = 2 * ps_precision * ps_recall / max(1e-9, ps_precision + ps_recall)
    avg_latency = sum(latencies) / max(1, len(latencies))
    return BenchResult(
        variant=variant,
        tp=tp,
        fp=fp,
        fn=fn,
        precision=precision,
        recall=recall,
        f1=f1,
        ps_tp=ps_tp,
        ps_fp=ps_fp,
        ps_fn=ps_fn,
        ps_precision=ps_precision,
        ps_recall=ps_recall,
        ps_f1=ps_f1,
        avg_latency_ms=avg_latency,
        peak_memory_mb=peak,
        model_size_mb=_dir_size_mb(model_dir),
    )


def _print_row(label: str, fp32: float, int8: float | None, unit: str = "") -> None:
    if int8 is None:
        print(f"  {label:30s} {fp32:>10.3f}{unit:<5s} {'(skipped)':>15s}")
    else:
        delta = int8 - fp32
        print(
            f"  {label:30s} {fp32:>10.3f}{unit:<5s} {int8:>10.3f}{unit:<5s} Δ={delta:+.3f}"
        )


def _verdict(fp32: BenchResult, int8: BenchResult | None) -> str:
    if int8 is None:
        return "B (INT8 not produced — see poc-quantize.py log)"

    overall_drop = (fp32.f1 - int8.f1) * 100.0
    ps_drop = (fp32.ps_f1 - int8.ps_f1) * 100.0
    mem_red = (1.0 - int8.peak_memory_mb / max(1.0, fp32.peak_memory_mb)) * 100.0
    latency_ratio = int8.avg_latency_ms / max(0.001, fp32.avg_latency_ms)

    failed: list[str] = []
    if overall_drop > GATE_OVERALL_F1_DROP_PP:
        failed.append(
            f"G1 overall F1 drop {overall_drop:.2f}pp > {GATE_OVERALL_F1_DROP_PP}pp"
        )
    if ps_drop > GATE_PS_F1_DROP_PP:
        failed.append(
            f"G2 PS F1 drop {ps_drop:.2f}pp > {GATE_PS_F1_DROP_PP}pp"
        )
    if mem_red < GATE_MEMORY_REDUCTION_PCT:
        failed.append(
            f"G3 memory reduction {mem_red:.1f}% < {GATE_MEMORY_REDUCTION_PCT}%"
        )
    if latency_ratio > GATE_LATENCY_RATIO_MAX:
        failed.append(
            f"G4 latency ratio {latency_ratio:.2f}x > {GATE_LATENCY_RATIO_MAX}x"
        )

    if not failed:
        return "C (INT8 — all 4 gates passed)"
    return f"B (INT8 fails: {'; '.join(failed)})"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--skip-int8", action="store_true", help="benchmark FP32 only"
    )
    parser.add_argument(
        "--runs",
        type=int,
        default=10,
        help="latency runs per case (higher = lower noise)",
    )
    args = parser.parse_args()

    if not FP32_DIR.exists():
        log.error("FP32 model missing: %s", FP32_DIR)
        log.error("run: python scripts/poc-quantize.py")
        return 2

    corpus = _load_corpus()
    fp32 = _benchmark("fp32", FP32_DIR, corpus, args.runs)

    int8: BenchResult | None = None
    if not args.skip_int8 and INT8_DIR.exists():
        int8 = _benchmark("int8", INT8_DIR, corpus, args.runs)
    elif not args.skip_int8:
        log.warning("INT8 dir missing: %s — skipping (verdict will lean B)", INT8_DIR)

    print()
    print("=" * 70)
    print(f"PoC benchmark — corpus={CORPUS.name} runs={args.runs}")
    print("=" * 70)
    header_int8 = "INT8" if int8 else "(none)"
    print(f"  {'metric':30s} {'FP32':>15s} {header_int8:>15s}")
    print("-" * 70)
    _print_row("overall precision", fp32.precision, int8.precision if int8 else None)
    _print_row("overall recall", fp32.recall, int8.recall if int8 else None)
    _print_row("overall F1", fp32.f1, int8.f1 if int8 else None)
    _print_row("PS precision", fp32.ps_precision, int8.ps_precision if int8 else None)
    _print_row("PS recall", fp32.ps_recall, int8.ps_recall if int8 else None)
    _print_row("PS F1", fp32.ps_f1, int8.ps_f1 if int8 else None)
    _print_row("avg latency", fp32.avg_latency_ms, int8.avg_latency_ms if int8 else None, "ms")
    _print_row("peak memory", fp32.peak_memory_mb, int8.peak_memory_mb if int8 else None, "MB")
    _print_row("model size on disk", fp32.model_size_mb, int8.model_size_mb if int8 else None, "MB")
    print("-" * 70)
    print(f"  TP={fp32.tp} FP={fp32.fp} FN={fp32.fn}", end="")
    if int8:
        print(f"   |  TP={int8.tp} FP={int8.fp} FN={int8.fn}")
    else:
        print()

    print()
    verdict = _verdict(fp32, int8)
    print(f"  VERDICT: {verdict}")
    print()
    print("Record this output in scripts/POC-INT8.md §Results before deciding.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
