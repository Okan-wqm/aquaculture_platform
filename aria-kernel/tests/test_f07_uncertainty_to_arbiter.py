"""F0.7 + J4 — judgment uncertainty goes to the arbiter, never to a human.

PLAN-v2 §3 F0.7: consensus_escalation (human_required.py's consensus sweep),
belief_escalation and WP-J's three reasons (`anchor_evidence_empty`,
`panel_echo`, `unverifiable`) route to the bounded rebuttal and
`dispatch_arbiter_for_split_verdicts`; `unverifiable` is terminal and outside
truth, and its rate has a ceiling. Exit: new consensus HUMAN_REQUIRED = 0 and
the unverifiable rate <= baseline + a pre-registered margin.

SEPT-HARVEST J4: the arbiter is bound to its inputs. `_mint_arbiter` stamps
the seats it was asked about; the bridge refuses `arbiter_inputs_stale` when
the group's seat set or verdicts changed after the mint (a rebuttal revote, a
late seat), writes no ai_judge row, and the group is re-offered.

Pinned NEW API (red by ImportError inside the test, never at collection):
`feedback_store.UNVERIFIABLE_RATE_CEILING`. The unverifiable rate it bounds is
read off the ledgers the judgment lane already writes, per tool:
unverifiable outcomes / (unverifiable outcomes + settled ai_consensus groups).
"""
from __future__ import annotations

import json
import tempfile
from datetime import datetime, timezone
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import list_agent_invocation_requests, sweep_expired_anchors
from aria_kernel.belief_escalation import escalate_stuck_contradictions
from aria_kernel.feedback_store import (
    _consensus_uncertainty,
    generate_ai_consensus,
    load_feedback,
    record_operator_feedback,
)
from aria_kernel.human_required import (
    list_human_required,
    sweep_consensus_uncertainties_for_human_required,
)
from aria_kernel.judge_fanout import (
    CONSENSUS_ARBITER_AGENT,
    CONSENSUS_ARBITRATION_ROLE,
    dispatch_arbiter_for_split_verdicts,
    dispatch_rebuttal_for_dissent,
)
from aria_kernel.judgment_bridge import record_judge_verdict_from_response
from aria_kernel.memory import _record_contradiction
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir, utc_now

TOOL = "tool-a"
GROUP = "judge:tool-a:run-1:F-1"


def _vote(tools: Path, judge_id: str, verdict: str, *, group: str = GROUP, finding: str = "F-1",
          request_id: str | None = None, model: str = "opus", rationale: str | None = None,
          refs: list[str] | None = None) -> None:
    record_operator_feedback(
        tool_id=TOOL, run_id="run-1", finding_id=finding, verdict=verdict, severity="high",
        note=f"{judge_id} verdict", source_type="ai_judge", judge_id=judge_id, model=model,
        confidence=0.9, rationale=rationale or f"{judge_id} read the code its own way",
        evidence_refs=[f"aria-kernel/aria_kernel/judge_fanout.py:{len(judge_id)}"] if refs is None else refs,
        judgment_group_id=group, request_ids=[request_id or f"REQ-{judge_id}-{finding}"],
        base_dir=tools,
    )


def _arbiters(tools: Path, group: str = GROUP) -> list[dict]:
    return [row for row in list_agent_invocation_requests(base_dir=tools, role=CONSENSUS_ARBITRATION_ROLE)
            if row.get("judgment_group_id") == group]


def _answer(request: dict, *, verdict: str | None = None, reason: str | None = None) -> dict:
    consensus: dict = {"confidence": 0.85, "rationale": "weighed the seats' evidence",
                       "evidence_refs": ["aria-kernel/aria_kernel/judge_fanout.py:1"]}
    if verdict is not None:
        consensus["verdict"] = verdict
        # J3 — a weighing brief is answered with a ruling per side before the verdict; the sides
        # are the verdicts the arbiter's bound seats voted.
        sides = sorted({str(seat["verdict"]) for seat in request["arbiter_inputs"]["facts"]})
        consensus["side_rulings"] = [
            {"verdict": side, "ruling": "upheld" if side == verdict else "speculative"} for side in sides
        ]
    else:
        consensus["uncertainty_reason"] = reason
    return {"role": CONSENSUS_ARBITRATION_ROLE, "request_id": request["request_id"],
            "details": {"agent_subagent_type": CONSENSUS_ARBITER_AGENT, "consensus": consensus}}


