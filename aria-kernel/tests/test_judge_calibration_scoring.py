"""Typed-judgment plan Phase 5 (ARIA-HIGH-167, ARIA-HIGH-173) — judge
confidence is scored, against ground truth the judge did not produce.

One property per test:

* a perfectly calibrated judge with 120 truth-backed votes is `calibrated`;
  the same judge with 40 is `provisional`; an overconfident judge (0.95 at
  60 % accuracy) past the floor is `uncalibrated` — the Wilson lower bound
  of its high-confidence accuracy is under 0.75;
* a constant-0.85 judge right 85 % of the time has an ECE near zero and no
  Brier skill: ECE alone confers nothing;
* an anchor consensus row is never ground truth for a judge that formed it
  (`n_anchor_self_excluded`), and IS for a judge that did not;
* `judge_weights_from_calibration` weighs an uncalibrated judge at the
  prior and keeps the posterior for a schema-1 row;
* the conformal floor's inputs are the consensus rows a human agreed with;
* the bootstrap is deterministic; `bins=0` is refused; `precision`,
  `recall` and `accuracy` of the existing pins are unchanged;
* `compute_judge_calibration` persists a schema-2 row with the thresholds.
"""
from __future__ import annotations

import json
import random
import tempfile
import unittest
from pathlib import Path

from aria_kernel.calibrated_intelligence import PRIOR_A, PRIOR_B, judge_weights_from_calibration
from aria_kernel.feedback_store import record_operator_feedback
from aria_kernel.judge_calibration import (
    bootstrap_ece_upper,
    brier_score,
    brier_skill_score,
    calibration_path,
    calibration_status,
    compute_judge_calibration,
    correct_consensus_confidences,
    expected_calibration_error,
    score_judges,
    wilson_lower,
)
from aria_kernel.tool_registry import ensure_tools_dir


def _pairs(rng: random.Random, n: int, *, confidence, accuracy_at) -> list[tuple[float, bool]]:
    out = []
    for _ in range(n):
        p = confidence(rng)
        out.append((p, rng.random() < accuracy_at(p)))
    return out


class TheStatisticsThemselves(unittest.TestCase):
    def test_brier_and_ece_of_a_perfect_and_a_constant_judge(self) -> None:
        perfect = [(1.0, True)] * 10 + [(0.0, False)] * 10
        self.assertEqual(brier_score(perfect), 0.0)
        self.assertEqual(expected_calibration_error(perfect)["ece"], 0.0)
        rng = random.Random(7)
        constant = [(0.85, rng.random() < 0.85) for _ in range(2000)]
        self.assertLess(expected_calibration_error(constant)["ece"], 0.03)
        skill = brier_skill_score(constant)
        self.assertIsNotNone(skill)
        self.assertLess(abs(skill), 0.05, "a constant forecast has no skill over the base rate")

    def test_the_bootstrap_is_seeded_and_the_bins_are_checked(self) -> None:
        rng = random.Random(3)
        pairs = _pairs(rng, 60, confidence=lambda r: 0.7 + 0.3 * r.random(), accuracy_at=lambda p: p)
        a = bootstrap_ece_upper(pairs, seed=11, resamples=200)
        b = bootstrap_ece_upper(pairs, seed=11, resamples=200)
        self.assertEqual(a, b)
        self.assertGreaterEqual(a, expected_calibration_error(pairs)["ece"] - 1e-9)
        with self.assertRaises(ValueError):
            expected_calibration_error(pairs, bins=0)
        self.assertIsNone(bootstrap_ece_upper([]))

    def test_wilson_lower_bound(self) -> None:
        self.assertIsNone(wilson_lower(0, 0))
        self.assertLess(wilson_lower(9, 10), 0.9)
        self.assertGreater(wilson_lower(90, 100), wilson_lower(9, 10))
        self.assertGreater(wilson_lower(85, 100), 0.75)
        self.assertLess(wilson_lower(6, 10), 0.75)

    def test_the_status_rule(self) -> None:
        common = dict(calibration_min_samples=100, provisional_min_samples=30, ece_threshold=0.10,
                      high_confidence_accuracy_min=0.75)
        self.assertEqual(calibration_status(samples_with_confidence=10, ece_upper=0.0, high_confidence_accuracy_lower=0.9,
                                            high_confidence_trials=5, **common), "insufficient_data")
        self.assertEqual(calibration_status(samples_with_confidence=50, ece_upper=0.0, high_confidence_accuracy_lower=0.9,
                                            high_confidence_trials=30, **common), "provisional")
        self.assertEqual(calibration_status(samples_with_confidence=120, ece_upper=0.05, high_confidence_accuracy_lower=0.8,
                                            high_confidence_trials=60, **common), "calibrated")
        self.assertEqual(calibration_status(samples_with_confidence=120, ece_upper=0.2, high_confidence_accuracy_lower=0.8,
                                            high_confidence_trials=60, **common), "uncalibrated")
        self.assertEqual(calibration_status(samples_with_confidence=120, ece_upper=0.05, high_confidence_accuracy_lower=0.6,
                                            high_confidence_trials=60, **common), "uncalibrated")
        self.assertEqual(calibration_status(samples_with_confidence=120, ece_upper=0.05, high_confidence_accuracy_lower=None,
                                            high_confidence_trials=0, **common), "uncalibrated")


