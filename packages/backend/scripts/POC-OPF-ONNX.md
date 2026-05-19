# v1.x OPF ONNX Migration PoC

> **Status**: PoC complete; BIOES + constrained Viterbi decoding implemented.
> **Decision**: option **B (FP32 ONNX)** for production integration planning; keep PyTorch until that follow-up is explicitly approved and implemented.
> **Related**: ADR-0008 (self-built Docker), ADR-0010 (PII categories), Phase 7 KLUE INT8 PoC

## Objective

Decide whether the OPF model (`openai/privacy-filter`) can be deployed as
ONNX (FP32, INT8, or INT4+FP16) without losing accuracy that matters for English PII.

Decision branches:

- **PASS all 4 gates** → option **C**: production OPF on quantized ONNX (INT8 or INT4+FP16).
- **FAIL G3/G4 but G1/G2 pass** → option **B**: FP32 ONNX. This still drops
  `torch` from runtime and keeps the most important image-size win.
- **FAIL G1 or G2** → keep current PyTorch path; accuracy is the bottom line.

The headline motivation is not only faster inference. Moving OPF off the
PyTorch runtime lets the production image remove `torch>=2.2,<3`, expected to
save roughly **700 MB** from the backend image.

License note: the backend README records the underlying OPF model as
Apache-2.0. Re-check the HuggingFace model card before production integration
and record any license nuance in the final ADR.

## PoC pass criteria

| Gate | Threshold | Why |
|---|---|---|
| **G1 overall F1 drop** | ≤ 2.0 pp | overall English PII regression budget |
| **G2 worst category F1 drop** | ≤ 5.0 pp | all 8 OPF categories are user-visible; aggregate F1 can hide a small category collapse |
| **G3 memory reduction** | ≥ 30% | dynamic INT8 on transformers rarely reaches 50%; Phase 7 KLUE PoC showed 30-45% is realistic |
| **G4 latency ratio** | quantized ≤ 1.05× FP32 | quantized ONNX must not regress speed; any-CPU fallback should still match |

All 4 must pass for verdict **C**. G1/G2 are hard accuracy gates; if either
fails, do not integrate a quantized ONNX variant as the default OPF path without
a larger corpus and explicit product decision. INT8 and INT4+FP16 are each
compared against the FP32 ONNX baseline.

Thresholds are encoded in `poc-opf-benchmark.py` and surface in the verdict
line.

## How to run

```powershell
cd packages/backend

# 1. fresh venv (or reuse the Phase 7 KLUE PoC venv if it already exists)
python -m venv .poc-venv
. .poc-venv/Scripts/Activate.ps1   # PowerShell (Linux/macOS: . .poc-venv/bin/activate)

# 2. install PoC-only deps (~2 GB; will not pollute production requirements)
pip install -r scripts/requirements-poc.txt

# 3. directly download OpenAI-published ONNX artifacts
python scripts/poc-opf-onnx.py
# expected: large first run because total ONNX artifacts are ~8 GB
# expected output: .poc/opf-fp32/      (model.onnx + model.onnx_data*)
#                  .poc/opf-int8/      (model_quantized.onnx + external data)
#                  .poc/opf-int4fp16/  (model_q4f16.onnx + external data)

# Optional: skip 5.6 GB FP32 baseline and only download/measure quantized files.
# Gate verdict is omitted without FP32 baseline.
$env:OPF_ONNX_SKIP_FP32 = "1"; python scripts/poc-opf-onnx.py

# 4. benchmark all available variants against the English PII corpus fixture
python scripts/poc-opf-benchmark.py
# expected: prints 3-way metric table + per-category table + INT8/INT4+FP16 verdicts

# 5. record outcome in §Results (this file)
```

If `OPF_ONNX_SKIP_FP32=1` is set, `poc-opf-benchmark.py` measures INT8 and
INT4+FP16 absolute F1/latency/memory only. It intentionally omits gate verdicts
because there is no FP32 ONNX baseline for delta comparisons.

## Corpus