def _arbiter_rows(tools: Path, group: str = GROUP) -> list[dict]:
    return [row for row in load_feedback(tool_id=TOOL, base_dir=tools)
            if row.get("judgment_group_id") == group and row.get("judge_id") == CONSENSUS_ARBITER_AGENT]


class _Case(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-f07-")
        self.addCleanup(self._tmp.cleanup)
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")

    def _human_required(self) -> list[dict]:
        return list_human_required(base_dir=self.tools).rows

    def _split(self, group: str = GROUP, finding: str = "F-1") -> None:
        _vote(self.tools, "aria-evidence-judge", "true_positive", group=group, finding=finding)
        _vote(self.tools, "aria-adversarial-judge", "false_positive", group=group, finding=finding)


class SplitVerdictReachesTheArbiterTest(_Case):
    def test_a_split_goes_to_the_arbiter_not_to_human_required(self) -> None:
        self._split()
        consensus = generate_ai_consensus(tool_id=TOOL, base_dir=self.tools)
        self.assertEqual([u["reason"] for u in consensus["uncertainties"]], ["judge_disagreement"])

        # No arbiter in flight (none minted yet, or the last one answered):
        # the sweep is where the operator used to be asked.
        sweep = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)

        self.assertEqual(sweep["created"], [])
        self.assertEqual(self._human_required(), [])
        minted = dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools)
        self.assertEqual([m["judgment_group_id"] for m in minted["minted"]], [GROUP])

    def _anchor_group(self, *, refs: list[str] | None, rationale: str | None) -> None:
        for judge, model in (("aria-evidence-judge", "opus"), ("aria-adversarial-judge", "sonnet"),
                             ("aria-test-writer-seat", "glm")):
            _vote(self.tools, judge, "false_positive", model=model, refs=refs, rationale=rationale)

    def _assert_wp_j_reason_goes_to_the_arbiter(self, reason: str) -> None:
        consensus = generate_ai_consensus(tool_id=TOOL, base_dir=self.tools)
        self.assertEqual([u["reason"] for u in consensus["uncertainties"]], [reason])

        sweep = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        minted = dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools)

        self.assertEqual(sweep["created"], [])
        self.assertEqual(self._human_required(), [])
        self.assertEqual([m["judgment_group_id"] for m in minted["minted"]], [GROUP])

    def test_anchor_evidence_empty_goes_to_the_arbiter(self) -> None:
        self._anchor_group(refs=[], rationale=None)
        self._assert_wp_j_reason_goes_to_the_arbiter("anchor_evidence_empty")

    def test_panel_echo_goes_to_the_arbiter(self) -> None:
        self._anchor_group(refs=None, rationale="the guard returns early so the rule cannot fire here")
        self._assert_wp_j_reason_goes_to_the_arbiter("panel_echo")


class ConsensusEscalationMintsNoHumanRequiredTest(_Case):
    def test_no_consensus_uncertainty_reason_mints_human_required(self) -> None:
        # The exit criterion, read at the sweep: new consensus HUMAN_REQUIRED = 0.
        from aria_kernel.feedback_store import CONSENSUS_UNCERTAINTY_REASONS

        rows = [_consensus_uncertainty(TOOL, f"run-{i}", f"F-{i}", f"g-{i}", reason)
                for i, reason in enumerate(CONSENSUS_UNCERTAINTY_REASONS)]
        path = self.tools / "feedback-consensus-uncertainties.jsonl"
        path.write_text(json.dumps({"schema_version": 1, "recorded_at": utc_now(), "tool_id": TOOL,
                                    "cycle_id": "cyc-1", "uncertainties": rows}) + "\n", encoding="utf-8")

        sweep = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)

        self.assertEqual(sweep["created"], [])
        self.assertEqual([r["context"].get("kind") for r in self._human_required()], [])


