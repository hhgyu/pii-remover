"""Python hot-path benchmark for the four paths the TypeScript port replaced.

The ceilings were set from a TypeScript baseline measured *before* any Python
was written, so passing them means the port did not regress the paths that
matter. Only ``restore`` and ``stream_buffer.push`` run per SSE delta; the other
two run once per request, which is why their budgets are loose.

``TS_NS_PER_OP`` records that baseline. It was produced by a one-off harness
(``scripts/bench-token-baseline.ts``, removed once the port landed) driving the
same four shapes at the same op counts against ``packages/proxy``:

    bun 1.3.14, Windows x64, 2026-08-12
    token_hash          2305 ns/op    50k ops, unique input per call
    vault.assign       32901 ns/op     5k ops, 10 detections per batch
    restore            10005 ns/op    20k ops, 10 tokens in 442 chars
    stream_buffer.push   108 ns/op   200k ops, 3-char SSE deltas

Treat those as a historical fixture, not a live measurement: they are only
comparable to a run on similar hardware. Re-derive them from
``packages/proxy`` if the comparison ever needs to be exact again.

Usage: python scripts/bench_pii_hotpath.py [--json]
"""

from __future__ import annotations

import json
import sys
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from itertools import count
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.pii.restorer import RestoreOptions, Restorer
from server.pii.stream_buffer import create_stream_buffer
from server.pii.token_hash import derive_token_key, token_hash
from server.pii.types import Detection
from server.pii.vault import VaultManager

SECRET = "pii-remover-baseline-secret"
KEY = derive_token_key(SECRET)

CEILINGS_US: dict[str, float] = {
    "token_hash": 50.0,
    "vault.assign": 500.0,
    "restore": 200.0,
    "stream_buffer.push": 5.0,
}

TS_NS_PER_OP: dict[str, int] = {
    "token_hash": 2305,
    "vault.assign": 32901,
    "restore": 10005,
    "stream_buffer.push": 108,
}


@dataclass
class Row:
    key: str
    name: str
    ops: int
    ms: float
    ops_per_sec: float
    ns_per_op: float


def bench(key: str, name: str, ops: int, fn: Callable[[], object]) -> Row:
    for _ in range(max(1, ops // 10)):
        fn()
    t0 = time.perf_counter()
    for _ in range(ops):
        fn()
    ms = (time.perf_counter() - t0) * 1000.0
    return Row(
        key=key,
        name=name,
        ops=ops,
        ms=ms,
        ops_per_sec=(ops / ms) * 1000.0,
        ns_per_op=(ms * 1e6) / ops,
    )


_hash_counter = count()


def _token_hash_op() -> object:
    return token_hash(KEY, "PERSON", f"김철수-{next(_hash_counter)}")


_assign_counter = count()


def _assign_op() -> object:
    vault = VaultManager(token_key=KEY)
    n = next(_assign_counter)
    detections = []
    for i in range(10):
        text = f"user{n}_{i}@example.com"
        detections.append(
            Detection(
                start=i * 40,
                end=i * 40 + len(text),
                category="private_email",
                confidence=0.95,
                text=text,
            )
        )
    return vault.assign("bench", detections)


_restore_vault = VaultManager(token_key=KEY)
_restore_detections = [
    Detection(
        start=i * 40,
        end=i * 40 + len(f"restore{i}@example.com"),
        category="private_email",
        confidence=0.95,
        text=f"restore{i}@example.com",
    )
    for i in range(10)
]
_assigned = _restore_vault.assign("restore-bench", _restore_detections)
_restorer = Restorer(_restore_vault, RestoreOptions(warn=lambda _m: None))
_RESTORE_TEXT = (
    "The following addresses were found in the audit log: "
    + ", ".join(a.token for a in _assigned)
    + ". Please confirm each one before the migration window closes."
)


def _restore_op() -> object:
    return _restorer.restore(_RESTORE_TEXT, "restore-bench")


_STREAM_PAYLOAD = f"Contact {_assigned[0].token} for details. "
_STREAM_CHUNKS = [_STREAM_PAYLOAD[i : i + 3] for i in range(0, len(_STREAM_PAYLOAD), 3)]
_stream_state: dict[str, object] = {"idx": 0, "buf": create_stream_buffer(None)}


def _stream_op() -> object:
    idx = int(_stream_state["idx"])  # type: ignore[call-overload]
    if idx >= len(_STREAM_CHUNKS):
        _stream_state["buf"] = create_stream_buffer(None)
        idx = 0
    buf = _stream_state["buf"]
    _stream_state["idx"] = idx + 1
    return buf.push(_STREAM_CHUNKS[idx])  # type: ignore[attr-defined]


def main() -> int:
    rows = [
        bench("token_hash", "token_hash (unique input)", 50_000, _token_hash_op),
        bench("vault.assign", "vault.assign (10 detections/batch)", 5_000, _assign_op),
        bench(
            "restore",
            f"restore (10 tokens, {len(_RESTORE_TEXT)} chars)",
            20_000,
            _restore_op,
        ),
        bench(
            "stream_buffer.push",
            f"stream_buffer.push ({len(_STREAM_CHUNKS)}-chunk cycle, 3 chars/delta)",
            200_000,
            _stream_op,
        ),
    ]

    if "--json" in sys.argv:
        print(json.dumps({"runtime": "cpython", "rows": [asdict(r) for r in rows]}, indent=2))
        return 0

    print("=== Python hot-path vs TypeScript baseline ===")
    header = (
        f"{'path':<46} {'ops/sec':>11} {'ns/op':>10} "
        f"{'vs TS':>7} {'budget':>9} {'verdict':>8}"
    )
    print(header)
    failures = 0
    for r in rows:
        ceiling_ns = CEILINGS_US[r.key] * 1000.0
        ratio = r.ns_per_op / TS_NS_PER_OP[r.key]
        ok = r.ns_per_op <= ceiling_ns
        if not ok:
            failures += 1
        print(
            f"{r.name:<46} {round(r.ops_per_sec):>11,} {round(r.ns_per_op):>10,} "
            f"{ratio:>6.1f}x {CEILINGS_US[r.key]:>8.0f}us {'PASS' if ok else 'FAIL':>8}"
        )

    print()
    if failures:
        print(f"{failures} path(s) over budget")
    else:
        print("all paths within budget")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