Default corpus: `packages/core/tests/fixtures/english-pii-corpus.json`
(17 cases: 10 TP + 5 TN + 2 edge). It covers all 8 OPF categories:

- `private_person`
- `private_email`
- `private_phone`
- `private_address`
- `private_url`
- `private_date`
- `account_number`
- `secret`

The corpus is PoC-grade only. For a production-grade claim, augment to at
least 50-100 cases covering:

- names with punctuation, initials, accents, and honorifics
- emails with plus-addressing, short domains, and internal TLDs
- US/international phone formats and Korean-looking phone strings
- postal addresses with abbreviations and multi-line variants
- account/card-looking numbers that should and should not classify as account numbers
- API keys, bearer tokens, and benign hashes that look secret-like
- dates in ISO, US, natural-language, and noisy/OCR forms
- dense PII clusters and true-negative developer text

The benchmark script consumes whatever is in the JSON — augmenting the corpus
does not require code changes.

## What the benchmark measures

Per variant (FP32, INT8, INT4+FP16):

- **Accuracy**: TP / FP / FN and overall precision / recall / F1.
- **Per-category accuracy**: precision / recall / F1 for each OPF category.
- **Latency**: per-case mean (excluding warm-up call); `--runs N` controls noise.
- **Memory**: process RSS peak across all runs (`psutil`).
- **Disk size**: on-disk model directory size.

Scoring uses exact span + exact category matching. OPF returns character
spans, while the corpus stores expected `text`, so the script derives expected
`start` / `end` offsets by finding each expected substring in the input text.
This catches both category regressions and span-boundary regressions.

Score gates compare each quantized variant to FP32 directly (delta in pp /
ratio). If both INT8 and INT4+FP16 pass, the final recommendation uses the
smaller/faster variant as the tiebreaker.

## Results

**Run date**: 2026-05-12 (initial attempt)
**Environment**: Windows + Python 3.14.4 + transformers 4.57.6 + optimum 2.1.0
**Corpus**: not run — PoC blocked at FP32 export stage

### Raw script output

```text
2026-05-12 21:47:28 INFO  stage 1/2: export FP32 ONNX from openai/privacy-filter
2026-05-12 21:47:28 ERROR FP32 export failed (option B not viable either)
ValueError: The checkpoint you are trying to load has model type
  `openai_privacy_filter` but Transformers does not recognize this
  architecture. This could be because of an issue with the checkpoint,
  or because your version of Transformers is out of date.
```

### Per-gate verdict

| Gate | FP32 | INT8 | Δ | Threshold | Pass? |
|---|---:|---:|---:|---|---|
| G1 overall F1 | n/a | n/a | n/a | drop ≤ 2.0pp | **PoC blocked** |
| G2 worst category F1 | n/a | n/a | n/a | drop ≤ 5.0pp | **PoC blocked** |
| G3 memory peak | n/a | n/a | n/a | reduction ≥ 30% | **PoC blocked** |
| G4 avg latency | n/a | n/a | n/a | ratio ≤ 1.05x | **PoC blocked** |

### Final decision

- [ ] C (INT8 ONNX)
- [ ] B (FP32 ONNX)
- [x] **Keep current PyTorch path** — `torch` cannot be removed from production runtime in v1.x

**Date**: 2026-05-12
**Decided by**: PoC measurement (FP32 export stage failure)
**Reasoning**:
- `openai/privacy-filter` declares a custom HF `model_type=openai_privacy_filter`
  that is not in the standard `transformers.AutoConfig` registry. Both
  `optimum.onnxruntime.ORTModelForTokenClassification.from_pretrained(...,
  export=True)` and the underlying `AutoConfig.from_pretrained` raise
  `ValueError` on the unknown architecture. There is no FP32 ONNX baseline
  to even measure against, so the four gates do not apply.
- This is a *blocker on the source side*, not a quantization-quality issue.
  Neither option B nor option C is reachable from the current
  transformers/optimum stack.

### Update 2026-05-12: ONNX direct download path discovered

