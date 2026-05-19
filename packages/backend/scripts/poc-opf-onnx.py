# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnusedCallResult=false
"""v1.x OPF ONNX migration PoC downloader.

PoC ONLY — not production code.

This script intentionally bypasses ``transformers.AutoConfig`` and
``optimum.exporters.onnx``. The OPF repo declares the custom
``model_type=openai_privacy_filter``, which blocks exporter-based loading, but
OpenAI already publishes ONNX artifacts in the HuggingFace repo.

Usage:
    cd packages/backend
    python scripts/poc-opf-onnx.py
    $env:OPF_ONNX_SKIP_FP32 = "1"; python scripts/poc-opf-onnx.py

Outputs:
    .poc/opf-fp32/       model.onnx + model.onnx_data* + tokenizer/config files
    .poc/opf-int8/       model_quantized.onnx + model_quantized.onnx_data + common files
    .poc/opf-int4fp16/   model_q4f16.onnx + model_q4f16.onnx_data + common files

Exit codes:
    0 = all requested variants downloaded successfully
    1 = FP32 download failed
    2 = FP32 succeeded but at least one quantized variant failed
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
import time
from pathlib import Path
from typing import TypedDict

from huggingface_hub import hf_hub_download

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("poc-opf-onnx")

MODEL_REPO = os.environ.get("OPF_MODEL_ID", "openai/privacy-filter")
OUT_DIR = Path(__file__).resolve().parent.parent / ".poc"

class VariantDownloadSpec(TypedDict):
    label: str
    onnx_files: list[str]
    onnx_filename: str


VARIANTS: dict[str, VariantDownloadSpec] = {
    "opf-fp32": {
        "label": "FP32 baseline",
        "onnx_files": [
            "onnx/model.onnx",
            "onnx/model.onnx_data",
            "onnx/model.onnx_data_1",
            "onnx/model.onnx_data_2",
        ],
        "onnx_filename": "model.onnx",
    },
    "opf-int8": {
        "label": "INT8 quantized",
        "onnx_files": [
            "onnx/model_quantized.onnx",
            "onnx/model_quantized.onnx_data",
        ],
        "onnx_filename": "model_quantized.onnx",
    },
    "opf-int4fp16": {
        "label": "INT4+FP16 quantized",
        "onnx_files": [
            "onnx/model_q4f16.onnx",
            "onnx/model_q4f16.onnx_data",
        ],
        "onnx_filename": "model_q4f16.onnx",
    },
}

COMMON_FILES = [
    "tokenizer.json",
    "tokenizer_config.json",
    "config.json",
    "viterbi_calibration.json",
]


def _dir_size_mb(path: Path) -> float:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file()) / (1024 * 1024)


def _materialize_download(downloaded: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    shutil.move(str(downloaded), str(destination))


def download_variant(name: str, spec: VariantDownloadSpec, out_dir: Path) -> bool:
    label = spec["label"]
    onnx_files = spec["onnx_files"]
    t0 = time.perf_counter()
    log.info("stage %s: downloading %s from %s", name, label, MODEL_REPO)

    if out_dir.exists():
        shutil.rmtree(out_dir)
    staging = out_dir / ".hf-download"
    staging.mkdir(parents=True, exist_ok=True)

    try:
        for filename in [*onnx_files, *COMMON_FILES]:
            log.info("  download: %s", filename)
            downloaded = Path(
                hf_hub_download(
                    repo_id=MODEL_REPO,
                    filename=str(filename),
                    local_dir=str(staging),
                )
            )
            destination = out_dir / Path(str(filename)).name
            _materialize_download(downloaded, destination)
            log.info("  ready: %s", destination.name)
    except Exception as exc:
        log.exception("variant %s failed: %s", name, exc)
        return False
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    elapsed = time.perf_counter() - t0
    size_mb = _dir_size_mb(out_dir)
    log.info("variant %s ready: %s (%.1f MB, %.1fs)", name, out_dir, size_mb, elapsed)
    return True


def _print_summary(results: dict[str, bool]) -> None:
    print()
    print("=" * 72)
    print("PoC OPF ONNX direct-download summary")
    print("=" * 72)
    for name, ok in results.items():
        out_dir = OUT_DIR / name
        status = "OK" if ok else "FAILED"
        size = f"{_dir_size_mb(out_dir):.1f} MB" if out_dir.exists() else "n/a"
        model = VARIANTS[name]["onnx_filename"]
        print(f"  {name:14s} {status:7s} {size:>10s}  model={model}")
    print()
    if all(results.values()):
        print("Next: python scripts/poc-opf-benchmark.py")
    else:
        print("Fix failed downloads, then re-run this script before benchmarking.")


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    skip_fp32 = os.environ.get("OPF_ONNX_SKIP_FP32") == "1"
    targets = ["opf-int8", "opf-int4fp16"] if skip_fp32 else ["opf-fp32", "opf-int8", "opf-int4fp16"]
    if skip_fp32:
        log.warning("OPF_ONNX_SKIP_FP32=1: skipping 5.6 GB FP32 baseline download")

    results: dict[str, bool] = {}
    for name in targets:
        ok = download_variant(name, VARIANTS[name], OUT_DIR / name)
        results[name] = ok
        if name == "opf-fp32" and not ok:
            _print_summary(results)
            return 1

    _print_summary(results)
    quant_ok = results.get("opf-int8", False) and results.get("opf-int4fp16", False)
    return 0 if quant_ok and all(results.values()) else 2


if __name__ == "__main__":
    sys.exit(main())