class UnverifiableIsTerminalTest(_Case):
    def test_an_unverifiable_arbitration_is_terminal_and_outside_truth(self) -> None:
        self._split()
        generate_ai_consensus(tool_id=TOOL, base_dir=self.tools)
        dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-1")
        [arbiter] = _arbiters(self.tools)
        record_judge_verdict_from_response(request=arbiter, response=_answer(arbiter, reason="unverifiable"),
                                           base_dir=self.tools)
        # The arbitration is over (its envelope is terminal), so nothing holds
        # the sweep back the way an in-flight arbiter does.
        sweep_expired_anchors(base_dir=self.tools, now=datetime(2100, 1, 1, tzinfo=timezone.utc))

        sweep = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        again = dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-2")
        rebuttal = dispatch_rebuttal_for_dissent(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-2")
        generate_ai_consensus(tool_id=TOOL, base_dir=self.tools)

        # Terminal: nobody is asked again — not a human, not the arbiter, not a seat.
        self.assertEqual(sweep["created"], [])
        self.assertEqual(self._human_required(), [])
        self.assertEqual(again["minted"], [])
        self.assertEqual(rebuttal["minted"], [])
        # Outside truth: no settled row and no arbiter verdict row for the group.
        self.assertEqual([r for r in load_feedback(tool_id=TOOL, base_dir=self.tools)
                          if r.get("source_type") == "ai_consensus"], [])
        self.assertEqual(_arbiter_rows(self.tools), [])


class UnverifiableRateCeilingTest(_Case):
    def test_the_ceiling_is_a_named_bound_below_a_coin_flip(self) -> None:
        # New API pin: the pre-registered ceiling has one name and one owner.
        from aria_kernel.feedback_store import UNVERIFIABLE_RATE_CEILING

        self.assertIsInstance(UNVERIFIABLE_RATE_CEILING, float)
        self.assertGreater(UNVERIFIABLE_RATE_CEILING, 0.0)
        self.assertLess(UNVERIFIABLE_RATE_CEILING, 0.5)

    def _settle(self, count: int) -> None:
        for i in range(count):
            group = f"judge:tool-a:run-1:S-{i}"
            for source in ("ai_judge", "ai_consensus"):
                record_operator_feedback(
                    tool_id=TOOL, run_id="run-1", finding_id=f"S-{i}", verdict="false_positive",
                    severity="medium", note="settled", source_type=source, judge_id=CONSENSUS_ARBITER_AGENT,
                    confidence=0.9, judgment_group_id=group, base_dir=self.tools,
                    **({"judge_count": 2, "judges_voted": 2} if source == "ai_consensus" else {}),
                )

    def _answer_unverifiable(self, finding: str) -> dict:
        [arbiter] = _arbiters(self.tools, f"judge:tool-a:run-1:{finding}")
        return record_judge_verdict_from_response(
            request=arbiter, response=_answer(arbiter, reason="unverifiable"), base_dir=self.tools)

    def test_an_unverifiable_answer_over_the_ceiling_is_recorded_and_the_breach_named(self) -> None:
        # Corrective B2 — the ceiling is enforced where the rate is read: a
        # refused answer would leave its group minted-but-unanswered and
        # outside the very rate the exit criterion reads.
        from aria_kernel.feedback_store import unverifiable_rate

        self._settle(99)
        self._split(group="judge:tool-a:run-1:U-1", finding="U-1")
        self._split(group="judge:tool-a:run-1:U-2", finding="U-2")
        dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools)

        # 1 of 100 judged groups unverifiable: under any sane ceiling.
        self.assertEqual(self._answer_unverifiable("U-1")["reason"], "unverifiable")
        self.assertFalse(unverifiable_rate(tool_id=TOOL, base_dir=self.tools)["over_ceiling"])
        self.assertEqual(sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
                         ["unverifiable_rate_ceiling"], [])

        prior = [_consensus_uncertainty(TOOL, "run-1", f"P-{i}", f"judge:tool-a:run-1:P-{i}", "unverifiable")
                 for i in range(99)]
        with (self.tools / "feedback-consensus-uncertainties.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"schema_version": 1, "recorded_at": utc_now(), "tool_id": TOOL,
                                 "cycle_id": "cyc-1", "uncertainties": prior}) + "\n")

        # ~101 of ~200 judged groups unverifiable: recorded, and the breach is named.
        self.assertEqual(self._answer_unverifiable("U-2")["reason"], "unverifiable")
        rate = unverifiable_rate(tool_id=TOOL, base_dir=self.tools)
        self.assertEqual(rate["unverifiable"], 101)
        self.assertTrue(rate["over_ceiling"])
        sweep = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        self.assertEqual([b["tool_id"] for b in sweep["unverifiable_rate_ceiling"]], [TOOL])
        governance = (self.tools / "governance.jsonl").read_text(encoding="utf-8")
        self.assertIn('"unverifiable_rate_ceiling"', governance)

    def test_every_refusable_answer_is_counted_and_no_group_is_stranded(self) -> None:
        from aria_kernel.feedback_store import unverifiable_rate
        from aria_kernel.judge_fanout import arbitration_groups

        findings = [f"U-{i}" for i in range(6)]
        for finding in findings:
            self._split(group=f"judge:tool-a:run-1:{finding}", finding=finding)
        generate_ai_consensus(tool_id=TOOL, base_dir=self.tools)
        dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools)
        for finding in findings:
            self._answer_unverifiable(finding)

        self.assertEqual(unverifiable_rate(tool_id=TOOL, base_dir=self.tools)["unverifiable"], 6)
        self.assertEqual(arbitration_groups(tool_id=TOOL, base_dir=self.tools), [])
        sweep = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        self.assertEqual([b["tool_id"] for b in sweep["unverifiable_rate_ceiling"]], [TOOL])