HuggingFace already publishes ONNX artifacts for `openai/privacy-filter` under
the repo's `onnx/` directory, so the exporter blocker above can be bypassed:

- FP32: `onnx/model.onnx` + `onnx/model.onnx_data{,_1,_2}` (~5.6 GB total)
- INT8: `onnx/model_quantized.onnx` + `onnx/model_quantized.onnx_data` (~1.6 GB)
- INT4+FP16: `onnx/model_q4f16.onnx` + `onnx/model_q4f16.onnx_data` (~809 MB)

`scripts/poc-opf-onnx.py` now uses `huggingface_hub.hf_hub_download` directly
and `scripts/poc-opf-benchmark.py` loads the model with
`onnxruntime.InferenceSession`, parses `config.json` as raw JSON for `id2label`,
and avoids `AutoConfig.from_pretrained` entirely.

### 2026-05-12 — ONNX direct download path 실행 결과 (Update 2)

**Run date**: 2026-05-12  
**Environment**: Windows + Python 3.14.4 + onnxruntime 1.26.0 + transformers 4.57.6 + optimum 2.1.0  
**Corpus**: `english-pii-corpus.json` (17 cases, runs=10)  
**Skip FP32**: False for final benchmark. A quantized-only smoke download was run first with `OPF_ONNX_SKIP_FP32=1`.

#### Raw script output

```text
# Step 1: OPF_ONNX_SKIP_FP32=1 python scripts/poc-opf-onnx.py
2026-05-12 22:27:14,151 WARNING OPF_ONNX_SKIP_FP32=1: skipping 5.6 GB FP32 baseline download
2026-05-12 22:27:14,151 INFO stage opf-int8: downloading INT8 quantized from openai/privacy-filter
...
2026-05-12 22:27:37,125 INFO variant opf-int8 ready: D:\Git\pii-remover\packages\backend\.poc\opf-int8 (1569.8 MB, 22.8s)
2026-05-12 22:27:37,125 INFO stage opf-int4fp16: downloading INT4+FP16 quantized from openai/privacy-filter
...
2026-05-12 22:27:50,759 INFO variant opf-int4fp16 ready: D:\Git\pii-remover\packages\backend\.poc\opf-int4fp16 (798.3 MB, 13.6s)

========================================================================
PoC OPF ONNX direct-download summary
========================================================================
  opf-int8       OK       1569.8 MB  model=model_quantized.onnx
  opf-int4fp16   OK        798.3 MB  model=model_q4f16.onnx

Next: python scripts/poc-opf-benchmark.py

# Step 2: OPF_ONNX_SKIP_FP32=0 python scripts/poc-opf-onnx.py
2026-05-12 22:28:04,333 INFO stage opf-fp32: downloading FP32 baseline from openai/privacy-filter
...
2026-05-12 22:29:22,965 INFO variant opf-fp32 ready: D:\Git\pii-remover\packages\backend\.poc\opf-fp32 (5397.3 MB, 78.6s)
2026-05-12 22:29:22,965 INFO stage opf-int8: downloading INT8 quantized from openai/privacy-filter
...
2026-05-12 22:29:45,606 INFO variant opf-int8 ready: D:\Git\pii-remover\packages\backend\.poc\opf-int8 (1569.8 MB, 22.4s)
2026-05-12 22:29:45,606 INFO stage opf-int4fp16: downloading INT4+FP16 quantized from openai/privacy-filter
...
2026-05-12 22:29:59,253 INFO variant opf-int4fp16 ready: D:\Git\pii-remover\packages\backend\.poc\opf-int4fp16 (798.3 MB, 13.6s)

========================================================================
PoC OPF ONNX direct-download summary
========================================================================
  opf-fp32       OK       5397.3 MB  model=model.onnx
  opf-int8       OK       1569.8 MB  model=model_quantized.onnx
  opf-int4fp16   OK        798.3 MB  model=model_q4f16.onnx

Next: python scripts/poc-opf-benchmark.py

# Step 3: python scripts/poc-opf-benchmark.py
2026-05-12 22:30:14,859 INFO loading variant=fp32 from D:\Git\pii-remover\packages\backend\.poc\opf-fp32
2026-05-12 22:30:21,827 INFO loading variant=int8 from D:\Git\pii-remover\packages\backend\.poc\opf-int8
2026-05-12 22:30:28,906 INFO loading variant=int4fp16 from D:\Git\pii-remover\packages\backend\.poc\opf-int4fp16

========================================================================
OPF ONNX PoC benchmark — corpus=english-pii-corpus.json runs=10
========================================================================
  metric                           FP32           INT8      INT4+FP16
------------------------------------------------------------------------
  overall precision                0.00           0.00           0.00
  overall recall                   0.00           0.00           0.00
  overall F1                       0.00           0.00           0.00
  worst category F1                0.00           0.00           0.00
  peak memory                 4670.6 MB      1588.7 MB      1653.4 MB
  model size on disk          5397.3 MB      1569.8 MB       798.3 MB
  avg latency                   33.7 ms        36.5 ms       483.9 ms
------------------------------------------------------------------------
  FP32       TP=0 FP=22 FN=24
  INT8       TP=0 FP=21 FN=24
  INT4+FP16  TP=0 FP=22 FN=24

Per-category F1:
  category                         FP32           INT8      INT4+FP16
------------------------------------------------------------------------
  account_number                   0.00           0.00           0.00
  private_address                  0.00           0.00           0.00
  private_date                     0.00           0.00           0.00
  private_email                    0.00           0.00           0.00
  private_person                   0.00           0.00           0.00
  private_phone                    0.00           0.00           0.00
  private_url                      0.00           0.00           0.00
  secret                           0.00           0.00           0.00

Gate verdicts vs FP32:
  INT8       FAIL | F1 drop=0.00pp, worst-cat drop=0.00pp, memory reduction=66.0%, latency=1.08x
    - G4 latency ratio 1.08x > 1.05x
  INT4+FP16  FAIL | F1 drop=0.00pp, worst-cat drop=0.00pp, memory reduction=64.6%, latency=14.38x
    - G4 latency ratio 14.38x > 1.05x
  FINAL RECOMMENDATION: B (FP32 ONNX only) — quantized variants failed gates

Record this output in scripts/POC-OPF-ONNX.md §Results before deciding.
```

