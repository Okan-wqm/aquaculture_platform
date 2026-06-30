"""Burn-in → autonomy unlock ladder bridge (ORPHAN-MEDIUM-262, slice 6a).

A PASSED observe burn-in advances the unlock ladder by recording one
observe_success per valid cycle. Fail-closed (nothing on a non-passed report),
idempotent (re-running never double-counts), operator-invoked (never auto-called
by run_observe_burn_in).
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

_KERNEL = Path(__file__).resolve().parents[1]
if str(_KERNEL) not in sys.path:
    sys.path.insert(0, str(_KERNEL))

from aria_kernel.autonomy_ladder import (  # noqa: E402
    BURN_IN_REASON_PREFIX,
    record_burn_in_acceptance,
)
from aria_kernel.autonomy_unlock import evaluate_autonomy_unlock  # noqa: E402
from aria_kernel.tool_registry import GovernanceError  # noqa: E402


def _passed(n_valid: int, n_invalid: int = 0) -> dict:
    cycles = [{"cycle_id": f"obs-{i}", "valid_cycle": True} for i in range(n_valid)]
    cycles += [{"cycle_id": f"bad-{i}", "valid_cycle": False} for i in range(n_invalid)]
    return {"acceptance_verdict": "passed", "cycles": cycles}


class BurnInBridgeTests(unittest.TestCase):
    def test_passed_records_one_event_per_valid_cycle(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            out = record_burn_in_acceptance(report=_passed(3, n_invalid=2), base_dir=Path(td))
            self.assertEqual(out["recorded"], 3)  # invalid cycles excluded
            self.assertEqual(out["valid_cycles"], 3)
            counts = dict(evaluate_autonomy_unlock(lane="L1", base_dir=Path(td)).counts)
            self.assertEqual(counts["observe_successes"], 3)

    def test_idempotent_rerun_records_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            record_burn_in_acceptance(report=_passed(2), base_dir=Path(td))
            again = record_burn_in_acceptance(report=_passed(2), base_dir=Path(td))
            self.assertEqual(again["recorded"], 0)
            self.assertEqual(again["skipped"], 2)
            # still only 2 in the ledger
            counts = dict(evaluate_autonomy_unlock(lane="L1", base_dir=Path(td)).counts)
            self.assertEqual(counts["observe_successes"], 2)

    def test_failed_verdict_records_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            out = record_burn_in_acceptance(
                report={"acceptance_verdict": "failed", "cycles": [{"cycle_id": "x", "valid_cycle": True}]},
                base_dir=Path(td),
            )
            self.assertEqual(out["recorded"], 0)
            self.assertEqual(out["outcome"], "verdict_not_passed")
            counts = dict(evaluate_autonomy_unlock(lane="L1", base_dir=Path(td)).counts)
            self.assertEqual(counts["observe_successes"], 0)

    def test_missing_verdict_records_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            out = record_burn_in_acceptance(report={"cycles": []}, base_dir=Path(td))
            self.assertEqual(out["recorded"], 0)

    def test_reason_ties_event_to_cycle(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            record_burn_in_acceptance(report=_passed(1), base_dir=Path(td))
            from aria_kernel.autonomy_ladder import _recorded_observe_reasons

            reasons = _recorded_observe_reasons(Path(td))
            self.assertIn(f"{BURN_IN_REASON_PREFIX}obs-0", reasons)

    def test_unknown_mode_raises(self) -> None:
        with self.assertRaises(GovernanceError):
            record_burn_in_acceptance(report=_passed(1), mode="bogus", base_dir=None)

    def test_mock_mode_does_not_touch_real_ladder(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            record_burn_in_acceptance(report=_passed(5), mode="mock", base_dir=Path(td))
            # mock ledger is separate → real L1 ladder stays empty
            counts = dict(evaluate_autonomy_unlock(lane="L1", base_dir=Path(td)).counts)
            self.assertEqual(counts["observe_successes"], 0)


if __name__ == "__main__":
    unittest.main()
