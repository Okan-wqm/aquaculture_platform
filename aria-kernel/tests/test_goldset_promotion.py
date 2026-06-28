"""Plan 025 §B — gold-set activation.

goldset.py was dead-ended (propose only, no promotion, no consumer). Promotion
is now an explicit operator act that writes the approved gold corpus to a stable
per-tool active file for the Plan 025 §C judge-replay to read.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import record_operator_feedback
from aria_kernel.goldset import (
    load_active_goldset,
    promote_goldset_proposal,
    propose_goldset,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class GoldsetPromotionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _seed_ready(self) -> None:
        # 20 true_positive + 10 false_positive human verdicts → "ready".
        for i in range(20):
            record_operator_feedback(
                tool_id="tool-x", run_id=f"tp{i}", finding_id=f"tp{i}", verdict="true_positive",
                severity="medium", note="gt", source_type="human", base_dir=self.tools,
            )
        for i in range(10):
            record_operator_feedback(
                tool_id="tool-x", run_id=f"fp{i}", finding_id=f"fp{i}", verdict="false_positive",
                severity="low", note="gt", source_type="human", base_dir=self.tools,
            )

    def test_promote_ready_proposal_writes_active_corpus(self) -> None:
        self._seed_ready()
        proposal = propose_goldset(tool_id="tool-x", base_dir=self.tools)
        self.assertEqual(proposal["status"], "ready")
        record = promote_goldset_proposal(tool_id="tool-x", curator="okan", base_dir=self.tools)
        self.assertEqual(record["status"], "active")
        self.assertEqual(record["curator"], "okan")
        self.assertEqual(record["true_positive_count"], 20)
        self.assertEqual(record["known_false_positive_count"], 10)
        self.assertEqual(len(record["true_positive_items"]), 20)
        loaded = load_active_goldset(tool_id="tool-x", base_dir=self.tools)
        self.assertEqual(loaded["status"], "active")

    def test_no_ready_proposal_raises(self) -> None:
        with self.assertRaises(GovernanceError):
            promote_goldset_proposal(tool_id="tool-x", curator="okan", base_dir=self.tools)

    def test_blocked_proposal_cannot_be_promoted(self) -> None:
        proposal = propose_goldset(tool_id="tool-x", base_dir=self.tools)  # no feedback → blocked
        self.assertEqual(proposal["status"], "blocked")
        with self.assertRaises(GovernanceError):
            promote_goldset_proposal(
                tool_id="tool-x", curator="okan", base_dir=self.tools, proposal=proposal,
            )

    def test_curator_required(self) -> None:
        self._seed_ready()
        propose_goldset(tool_id="tool-x", base_dir=self.tools)
        with self.assertRaises(GovernanceError):
            promote_goldset_proposal(tool_id="tool-x", curator="  ", base_dir=self.tools)

    def test_load_active_none_when_unpromoted(self) -> None:
        self.assertIsNone(load_active_goldset(tool_id="tool-x", base_dir=self.tools))


if __name__ == "__main__":
    unittest.main()