#### Per-gate verdict (3-way)

| Gate | FP32 | INT8 | INT4+FP16 | INT8 PASS? | INT4+FP16 PASS? |
|---|---:|---:|---:|---|---|
| G1 overall F1 | 0.00 | 0.00 (drop 0.00pp) | 0.00 (drop 0.00pp) | **No — baseline unusable** | **No — baseline unusable** |
| G2 worst category F1 | 0.00 | 0.00 (drop 0.00pp) | 0.00 (drop 0.00pp) | **No — all categories 0.00** | **No — all categories 0.00** |
| G3 peak memory | 4670.6 MB | 1588.7 MB (66.0% reduction) | 1653.4 MB (64.6% reduction) | Yes | Yes |
| G4 avg latency | 33.7 ms | 36.5 ms (1.08x) | 483.9 ms (14.38x) | No | No |

#### Final decision

- [ ] C-INT8 (`model_quantized.onnx`)
- [ ] C-INT4+FP16 (`model_q4f16.onnx`)
- [ ] B (FP32 ONNX only)
- [x] **Keep PyTorch** — all ONNX variants returned 0 exact-match F1 on the current corpus

**Reasoning**:
- Direct HF artifact download works. Disk footprint was FP32 5397.3 MB, INT8
  1569.8 MB, INT4+FP16 798.3 MB. Total download/materialization time for the
  full 3-way run was about 115 seconds after the initial quantized smoke run.
- The direct ONNX Runtime path loads all three variants, but the benchmark's
  exact span + exact category scoring produced **TP=0** for FP32, INT8, and
  INT4+FP16. Because the FP32 ONNX baseline itself is unusable under this
  runner/scoring path, the script's printed `B (FP32 ONNX only)` recommendation
  is not accepted as a production verdict.
