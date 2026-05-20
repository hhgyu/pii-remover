/**
 * Backend latency benchmark — pre-/post- comparison for ADR-0019 follow-ups.
 *
 * Measures four scenarios against a running detection backend:
 *   1) `/health` round-trip  — pure HTTP RTT baseline (no inference)
 *   2) `/redact` × N sequential — current N+1 pattern that the OpenCode
 *      plugin and proxy producer use (one HTTP per text)
 *   3) `/redact/batch` with N texts in one POST — best-case batched call
 *   4) OpfHttpBackend.detect() × N sequential — same as (2) but through
 *      the production client (includes our TypeScript abstraction overhead)
 *
 * Run:
 *   bun scripts/bench-backend-latency.ts
 *   PII_REMOVER_ENDPOINT=http://localhost:8000 BENCH_ITER=200 \
 *     bun scripts/bench-backend-latency.ts
 *
 * Output is a compact summary table per scenario plus the calculated
 * speed-up that batching alone would deliver. Use as the baseline before
 * shipping batch-API / keep-alive changes, then re-run to verify.
 */
import { performance } from "node:perf_hooks";

import { OpfHttpBackend } from "../packages/core/src/backend/opf-http.js";

const ENDPOINT = (process.env.PII_REMOVER_ENDPOINT ?? "http://localhost:8000").replace(
  /\/+$/,
  ""
);
const ITER = Math.max(1, Number(process.env.BENCH_ITER ?? 100));
const BATCH_MAX = Math.max(1, Number(process.env.BENCH_BATCH_MAX ?? 256));

const SAMPLES: ReadonlyArray<string> = [
  "Contact alice@example.com about the meeting tomorrow.",
  "전화 010-1234-5678 로 김철수씨께 연락 부탁드립니다.",
  "주민번호 900101-1023483 확인 필요합니다.",
  "API key: sk-1234567890abcdefghij1234567890ABCDEF for the OpenAI integration.",
  "card 4111-1111-1111-1111 expires 12/27, billed to bob@example.com",
  "사업자번호 124-81-00998 등록 후 https://internal.corp.io/admin 에서 확인",
  "Reach Mary Johnson at mary.johnson@globex.com or +1-415-555-0142 (San Francisco office).",
  "github_pat_11ABCDEFG0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 — rotate ASAP",
  "AWS key AKIAIOSFODNN7EXAMPLE is hardcoded in src/lib/aws.ts, please remove",
  "주소: 서울특별시 강남구 테헤란로 152, 우편번호 06236",
];

interface Stats {
  n: number;
  total_ms: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  throughput_per_sec: number;
}

function summarise(times: number[]): Stats {
  const sorted = [...times].sort((a, b) => a - b);
  const total = sorted.reduce((s, x) => s + x, 0);
  const pick = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  return {
    n: sorted.length,
    total_ms: round(total),
    avg_ms: round(total / sorted.length),
    p50_ms: round(pick(0.5)),
    p95_ms: round(pick(0.95)),
    p99_ms: round(pick(0.99)),
    throughput_per_sec: round((sorted.length / total) * 1000),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function pickSample(i: number): string {
  return SAMPLES[i % SAMPLES.length]!;
}

async function ensureBackendReady(): Promise<void> {
  let body: { ok?: boolean; model_loaded?: boolean } = {};
  try {
    const res = await fetch(`${ENDPOINT}/health`);
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw new Error(
      `Backend not reachable at ${ENDPOINT}/health: ${(err as Error).message}\n` +
        `  → start it with:  cd packages/backend && docker compose up -d`
    );
  }
  if (!body.ok) {
    throw new Error(`Backend at ${ENDPOINT}/health reports not-ok: ${JSON.stringify(body)}`);
  }
  if (!body.model_loaded) {
    process.stdout.write(
      `⚠ Model not loaded — warming up with a /redact call (this may take a few seconds)…\n`
    );
    await fetch(`${ENDPOINT}/redact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "warmup" }),
    });
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function benchHealthRoundTrip(): Promise<Stats> {
  const times: number[] = [];
  for (let i = 0; i < ITER; i++) {
    const t0 = performance.now();
    const res = await fetch(`${ENDPOINT}/health`);
    await res.text();
    times.push(performance.now() - t0);
  }
  return summarise(times);
}

async function benchSingleRedactSequential(): Promise<Stats> {
  const times: number[] = [];
  for (let i = 0; i < ITER; i++) {
    const t0 = performance.now();
    const res = await fetch(`${ENDPOINT}/redact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: pickSample(i) }),
    });
    await res.json();
    times.push(performance.now() - t0);
  }
  return summarise(times);
}

interface BatchResult {
  total_ms: number;
  per_text_amortised_ms: number;
  throughput_per_sec: number;
  chunks: number;
  chunk_size: number;
  detection_count: number;
}

