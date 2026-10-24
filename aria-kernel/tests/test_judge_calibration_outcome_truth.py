"""WP-J D-1 — outcome truth SCORES judges; ground truth stays untouched.

JJ-1's one-predicate law (``is_ground_truth_row``) keeps every authority
reader byte-identical — suppression, goldset admission, promotion
readiness. This suite pins the AMENDMENT, on the record: judge scoring
widens to a sibling predicate ``is_calibration_truth_row`` that also
admits ``outcome`` rows, so a judge is finally scored against something
the judge fleet did not produce.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.calibrated_intelligence import conformal_threshold
from aria_kernel.feedback_store import (
    is_ground_truth_row,
    load_feedback,
    record_operator_feedback,
)
from aria_kernel.judge_calibration import (
    correct_consensus_confidences,
    is_calibration_truth_row,
    score_judges,
)
from aria_kernel.outcome_truth import OUTCOME_SOURCE_TYPE, OUTCOME_TRUTH_JUDGE_ID
from aria_kernel.tool_registry import ensure_tools_dir


class OutcomeScoringBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _row(self, *, source_type: str, verdict: str, group: str = "g1", run: str = "r1",
             finding: str = "f1", judge_id: str | None = None, confidence: float | None = None,
             judge_count: int | None = None, judges_voted: int | None = None,
             observers: list[dict] | None = None) -> None:
        record_operator_feedback(
            tool_id="tool-x", run_id=run, finding_id=finding, verdict=verdict,
            severity="medium", note="n", source_type=source_type, judge_id=judge_id,
            judgment_group_id=group, confidence=confidence,
            judge_count=judge_count, judges_voted=judges_voted, observers=observers,
            base_dir=self.tools,
        )

    def _outcome_truth(self, verdict: str = "true_positive", group: str = "g1",
                       run: str = "r1", finding: str = "f1") -> None:
        self._row(
            source_type=OUTCOME_SOURCE_TYPE, verdict=verdict, group=group,
            run=run, finding=finding, judge_id=OUTCOME_TRUTH_JUDGE_ID,
        )


class PredicateTests(OutcomeScoringBase):
    def test_outcome_row_is_calibration_truth_but_never_ground_truth(self) -> None:
        self._outcome_truth()
        row = next(
            r for r in load_feedback(base_dir=self.tools)
            if r.get("source_type") == OUTCOME_SOURCE_TYPE
        )
        self.assertTrue(is_calibration_truth_row(row))
        # The authority leg is untouched: an outcome row never suppresses a
        # finding, never enters a goldset, never marks a tool promotion-ready.
        self.assertFalse(is_ground_truth_row(row))

    def test_calibration_truth_still_refuses_ai_judge_rows(self) -> None:
        self._row(source_type="ai_judge", verdict="true_positive", judge_id="j1")
        row = load_feedback(base_dir=self.tools)[0]
        self.assertFalse(is_calibration_truth_row(row))
        self.assertFalse(is_ground_truth_row(row))


class ScoringTests(OutcomeScoringBase):
    def test_outcome_row_scores_its_judges(self) -> None:
        self._outcome_truth()
        self._row(
            source_type="ai_judge", verdict="true_positive", judge_id="j-evidence",
            confidence=0.9,
        )
        result = score_judges(base_dir=self.tools, min_samples=1)
        self.assertEqual(len(result["judges"]), 1, "the judge must be scored at all")
        judge = result["judges"][0]
        self.assertEqual(judge["judge_id"], "j-evidence")
        self.assertEqual(judge["samples"], 1)
        self.assertEqual(judge["accuracy"], 1.0)
        self.assertEqual(judge["ground_truth_strata"]["n_outcome"], 1)

    def test_outcome_truth_outranks_consensus_truth(self) -> None:
        # An anchor consensus settled false_positive; the mechanical outcome
        # proved the defect real. Scoring follows the OUTCOME.
        self._row(
            source_type="ai_consensus", verdict="false_positive",
            judge_id="aria-consensus-arbiter", judge_count=3, judges_voted=3,
            observers=[
                {"judge_id": "j-evidence", "model": "m1"},
                {"judge_id": "j-adversarial", "model": "m2"},
                {"judge_id": "aria-consensus-arbiter", "model": "m3"},
            ],
        )
        self._outcome_truth()
        self._row(
            source_type="ai_judge", verdict="true_positive", judge_id="j-evidence",
            confidence=0.9,
        )
        result = score_judges(base_dir=self.tools, min_samples=1)
        judge = {j["judge_id"]: j for j in result["judges"]}["j-evidence"]
        self.assertEqual(judge["accuracy"], 1.0)
        self.assertEqual(judge["ground_truth_strata"]["n_outcome"], 1)

    def test_human_truth_still_outranks_outcome(self) -> None:
        self._outcome_truth(verdict="true_positive")
        self._row(source_type="human", verdict="false_positive")
        self._row(
            source_type="ai_judge", verdict="false_positive", judge_id="j-evidence",
            confidence=0.9,
        )
        result = score_judges(base_dir=self.tools, min_samples=1)
        judge = {j["judge_id"]: j for j in result["judges"]}["j-evidence"]
        self.assertEqual(judge["accuracy"], 1.0)
        self.assertEqual(judge["ground_truth_strata"]["n_human"], 1)


class ConformalWindowTests(OutcomeScoringBase):
    def test_outcome_agreement_widens_the_conformal_window(self) -> None:
        for i in range(8):
            group = f"g{i}"
            self._row(
                source_type="ai_consensus", verdict="true_positive", group=group,
                run=f"r{i}", finding=f"f{i}", judge_id="aria-consensus-arbiter",
                judge_count=3, judges_voted=3, confidence=0.9,
                observers=[
                    {"judge_id": "a", "model": "m1"},
                    {"judge_id": "b", "model": "m2"},
                    {"judge_id": "c", "model": "m3"},
                ],
            )
            self._outcome_truth(group=group, run=f"r{i}", finding=f"f{i}")
        rows = load_feedback(base_dir=self.tools)
        confidences = correct_consensus_confidences(rows)
        self.assertEqual(len(confidences), 8)
        self.assertIsNotNone(conformal_threshold(confidences))


class OrganicExclusionTests(OutcomeScoringBase):
    def test_replay_group_rows_stay_out_of_organic_scoring(self) -> None:
        self._row(source_type="human", verdict="true_positive", group="organic:g")
        self._row(
            source_type="ai_judge", verdict="true_positive", judge_id="j-evidence",
            group="organic:g", confidence=0.9,
        )
        self._row(source_type="human", verdict="true_positive", group="replay:tool-x:r:f")
        self._row(
            source_type="ai_judge", verdict="true_positive", judge_id="j-replay",
            group="replay:tool-x:r:f", confidence=0.9,
        )
        result = score_judges(base_dir=self.tools, min_samples=1)
        by_id = {j["judge_id"]: j for j in result["judges"]}
        self.assertEqual(by_id["j-evidence"]["samples"], 1)
        self.assertNotIn("j-replay", by_id)


if __name__ == "__main__":
    unittest.main()