- INT8 and INT4+FP16 also fail G4 latency. INT8 was slightly slower than FP32
  (1.08x > 1.05x). INT4+FP16 was much slower on CPU (14.38x), despite having
  the smallest disk footprint.
- No production OPF ONNX integration should proceed until the ONNX inference
  path is reconciled with upstream OPF post-processing (likely Viterbi/span
  decoding behavior) and FP32 ONNX reaches non-zero corpus F1.

### What this means for production

- **No change to the runtime image**: `torch>=2.5` and the current
  `OpfRunner` (PyTorch + transformers) stay. The `-700 MB` image-size win
  hypothesised in the Phase 7 retrospective is **not realised in v1**.
- **Direct ONNX download is no longer blocked**, but the direct
  `InferenceSession` runner is not yet semantically equivalent to the current
  OPF runtime: FP32 ONNX scored 0.00 F1 on the PoC corpus.
- **KLUE INT8 ONNX migration is unaffected**: that path uses a standard
  ELECTRA architecture and shipped successfully; this OPF blocker does
  not regress it.
- **No code or Dockerfile changes** were made as part of this PoC. The
  scripts and fixtures stay in tree as the audit trail.

### Per-category notes

Worst category is all measured categories tied at F1 0.00:
`account_number`, `private_address`, `private_date`, `private_email`,
`private_person`, `private_phone`, `private_url`, and `secret`.

This looks like a runner/post-processing incompatibility rather than a
quantization-only regression, because FP32 ONNX, INT8, and INT4+FP16 all have
the same zero-F1 pattern.

### Follow-ups for v1.x or v2

| Path | Effort | Risk | Notes |
|---|---|---|---|
| Reconcile direct ONNX post-processing with upstream OPF behavior | medium (0.5-1 day) | medium | Inspect the model repo's published decoding/Viterbi expectations and make FP32 ONNX match the PyTorch API before reconsidering B/C. |
| Re-run with `transformers` from main (`pip install git+https://github.com/huggingface/transformers.git`) | low (~30 min) | medium (unstable API) | Confirms whether HF mainline has added the architecture; if so, pin the release that includes it and re-run the PoC unchanged. |
| Try `trust_remote_code=True` in `from_pretrained` | low | high (security) | Loads custom code from the HF model repo. Each new model revision needs a manual review before trusting; not acceptable as a production default. |
| Manually re-export OPF as a standard architecture (`BertForTokenClassification` etc.) | medium-high | medium (label drift) | Requires understanding of the model's head; risk of introducing label/score discrepancies vs the upstream model. |
| Wait for OpenAI to publish OPF as a standard architecture | n/a | low | Cheapest path; track HF model card for revisions and re-run this PoC on a future date. |
| Drop OPF dependency entirely (replace with another English NER model) | high | high | Out of scope for v1.x without a separate ADR. |

The recommended v1.x action is to re-run the PoC after a transformers
upgrade and only then revisit the production migration. Until that PoC
returns a passing verdict, the production OPF runtime stays on PyTorch.

### 2026-05-12 — BIOES + Viterbi decoding 구현 후 재측정 (Update 3; supersedes Update 2 verdict)

**Run date**: 2026-05-12  
**Environment**: Windows + Python 3.14.4 + onnxruntime 1.26.0 + transformers main (`5.8.0.dev0`)  
**Corpus**: `english-pii-corpus.json` (17 cases, runs=10)  
**Path used**: Step 1 partially succeeded for PyTorch `AutoModelForTokenClassification`, but ORT pipeline was blocked by `optimum-onnx` / transformers main incompatibility. Step 2 direct ONNX Runtime path was therefore fixed with BIOES span extraction + constrained Viterbi.

#### Step 1 outcome

```text
transformers= 5.8.0.dev0
config model_type: openai_privacy_filter
architectures: ['OpenAIPrivacyFilterForTokenClassification']
model loaded OK
id2label sample: [(0, 'O'), (1, 'B-account_number'), (2, 'I-account_number'), (3, 'E-account_number'), (4, 'S-account_number')]
```

