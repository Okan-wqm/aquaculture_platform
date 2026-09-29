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

from aria_kernel.calibrated_intelligence import (
    beta_posterior,
    judge_weights_from_calibration,
)
from aria_kernel.feedback_store import record_operator_feedback
from aria_kernel.judge_calibration import calibration_path, compute_judge_calibration
from aria_kernel.tool_registry import ensure_tools_dir

TP = "true_positive"
FP = "false_positive"


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

    def test_the_pair_axis_leaves_the_per_judge_numbers_alone(self) -> None:
        """G-2 regression pin — measuring pairs must not move precision.

        The pair axis rides on the SAME row and the SAME grouping pass, so the
        cheapest way for it to do damage is to quietly change what
        ``judges[]`` reports. These are the exact numbers the pre-G-2 module
        produced on this fixture.
        """
        self._seed()
        result = compute_judge_calibration(base_dir=self.tools)
        by_id = {j["judge_id"]: j for j in result["judges"]}

        self.assertEqual(by_id["judge-good"]["precision"], 1.0)
        self.assertEqual(by_id["judge-good"]["recall"], 1.0)
        self.assertEqual(by_id["judge-good"]["samples"], 12)
        self.assertEqual(by_id["judge-good"]["status"], "ok")
        self.assertEqual(by_id["judge-bad"]["precision"], 0.667)
        self.assertEqual(by_id["judge-bad"]["status"], "degraded")
        self.assertEqual(by_id["judge-thin"]["status"], "insufficient_data")

        pairs = {(p["judge_a"], p["judge_b"]): p for p in result["judge_pairs"]}
        # judge-bad answers "true_positive" to everything, so it AGREES with
        # judge-good two thirds of the time — and carries no information doing
        # it. Chance correction is what tells those apart: kappa 0.
        agreeing = pairs[("judge-bad", "judge-good")]
        self.assertEqual(agreeing["observed_agreement"], 0.667)
        self.assertEqual(agreeing["kappa"], 0.0)
        self.assertEqual(agreeing["status"], "independent")
        # judge-thin shares 3 questions: too few to claim anything about it.
        thin = pairs[("judge-good", "judge-thin")]
        self.assertEqual(thin["co_observations"], 3)
        self.assertIsNone(thin["kappa"])
        self.assertEqual(thin["status"], "insufficient_data")


