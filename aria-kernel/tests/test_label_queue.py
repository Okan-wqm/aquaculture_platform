"""Typed-judgment plan Phase 6 (ARIA-HIGH-165, ARIA-HIGH-169) — the label
queue and the labels it lets a human record.

One property per test:

* the queue writes its own `calibration_stratified` sample from the judge
  groups: escalated, auto-closed (a consensus exists) and pending
  (single-judge) strata, deterministically, never a finding a human already
  labelled; the verdict file is unfilled and unconfirmed;
* an unchanged verdict file mints nothing (null verdict refused; an
  unconfirmed item refused); a completed one records human rows on the
  exact `judgment_group_id` the judges voted on, with the queue and stratum
  as provenance, and the sample is persisted as recorded — twice is refused;
* a recorded label joins the judge's calibration; an escalated label is
  reported but does not decide `calibrated`;
* a row without an explicit `source_type` is not human ground truth, and a
  human row whose signature does not verify is not either — both are
  counted as unverified;
* the kernel CLI verb writes the file the batch lane reads.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import (
    CALIBRATION_STRATIFIED_STRATEGY,
    JUDGMENT_STRATEGIES,
    load_feedback,
    load_jsonl,
    judgment_samples_path,
    record_consensus_uncertainty,
    record_operator_feedback,
    record_operator_feedback_batch,
)
from aria_kernel.judge_calibration import score_judges
from aria_kernel.label_queue import LABEL_QUEUE_STRATA, build_label_queue
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_KERNEL_DIR = Path(__file__).resolve().parents[1]


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _vote(self, i: int, judge_id: str, verdict: str, confidence: float, *, model: str = "opus") -> None:
        record_operator_feedback(tool_id="tool-x", run_id=f"r{i}", finding_id=f"f{i}", verdict=verdict, severity="medium",
                                 note="judge vote", source_type="ai_judge", judge_id=judge_id, model=model,
                                 confidence=confidence, judgment_group_id=f"judge:tool-x:fp{i}",
                                 finding_fingerprint=f"fp{i}", evidence_refs=[f"src/f{i}.py:1"], base_dir=self.tools)

    def _consensus(self, i: int, verdict: str) -> None:
        record_operator_feedback(tool_id="tool-x", run_id=f"r{i}", finding_id=f"f{i}", verdict=verdict, severity="medium",
                                 note="consensus", source_type="ai_consensus", judge_id="aria-consensus-arbiter",
                                 confidence=0.9, judgment_group_id=f"judge:tool-x:fp{i}", judge_count=2, judges_voted=2,
                                 base_dir=self.tools)

    def _seed_groups(self) -> None:
        # 0..3 escalated (two judges disagree), 4..7 auto-closed, 8..11 pending (one judge)
        for i in range(4):
            self._vote(i, "judge-a", "true_positive", 0.9)
            self._vote(i, "judge-b", "false_positive", 0.9, model="glm")
            record_consensus_uncertainty(tool_id="tool-x", run_id=f"r{i}", finding_id=f"f{i}",
                                         group_id=f"judge:tool-x:fp{i}", reason="judge_disagreement", base_dir=self.tools)
        for i in range(4, 8):
            self._vote(i, "judge-a", "true_positive", 0.9)
            self._vote(i, "judge-b", "true_positive", 0.85, model="glm")
            self._consensus(i, "true_positive")
        for i in range(8, 12):
            self._vote(i, "judge-a", "true_positive", 0.8)


class TheQueueWritesItsOwnSample(_Store):
    def test_three_strata_from_the_judge_groups(self) -> None:
        self._seed_groups()
        # A finding a human already labelled is not asked again.
        record_operator_feedback(tool_id="tool-x", run_id="r8", finding_id="f8", verdict="true_positive", severity="medium",
                                 note="already", source_type="human", judgment_group_id="judge:tool-x:fp8", base_dir=self.tools)
        queue = build_label_queue(tool_id="tool-x", base_dir=self.tools, limit=9, cycle_id="c1")
        sample = queue["sample"]
        self.assertEqual(sample["strategy"], CALIBRATION_STRATIFIED_STRATEGY)
        self.assertIn(CALIBRATION_STRATIFIED_STRATEGY, JUDGMENT_STRATEGIES)
        self.assertEqual(sample["strata_available"], {"escalated": 4, "auto_closed_random": 4, "pending_random": 3})
        strata = [item["stratum"] for item in sample["items"]]
        self.assertEqual(len(strata), 9)
        for stratum in LABEL_QUEUE_STRATA:
            self.assertEqual(strata.count(stratum), 3, stratum)
        self.assertNotIn("r8", {item["run_id"] for item in sample["items"]})
        item = sample["items"][0]
        self.assertTrue(item["judgment_group_id"].startswith("judge:tool-x:fp"))
        self.assertTrue(item["judge_verdicts"])
        file_rows = queue["verdict_file"]["verdicts"]
        self.assertEqual({row["verdict"] for row in file_rows}, {None})
        self.assertEqual({row["confirmed_by_operator"] for row in file_rows}, {False})
        stored = [row for row in load_jsonl(judgment_samples_path(self.tools)) if row["sample_id"] == sample["sample_id"]]
        self.assertEqual(len(stored), 1)
        again = build_label_queue(tool_id="tool-x", base_dir=self.tools, limit=9, cycle_id="c1")
        self.assertEqual([i["run_id"] for i in again["sample"]["items"]], [i["run_id"] for i in sample["items"]],
                         "the draw is seeded")


class TheBatchLaneUnderTheQueue(_Store):
    def _queue(self) -> dict:
        self._seed_groups()
        return build_label_queue(tool_id="tool-x", base_dir=self.tools, limit=3, cycle_id="c1")

    def test_an_unchanged_file_mints_nothing(self) -> None:
        queue = self._queue()
        with self.assertRaisesRegex(GovernanceError, "not decided"):
            record_operator_feedback_batch(sample_id=queue["sample"]["sample_id"], verdict_payload=queue["verdict_file"],
                                           base_dir=self.tools)
        self.assertEqual([r for r in load_feedback(base_dir=self.tools) if r.get("source_type") == "human"], [])
        filled = json.loads(json.dumps(queue["verdict_file"]))
        for row in filled["verdicts"]:
            row["verdict"] = "true_positive"
        with self.assertRaisesRegex(GovernanceError, "not confirmed"):
            record_operator_feedback_batch(sample_id=queue["sample"]["sample_id"], verdict_payload=filled, base_dir=self.tools)

    def test_a_completed_file_lands_on_the_judges_group_with_provenance_and_persists_the_sample(self) -> None:
        queue = self._queue()
        filled = json.loads(json.dumps(queue["verdict_file"]))
        for row in filled["verdicts"]:
            row["verdict"] = "true_positive"
            row["confirmed_by_operator"] = True
        result = record_operator_feedback_batch(sample_id=queue["sample"]["sample_id"], verdict_payload=filled,
                                                base_dir=self.tools)
        self.assertEqual(result["recorded_count"], 3)
        humans = [r for r in load_feedback(base_dir=self.tools) if r.get("source_type") == "human"]
        self.assertEqual(len(humans), 3)
        for row in humans:
            self.assertTrue(row["judgment_group_id"].startswith("judge:tool-x:fp"), row["judgment_group_id"])
            self.assertEqual(row["label_provenance"]["queue_id"], queue["sample"]["sample_id"])
            self.assertIn(row["label_provenance"]["stratum"], LABEL_QUEUE_STRATA)
        samples = [row for row in load_jsonl(judgment_samples_path(self.tools)) if row["sample_id"] == queue["sample"]["sample_id"]]
        self.assertEqual([row["status"] for row in samples], ["pending", "recorded"])
        with self.assertRaisesRegex(GovernanceError, "already recorded"):
            record_operator_feedback_batch(sample_id=queue["sample"]["sample_id"], verdict_payload=filled, base_dir=self.tools)

    def test_a_recorded_label_joins_the_calibration_and_an_escalated_one_does_not_decide(self) -> None:
        queue = self._queue()
        filled = json.loads(json.dumps(queue["verdict_file"]))
        for row in filled["verdicts"]:
            row["verdict"] = "true_positive"
            row["confirmed_by_operator"] = True
        record_operator_feedback_batch(sample_id=queue["sample"]["sample_id"], verdict_payload=filled, base_dir=self.tools)
        judge = {j["judge_id"]: j for j in score_judges(base_dir=self.tools)["judges"]}["judge-a"]
        strata = judge["ground_truth_strata"]
        self.assertEqual(strata["n_human"] + strata["n_human_escalated"], 3)
        self.assertEqual(strata["n_human_escalated"], 1)
        self.assertEqual(judge["samples_with_confidence_all_strata"], 3)
        self.assertEqual(judge["samples_with_confidence"], 2, "the escalated label is reported, never decided on")


class HumanTruthIsVerified(_Store):
    def test_a_row_without_source_type_and_an_unsigned_row_are_not_ground_truth(self) -> None:
        self._vote(1, "judge-a", "true_positive", 0.9)
        # A row appended without the kernel's signature (and, worse, without
        # a source_type: the old default read it as human).
        path = self.tools / "operator-feedback.jsonl"
        forged = {"schema_version": 2, "recorded_at": "2026-09-19T00:00:00+00:00", "tool_id": "tool-x", "run_id": "r1",
                  "finding_id": "f1", "verdict": "true_positive", "severity": "medium", "note": "forged",
                  "judgment_group_id": "judge:tool-x:fp1"}
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(forged) + "\n")
        result = score_judges(base_dir=self.tools)
        by_id = {j["judge_id"]: j for j in result["judges"]}
        self.assertNotIn("judge-a", by_id, "no verified truth: the judge has no scored sample")
        self.assertEqual(result["unverified_ground_truth_rows"], 1)
        # A signed, explicit human row does count.
        record_operator_feedback(tool_id="tool-x", run_id="r1", finding_id="f1", verdict="true_positive", severity="medium",
                                 note="signed", source_type="human", judgment_group_id="judge:tool-x:fp1", base_dir=self.tools)
        by_id = {j["judge_id"]: j for j in score_judges(base_dir=self.tools)["judges"]}
        self.assertEqual(by_id["judge-a"]["ground_truth_strata"]["n_human"], 1)


class TheCliVerb(_Store):
    def test_label_queue_writes_the_file_the_batch_lane_reads(self) -> None:
        self._seed_groups()
        out = Path(self._tmp.name) / "verdicts.json"
        completed = subprocess.run(
            [sys.executable, "-m", "aria_kernel.cli", "--tools-dir", str(self.tools), "feedback", "label-queue",
             "--tool-id", "tool-x", "--limit", "3", "--out", str(out)],
            cwd=_KERNEL_DIR, capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr[-1500:])
        summary = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertEqual(summary["sampled_count"], 3)
        file_rows = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(file_rows["sample_id"], summary["sample_id"])
        self.assertEqual(len(file_rows["verdicts"]), 3)


if __name__ == "__main__":
    unittest.main()
