"""Plan 025 §C — gold-set replay recall.

Replaying judges on the promoted gold corpus seeds each gold verdict as a
replay-group ground-truth anchor and mints two judge envelopes per item. Once
the judges respond, true recall (does a judge correctly re-call a known TP)
falls out of compute_judge_calibration scoped to the replay groups.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import record_operator_feedback
from aria_kernel.goldset import promote_goldset_proposal
from aria_kernel.judge_replay import (
    REPLAY_GROUP_PREFIX,
    compute_replay_recall,
    replay_judges_on_goldset,
)
from aria_kernel.tool_registry import ensure_tools_dir, utc_now


def _gi(run: str, finding: str, verdict: str) -> dict:
    return {
        "run_id": run, "finding_id": finding, "finding_fingerprint": f"fp:{finding}",
        "verdict": verdict, "severity": "medium", "source_type": "human",
        "confidence": 0.9, "evidence_refs": [f"src/{finding}.py:1"], "rationale": "gt",
    }


class JudgeReplayTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.tp = [_gi("rtp0", "ftp0", "true_positive"), _gi("rtp1", "ftp1", "true_positive")]
        self.fp = [_gi("rfp0", "ffp0", "false_positive")]
        proposal = {
            "status": "ready", "recorded_at": utc_now(), "tool_id": "tool-x",
            "true_positive_count": 2, "known_false_positive_count": 1,
            "true_positive_items": self.tp, "known_false_positive_items": self.fp,
        }
        promote_goldset_proposal(tool_id="tool-x", curator="okan", base_dir=self.tools, proposal=proposal)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _judge_vote(self, run: str, finding: str, judge_id: str, verdict: str) -> None:
        record_operator_feedback(
            tool_id="tool-x", run_id=run, finding_id=finding, verdict=verdict,
            severity="medium", note="replay vote", source_type="ai_judge", judge_id=judge_id,
            confidence=0.9, judgment_group_id=f"{REPLAY_GROUP_PREFIX}tool-x:{run}:{finding}",
            base_dir=self.tools,
        )

    def test_replay_seeds_ground_truth_and_mints_envelopes(self) -> None:
        result = replay_judges_on_goldset(tool_id="tool-x", base_dir=self.tools)
        self.assertEqual(result["replayed_items"], 3)
        self.assertEqual(len(result["minted"]), 6)  # 3 items x 2 judges

    def test_replay_recall_reflects_judge_accuracy(self) -> None:
        replay_judges_on_goldset(tool_id="tool-x", base_dir=self.tools)
        # judge-good calls each gold item correctly; judge-miss always says
        # false_positive (so it misses both true positives).
        for run, finding, gold in (("rtp0", "ftp0", "true_positive"),
                                   ("rtp1", "ftp1", "true_positive"),
                                   ("rfp0", "ffp0", "false_positive")):
            self._judge_vote(run, finding, "judge-good", gold)
            self._judge_vote(run, finding, "judge-miss", "false_positive")

        recall = compute_replay_recall(base_dir=self.tools)
        by_id = {j["judge_id"]: j for j in recall["judges"]}
        self.assertEqual(by_id["judge-good"]["recall"], 1.0)   # caught both TPs
        self.assertEqual(by_id["judge-miss"]["recall"], 0.0)   # missed both TPs

    def test_replay_does_not_corrupt_organic_calibration(self) -> None:
        from aria_kernel.judge_calibration import compute_judge_calibration
        # judge-x votes correctly ORGANICALLY on one finding (group "judge:..").
        record_operator_feedback(
            tool_id="tool-x", run_id="org1", finding_id="of1", verdict="true_positive",
            severity="medium", note="gt", source_type="human",
            judgment_group_id="judge:tool-x:org1:of1", base_dir=self.tools,
        )
        record_operator_feedback(
            tool_id="tool-x", run_id="org1", finding_id="of1", verdict="true_positive",
            severity="medium", note="vote", source_type="ai_judge", judge_id="judge-x",
            confidence=0.9, judgment_group_id="judge:tool-x:org1:of1", base_dir=self.tools,
        )
        # ...and MISSES every gold item in replay.
        replay_judges_on_goldset(tool_id="tool-x", base_dir=self.tools)
        for run, finding in (("rtp0", "ftp0"), ("rtp1", "ftp1"), ("rfp0", "ffp0")):
            self._judge_vote(run, finding, "judge-x", "false_positive")
        organic = {j["judge_id"]: j for j in
                   compute_judge_calibration(base_dir=self.tools, min_samples=1)["judges"]}
        # Organic recall must reflect ONLY the organic verdict (1.0), not the replay misses.
        self.assertEqual(organic["judge-x"]["recall"], 1.0)
        self.assertEqual(organic["judge-x"]["samples"], 1)

    def test_replay_seed_is_idempotent_across_reruns(self) -> None:
        from aria_kernel.feedback_store import load_feedback
        replay_judges_on_goldset(tool_id="tool-x", base_dir=self.tools)
        replay_judges_on_goldset(tool_id="tool-x", base_dir=self.tools)
        seeds = [r for r in load_feedback(base_dir=self.tools)
                 if r.get("judge_id") == "goldset-replay"]
        self.assertEqual(len(seeds), 3)  # one per gold item, not doubled

    def test_no_active_goldset_is_noop(self) -> None:
        result = replay_judges_on_goldset(tool_id="other-tool", base_dir=self.tools)
        self.assertEqual(result["status"], "no_active_goldset")


if __name__ == "__main__":
    unittest.main()