class ScoringAgainstTheLedger(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.rng = random.Random(42)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _human(self, i: int, verdict: str) -> None:
        record_operator_feedback(tool_id="tool-x", run_id=f"r{i}", finding_id=f"f{i}", verdict=verdict, severity="medium",
                                 note="ground truth", source_type="human", judgment_group_id=f"g{i}", base_dir=self.tools)

    def _vote(self, i: int, judge_id: str, verdict: str, confidence: float, *, model: str = "opus") -> None:
        record_operator_feedback(tool_id="tool-x", run_id=f"r{i}", finding_id=f"f{i}", verdict=verdict, severity="medium",
                                 note="judge vote", source_type="ai_judge", judge_id=judge_id, model=model,
                                 confidence=confidence, confidence_source="self_reported",
                                 judgment_group_id=f"g{i}", base_dir=self.tools)

    def _seed_judge(self, judge_id: str, n: int, *, stated: float, true_accuracy: float, start: int = 0) -> None:
        for i in range(start, start + n):
            truth = "true_positive" if self.rng.random() < 0.6 else "false_positive"
            self._human(i, truth)
            right = self.rng.random() < true_accuracy
            verdict = truth if right else ("false_positive" if truth == "true_positive" else "true_positive")
            self._vote(i, judge_id, verdict, stated)

    def test_a_calibrated_judge_at_120_and_provisional_at_40(self) -> None:
        # Stated 0.85, right 85 % of the time: calibrated at n = 120.
        self._seed_judge("judge-cal", 120, stated=0.85, true_accuracy=0.85)
        result = score_judges(base_dir=self.tools)
        judge = {j["judge_id"]: j for j in result["judges"]}["judge-cal"]
        self.assertEqual(judge["calibration_status"], "calibrated", json.dumps(judge)[:600])
        self.assertEqual(judge["ground_truth_strata"], {"n_human": 120, "n_anchor_external": 0, "n_anchor_self_excluded": 0})
        self.assertLessEqual(judge["ece_upper_90"], 0.10)
        self.assertEqual(judge["by_source"][0]["confidence_source"], "self_reported")
        self.assertEqual(judge["by_source"][0]["samples"], 120)
        self.assertEqual(result["schema_version"], 2)
        thin = score_judges(base_dir=self.tools, calibration_min_samples=200)
        self.assertEqual({j["judge_id"]: j["calibration_status"] for j in thin["judges"]}["judge-cal"], "provisional")

    def test_an_overconfident_judge_is_uncalibrated(self) -> None:
        self._seed_judge("judge-loud", 120, stated=0.95, true_accuracy=0.60)
        judge = {j["judge_id"]: j for j in score_judges(base_dir=self.tools)["judges"]}["judge-loud"]
        self.assertEqual(judge["calibration_status"], "uncalibrated")
        self.assertLess(judge["high_confidence_accuracy_lower"], 0.75)
        self.assertGreater(judge["ece_top"], 0.2)

    def test_a_self_anchor_is_never_ground_truth_for_the_judges_that_formed_it(self) -> None:
        # An anchor-grade consensus (three observers, two models) on g1;
        # judge-a and judge-b formed it, judge-x did not.
        for judge_id, model in (("judge-a", "opus"), ("judge-b", "glm-5.3"), ("judge-c", "opus")):
            self._vote(1, judge_id, "true_positive", 0.9, model=model)
        self._vote(1, "judge-x", "true_positive", 0.9, model="fable")
        record_operator_feedback(
            tool_id="tool-x", run_id="r1", finding_id="f1", verdict="true_positive", severity="medium",
            note="anchor", source_type="ai_consensus", judge_id="aria-consensus-arbiter", model=None,
            confidence=0.9, judgment_group_id="g1", judge_count=3, judges_voted=3,
            observers=[{"judge_id": "judge-a", "model": "opus"}, {"judge_id": "judge-b", "model": "glm-5.3"},
                       {"judge_id": "judge-c", "model": "opus"}],
            base_dir=self.tools,
        )
        by_id = {j["judge_id"]: j for j in score_judges(base_dir=self.tools)["judges"]}
        self.assertEqual(by_id["judge-a"]["ground_truth_strata"], {"n_human": 0, "n_anchor_external": 0, "n_anchor_self_excluded": 1})
        self.assertEqual(by_id["judge-a"]["samples"], 0)
        self.assertEqual(by_id["judge-x"]["ground_truth_strata"], {"n_human": 0, "n_anchor_external": 1, "n_anchor_self_excluded": 0})
        self.assertEqual(by_id["judge-x"]["samples"], 1)

    def test_weights_keep_the_prior_for_an_uncalibrated_judge_and_the_posterior_for_a_schema_one_row(self) -> None:
        prior_mean = PRIOR_A / (PRIOR_A + PRIOR_B)
        v2 = {"schema_version": 2, "judges": [
            {"judge_id": "cal", "true_positive": 40, "false_positive": 2, "calibration_status": "calibrated"},
            {"judge_id": "loud", "true_positive": 40, "false_positive": 2, "calibration_status": "uncalibrated"},
            {"judge_id": "thin", "true_positive": 1, "false_positive": 0, "calibration_status": "insufficient_data"},
        ]}
        weights = judge_weights_from_calibration(v2)
        self.assertGreater(weights["cal"], prior_mean)
        self.assertEqual(weights["loud"], prior_mean)
        self.assertEqual(weights["thin"], prior_mean)
        v1 = {"schema_version": 1, "judges": [{"judge_id": "old", "true_positive": 40, "false_positive": 2}]}
        self.assertGreater(judge_weights_from_calibration(v1)["old"], prior_mean)

    def test_the_conformal_floor_reads_only_human_agreed_consensus(self) -> None:
        rows = [
            {"source_type": "ai_consensus", "run_id": "r1", "finding_id": "f1", "judgment_group_id": "g1",
             "verdict": "true_positive", "confidence": 0.9},
            {"source_type": "ai_consensus", "run_id": "r2", "finding_id": "f2", "judgment_group_id": "g2",
             "verdict": "true_positive", "confidence": 0.8},
            {"source_type": "ai_consensus", "run_id": "r3", "finding_id": "f3", "judgment_group_id": "g3",
             "verdict": "true_positive", "confidence": 0.7},
            {"source_type": "human", "run_id": "r1", "finding_id": "f1", "judgment_group_id": "g1", "verdict": "true_positive"},
            {"source_type": "human", "run_id": "r2", "finding_id": "f2", "judgment_group_id": "g2", "verdict": "false_positive"},
        ]
        self.assertEqual(correct_consensus_confidences(rows), [0.9])

    def test_the_existing_precision_recall_accuracy_pins_are_unchanged_and_the_row_persists(self) -> None:
        for i in range(12):
            truth = "true_positive" if i < 8 else "false_positive"
            self._human(i, truth)
            self._vote(i, "judge-good", truth, 0.9 if truth == "true_positive" else 0.4)
            self._vote(i, "judge-bad", "true_positive", 0.95)
        result = compute_judge_calibration(cycle_id="c1", base_dir=self.tools)
        by_id = {j["judge_id"]: j for j in result["judges"]}
        self.assertEqual((by_id["judge-good"]["precision"], by_id["judge-good"]["recall"], by_id["judge-good"]["accuracy"]),
                         (1.0, 1.0, 1.0))
        self.assertEqual((by_id["judge-bad"]["precision"], by_id["judge-bad"]["recall"]), (round(8 / 12, 3), 1.0))
        self.assertEqual(by_id["judge-bad"]["status"], "degraded")
        self.assertEqual(by_id["judge-good"]["calibration_status"], "insufficient_data")
        stored = [json.loads(line) for line in calibration_path(self.tools).read_text().splitlines() if line.strip()]
        self.assertEqual(stored[-1]["schema_version"], 2)
        self.assertEqual(stored[-1]["calibration_thresholds"]["calibration_min_samples"], 100)


if __name__ == "__main__":
    unittest.main()
