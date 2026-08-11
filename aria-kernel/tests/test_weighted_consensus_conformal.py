"""Kalibre Zekâ Z2a/Z2c — weighted vote + conformal abstention."""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from aria_kernel.calibrated_intelligence import (
    conformal_threshold,
    judge_weights_from_calibration,
)
from aria_kernel.feedback_store import generate_ai_consensus, record_operator_feedback
from aria_kernel.human_required import CONSENSUS_UNCERTAINTY_SEVERITY
from aria_kernel.tool_registry import ensure_tools_dir


def _seed(root, pairs):
    for judge, verdict, conf in pairs:
        record_operator_feedback(
            tool_id="t", run_id="r", finding_id="f",
            verdict=verdict, severity="medium", note="x",
            source_type="ai_judge", judge_id=judge, confidence=conf,
            judgment_group_id="judge:t:r:f", base_dir=root,
        )


class WeightedVoteTest(unittest.TestCase):
    def test_none_weights_keep_the_legacy_gate_bit_for_bit(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"; ensure_tools_dir(root)
            _seed(root, [("j1", "true_positive", 0.9), ("j2", "false_positive", 0.9)])
            result = generate_ai_consensus(tool_id="t", base_dir=root)
        self.assertEqual([u["reason"] for u in result["uncertainties"]], ["judge_disagreement"])

    def test_two_equal_judges_still_degenerate_to_unanimity(self) -> None:
        # The legacy guarantee survives: 0.5 share <= 0.5+margin.
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"; ensure_tools_dir(root)
            _seed(root, [("j1", "true_positive", 0.9), ("j2", "false_positive", 0.9)])
            result = generate_ai_consensus(
                tool_id="t", base_dir=root,
                judge_weights={"j1": 0.8, "j2": 0.8},
            )
        self.assertEqual([u["reason"] for u in result["uncertainties"]], ["judge_disagreement"])

    def test_a_separated_posterior_lets_the_stronger_bench_carry(self) -> None:
        # Three judges, one weak dissenter: 0.9+0.9 vs 0.2 -> winner share
        # 0.9 > 0.6 -> consensus published on the majority verdict.
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"; ensure_tools_dir(root)
            _seed(root, [
                ("j1", "true_positive", 0.9),
                ("j2", "true_positive", 0.92),
                ("j3", "false_positive", 0.85),
            ])
            result = generate_ai_consensus(
                tool_id="t", base_dir=root,
                judge_weights={"j1": 0.9, "j2": 0.9, "j3": 0.2},
            )
        self.assertEqual(result["consensus_count"], 1)
        self.assertEqual(result["consensus"][0]["verdict"], "true_positive")


class ConformalTest(unittest.TestCase):
    def test_below_the_floor_abstains_by_name(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"; ensure_tools_dir(root)
            _seed(root, [("j1", "true_positive", 0.82), ("j2", "true_positive", 0.84)])
            result = generate_ai_consensus(
                tool_id="t", base_dir=root, conformal_floor=0.9,
            )
        self.assertEqual([u["reason"] for u in result["uncertainties"]], ["conformal_abstain"])
        self.assertIn("conformal_abstain", CONSENSUS_UNCERTAINTY_SEVERITY)

    def test_short_window_yields_no_floor(self) -> None:
        self.assertIsNone(conformal_threshold([0.9] * 7))

    def test_weights_from_calibration_use_the_beta_prior(self) -> None:
        w = judge_weights_from_calibration(
            {"judges": [{"judge_id": "j1", "true_positive": 6, "false_positive": 2}]}
        )
        self.assertAlmostEqual(w["j1"], 10 / 13)


if __name__ == "__main__":
    unittest.main()
