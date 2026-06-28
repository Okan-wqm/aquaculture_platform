"""Plan 024 §B — operator resolution of a consensus escalation closes the loop.

Resolving a HUMAN_REQUIRED consensus escalation with a verdict fans the
operator's adjudication into the ground-truth feedback ledger, where Plan 024 §A
judge calibration scores the judges that disagreed.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import _consensus_uncertainty, load_feedback
from aria_kernel.human_required import (
    resolve_human_required,
    sweep_consensus_uncertainties_for_human_required,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir, utc_now


class ConsensusResolutionFeedbackTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _escalate(self) -> str:
        unc = _consensus_uncertainty("tool-x", "run-1", "F-1", "g1", "judge_disagreement")
        line = {
            "schema_version": 1, "recorded_at": utc_now(),
            "tool_id": "tool-x", "cycle_id": "c1", "uncertainties": [unc],
        }
        with (self.tools / "feedback-consensus-uncertainties.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, sort_keys=True) + "\n")
        created = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)["created"]
        self.assertEqual(len(created), 1)
        return created[0]["request_id"]

    def test_escalation_record_carries_structured_context(self) -> None:
        rid = self._escalate()
        rec = json.loads((self.tools / "human-required" / f"{rid}.json").read_text())
        ctx = rec["context"]
        self.assertEqual(ctx["kind"], "consensus_escalation")
        self.assertEqual(ctx["tool_id"], "tool-x")
        self.assertEqual(ctx["finding_id"], "F-1")

    def test_resolution_with_verdict_writes_ground_truth(self) -> None:
        rid = self._escalate()
        resolve_human_required(
            request_id=rid, resolution_note="real bug confirmed",
            verdict="true_positive", base_dir=self.tools,
        )
        human = [r for r in load_feedback(base_dir=self.tools) if r["source_type"] == "human"]
        self.assertEqual(len(human), 1)
        row = human[0]
        self.assertEqual(row["tool_id"], "tool-x")
        self.assertEqual(row["run_id"], "run-1")
        self.assertEqual(row["finding_id"], "F-1")
        self.assertEqual(row["verdict"], "true_positive")
        self.assertEqual(row["judgment_group_id"], "g1")

    def test_resolution_without_verdict_writes_no_feedback(self) -> None:
        rid = self._escalate()
        resolve_human_required(request_id=rid, resolution_note="closed, no call", base_dir=self.tools)
        human = [r for r in load_feedback(base_dir=self.tools) if r["source_type"] == "human"]
        self.assertEqual(human, [])

    def test_invalid_verdict_rejected(self) -> None:
        rid = self._escalate()
        with self.assertRaises(GovernanceError):
            resolve_human_required(
                request_id=rid, resolution_note="x", verdict="maybe", base_dir=self.tools,
            )


if __name__ == "__main__":
    unittest.main()