class ArbiterNonVerdictIsTerminalTest(_Case):
    def test_an_aggregation_non_verdict_is_terminal_and_counted(self) -> None:
        # Corrective B1 (arch) — an arbiter that cannot close a split (before
        # J3 the aggregation brief's gate, which a split fails by construction;
        # now a weighing that finds nothing to rule on) answers
        # judge_disagreement. The arbiter lane has one non-verdict: the
        # terminal one, with the arbiter's stated reason kept beside it.
        from aria_kernel.feedback_store import unverifiable_rate
        from aria_kernel.judge_fanout import _uncertain_group_keys, arbitration_groups

        self._split()
        generate_ai_consensus(tool_id=TOOL, base_dir=self.tools)
        dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools)
        [arbiter] = _arbiters(self.tools)

        row = record_judge_verdict_from_response(
            request=arbiter, response=_answer(arbiter, reason="judge_disagreement"), base_dir=self.tools)

        self.assertEqual((row["reason"], row["arbiter_reason"]), ("unverifiable", "judge_disagreement"))
        self.assertIn(("run-1", "F-1", GROUP), _uncertain_group_keys(TOOL, self.tools)[1])
        self.assertEqual(arbitration_groups(tool_id=TOOL, base_dir=self.tools), [])
        self.assertEqual(unverifiable_rate(tool_id=TOOL, base_dir=self.tools)["unverifiable"], 1)
        self.assertEqual(sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)["routed"],
                         {"not_arbitrated": 0, "arbiter": 0, "terminal": 1})


