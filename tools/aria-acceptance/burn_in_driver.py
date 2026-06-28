#!/usr/bin/env python3
"""Plan 031 Faz 031a + 031c — self-driving MOCK autonomy burn-in.

This is the missing runtime caller. ARIA's unlock ladder had a counter writer
(``record_acceptance_event``) with no runtime caller, so clean cycles never
accumulated toward autonomy. This driver bridges that gap in MOCK mode: it
gates on the Plan 030 acceptance harness (031c — a cycle counts only if the
harness still ACCEPTs), then records N clean cycles into the SEPARATE mock
ledger and shows the ladder advancing toward L1 — while the REAL unlock ledger
stays untouched (a sandbox cannot unlock real merge).

Run: ``python3 tools/aria-acceptance/burn_in_driver.py --cycles 30 --mock``
Exit 0 = mock L1 reached; exit 1 = harness REJECT or L1 not reached.
"""
from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL_PATH = _REPO_ROOT / "aria-kernel"
_HARNESS_DIR = Path(__file__).resolve().parent
for _p in (str(_KERNEL_PATH), str(_HARNESS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import harness  # noqa: E402  (tools/aria-acceptance/harness.py)
from aria_kernel.autonomy_ladder import evaluate_mock_unlock, record_clean_cycle  # noqa: E402
from aria_kernel.autonomy_unlock import evaluate_autonomy_unlock  # noqa: E402


def run_mock_burn_in(*, cycles: int, base_dir: Path, run_harness: bool) -> int:
    # 031c gate — a cycle counts toward autonomy only if the deterministic
    # acceptance harness still ACCEPTs ARIA's outputs. Run it once as the
    # cleanliness precondition for this mock burn-in.
    if run_harness:
        report = harness.run_all(repo_root=_REPO_ROOT)
        harness_accepted = bool(report["passed"])
        print(f"[031c] acceptance harness: {'ACCEPT' if harness_accepted else 'REJECT'}")
        if not harness_accepted:
            print("[031c] harness REJECT — refusing to record any clean cycle.")
            return 1
    else:
        harness_accepted = True
        print("[031c] harness skipped (--skip-harness); assuming ACCEPT for demo.")

    for i in range(1, cycles + 1):
        record_clean_cycle(
            cycle_id=f"mock-burnin-{i:03d}",
            mode="mock",
            harness_accepted=harness_accepted,
            base_dir=base_dir,
            profile="observe",
        )

    mock = evaluate_mock_unlock(lane="L1", base_dir=base_dir)
    real = evaluate_autonomy_unlock(lane="L1", base_dir=base_dir)
    mock_observe = mock.counts.get("observe_successes", 0)
    real_observe = real.counts.get("observe_successes", 0)

    print(f"[031a] mock ledger observe_successes : {mock_observe}")
    print(f"[031a] mock L1 unlocked              : {mock.valid}")
    print(f"[031a] REAL ledger observe_successes : {real_observe} (must stay 0)")
    print(f"[031a] REAL L1 unlocked              : {real.valid} (must stay False)")

    if real_observe != 0 or real.valid:
        print("[031a] SAFETY VIOLATION — mock events leaked into the real ledger.")
        return 1
    if not mock.valid:
        print(f"[031a] mock L1 not reached: {mock.reasons}")
        return 1
    print("[031a] OK — mock burn-in advanced the ladder to L1; real merge untouched.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="ARIA mock autonomy burn-in driver")
    parser.add_argument("--cycles", type=int, default=30)
    parser.add_argument("--mock", action="store_true", help="mock mode (the only supported mode here)")
    parser.add_argument("--skip-harness", action="store_true", help="skip the 031c harness gate (fast demo)")
    parser.add_argument("--base-dir", type=str, default=None, help="tools dir (default: temp dir)")
    args = parser.parse_args()

    if not args.mock:
        print("Refusing to run: only --mock is supported here. Real-mode burn-in "
              "is operator/runner-bound (see docs/aria/runbooks/autonomy-unlock.md).")
        return 2

    cleanup = False
    if args.base_dir:
        base_dir = Path(args.base_dir)
    else:
        base_dir = Path(tempfile.mkdtemp(prefix="aria-mock-burnin-"))
        cleanup = True
    try:
        return run_mock_burn_in(
            cycles=args.cycles, base_dir=base_dir, run_harness=not args.skip_harness,
        )
    finally:
        if cleanup:
            shutil.rmtree(base_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