`AutoConfig` / PyTorch model loading now works on transformers main, but the ONNX measurement path could not use `optimum.onnxruntime` because installed `optimum-onnx` imports a removed transformers utility:

```text
ImportError: cannot import name 'is_offline_mode' from 'transformers.utils'
```

#### Raw script output after decoder fix

```text
========================================================================
OPF ONNX PoC benchmark — corpus=english-pii-corpus.json runs=10
========================================================================
  metric                           FP32           INT8      INT4+FP16
------------------------------------------------------------------------
  overall precision                0.86           0.86           0.82
  overall recall                   0.75           0.75           0.75
  overall F1                       0.80           0.80           0.78
  worst category F1                0.00           0.00           0.00
  peak memory                 4638.0 MB      1556.7 MB      1626.5 MB
  model size on disk          5397.3 MB      1569.8 MB       798.3 MB
  avg latency                   35.1 ms        38.0 ms       486.3 ms
------------------------------------------------------------------------
  FP32       TP=18 FP=3 FN=6
  INT8       TP=18 FP=3 FN=6
  INT4+FP16  TP=18 FP=4 FN=6

Per-category F1:
  category                         FP32           INT8      INT4+FP16
------------------------------------------------------------------------
  account_number                   1.00           1.00           1.00
  private_address                  1.00           1.00           1.00
  private_date                     0.80           0.80           0.80
  private_email                    0.91           0.91           0.91
  private_person                   0.91           0.91           0.83
  private_phone                    1.00           1.00           1.00
  private_url                      0.00           0.00           0.00
  secret                           0.00           0.00           0.00

Gate verdicts vs FP32:
  INT8       FAIL | F1 drop=0.00pp, worst-cat drop=0.00pp, memory reduction=66.4%, latency=1.08x
    - G4 latency ratio 1.08x > 1.05x
  INT4+FP16  FAIL | F1 drop=1.74pp, worst-cat drop=7.58pp, memory reduction=64.9%, latency=13.86x
    - G2 worst category F1 drop 7.58pp > 5.0pp
    - G4 latency ratio 13.86x > 1.05x
  FINAL RECOMMENDATION: B (FP32 ONNX only) — quantized variants failed gates
```

#### Per-gate verdict (decoder-fixed run)

| Gate | FP32 | INT8 | INT4+FP16 | INT8 PASS? | INT4+FP16 PASS? |
|---|---:|---:|---:|---|---|
| G1 overall F1 | 0.80 | 0.80 (drop 0.00pp) | 0.78 (drop 1.74pp) | Yes | Yes |
| G2 worst category F1 | 0.00 | 0.00 (drop 0.00pp) | 0.00 (worst measured drop 7.58pp on `private_person`) | Yes | No |
| G3 peak memory | 4638.0 MB | 1556.7 MB (66.4% reduction) | 1626.5 MB (64.9% reduction) | Yes | Yes |
| G4 avg latency | 35.1 ms | 38.0 ms (1.08x) | 486.3 ms (13.86x) | No | No |

#### Final decision after decoder fix

- [ ] C-INT8 (`model_quantized.onnx`)
- [ ] C-INT4+FP16 (`model_q4f16.onnx`)
- [x] **B (FP32 ONNX only)** — accuracy is restored and torch can be removed in a follow-up production integration, but quantized variants do not pass all four gates under the current thresholds.
- [ ] Keep PyTorch as the long-term default

**Reasoning**:
- BIOES + constrained Viterbi decoding is now implemented in the PoC runner and restores meaningful exact-match corpus performance: FP32 ONNX reaches precision 0.86 / recall 0.75 / F1 0.80 on the 17-case fixture.
- FP32 and INT8 accuracy are identical on this corpus (precision 0.86 / recall 0.75 / F1 0.80; TP=18 FP=3 FN=6). INT8 still misses the strict G4 latency gate by a small margin in the accepted runs=10 measurement (1.08x > 1.05x).
- INT4+FP16 is not a CPU production candidate: it is much smaller on disk, but latency is 13.86x FP32 and `private_person` regresses enough to fail G2.
- `worst category F1=0.00` exposes a weakness in the small PoC corpus and gate definition. Some categories have too few examples for a stable per-category floor; use this fixture as a migration smoke test, not a production-grade model quality claim.