class LegacyConsensusEscalationHasOneOwnerTest(_Case):
    def test_an_open_legacy_record_is_routed_to_the_arbiter_and_no_panel_opens(self) -> None:
        # Corrective B1 (ssot) — a consensus_escalation record minted before
        # F0.7 and the arbiter lane must not both hold the group.
        from aria_kernel.agent_invocations import create_agent_invocation_request
        from aria_kernel.human_required import RESOLVED_BY_KERNEL, record_human_required
        from aria_kernel.human_required_adjudication import sweep_human_required_adjudications
        from aria_kernel.judge_fanout import _arbiter_admission

        self._split()
        [uncertainty] = generate_ai_consensus(tool_id=TOOL, base_dir=self.tools)["uncertainties"]
        create_agent_invocation_request(
            target_agent=CONSENSUS_ARBITER_AGENT, role=CONSENSUS_ARBITRATION_ROLE,
            suggested_prompt="pre-F0.7 arbiter", must_satisfy=[{"id": "consensus", "description": "x"}],
            allowed_scope=["**"], finding_id="F-1", tool_id=TOOL, run_id="run-1", judgment_group_id=GROUP,
            base_dir=self.tools, admission=_arbiter_admission(self.tools, None))
        legacy = record_human_required(
            request_id=uncertainty["escalation_id"], severity="HIGH", reason="pre-F0.7 consensus escalation",
            context={"kind": "consensus_escalation", "uncertainty_reason": "judge_disagreement",
                     "tool_id": TOOL, "run_id": "run-1", "finding_id": "F-1", "judgment_group_id": GROUP},
            base_dir=self.tools)

        sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools)
        panel = sweep_human_required_adjudications(base_dir=self.tools)

        self.assertEqual(panel["opened"], [])
        self.assertEqual(len([row for row in _arbiters(self.tools) if row.get("arbiter_inputs")]), 1)
        record = json.loads((self.tools / "human-required" / f"{legacy['request_id']}.json")
                            .read_text(encoding="utf-8"))
        self.assertEqual((record["status"], record["resolved_by"]), ("resolved", RESOLVED_BY_KERNEL))
        self.assertEqual(self._human_required(), [])


class ArbiterBoundToItsInputsTest(_Case):
    def test_a_rebuttal_revote_after_the_mint_makes_the_answer_stale(self) -> None:
        self._split()
        dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-1")
        [arbiter] = _arbiters(self.tools)
        # The dissenter revotes (the rebuttal round) after the arbiter was minted.
        _vote(self.tools, "aria-adversarial-judge", "true_positive", request_id="REQ-rebuttal")

        with self.assertRaises(GovernanceError) as ctx:
            record_judge_verdict_from_response(request=arbiter, response=_answer(arbiter, verdict="false_positive"),
                                               base_dir=self.tools)

        self.assertIn("arbiter_inputs_stale", str(ctx.exception))
        self.assertEqual(_arbiter_rows(self.tools), [])

    def test_a_late_seat_is_refused_and_the_group_is_re_offered(self) -> None:
        self._split()
        dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-1")
        [stale] = _arbiters(self.tools)
        _vote(self.tools, "aria-test-writer-seat", "false_positive")

        with self.assertRaises(GovernanceError) as ctx:
            record_judge_verdict_from_response(request=stale, response=_answer(stale, verdict="false_positive"),
                                               base_dir=self.tools)
        self.assertIn("arbiter_inputs_stale", str(ctx.exception))

        reoffer = dispatch_arbiter_for_split_verdicts(tool_id=TOOL, base_dir=self.tools, cycle_id="cyc-2")
        self.assertEqual([m["judgment_group_id"] for m in reoffer["minted"]], [GROUP])
        fresh = next(row for row in _arbiters(self.tools) if row["request_id"] != stale["request_id"])
        record_judge_verdict_from_response(request=fresh, response=_answer(fresh, verdict="false_positive"),
                                           base_dir=self.tools)
        self.assertEqual(len(_arbiter_rows(self.tools)), 1)


class BeliefEscalationGoesToTheArbiterTest(_Case):
    def test_a_standing_contradiction_asks_the_arbiter_not_a_human(self) -> None:
        for cycle in ("cyc-1", "cyc-2", "cyc-3"):
            _record_contradiction(self.tools, cycle_id=cycle, belief_id="B-stuck",
                                  reason="adapter re-emitted a withdrawn claim", source_tool_id="adapter-x")

        escalate_stuck_contradictions(cycle_id="cyc-3", base_dir=self.tools)
        escalate_stuck_contradictions(cycle_id="cyc-4", base_dir=self.tools)

        self.assertEqual(self._human_required(), [])
        arbiters = [row for row in list_agent_invocation_requests(base_dir=self.tools, role=CONSENSUS_ARBITRATION_ROLE)
                    if "B-stuck" in json.dumps(row, sort_keys=True)]
        self.assertEqual([row["target_agent"] for row in arbiters], [CONSENSUS_ARBITER_AGENT])


if __name__ == "__main__":
    unittest.main()
