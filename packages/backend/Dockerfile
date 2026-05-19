# syntax=docker/dockerfile:1.8
# pii-remover OPF backend — CPU image with pre-baked model weights.
# Three stages:
#   1a. opf-weights — download OpenAI-published OPF INT8 ONNX artifacts.
#   1b. kner-export — export Korean NER to INT8 ONNX.
#   2.  runtime     — slim image, copies OPF/KLUE ONNX models + server
#                    code, installs the trimmed runtime deps + tesseract OCR.
#
# See ADR-0008 for the self-built rationale; ADR-0009 for the tesseract
# install (Phase 6 image redaction).
#
# BuildKit cache mounts (--mount=type=cache) keep pip downloads and the
# HuggingFace model cache off the final image while letting subsequent
# builds reuse them — much more effective than the previous host-level
# actions/cache, which mounted /tmp/hf-cache on the runner but never
# inside the container.

ARG PYTHON_VERSION=3.11
ARG OPF_MODEL_ID=openai/privacy-filter
ARG KNER_MODEL_ID=soddokayo/koelectra-base-klue-ner

# ---------------------------------------------------------------------------
# Stage 1a — OPF weights pre-builder
# ---------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS opf-weights

ARG OPF_MODEL_ID
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/root/.cache/huggingface \
    TRANSFORMERS_NO_ADVISORY_WARNINGS=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY scripts/requirements-opf-builder.txt .
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    pip install --upgrade pip \
    && pip install -r requirements-opf-builder.txt

RUN --mount=type=cache,target=/root/.cache/huggingface,sharing=locked \
    OPF_MODEL_ID="${OPF_MODEL_ID}" python - <<'PY'
from huggingface_hub import hf_hub_download
import os
import shutil

target = "/models/opf-int8"
os.makedirs(target, exist_ok=True)
files = [
    "onnx/model_quantized.onnx",
    "onnx/model_quantized.onnx_data",
    "tokenizer.json",
    "tokenizer_config.json",
    "config.json",
    "viterbi_calibration.json",
]
for filename in files:
    source = hf_hub_download(repo_id=os.environ["OPF_MODEL_ID"], filename=filename)
    shutil.copyfile(source, os.path.join(target, os.path.basename(filename)))
PY

# ---------------------------------------------------------------------------
# Stage 1b — Korean NER ONNX exporter
# ---------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS kner-export

ARG KNER_MODEL_ID
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/root/.cache/huggingface \
    TRANSFORMERS_NO_ADVISORY_WARNINGS=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY scripts/requirements-kner-builder.txt .
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    pip install --upgrade pip \
    && pip install --extra-index-url https://download.pytorch.org/whl/cpu \
        -r requirements-kner-builder.txt

# Pre-bake Korean NER as INT8 ONNX (Phase 7 PoC verdict C — see
# scripts/POC-INT8.md): on the 13-case PoC corpus the INT8 export was 75%
# smaller on disk (109 MB vs 430 MB), 2x faster on CPU, 37% lower process
# RSS, and accuracy went UP (PS F1 0.818 vs 0.750). Builder discards
# the FP32 staging dir; runtime only carries /models/klue-ner-int8.
RUN --mount=type=cache,target=/root/.cache/huggingface,sharing=locked \
    --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    python -c "\
from optimum.onnxruntime import ORTModelForTokenClassification, ORTQuantizer; \
from optimum.onnxruntime.configuration import AutoQuantizationConfig; \
from transformers import AutoTokenizer; \
import shutil, os; \
mid = '${KNER_MODEL_ID}'; \
tok = AutoTokenizer.from_pretrained(mid); \
m = ORTModelForTokenClassification.from_pretrained(mid, export=True); \
m.save_pretrained('/models/klue-ner-fp32'); \
tok.save_pretrained('/models/klue-ner-fp32'); \
q = ORTQuantizer.from_pretrained('/models/klue-ner-fp32'); \
q.quantize(save_dir='/models/klue-ner-int8', \
           quantization_config=AutoQuantizationConfig.avx512_vnni(is_static=False, per_channel=True)); \
[shutil.copy('/models/klue-ner-fp32/' + f, '/models/klue-ner-int8/' + f) \
 for f in ('tokenizer.json','tokenizer_config.json','special_tokens_map.json','vocab.txt') \
 if os.path.exists('/models/klue-ner-fp32/' + f)]" \
    && rm -rf /models/klue-ner-fp32

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS runtime

ARG OPF_MODEL_ID
ARG KNER_MODEL_ID
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/home/app/.cache/huggingface \
    OPF_DEVICE=cpu \
    OPF_HOST=0.0.0.0 \
    OPF_PORT=8000 \
    OPF_MODEL_ID=${OPF_MODEL_ID} \
    OPF_ONNX_PATH=/models/opf-int8 \
    OPF_VARIANT=int8 \
    KNER_MODEL_ID=${KNER_MODEL_ID} \
    KNER_ONNX_PATH=/models/klue-ner-int8

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl \
        tesseract-ocr tesseract-ocr-eng tesseract-ocr-kor \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system app \
    && useradd --system --gid app --home /home/app --create-home app

WORKDIR /app

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    pip install --upgrade pip \
    && pip install -r requirements.txt

COPY --from=opf-weights --chown=app:app /models/opf-int8 /models/opf-int8

# Pre-baked Korean NER INT8 ONNX (Phase 7 PoC verdict C). The image-time
# resolution by KoreanNerRunner finds this dir via KNER_ONNX_PATH env var
# (set above) and uses it as the default model — bypasses the PyTorch
# fallback path entirely in production.
COPY --from=kner-export --chown=app:app /models/klue-ner-int8 /models/klue-ner-int8

COPY --chown=app:app server/ ./server/
COPY --chown=app:app pyproject.toml ./pyproject.toml

USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -fs http://localhost:8000/health || exit 1

CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
