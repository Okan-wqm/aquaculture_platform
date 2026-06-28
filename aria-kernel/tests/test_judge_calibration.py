"""Plan 024 §A — closed-loop judge calibration measurement.

Proves judges are scored against ground truth (human / ai_consensus verdicts)
from the existing feedback ledger, with no LLM re-invocation: a judge that
agrees with truth reads ``ok``; a judge that over-flags reads ``degraded``;
a judge with too few ground-truth-backed votes reads ``insufficient_data``.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import record_operator_feedback
from aria_kernel.judge_calibration import calibration_path, compute_judge_calibration
from aria_kernel.tool_registry import ensure_tools_dir


class JudgeCalibrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _truth(self, i: int, verdict: str) -> None:
        record_operator_feedback(
            tool_id="tool-x", run_id=f"r{i}", finding_id=f"f{i}", verdict=verdict,
            severity="medium", note="ground truth", source_type="human",
            judgment_group_id=f"g{i}", base_dir=self.tools,
        )

    def _vote(self, i: int, judge_id: str, verdict: str, confidence: float) -> None:
        record_operator_feedback(
            tool_id="tool-x", run_id=f"r{i}", finding_id=f"f{i}", verdict=verdict,
            severity="medium", note="judge vote", source_type="ai_judge",
            judge_id=judge_id, confidence=confidence, judgment_group_id=f"g{i}",
            base_dir=self.tools,
        )

    def _seed(self) -> None:
        # 12 findings: 8 true_positive, 4 false_positive ground truth.
        for i in range(12):
            truth = "true_positive" if i < 8 else "false_positive"
            self._truth(i, truth)
            # j-good always agrees with truth.
            self._vote(i, "judge-good", truth, 0.9 if truth == "true_positive" else 0.4)
            # j-bad always says true_positive (over-flags the 4 FPs).
            self._vote(i, "judge-bad", "true_positive", 0.95)
        # j-thin: only 3 votes → insufficient_data.
        for i in range(3):
            self._vote(i, "judge-thin", "true_positive", 0.8)

    def test_scores_judges_against_ground_truth(self) -> None:
        self._seed()
        result = compute_judge_calibration(cycle_id="c1", base_dir=self.tools)
        by_id = {j["judge_id"]: j for j in result["judges"]}

        good = by_id["judge-good"]
        self.assertEqual(good["status"], "ok")
        self.assertEqual(good["precision"], 1.0)
        self.assertEqual(good["recall"], 1.0)
        self.assertEqual(good["samples"], 12)

        bad = by_id["judge-bad"]
        self.assertEqual(bad["status"], "degraded")
        self.assertLess(bad["precision"], 0.7)   # 8/(8+4) = 0.667
        self.assertEqual(bad["recall"], 1.0)
        self.assertIn("judge-bad", result["degraded_judges"])

        thin = by_id["judge-thin"]
        self.assertEqual(thin["status"], "insufficient_data")

    def test_calibration_signal_separates_confidence(self) -> None:
        self._seed()
        result = compute_judge_calibration(base_dir=self.tools)
        bad = {j["judge_id"]: j for j in result["judges"]}["judge-bad"]
        # judge-bad is wrong on the 4 FP findings at high confidence → a
        # non-null mean confidence on its wrong calls (over-confident signal).
        self.assertIsNotNone(bad["mean_confidence_wrong"])

    def test_persists_ledger_row(self) -> None:
        self._seed()
        compute_judge_calibration(base_dir=self.tools)
        self.assertTrue(calibration_path(self.tools).exists())

    def test_no_feedback_is_empty(self) -> None:
        result = compute_judge_calibration(base_dir=self.tools)
        self.assertEqual(result["judged_judges"], 0)
        self.assertEqual(result["degraded_judges"], [])


if __name__ == "__main__":
    unittest.main()
