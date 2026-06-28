"""Plan 031 Faz 031a — burn-in → autonomy-ladder bridge tests.

What this suite pins:
- record_clean_cycle requires harness_accepted (the 031c precondition).
- mode="mock" writes ONLY the mock demonstration ledger; the real unlock
  ledger stays empty and evaluate_autonomy_unlock(L1) never advances.
- evaluate_mock_unlock counts mock observe_successes with the SAME rule as the
  real evaluator, so 30 clean mock cycles satisfy L1 on the mock ledger.
- mode="real" writes the real ledger and advances evaluate_autonomy_unlock.
- An unknown mode is rejected.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.autonomy_ladder import (
    evaluate_mock_unlock,
    record_clean_cycle,
)
from aria_kernel.autonomy_unlock import evaluate_autonomy_unlock
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class AutonomyLadderBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-ladder-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_requires_harness_accept(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            record_clean_cycle(
                cycle_id="c1", mode="mock", harness_accepted=False,
                base_dir=self.tools,
            )
        self.assertIn("autonomy_ladder_requires_harness_accept", str(cm.exception))

    def test_unknown_mode_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            record_clean_cycle(
                cycle_id="c1", mode="sideways", harness_accepted=True,
                base_dir=self.tools,
            )

    def test_mock_advances_only_mock_ledger(self) -> None:
        for i in range(30):
            record_clean_cycle(
                cycle_id=f"mock-{i:03d}", mode="mock", harness_accepted=True,
                base_dir=self.tools, profile="observe",
            )
        mock = evaluate_mock_unlock(lane="L1", base_dir=self.tools)
        real = evaluate_autonomy_unlock(lane="L1", base_dir=self.tools)

        self.assertEqual(mock.counts["observe_successes"], 30)
        self.assertTrue(mock.valid, msg=mock.reasons)
        # The real ledger must be untouched — a sandbox cannot unlock real merge.
        self.assertEqual(real.counts["observe_successes"], 0)
        self.assertFalse(real.valid)

    def test_real_mode_advances_real_ledger(self) -> None:
        record_clean_cycle(
            cycle_id="real-1", mode="real", harness_accepted=True,
            base_dir=self.tools,
        )
        real = evaluate_autonomy_unlock(lane="L1", base_dir=self.tools)
        self.assertEqual(real.counts["observe_successes"], 1)
        # And the mock ledger stays empty.
        mock = evaluate_mock_unlock(lane="L1", base_dir=self.tools)
        self.assertEqual(mock.counts["observe_successes"], 0)


if __name__ == "__main__":
    unittest.main()
