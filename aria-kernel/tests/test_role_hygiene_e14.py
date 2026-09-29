"""E14 — every role on the agent surface either mints or is gone.

`agent_surface.REQUEST_ROLES` is the closed set of roles a request may name.
A role in that set with no producer is a promise the kernel cannot keep: a
caller can build the envelope, the strict validators accept it, and nothing
ever dispatches it — which is how `implementation_review` ended up claimed by
an agent prompt for months (ORPHAN-MEDIUM-280) while no kernel path routed it.

Three roles get their first production minter here:

  * `goldset_curation`   — a proposal that reaches `ready` (goldset.py)
  * `change_intelligence` — a merge carried into the impact ledger (pr_tracking)
  * `consensus_arbitration` — two judges who disagree (judge_fanout)

and five that no lane could ever mint are removed from the surface. These
tests pin BOTH halves: the mint fires on the real trigger and is idempotent
against re-runs, and the removed roles are refused at the mint seam.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel import cycle as cycle_mod
from aria_kernel.agent_contract import validate_request
from aria_kernel.agent_invocations import (
    create_agent_invocation_request,
    minted_subject_refs,
    list_agent_invocation_requests,
)
from aria_kernel.agent_surface import REQUEST_ROLES, ROLE_TARGET_PAIRING
from aria_kernel.auto_merge import record_pr_lifecycle
from aria_kernel.context_budget_gate import ROLE_CAP_MAP
from aria_kernel.feedback_store import generate_ai_consensus, record_operator_feedback
from aria_kernel.goldset import (
    GOLDSET_CURATION_ROLE,
    GOLDSET_CURATOR_AGENT,
    propose_goldsets_for_labelled_tools,
)
from aria_kernel.human_required import (
    sweep_consensus_uncertainties_for_human_required,
)
from aria_kernel.judge_fanout import (
    CONSENSUS_ARBITER_AGENT,
    CONSENSUS_ARBITRATION_ROLE,
    dispatch_arbiter_for_split_verdicts,
    split_verdict_groups,
)
from aria_kernel.pr_tracking import (
    CHANGE_INTELLIGENCE_AGENT,
    CHANGE_INTELLIGENCE_ROLE,
    change_intelligence_subject_ref,
    dispatch_change_intelligence,
    ingest_merged_pr_lifecycle,
)
from aria_kernel.tool_registry import GovernanceError


REMOVED_ROLES = (
    "implementation_review",
    "architectural_arbitration",
    "auth_security_review",
    "access_boundary_review",
    "tenant_isolation_review",
)


class _ToolsDirTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        self.tools.mkdir(parents=True)
        self.addCleanup(self._tmp.cleanup)

    def _requests(self, role: str) -> list[dict]:
        return list_agent_invocation_requests(base_dir=self.tools, role=role)


def _label(tools: Path, tool_id: str, index: int, verdict: str) -> None:
    record_operator_feedback(
        tool_id=tool_id,
        run_id=f"run-{index}",
        finding_id=f"F-{index}",
        verdict=verdict,
        severity="medium",
        note=f"operator label {index}",
        base_dir=tools,
    )


def _judge_vote(
    tools: Path,
    *,
    judge_id: str,
    verdict: str,
    group: str = "judge:tool-a:run-1:F-1",
    confidence: float = 0.9,
) -> None:
    record_operator_feedback(
        tool_id="tool-a",
        run_id="run-1",
        finding_id="F-1",
        verdict=verdict,
        severity="high",
        note=f"{judge_id} verdict",
        source_type="ai_judge",
        judge_id=judge_id,
        confidence=confidence,
        evidence_refs=[f"aria-kernel/aria_kernel/judge_fanout.py:{len(judge_id)}"],
        judgment_group_id=group,
        base_dir=tools,
    )


class GoldsetCurationMinterTest(_ToolsDirTest):
    def _label_to_ready(self) -> dict:
        _label(self.tools, "tool-a", 1, "true_positive")
        _label(self.tools, "tool-a", 2, "false_positive")
        return propose_goldsets_for_labelled_tools(
            cycle_id="cyc-1",
            base_dir=self.tools,
            target_true_positives=1,
            target_known_false_positives=1,
            target_sha="a" * 40,
        )

    def test_a_ready_proposal_mints_the_curator_envelope(self) -> None:
        result = self._label_to_ready()

        self.assertEqual(result["ready_tool_ids"], ["tool-a"])
        self.assertEqual([r["tool_id"] for r in result["curation_requests"]], ["tool-a"])
        requests = self._requests(GOLDSET_CURATION_ROLE)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["role"], GOLDSET_CURATION_ROLE)
        self.assertEqual(requests[0]["target_agent"], GOLDSET_CURATOR_AGENT)
        self.assertEqual(requests[0]["target_sha"], "a" * 40)

    def test_a_blocked_proposal_mints_nothing(self) -> None:
        # A curator asked to draft from a corpus that is still short can only
        # repeat the blocker the ledger already states, at LLM cost.
        _label(self.tools, "tool-b", 1, "true_positive")

        result = propose_goldsets_for_labelled_tools(cycle_id="cyc-1", base_dir=self.tools)

        self.assertEqual(result["ready_tool_ids"], [])
        self.assertEqual(result["curation_requests"], [])
        self.assertEqual(self._requests(GOLDSET_CURATION_ROLE), [])

    def test_the_same_corpus_state_is_never_sent_twice(self) -> None:
        self._label_to_ready()
        first = len(self._requests(GOLDSET_CURATION_ROLE))

        # A later cycle re-proposes the same picture directly (the producer's
        # unchanged-guard is not the thing under test here — the subject guard
        # is): the curator must not be asked the same question again.
        from aria_kernel.goldset import dispatch_goldset_curation, list_goldset_proposals

        proposal = list_goldset_proposals(base_dir=self.tools)[-1]
        again = dispatch_goldset_curation(
            tool_id="tool-a",
            proposal=proposal,
            cycle_id="cyc-2",
            base_dir=self.tools,
            target_sha="b" * 40,
        )

        self.assertIsNone(again)
        self.assertEqual(len(self._requests(GOLDSET_CURATION_ROLE)), first)


class ChangeIntelligenceMinterTest(_ToolsDirTest):
    def _merge(self, *, pr_number: int = 7, head_sha: str = "c" * 40) -> None:
        record_pr_lifecycle(
            {
                "number": pr_number,
                "head_sha": head_sha,
                "base_branch": "main",
                "changed_files": ["apps/farm-service/src/batch/batch.service.ts"],
            },
            event="merged",
            base_dir=self.tools,
        )

    def test_a_merge_becomes_a_merge_event_and_one_envelope(self) -> None:
        self._merge()

        ingest = ingest_merged_pr_lifecycle(base_dir=self.tools)
        dispatch = dispatch_change_intelligence(cycle_id="cyc-1", base_dir=self.tools)

        self.assertEqual(len(ingest["ingested"]), 1)
        self.assertEqual(len(dispatch["minted"]), 1)
        request = self._requests(CHANGE_INTELLIGENCE_ROLE)[0]
        self.assertEqual(request["role"], CHANGE_INTELLIGENCE_ROLE)
        self.assertEqual(request["target_agent"], CHANGE_INTELLIGENCE_AGENT)
        # Anchored to the merged head, not the workspace head: the question is
        # what THAT merge invalidated.
        self.assertEqual(request["target_sha"], "c" * 40)
        self.assertIn(
            change_intelligence_subject_ref(pr_number=7, head_sha="c" * 40),
            request["evidence_refs"],
        )

    def test_re_running_the_phase_asks_about_the_merge_once(self) -> None:
        self._merge()
        ingest_merged_pr_lifecycle(base_dir=self.tools)
        dispatch_change_intelligence(cycle_id="cyc-1", base_dir=self.tools)

        second_ingest = ingest_merged_pr_lifecycle(base_dir=self.tools)
        second_dispatch = dispatch_change_intelligence(cycle_id="cyc-2", base_dir=self.tools)

        self.assertEqual(second_ingest["ingested"], [])
        self.assertEqual(second_ingest["already_known"], 1)
        self.assertEqual(second_dispatch["minted"], [])
        self.assertEqual(len(self._requests(CHANGE_INTELLIGENCE_ROLE)), 1)

    def test_a_backlog_is_drained_newest_first_under_a_mint_budget(self) -> None:
        # The first run after this producer lands sees every merge ever
        # recorded; an unbounded mint would turn that backlog into one night's
        # LLM bill.
        for pr_number in range(1, 6):
            self._merge(pr_number=pr_number, head_sha=str(pr_number) * 40)
        ingest_merged_pr_lifecycle(base_dir=self.tools)

        first = dispatch_change_intelligence(
            cycle_id="cyc-1", base_dir=self.tools, max_requests=2,
        )
        second = dispatch_change_intelligence(
            cycle_id="cyc-2", base_dir=self.tools, max_requests=2,
        )

        self.assertEqual([m["pr_number"] for m in first["minted"]], [5, 4])
        self.assertEqual([m["pr_number"] for m in second["minted"]], [3, 2])
        self.assertIn(
            "mint_budget_exhausted", [s["reason"] for s in second["skipped"]],
        )

    def test_a_second_merge_gets_its_own_envelope(self) -> None:
        self._merge()
        ingest_merged_pr_lifecycle(base_dir=self.tools)
        dispatch_change_intelligence(cycle_id="cyc-1", base_dir=self.tools)

        self._merge(pr_number=8, head_sha="d" * 40)
        ingest_merged_pr_lifecycle(base_dir=self.tools)
        dispatch_change_intelligence(cycle_id="cyc-2", base_dir=self.tools)

        self.assertEqual(len(self._requests(CHANGE_INTELLIGENCE_ROLE)), 2)


class ConsensusArbitrationMinterTest(_ToolsDirTest):
    def test_a_split_verdict_mints_the_arbiter(self) -> None:
        _judge_vote(self.tools, judge_id="aria-evidence-judge", verdict="true_positive")
        _judge_vote(self.tools, judge_id="aria-adversarial-judge", verdict="false_positive")

        splits = split_verdict_groups(tool_id="tool-a", base_dir=self.tools)
        result = dispatch_arbiter_for_split_verdicts(
            tool_id="tool-a", base_dir=self.tools, cycle_id="cyc-1", target_sha="e" * 40,
        )

        self.assertEqual(len(splits), 1)
        self.assertEqual(len(result["minted"]), 1)
        request = self._requests(CONSENSUS_ARBITRATION_ROLE)[0]
        self.assertEqual(request["role"], CONSENSUS_ARBITRATION_ROLE)
        self.assertEqual(request["target_agent"], CONSENSUS_ARBITER_AGENT)
        self.assertEqual(request["judgment_group_id"], "judge:tool-a:run-1:F-1")
        # The arbiter's verdict must land in the SAME group as a third vote,
        # so the consensus engine can settle the finding.
        self.assertEqual(request["finding_id"], "F-1")
        self.assertEqual(request["run_id"], "run-1")

    def test_agreeing_judges_are_not_arbitrated(self) -> None:
        _judge_vote(self.tools, judge_id="aria-evidence-judge", verdict="true_positive")
        _judge_vote(self.tools, judge_id="aria-adversarial-judge", verdict="true_positive")

        result = dispatch_arbiter_for_split_verdicts(tool_id="tool-a", base_dir=self.tools)

        self.assertEqual(split_verdict_groups(tool_id="tool-a", base_dir=self.tools), [])
        self.assertEqual(result["minted"], [])

    def test_one_judge_alone_is_not_a_split(self) -> None:
        _judge_vote(self.tools, judge_id="aria-evidence-judge", verdict="true_positive")

        self.assertEqual(split_verdict_groups(tool_id="tool-a", base_dir=self.tools), [])

    def test_the_same_split_is_arbitrated_once(self) -> None:
        _judge_vote(self.tools, judge_id="aria-evidence-judge", verdict="true_positive")
        _judge_vote(self.tools, judge_id="aria-adversarial-judge", verdict="false_positive")
        dispatch_arbiter_for_split_verdicts(
            tool_id="tool-a", base_dir=self.tools, cycle_id="cyc-1",
        )

        second = dispatch_arbiter_for_split_verdicts(
            tool_id="tool-a", base_dir=self.tools, cycle_id="cyc-2",
        )

        self.assertEqual(second["minted"], [])
        self.assertEqual(second["skipped"][0]["reason"], "already_dispatched")
        self.assertEqual(len(self._requests(CONSENSUS_ARBITRATION_ROLE)), 1)

    def test_a_settled_group_is_never_arbitrated(self) -> None:
        _judge_vote(self.tools, judge_id="aria-evidence-judge", verdict="true_positive")
        _judge_vote(self.tools, judge_id="aria-adversarial-judge", verdict="false_positive")
        record_operator_feedback(
            tool_id="tool-a", run_id="run-1", finding_id="F-1",
            verdict="true_positive", severity="high", note="consensus",
            source_type="ai_consensus", judge_id="aria-consensus-arbiter",
            judgment_group_id="judge:tool-a:run-1:F-1", judge_count=2,
            judges_voted=2, base_dir=self.tools,
        )

        self.assertEqual(split_verdict_groups(tool_id="tool-a", base_dir=self.tools), [])


class ArbitrationBeforeEscalationTest(_ToolsDirTest):
    """One authority per question: the split goes to the arbiter first.

    The HUMAN_REQUIRED adjudication panel for a consensus escalation dispatches
    three agents — and one of them IS `aria-consensus-arbiter`. Raising the
    escalation while arbitration is in flight asks the same agent the same
    question twice.
    """

    def _split_and_record_uncertainty(self) -> None:
        _judge_vote(self.tools, judge_id="aria-evidence-judge", verdict="true_positive")
        _judge_vote(self.tools, judge_id="aria-adversarial-judge", verdict="false_positive")
        # The real producer of the uncertainty row: the mechanical gate that
        # refuses to settle a split.
        result = generate_ai_consensus(tool_id="tool-a", base_dir=self.tools)
        self.assertEqual(
            [u["reason"] for u in result["uncertainties"]], ["judge_disagreement"],
        )

    def test_escalation_waits_while_arbitration_is_in_flight(self) -> None:
        self._split_and_record_uncertainty()
        dispatch_arbiter_for_split_verdicts(tool_id="tool-a", base_dir=self.tools)

        result = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)

        self.assertEqual(result["created"], [])
        self.assertEqual(result["skipped"][0]["reason"], "arbitration_in_flight")

    def test_without_arbitration_the_escalation_still_reaches_the_operator(self) -> None:
        # Nothing is dropped, only ordered: a split with no arbiter in flight
        # escalates exactly as it did before.
        self._split_and_record_uncertainty()

        result = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)

        self.assertEqual(len(result["created"]), 1)


class RemovedRolesTest(_ToolsDirTest):
    def test_the_surface_no_longer_admits_them(self) -> None:
        for role in REMOVED_ROLES:
            self.assertNotIn(role, REQUEST_ROLES, role)
            self.assertNotIn(role, ROLE_TARGET_PAIRING, role)
            self.assertNotIn(role, ROLE_CAP_MAP, role)

    def test_the_mint_seam_refuses_them(self) -> None:
        for role in REMOVED_ROLES:
            with self.subTest(role=role):
                with self.assertRaisesRegex(GovernanceError, "unknown invocation role"):
                    create_agent_invocation_request(
                        target_agent="architectural-arbiter",
                        role=role,
                        suggested_prompt="review this",
                        must_satisfy=[{"id": "MS-1", "criterion": "review"}],
                        allowed_scope=["**"],
                        base_dir=self.tools,
                    )

    def test_the_envelope_validator_refuses_them(self) -> None:
        for role in REMOVED_ROLES:
            with self.subTest(role=role):
                with self.assertRaises(GovernanceError):
                    validate_request({
                        "$schema": "aria/agent-request/v1",
                        "request_id": "req-removed-001",
                        "role": role,
                        "target_agent": "architectural-arbiter",
                        "evidence_refs": ["docs/aria/SPEC.md:1"],
                        "allowed_scope": ["aria-kernel/**"],
                        "forbidden_scope": ["secrets/**"],
                        "must_satisfy": [{"id": "MS-1", "statement": "review it"}],
                        "validation_commands": [],
                        "expected_output_path": "aria-tools/agent-invocations/results/x.json",
                    })

    def test_every_surviving_role_pairing_targets_a_whitelisted_agent(self) -> None:
        from aria_kernel.agent_surface import DEFAULT_TARGET_AGENT_WHITELIST

        for role, targets in ROLE_TARGET_PAIRING.items():
            for target in targets:
                self.assertIn(target, DEFAULT_TARGET_AGENT_WHITELIST, f"{role} -> {target}")


class SubjectIdempotencySeamTest(_ToolsDirTest):
    def test_the_same_subject_in_a_new_cycle_is_still_recognised(self) -> None:
        # WHY the seam exists: request_id folds cycle_id in, so the identity
        # collapse alone cannot stop a nightly producer from re-minting for a
        # subject that outlives its cycle.
        first = create_agent_invocation_request(
            target_agent=CHANGE_INTELLIGENCE_AGENT,
            role=CHANGE_INTELLIGENCE_ROLE,
            suggested_prompt="analyse merge",
            must_satisfy=[{"id": "MS-1", "criterion": "impact map"}],
            allowed_scope=["**"],
            evidence_refs=["merged-pr:1:abc"],
            cycle_id="cyc-1",
            base_dir=self.tools,
        )
        second = create_agent_invocation_request(
            target_agent=CHANGE_INTELLIGENCE_AGENT,
            role=CHANGE_INTELLIGENCE_ROLE,
            suggested_prompt="analyse merge",
            must_satisfy=[{"id": "MS-1", "criterion": "impact map"}],
            allowed_scope=["**"],
            evidence_refs=["merged-pr:1:abc"],
            cycle_id="cyc-2",
            base_dir=self.tools,
        )

        self.assertNotEqual(first["request_id"], second["request_id"])
        self.assertIn(
            "merged-pr:1:abc",
            minted_subject_refs(
                role=CHANGE_INTELLIGENCE_ROLE,
                target_agent=CHANGE_INTELLIGENCE_AGENT,
                base_dir=self.tools,
            ),
        )

    def test_an_unasked_subject_is_not_invented(self) -> None:
        self.assertEqual(
            minted_subject_refs(
                role=CHANGE_INTELLIGENCE_ROLE,
                target_agent=CHANGE_INTELLIGENCE_AGENT,
                base_dir=self.tools,
            ),
            set(),
        )


class DispatchableRolesTest(unittest.TestCase):
    """Minting and draining are one contract.

    `ci_executor.claim_and_dispatch_one` refuses a role outside
    `DISPATCHABLE_ROLES`, so a producer for a non-dispatchable role would fill
    the queue with envelopes no consumer may claim — alive in the ledger, dead
    on the lane, which is the same defect class E14 removes.
    """

    def test_every_role_with_a_new_producer_can_be_claimed(self) -> None:
        from aria_kernel.agent_surface import DISPATCHABLE_ROLES

        for role in (
            GOLDSET_CURATION_ROLE,
            CHANGE_INTELLIGENCE_ROLE,
            CONSENSUS_ARBITRATION_ROLE,
        ):
            self.assertIn(role, DISPATCHABLE_ROLES, role)

    def test_the_executor_standalone_fallback_does_not_drift(self) -> None:
        # The fallback literal in ci_executor is only used when the kernel
        # import fails — the one mode where a narrower copy is invisible.
        import re

        from aria_kernel.agent_surface import DISPATCHABLE_ROLES

        source = (
            Path(__file__).resolve().parents[2]
            / "tools" / "aria-poc" / "ci_executor.py"
        ).read_text(encoding="utf-8")
        match = re.search(
            r"_DISPATCHABLE_ROLES = frozenset\(\{(.*?)\}\)", source, re.DOTALL,
        )
        self.assertIsNotNone(match, "ci_executor fallback literal not found")
        assert match is not None  # for type-checkers
        fallback = set(re.findall(r'"([a-z_]+)"', match.group(1)))
        self.assertEqual(fallback, set(DISPATCHABLE_ROLES))


class PhaseWiringTest(unittest.TestCase):
    def test_change_intelligence_runs_every_cycle_and_cannot_fail_it(self) -> None:
        names = [p.name for p in cycle_mod.CYCLE_PHASES]
        self.assertIn("change_intelligence", names)
        # Before pressure: a merge that invalidated evidence must mark it
        # needs_revalidation in the same cycle the ranking reads it.
        self.assertLess(names.index("change_intelligence"), names.index("pressure"))
        phase = next(p for p in cycle_mod.CYCLE_PHASES if p.name == "change_intelligence")
        self.assertEqual(phase.precondition, cycle_mod.WRITES_PERMITTED)
        self.assertEqual(phase.on_error, "record_and_continue")

    def test_the_judgment_pipeline_reports_its_arbitrations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            tools.mkdir(parents=True)
            _judge_vote(tools, judge_id="aria-evidence-judge", verdict="true_positive")
            _judge_vote(tools, judge_id="aria-adversarial-judge", verdict="false_positive")
            context = cycle_mod.build_phase_context(
                cycle_id="cyc-arb", workspace_root=Path(tmp), base_dir=tools,
            )
            from unittest.mock import patch

            with patch.object(cycle_mod, "list_tools", return_value=[{"tool_id": "tool-a"}]), \
                 patch("aria_kernel.feedback_store.generate_judgment_sample",
                       return_value={"items": []}), \
                 patch("aria_kernel.convergence_drainer._resolve_workspace_head_sha",
                       return_value="f" * 40):
                result = cycle_mod._phase_judgment_pipeline(context)

            self.assertEqual(result["arbiter_requests_minted"], 1)
            self.assertEqual(
                list_agent_invocation_requests(
                    base_dir=tools, role=CONSENSUS_ARBITRATION_ROLE,
                )[0]["target_sha"],
                "f" * 40,
            )


if __name__ == "__main__":
    unittest.main()
