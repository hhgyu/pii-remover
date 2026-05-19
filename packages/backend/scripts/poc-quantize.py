"""Phase 7 INT8 quantization PoC (ADR-0007 v2 follow-up).

PoC ONLY — not production code. Lives under ``scripts/`` so it's clearly
not in the deployable image. Run by the developer; record the outcome in
POC-INT8.md; then either:

  - PoC PASS  -> integrate INT8 model into ``server.korean_ner_runner`` (option C)
  - PoC FAIL  -> integrate FP32 ONNX model into ``server.korean_ner_runner`` (option B)

Usage:
    cd packages/backend
    python -m venv .poc-venv
    . .poc-venv/Scripts/Activate.ps1   # PowerShell
    pip install -r scripts/requirements-poc.txt
    python scripts/poc-quantize.py

Outputs:
    .poc/klue-fp32/    FP32 ONNX model + tokenizer (option B baseline)
    .poc/klue-int8/    INT8 dynamic-quantized model (option C attempt)
    .poc/quantize.log  Stage timings + first-pass diagnostics

Quantization choice: dynamic INT8 (no calibration data needed). Static
quantization with a Korean calibration set is a v1.x improvement; for
PoC we test the cheapest path first. If dynamic INT8 fails the gate,
the verdict is "B" — static INT8 is its own follow-up PoC.
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
import time
from pathlib import Path

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
)
log = logging.getLogger("poc-quantize")

MODEL_ID = os.environ.get("KNER_MODEL_ID", "soddokayo/koelectra-base-klue-ner")
OUT_DIR = Path(__file__).resolve().parent.parent / ".poc"
FP32_DIR = OUT_DIR / "klue-fp32"
INT8_DIR = OUT_DIR / "klue-int8"


def _stage_export_fp32() -> bool:
    log.info("stage 1/2: export FP32 ONNX from %s", MODEL_ID)
    t0 = time.perf_counter()
    try:
        from optimum.onnxruntime import ORTModelForTokenClassification
        from transformers import AutoTokenizer
    except ImportError as exc:
        log.error("optimum/transformers not installed: %s", exc)
        log.error("run: pip install -r scripts/requirements-poc.txt")
        return False

    if FP32_DIR.exists():
        shutil.rmtree(FP32_DIR)
    FP32_DIR.mkdir(parents=True, exist_ok=True)

    try:
        model = ORTModelForTokenClassification.from_pretrained(
            MODEL_ID, export=True
        )
        tok = AutoTokenizer.from_pretrained(MODEL_ID)
    except Exception as exc:
        log.exception("FP32 export failed (option B not viable either)")
        log.error("verdict: PoC blocked — model cannot be exported to ONNX: %s", exc)
        return False

    model.save_pretrained(str(FP32_DIR))
    tok.save_pretrained(str(FP32_DIR))
    elapsed = time.perf_counter() - t0
    size_mb = _dir_size_mb(FP32_DIR)
    log.info("FP32 ONNX exported: %s (%.1f MB) in %.1fs", FP32_DIR, size_mb, elapsed)
    return True


def _stage_quantize_int8() -> bool:
    log.info("stage 2/2: quantize FP32 -> INT8 (dynamic)")
    t0 = time.perf_counter()
    try:
        from optimum.onnxruntime import ORTQuantizer
        from optimum.onnxruntime.configuration import AutoQuantizationConfig
    except ImportError as exc:
        log.error("optimum.onnxruntime missing quantization helpers: %s", exc)
        return False

    if INT8_DIR.exists():
        shutil.rmtree(INT8_DIR)
    INT8_DIR.mkdir(parents=True, exist_ok=True)

    try:
        quantizer = ORTQuantizer.from_pretrained(str(FP32_DIR))
        # Dynamic quantization: no calibration data. AVX512 VNNI + per-channel
        # is the strongest dynamic preset; falls back gracefully on older CPUs.
        qconfig = AutoQuantizationConfig.avx512_vnni(
            is_static=False, per_channel=True
        )
        quantizer.quantize(save_dir=str(INT8_DIR), quantization_config=qconfig)
    except Exception as exc:
        log.exception("INT8 quantization failed — verdict: B (FP32 only)")
        log.error("reason: %s", exc)
        return False

    # Copy tokenizer alongside the int8 model so the runner can load both
    # from one directory.
    for fname in ("tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt"):
        src = FP32_DIR / fname
        if src.exists():
            shutil.copy(src, INT8_DIR / fname)

    elapsed = time.perf_counter() - t0
    size_mb = _dir_size_mb(INT8_DIR)
    log.info("INT8 quantized: %s (%.1f MB) in %.1fs", INT8_DIR, size_mb, elapsed)
    return True


def _dir_size_mb(path: Path) -> float:
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            total += p.stat().st_size
    return total / (1024 * 1024)


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if not _stage_export_fp32():
        return 1
    int8_ok = _stage_quantize_int8()

    fp32_mb = _dir_size_mb(FP32_DIR)
    int8_mb = _dir_size_mb(INT8_DIR) if int8_ok else 0.0
    print()
    print("=" * 60)
    print("PoC quantize summary")
    print("=" * 60)
    print(f"  FP32  : {FP32_DIR} ({fp32_mb:.1f} MB)")
    if int8_ok:
        ratio = (1.0 - int8_mb / fp32_mb) * 100 if fp32_mb > 0 else 0
        print(f"  INT8  : {INT8_DIR} ({int8_mb:.1f} MB, {ratio:.1f}% smaller)")
        print()
        print("Next: python scripts/poc-benchmark.py")
        return 0
    else:
        print("  INT8  : FAILED (see log above)")
        print()
        print("Verdict (preliminary): B (FP32 ONNX only).")
        print("Run scripts/poc-benchmark.py with --skip-int8 to record FP32 baseline.")
        return 2


if __name__ == "__main__":
    sys.exit(main())
