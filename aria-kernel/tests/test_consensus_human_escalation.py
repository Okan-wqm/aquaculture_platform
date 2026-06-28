"""Plan 023 §B — consensus disagreement → HUMAN_REQUIRED escalation.

Before Plan 023 the consensus gate wrote judge disagreements / low-confidence
verdicts to ``feedback-consensus-uncertainties.jsonl`` and nothing read it, so
a split judge vote was silently held forever. These tests prove the drain
consumer turns each genuine consensus failure into an idempotent operator
HUMAN_REQUIRED record, and that the benign single-judge case is not escalated.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import _consensus_uncertainty
from aria_kernel.human_required import (
    list_human_required,
    sweep_consensus_uncertainties_for_human_required,
)
from aria_kernel.tool_registry import ensure_tools_dir, utc_now


class ConsensusEscalationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_uncertainties(self, *uncertainties: dict) -> None:
        line = {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "tool_id": "tool-x",
            "cycle_id": "cycle-1",
            "uncertainties": list(uncertainties),
        }
        path = self.tools / "feedback-consensus-uncertainties.jsonl"
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, sort_keys=True) + "\n")

    def test_no_file_is_a_noop(self) -> None:
        result = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        self.assertEqual(result["created"], [])

    def test_disagreement_and_low_confidence_escalate_single_judge_does_not(self) -> None:
        self._write_uncertainties(
            _consensus_uncertainty("tool-x", "run-1", "F-1", "g1", "judge_disagreement"),
            _consensus_uncertainty("tool-x", "run-2", "F-2", "g2", "low_confidence"),
            _consensus_uncertainty("tool-x", "run-3", "F-3", "g3", "single_judge"),
        )
        result = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        self.assertEqual(len(result["created"]), 2)
        severities = sorted(r["severity"] for r in result["created"])
        self.assertEqual(severities, ["HIGH", "MEDIUM"])
        # single_judge is benign and must be skipped, not escalated.
        self.assertTrue(
            any(s.get("kind") == "benign_not_escalated" for s in result["skipped"])
        )
        open_rows = list_human_required(base_dir=self.tools)
        self.assertEqual(len(open_rows), 2)

    def test_severity_mapping(self) -> None:
        self._write_uncertainties(
            _consensus_uncertainty("tool-x", "run-1", "F-1", "g1", "judge_disagreement"),
            _consensus_uncertainty("tool-x", "run-2", "F-2", "g2", "low_confidence"),
        )
        sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        rows = {r["reason"].split("(")[1].split(")")[0]: r["severity"]
                for r in list_human_required(base_dir=self.tools)}
        self.assertEqual(rows["judge_disagreement"], "HIGH")
        self.assertEqual(rows["low_confidence"], "MEDIUM")

    def test_idempotent_across_reruns(self) -> None:
        self._write_uncertainties(
            _consensus_uncertainty("tool-x", "run-1", "F-1", "g1", "judge_disagreement"),
        )
        first = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        self.assertEqual(len(first["created"]), 1)
        second = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        self.assertEqual(len(second["created"]), 0)
        self.assertEqual(len(list_human_required(base_dir=self.tools)), 1)


if __name__ == "__main__":
    unittest.main()