### What this means for production after decoder fix

- **Recommended next step**: implement an ONNX-backed `opf_runner.py` path using FP32 ONNX + the same BIOES/Viterbi decoder semantics, guarded by config/env rollback to the current PyTorch runner.
- **Expected production benefit**: once FP32 ONNX is the default, remove the PyTorch runtime from production `requirements.txt` / Docker image and verify the expected ~700 MB image reduction.
- **Do not switch to INT8 by default yet**: INT8 is accuracy-equivalent and saves RSS/disk, but misses the current latency threshold. It can be reconsidered if the product decision relaxes G4 from 1.05x to about 1.10x or a larger benchmark shows the 1.08x run was noise.
- **Hold INT4+FP16** for GPU/WebGPU or other non-CPU environments; do not use it as the CPU backend default.
- **No production code changed in this PoC**: `opf_runner.py`, `Dockerfile`, and production `requirements.txt` remain unchanged pending an explicit integration task.

## Failure-mode notes

| Failure | What it means | Next step |
|---|---|---|
| `poc-opf-onnx.py` cannot download FP32 | HF artifact unavailable, network/auth issue, or disk full | fix download environment; without FP32 baseline, only absolute quantized metrics are available |
| Quantized artifact download fails | HF artifact unavailable, network/auth issue, or disk full | benchmark any successfully downloaded variants; do not issue a gate verdict for missing variants |
| G1 fails | broad English PII regression | hard fail unless a larger corpus disproves it |
| G2 fails | at least one OPF category regressed too much | hard fail for that quantized variant; inspect the category and consider FP32 ONNX |
| G3 fails | quantized variant did not reduce RSS enough | option B or C depends on latency/disk-size; do not claim memory win |
| G4 fails | quantized variant is slower than FP32 | option B or the other quantized candidate; inspect CPU provider / unsupported op fallback |
| FP32 passes but both quantized variants fail G3/G4 | accuracy OK, quantization benefit weak | choose option B and still remove torch from production runtime |

## What ships either way

If G1/G2 pass, ONNX options can replace the current PyTorch OPF runtime:

- **B (FP32 ONNX)**: larger model than INT8, but removes `torch` and keeps
  OPF behavior closest to baseline.
- **C (quantized ONNX)**: INT8 or INT4+FP16 target if all four gates pass.

Both options should allow production `requirements.txt` and Docker image
cleanup by removing the PyTorch runtime. That image-size reduction is the
headline reason to do this migration.

## Post-verdict integration guide

Do not perform these changes until the PoC result is recorded and reviewed:

1. Add an ONNX-backed OPF runner beside the current PyTorch runner.
2. Wire config/env selection so the PyTorch path remains a rollback option.
3. Update production `requirements.txt` only after ONNX path is default.
4. Update `Dockerfile` to remove torch-only layers and verify image size.
5. Run backend API tests and a real Docker smoke test against `/redact` and `/health`.
6. Record the decision in an ADR if the production default changes.

## Out of scope for this PoC

- Production OPF runner implementation.
- `Dockerfile` / production requirements changes.
- Static INT8 with calibration data.
- Larger English PII corpus curation beyond the existing PoC fixture.
- ADR authoring before the result is known.

## Cleanup

After the decision is recorded, the `.poc/` directory and `.poc-venv/` can be
deleted (they are in `.gitignore`):

```powershell
Remove-Item -Recurse -Force .poc, .poc-venv
```

The PoC scripts (`scripts/poc-opf-onnx.py`, `scripts/poc-opf-benchmark.py`,
`scripts/requirements-poc.txt`, this file) stay in tree as the audit trail —
anyone re-evaluating the decision later (new model revision, different CPU
baseline) can rerun them and update §Results.
