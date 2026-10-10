"""Export missing Korean NER ONNX weights before starting the native backend."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import tempfile


def prepare_korean_model() -> Path:
    configured = os.environ.get("KNER_ONNX_PATH")
    if configured:
        target = Path(configured)
        if not any((target / name).is_file() for name in ("model_quantized.onnx", "model.onnx")):
            raise FileNotFoundError(f"KNER_ONNX_PATH contains no ONNX model: {target}")
        return target

    model_id = os.environ.get("KNER_MODEL_ID") or "soddokayo/koelectra-base-klue-ner"
    revision = os.environ.get("KNER_MODEL_REVISION") or None
    identity = hashlib.sha256(f"{model_id}\0{revision or ''}".encode()).hexdigest()[:16]
    target = Path(__file__).resolve().parents[1] / ".cache" / "kner-onnx" / identity
    if (target / "model_quantized.onnx").is_file() and (target / "config.json").is_file() and (target / "tokenizer.json").is_file():
        return target

    from optimum.onnxruntime import ORTModelForTokenClassification
    from transformers import AutoTokenizer
    from onnxruntime.quantization import QuantType, quantize_dynamic

    print(f"Exporting Korean NER to ONNX: {model_id} (first setup only)", flush=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Export into a temporary directory so failed exports are never reused.
    with tempfile.TemporaryDirectory(dir=target.parent) as temporary:
        work = Path(temporary)
        model = ORTModelForTokenClassification.from_pretrained(model_id, revision=revision, export=True)
        model.save_pretrained(work)
        tokenizer = AutoTokenizer.from_pretrained(model_id, revision=revision)
        tokenizer.save_pretrained(work)
        quantize_dynamic(
            str(work / "model.onnx"), str(work / "model_quantized.onnx"),
            weight_type=QuantType.QUInt8, per_channel=True,
        )
        target.mkdir(parents=True, exist_ok=True)
        for source in work.iterdir():
            if source.is_file() and source.name != "model.onnx":
                shutil.copy2(source, target / source.name)
    return target


if __name__ == "__main__":
    import sys
    # The script lives in scripts/, but server imports are rooted at backend/.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    model_path = prepare_korean_model()
    os.environ["KNER_ONNX_PATH"] = str(model_path)
    # Check both actual inference sessions, rather than relying on /health.
    from server.opf_runner import OpfRunner
    from server.korean_ner_runner import KoreanNerRunner
    opf = OpfRunner()
    opf.load()
    kner = KoreanNerRunner()
    kner.load()
    print("OPF and Korean NER model loading verified.", flush=True)
    # A small handoff file avoids parsing model/exporter output for the path.
    Path(sys.argv[1]).write_text(str(model_path), encoding="utf-8")
