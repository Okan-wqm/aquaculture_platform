"""M4+M8/E8 — the belief-verdict channel, end to end.

Pre-fix the loop was severed at both ends: contradictions had no escalation
producer (a belief could stand contradicted for months with no path to a
human), and `affected_belief_ids` had no producer (a human's verdict could
not move belief confidence — `_feedback_adjustment` always returned 0.0).
The end-to-end test is the point: contradiction × N cycles → HUMAN_REQUIRED
→ operator verdict → feedback row carrying the belief id →
`_feedback_adjustment` returns a non-zero adjustment for that belief.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.belief_escalation import escalate_stuck_contradictions
from aria_kernel.memory import _feedback_adjustment, _record_contradiction
from aria_kernel.tool_registry import ensure_tools_dir


def _open_contradiction(root: Path, belief_id: str, cycle_id: str) -> None:
    _record_contradiction(
        root,
        cycle_id=cycle_id,
        belief_id=belief_id,
        reason="adapter re-emitted a withdrawn claim",
        source_tool_id="adapter-x",
    )


class EscalationProducerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def test_contradiction_below_threshold_does_not_page(self) -> None:
        _open_contradiction(self.root, "B-quiet", "cyc-1")
        _open_contradiction(self.root, "B-quiet", "cyc-2")
        result = escalate_stuck_contradictions(cycle_id="cyc-2", base_dir=self.root)
        self.assertEqual(result["escalated_belief_ids"], [])

    def test_standing_contradiction_escalates_idempotently(self) -> None:
        for cyc in ("cyc-1", "cyc-2", "cyc-3"):
            _open_contradiction(self.root, "B-stuck", cyc)
        first = escalate_stuck_contradictions(cycle_id="cyc-3", base_dir=self.root)
        self.assertEqual(first["escalated_belief_ids"], ["B-stuck"])
        # Same standing contradiction next cycle folds into the existing
        # record instead of re-paging the operator.
        _open_contradiction(self.root, "B-stuck", "cyc-4")
        second = escalate_stuck_contradictions(cycle_id="cyc-4", base_dir=self.root)
        self.assertEqual(second["escalated_belief_ids"], ["B-stuck"])
        hr_dir = self.root / "human-required"
        records = list(hr_dir.glob("HR-belief-B-stuck*")) if hr_dir.exists() else []
        self.assertEqual(len(records), 1, records)


class VerdictMovesBeliefConfidenceTests(unittest.TestCase):
    def test_end_to_end_verdict_reaches_feedback_adjustment(self) -> None:
        from aria_kernel.human_required import resolve_human_required

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            for cyc in ("cyc-1", "cyc-2", "cyc-3"):
                _open_contradiction(root, "B-judged", cyc)
            escalate_stuck_contradictions(cycle_id="cyc-3", base_dir=root)

            # Pre-fix baseline: no producer, adjustment is exactly 0.0.
            self.assertEqual(_feedback_adjustment(root, "B-judged"), 0.0)

            resolve_human_required(
                request_id="HR-belief-B-judged",
                resolution_note="operator confirms the adapters; belief is wrong",
                resolved_by="operator",
                verdict="false_positive",
                base_dir=root,
            )
            adjustment = _feedback_adjustment(root, "B-judged")
        # false_positive at medium severity → -0.1: the verdict MOVED
        # belief confidence for the first time in ARIA's history.
        self.assertEqual(adjustment, -0.1)

    def test_true_positive_raises_confidence(self) -> None:
        from aria_kernel.human_required import resolve_human_required

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            for cyc in ("cyc-1", "cyc-2", "cyc-3"):
                _open_contradiction(root, "B-vindicated", cyc)
            escalate_stuck_contradictions(cycle_id="cyc-3", base_dir=root)
            resolve_human_required(
                request_id="HR-belief-B-vindicated",
                resolution_note="belief holds; the adapter is noisy",
                resolved_by="operator",
                verdict="true_positive",
                base_dir=root,
            )
            adjustment = _feedback_adjustment(root, "B-vindicated")
        self.assertEqual(adjustment, 0.05)


if __name__ == "__main__":
    unittest.main()
