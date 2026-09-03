"""F4.2 — the gold corpus producer.

`propose_goldset` shipped with Plan 025 §B and had ZERO callers: the read
side (`judge_replay`, `proactive_priority`) consulted an active corpus that
could never be created, because nothing ever minted a proposal for an
operator to promote. These tests pin the producer that closes that gap and
the two properties that make it safe to run every night: it proposes for
every labelled tool, and it stays silent when nothing changed.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import record_operator_feedback
from aria_kernel.goldset import (
    list_goldset_proposals,
    propose_goldset,
    propose_goldsets_for_labelled_tools,
)


def _label(tools: Path, tool_id: str, index: int, verdict: str) -> None:
    record_operator_feedback(
        tool_id=tool_id,
        run_id=f"run-{tool_id}-{index}",
        finding_id=f"F-{tool_id}-{index}",
        verdict=verdict,
        severity="medium",
        note=f"operator label {index} for {tool_id}",
        base_dir=tools,
    )


class GoldsetProducerTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_proposes_for_every_labelled_tool_and_reports_distance_to_ready(self) -> None:
        _label(self.tools, "tool-a", 1, "true_positive")
        _label(self.tools, "tool-b", 1, "false_positive")

        result = propose_goldsets_for_labelled_tools(cycle_id="cyc-1", base_dir=self.tools)

        self.assertEqual(result["labelled_tool_count"], 2)
        self.assertEqual({p["tool_id"] for p in result["proposed"]}, {"tool-a", "tool-b"})
        self.assertEqual(result["ready_tool_ids"], [])
        # The operator must be able to read WHY it is not ready — silence
        # ("no proposal") is what the dead producer already gave us.
        blocked = {p["tool_id"]: p["blocked_by"] for p in result["proposed"]}
        self.assertIn("insufficient_true_positive_gold_items", blocked["tool-b"])
        self.assertIn("insufficient_known_false_positive_gold_items", blocked["tool-a"])

    def test_unchanged_picture_appends_nothing(self) -> None:
        _label(self.tools, "tool-a", 1, "true_positive")
        first = propose_goldsets_for_labelled_tools(cycle_id="cyc-1", base_dir=self.tools)
        self.assertEqual([p["tool_id"] for p in first["proposed"]], ["tool-a"])
        after_first = len(list_goldset_proposals(base_dir=self.tools))

        second = propose_goldsets_for_labelled_tools(cycle_id="cyc-2", base_dir=self.tools)

        self.assertEqual(second["proposed"], [])
        self.assertEqual(second["unchanged_tool_ids"], ["tool-a"])
        # The nightly runs forever; an identical row per cycle would bury the
        # real transitions under repeats.
        self.assertEqual(len(list_goldset_proposals(base_dir=self.tools)), after_first)

    def test_a_new_label_makes_the_producer_speak_again(self) -> None:
        _label(self.tools, "tool-a", 1, "true_positive")
        propose_goldsets_for_labelled_tools(cycle_id="cyc-1", base_dir=self.tools)
        _label(self.tools, "tool-a", 2, "true_positive")

        result = propose_goldsets_for_labelled_tools(cycle_id="cyc-2", base_dir=self.tools)

        self.assertEqual([p["tool_id"] for p in result["proposed"]], ["tool-a"])
        self.assertEqual(result["proposed"][0]["true_positive_count"], 2)

    def test_ready_when_targets_are_met(self) -> None:
        for index in range(2):
            _label(self.tools, "tool-a", index, "true_positive")
        _label(self.tools, "tool-a", 99, "false_positive")

        result = propose_goldsets_for_labelled_tools(
            cycle_id="cyc-1",
            base_dir=self.tools,
            target_true_positives=2,
            target_known_false_positives=1,
        )

        self.assertEqual(result["ready_tool_ids"], ["tool-a"])

    def test_a_tool_with_no_feedback_at_all_is_not_proposed_for(self) -> None:
        # The producer walks the feedback ledger, not the tool registry: a
        # registered adapter nobody has labelled yet has no ground truth to
        # propose, and inventing an empty proposal for it would read as
        # "measured and found wanting".
        result = propose_goldsets_for_labelled_tools(cycle_id="cyc-1", base_dir=self.tools)

        self.assertEqual(result["labelled_tool_count"], 0)
        self.assertEqual(result["proposed"], [])

    def test_direct_propose_always_returns_a_row(self) -> None:
        # The CLI ceremony asks a question and must get an answer even when
        # the picture is identical to last night's.
        _label(self.tools, "tool-a", 1, "true_positive")
        propose_goldsets_for_labelled_tools(cycle_id="cyc-1", base_dir=self.tools)

        row = propose_goldset(tool_id="tool-a", cycle_id="cyc-2", base_dir=self.tools)

        self.assertIsNotNone(row)
        self.assertEqual(row["tool_id"], "tool-a")


if __name__ == "__main__":
    unittest.main()