class JudgePairIndependenceTests(unittest.TestCase):
    """G-2 — independence measured per PAIR, and what the measurement buys.

    ``verify_independence`` (convergence_drainer) asks whether two judges are
    two AGENTS; nothing asked whether they are two OBSERVERS. Both fleets
    below are structurally impeccable — three distinct judge ids, three
    verdicts per question. They differ only in whether two of the three are
    the same observer twice, and that difference decides whether their
    unanimous consensus is allowed to be the ground truth they are scored
    against.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # 8 true_positive then 4 false_positive: varied marginals, so agreement
    # cannot be explained by one verdict dominating the ledger.
    BASE = [TP] * 8 + [FP] * 4

    @staticmethod
    def _flip(verdicts: list[str], indexes: list[int]) -> list[str]:
        flipped = list(verdicts)
        for index in indexes:
            flipped[index] = FP if flipped[index] == TP else TP
        return flipped

    def _fleet(self, plan: dict[str, list[str]]) -> None:
        """Write each judge's verdicts, plus an ANCHOR on every unanimous group.

        The anchor rows are exactly what ``generate_ai_consensus`` writes when
        three judges agree and none dissents (judge_count == judges_voted ==
        3) — the row JJ-1 promotes to ground truth.
        """
        for index in range(12):
            for judge_id, verdicts in plan.items():
                record_operator_feedback(
                    tool_id="tool-x", run_id=f"r{index}", finding_id=f"f{index}",
                    verdict=verdicts[index], severity="medium", note="judge vote",
                    source_type="ai_judge", judge_id=judge_id, confidence=0.9,
                    judgment_group_id=f"g{index}", base_dir=self.tools,
                )
            settled = {verdicts[index] for verdicts in plan.values()}
            if len(settled) != 1:
                continue
            record_operator_feedback(
                tool_id="tool-x", run_id=f"r{index}", finding_id=f"f{index}",
                verdict=next(iter(settled)), severity="medium",
                note="AI consensus from 3 independent judges",
                source_type="ai_consensus", judge_id="consensus", confidence=0.9,
                judgment_group_id=f"g{index}", judge_count=3, judges_voted=3,
                base_dir=self.tools,
            )

    def test_kappa_above_the_ceiling_invalidates_the_anchor(self) -> None:
        # judge-a and judge-b never differ; judge-c differs on three findings.
        self._fleet({
            "judge-a": list(self.BASE),
            "judge-b": list(self.BASE),
            "judge-c": self._flip(self.BASE, [2, 3, 9]),
        })
        result = compute_judge_calibration(base_dir=self.tools, min_samples=1)
        pairs = {(p["judge_a"], p["judge_b"]): p for p in result["judge_pairs"]}

        twins = pairs[("judge-a", "judge-b")]
        self.assertEqual(twins["co_observations"], 12)
        self.assertEqual(twins["observed_agreement"], 1.0)
        self.assertEqual(twins["expected_agreement"], 0.556)
        self.assertEqual(twins["kappa"], 1.0)
        self.assertEqual(twins["status"], "correlated")
        self.assertEqual(result["correlated_pair_count"], 1)
        self.assertEqual(pairs[("judge-a", "judge-c")]["status"], "independent")

        # Nine unanimous findings produced nine anchors, and every one of them
        # rested on a 3-judge badge worn by 2 observers. None survives as
        # truth, so the fleet ends up scoring itself against nothing at all —
        # which is the honest answer, and the one that makes a human label
        # (unconditional ground truth, JJ-2) the way out.
        self.assertEqual(result["anchors_invalidated_by_correlation"], 9)
        self.assertEqual(result["judges"], [])
        self.assertEqual(result["judged_judges"], 0)

    def test_an_independent_bench_keeps_its_anchors(self) -> None:
        # Same shape, same anchor rows, no pair above the ceiling.
        self._fleet({
            "judge-a": list(self.BASE),
            "judge-b": self._flip(self.BASE, [0, 1, 8]),
            "judge-c": self._flip(self.BASE, [2, 3, 9]),
        })
        result = compute_judge_calibration(base_dir=self.tools, min_samples=1)

        self.assertEqual(
            [p["status"] for p in result["judge_pairs"]],
            ["independent", "independent", "independent"],
        )
        self.assertEqual(result["correlated_pair_count"], 0)
        self.assertEqual(result["anchors_invalidated_by_correlation"], 0)
        # Six findings were unanimous; all six anchors stand as ground truth.
        self.assertEqual(
            {j["judge_id"]: j["samples"] for j in result["judges"]},
            {"judge-a": 6, "judge-b": 6, "judge-c": 6},
        )

    def test_a_correlated_pair_cannot_carry_two_independent_votes(self) -> None:
        """The row this module writes is the row the weight consumer reads."""
        # Human ground truth, so the anchor rule is out of the picture and the
        # only thing under test is what correlation does to the vote weights.
        for index in range(12):
            truth = TP if index < 8 else FP
            record_operator_feedback(
                tool_id="tool-x", run_id=f"r{index}", finding_id=f"f{index}",
                verdict=truth, severity="medium", note="ground truth",
                source_type="human", judgment_group_id=f"g{index}",
                base_dir=self.tools,
            )
            for judge_id in ("twin-a", "twin-b"):
                record_operator_feedback(
                    tool_id="tool-x", run_id=f"r{index}", finding_id=f"f{index}",
                    verdict=TP, severity="medium", note="judge vote",
                    source_type="ai_judge", judge_id=judge_id, confidence=0.9,
                    judgment_group_id=f"g{index}", base_dir=self.tools,
                )
            record_operator_feedback(
                tool_id="tool-x", run_id=f"r{index}", finding_id=f"f{index}",
                verdict=truth if index % 3 else FP, severity="medium",
                note="judge vote", source_type="ai_judge", judge_id="solo",
                confidence=0.9, judgment_group_id=f"g{index}",
                base_dir=self.tools,
            )
        result = compute_judge_calibration(base_dir=self.tools, min_samples=1)
        weights = judge_weights_from_calibration(result)

        by_id = {j["judge_id"]: j for j in result["judges"]}
        undiscounted = beta_posterior(
            by_id["twin-a"]["true_positive"], by_id["twin-a"]["false_positive"],
        )["mean"]
        # Two votes' worth of weight, before the pair axis existed.
        self.assertLess(weights["twin-a"] + weights["twin-b"], 2 * undiscounted)
        # After it: one vote, split between them.
        self.assertAlmostEqual(weights["twin-a"] + weights["twin-b"], undiscounted)
        # The judge nobody duplicates is untouched — the discount is paid by
        # redundancy, not levied on the fleet.
        self.assertAlmostEqual(
            weights["solo"],
            beta_posterior(
                by_id["solo"]["true_positive"], by_id["solo"]["false_positive"],
            )["mean"],
        )


if __name__ == "__main__":
    unittest.main()