async function benchBatchRedactChunked(): Promise<BatchResult> {
  const texts = Array.from({ length: ITER }, (_, i) => pickSample(i));
  const chunkSize = BATCH_MAX;
  let detectionCount = 0;
  let chunks = 0;
  const t0 = performance.now();
  for (let offset = 0; offset < texts.length; offset += chunkSize) {
    const slice = texts.slice(offset, offset + chunkSize);
    const res = await fetch(`${ENDPOINT}/redact/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: slice }),
    });
    if (!res.ok) {
      throw new Error(
        `batch chunk rejected: HTTP ${res.status} ${res.statusText} ` +
          `(chunk_size=${slice.length}, BENCH_BATCH_MAX=${BATCH_MAX}, ` +
          `backend OPF_BATCH_MAX must be >= ${slice.length})`
      );
    }
    const body = (await res.json()) as {
      results: { detections: unknown[] }[];
    };
    if (!Array.isArray(body.results) || body.results.length !== slice.length) {
      throw new Error(
        `batch returned ${body.results?.length ?? "non-array"} results for ${slice.length} texts`
      );
    }
    detectionCount += body.results.reduce(
      (s, r) => s + (Array.isArray(r.detections) ? r.detections.length : 0),
      0
    );
    chunks++;
  }
  const total = performance.now() - t0;
  return {
    total_ms: round(total),
    per_text_amortised_ms: round(total / ITER),
    throughput_per_sec: round((ITER / total) * 1000),
    chunks,
    chunk_size: chunkSize,
    detection_count: detectionCount,
  };
}

async function benchOpfHttpBackendSequential(): Promise<Stats> {
  const backend = new OpfHttpBackend({ endpoint: ENDPOINT });
  const times: number[] = [];
  for (let i = 0; i < ITER; i++) {
    const t0 = performance.now();
    await backend.detect(pickSample(i), { request_id: `bench-${i}` });
    times.push(performance.now() - t0);
  }
  return summarise(times);
}

function printTable(title: string, stats: Stats): void {
  process.stdout.write(`\n## ${title}\n`);
  process.stdout.write(
    `  n=${stats.n}  total=${stats.total_ms}ms  avg=${stats.avg_ms}ms  ` +
      `p50=${stats.p50_ms}ms  p95=${stats.p95_ms}ms  p99=${stats.p99_ms}ms  ` +
      `throughput=${stats.throughput_per_sec}/s\n`
  );
}

async function main(): Promise<void> {
  process.stdout.write(`# Backend latency benchmark\n`);
  process.stdout.write(`  endpoint  = ${ENDPOINT}\n`);
  process.stdout.write(`  iter      = ${ITER}\n`);
  process.stdout.write(`  batch_max = ${BATCH_MAX}\n`);
  process.stdout.write(`  samples   = ${SAMPLES.length} texts (rotated)\n\n`);

  await ensureBackendReady();

  const health = await benchHealthRoundTrip();
  printTable("1) /health round-trip (pure HTTP RTT, no inference)", health);

  const single = await benchSingleRedactSequential();
  printTable("2) /redact × N sequential (current N+1 pattern)", single);

  const backend = await benchOpfHttpBackendSequential();
  printTable("3) OpfHttpBackend.detect() × N sequential (production client)", backend);

  const batch = await benchBatchRedactChunked();
  process.stdout.write(
    `\n## 4) /redact/batch chunked (${batch.chunks} POSTs × ${batch.chunk_size} texts = ${ITER} total)\n`
  );
  process.stdout.write(
    `  total=${batch.total_ms}ms  per-text-amortised=${batch.per_text_amortised_ms}ms  ` +
      `throughput=${batch.throughput_per_sec}/s  detections=${batch.detection_count}\n`
  );

  const speedup = round(single.total_ms / batch.total_ms);
  const overheadEst = round(single.avg_ms - batch.per_text_amortised_ms);
  process.stdout.write(`\n## Summary\n`);
  process.stdout.write(`  HTTP RTT (health avg)              : ${health.avg_ms} ms\n`);
  process.stdout.write(`  Single mask wall-time avg          : ${single.avg_ms} ms\n`);
  process.stdout.write(`  Batch per-text amortised           : ${batch.per_text_amortised_ms} ms\n`);
  process.stdout.write(
    `  HTTP-overhead saved per text (est.) : ${overheadEst} ms\n` +
      `  Batch / N+1 wall-time speedup       : ${speedup}×\n` +
      `\n` +
      `  → If 'speedup' is high (>3×) the wins from Option A (batching) are real.\n` +
      `  → If HTTP RTT >> inference cost, Option B (keep-alive) also pays off.\n`
  );
}

main().catch((err) => {
  process.stderr.write(`bench failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
