"""M4+M8/E8 — the belief-verdict channel, end to end; F0.7 (ARIA-MEDIUM-730)
moved its adjudicator from a human to the consensus arbiter.

Pre-fix the loop was severed at both ends: contradictions had no escalation
producer, and `affected_belief_ids` had no producer (`_feedback_adjustment`
always returned 0.0). Since F0.7: contradiction x N cycles -> ONE arbiter
envelope -> the arbiter's ruling through the judgment bridge -> a feedback row
carrying the belief id -> `_feedback_adjustment` moves the belief, in the one
direction a non-human ruling may (JJ-3). The operator's verdict on a belief
record minted before F0.7 (the arm `resolve_human_required` kept) is pinned
beside it, through a hand-built record.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.belief_escalation import BELIEF_ESCALATION_KIND, escalate_stuck_contradictions
from aria_kernel.feedback_store import is_ground_truth_row, load_feedback
from aria_kernel.human_required import list_human_required, record_human_required, resolve_human_required
from aria_kernel.judge_fanout import CONSENSUS_ARBITER_AGENT, CONSENSUS_ARBITRATION_ROLE
from aria_kernel.judgment_bridge import record_judge_verdict_from_response
from aria_kernel.memory import _feedback_adjustment, _record_contradiction
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _open_contradiction(root: Path, belief_id: str, cycle_id: str, reason: str = "adapter re-emitted a withdrawn claim") -> None:
    _record_contradiction(root, cycle_id=cycle_id, belief_id=belief_id, reason=reason, source_tool_id="adapter-x")


def _stuck(root: Path, belief_id: str) -> dict:
    for cyc in ("cyc-1", "cyc-2", "cyc-3"):
        _open_contradiction(root, belief_id, cyc)
    escalate_stuck_contradictions(cycle_id="cyc-3", base_dir=root)
    [arbiter] = _arbiters(root, belief_id)
    return arbiter


def _arbiters(root: Path, belief_id: str) -> list[dict]:
    return [row for row in list_agent_invocation_requests(base_dir=root, role=CONSENSUS_ARBITRATION_ROLE)
            if row.get("judgment_group_id") == f"belief:{belief_id}"]


def _rule(root: Path, arbiter: dict, verdict: str) -> dict:
    return record_judge_verdict_from_response(
        request=arbiter,
        response={"role": CONSENSUS_ARBITRATION_ROLE, "request_id": arbiter["request_id"],
                  "details": {"agent_subagent_type": CONSENSUS_ARBITER_AGENT,
                              "consensus": {"verdict": verdict, "confidence": 0.9,
                                            "rationale": "read the cited code",
                                            "evidence_refs": ["aria-kernel/aria_kernel/memory.py:1"]}}},
        base_dir=root,
    )


def _pre_f07_belief_record(root: Path, belief_id: str) -> str:
    """A belief escalation as the producer minted it before F0.7 (the same
    hand-built record `test_jj3_belief_panel._stuck_belief` drains). The
    producer no longer exists; the operator's verdict on such a record, or on
    one a refused panel handed back, still does (`resolve_human_required`)."""
    request_id = f"HR-belief-{belief_id}"
    record_human_required(
        request_id=request_id,
        severity="medium",
        reason=f"belief {belief_id} has an open contradiction across 3 cycles",
        context={
            "kind": BELIEF_ESCALATION_KIND,
            "belief_id": belief_id,
            "source_tool_id": "adapter-x",
            "contradiction_reason": "x",
            "open_cycle_count": 3,
        },
        base_dir=root,
    )
    return request_id


class EscalationProducerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def test_contradiction_below_threshold_asks_nobody(self) -> None:
        _open_contradiction(self.root, "B-quiet", "cyc-1")
        _open_contradiction(self.root, "B-quiet", "cyc-2")
        result = escalate_stuck_contradictions(cycle_id="cyc-2", base_dir=self.root)
        self.assertEqual(result["escalated_belief_ids"], [])
        self.assertEqual(_arbiters(self.root, "B-quiet"), [])

    def test_standing_contradiction_asks_the_arbiter_once_and_no_human(self) -> None:
        _stuck(self.root, "B-stuck")
        _open_contradiction(self.root, "B-stuck", "cyc-4")
        second = escalate_stuck_contradictions(cycle_id="cyc-4", base_dir=self.root)
        self.assertEqual(second["escalated_belief_ids"], ["B-stuck"])
        self.assertEqual(second["arbitration"][0]["reason"], "already_dispatched")
        self.assertEqual(len(_arbiters(self.root, "B-stuck")), 1)
        self.assertEqual(list_human_required(base_dir=self.root).rows, [])


class VerdictMovesBeliefConfidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def test_an_affirmed_contradiction_lowers_the_belief_once(self) -> None:
        arbiter = _stuck(self.root, "B-judged")
        self.assertEqual(_feedback_adjustment(self.root, "B-judged"), 0.0)

        row = _rule(self.root, arbiter, "false_positive")
        _rule(self.root, arbiter, "false_positive")  # a bridge replay stacks nothing

        self.assertEqual(_feedback_adjustment(self.root, "B-judged"), -0.1)
        self.assertEqual((row["source_type"], row["judgment_subject"]), ("ai_consensus", "belief"))
        self.assertFalse(is_ground_truth_row(row))

    def test_a_belief_that_stands_is_recorded_and_not_raised(self) -> None:
        arbiter = _stuck(self.root, "B-vindicated")
        _rule(self.root, arbiter, "true_positive")
        self.assertEqual(_feedback_adjustment(self.root, "B-vindicated"), 0.0)
        self.assertEqual([r["verdict"] for r in load_feedback(base_dir=self.root)
                          if r.get("judgment_group_id") == "belief:B-vindicated"], ["true_positive"])

    def test_an_operator_verdict_on_a_pre_f07_belief_record_lowers_the_belief(self) -> None:
        # The operator leg F0.7's removal of the producer left in production
        # (`resolve_human_required`, kind `belief_escalation`): a human
        # `false_positive` is ground truth and moves the belief it names.
        request_id = _pre_f07_belief_record(self.root, "B-judged")
        self.assertEqual(_feedback_adjustment(self.root, "B-judged"), 0.0)

        resolved = resolve_human_required(
            request_id=request_id, resolution_note="operator confirms the adapters; belief is wrong",
            resolved_by="operator", verdict="false_positive", base_dir=self.root)

        self.assertEqual(resolved["operator_verdict"], "false_positive")
        self.assertEqual(_feedback_adjustment(self.root, "B-judged"), -0.1)
        [row] = load_feedback(base_dir=self.root)
        self.assertEqual((row["source_type"], row["judgment_subject"], row["affected_belief_ids"]),
                         ("human", "belief", ["B-judged"]))
        self.assertEqual((row["run_id"], row["verdict"]), (request_id, "false_positive"))
        self.assertTrue(is_ground_truth_row(row))

    def test_an_operator_true_positive_raises_the_belief(self) -> None:
        # The other direction, and the contrast with the arbiter: a human
        # `true_positive` raises the belief (+0.05); an arbiter's moves nothing
        # (`test_a_belief_that_stands_is_recorded_and_not_raised`).
        request_id = _pre_f07_belief_record(self.root, "B-vindicated")
        self.assertEqual(_feedback_adjustment(self.root, "B-vindicated"), 0.0)

        resolve_human_required(
            request_id=request_id, resolution_note="belief holds; the adapter is noisy",
            resolved_by="operator", verdict="true_positive", base_dir=self.root)

        self.assertEqual(_feedback_adjustment(self.root, "B-vindicated"), 0.05)
        [row] = load_feedback(base_dir=self.root)
        self.assertEqual((row["source_type"], row["judgment_subject"], row["affected_belief_ids"]),
                         ("human", "belief", ["B-vindicated"]))

    def test_a_ruling_over_a_changed_contradiction_is_stale(self) -> None:
        arbiter = _stuck(self.root, "B-moved")
        _open_contradiction(self.root, "B-moved", "cyc-4", reason="a different scanner claim")
        with self.assertRaises(GovernanceError) as ctx:
            _rule(self.root, arbiter, "false_positive")
        self.assertIn("arbiter_inputs_stale", str(ctx.exception))
        self.assertEqual(_feedback_adjustment(self.root, "B-moved"), 0.0)


if __name__ == "__main__":
    unittest.main()
