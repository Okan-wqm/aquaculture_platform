"""ARIA-MEDIUM-385 — what the submit law refuses, the mint refuses, for every role.

ARIA-HIGH-384 made the pressure lane hand agents only refs the agent evidence
law can admit, and named the rest as provenance. The mint itself still
refused only two shapes (a store record, ARIA-HIGH-354; ARIA's own output as
a planner's ONLY evidence, ARIA-HIGH-194), because producers outside the
pressure lane put kernel pointers into ``evidence_refs`` on purpose:
``cycle:<id>`` (review_runner, specialist_review_runner), ``plan:<id>``
(decision_questioning), ``seed:<id>`` / ``round:<n>`` /
``sandbox_result:precision=<p>`` (the genesis drafters and judges),
``merged-pr:<n>:<sha>`` and ``goldset-proposal:<tool>:<at>`` (the
change-intelligence and goldset subjects). An agent cites the refs its
envelope hands it, and the submit law refuses every one of these as
``agent_evidence_ref_malformed``: on aria/state (8e39b2eeb) the three
``verification`` envelopes of 2026-10-15/16 and the change-intelligence
envelope of 2026-10-13 were each refused for citing exactly that pointer.

Each pointer now rides on the field that owns it (``cycle_id``,
``convergence_id``, ``round_number``, the prompt, or ``subject_ref``), and
``create_agent_invocation_request`` refuses, for every role, an evidence ref
the agent law refuses by shape (``evidence_validator.agent_ref_mint_refusal``).
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.agent_invocations import (
    create_agent_invocation_request,
    list_agent_invocation_requests,
    minted_subject_refs,
)
from aria_kernel.agent_surface import allowed_targets_for_role
from aria_kernel.evidence_validator import agent_ref_shape_refusal
from aria_kernel.request_admission import admit_request
from aria_kernel.tool_registry import GovernanceError, bound_workspace_root, ensure_tools_dir
from aria_kernel import human_required_adjudication as hra
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.routing_fixture import write_routing_table
from tests.test_decision_questioning import _QuestioningFixture
from tests.test_y7_self_adjudication import _PanelCase

# Every kernel pointer a producer used to hand out, and one self-output ref.
UNCITABLE = (
    "cycle:cyc-385",
    "plan:plan-385",
    "seed:seed-385",
    "sandbox_result:precision=0.9",
    "merged-pr:7:" + "c" * 40,
    "goldset-proposal:tool-a:2026-10-17T00:00:00Z",
    "aria-findings/F-385.json",
)
ROLES = (
    "verification",
    "change_intelligence",
    "goldset_curation",
    "evidence_judgment",
    "adversarial_judgment",
    "maintenance_utility",
    "specialist_domain_review",
    "primary_authoring",
    "challenger_plan",
    "consensus_arbitration",
)


def _target(role: str) -> str:
    targets = allowed_targets_for_role(role)
    return targets[0] if targets else "aria-autonomy-planner"


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="aria-m385-"))
        self.addCleanup(shutil.rmtree, base, True)
        self.tools = ensure_tools_dir(base / "aria-tools")

    def mint(self, role: str, refs: list[str], **extra):
        return create_agent_invocation_request(
            target_agent=_target(role),
            role=role,
            suggested_prompt=f"answer as {role}",
            must_satisfy=[{"id": "MS-385", "description": "cite the repository"}],
            allowed_scope=["**"],
            evidence_refs=refs,
            base_dir=self.tools,
            admission=admit_request("operator_cli.request", role, base_dir=self.tools),
            **extra,
        )

    def assert_citable(self, row: dict) -> None:
        refused = [(ref, agent_ref_shape_refusal(ref)) for ref in row.get("evidence_refs") or []]
        self.assertEqual([item for item in refused if item[1] is not None], [], row["request_id"])


class TheMintRefusesForEveryRole(_Store):
    def test_a_pointer_the_submit_law_refuses_is_refused_at_the_mint(self) -> None:
        for role in ROLES:
            for ref in UNCITABLE:
                if role == "consensus_arbitration" and ref.startswith("aria-findings/"):
                    continue  # an arbitration role's own-output refs are the submit law's (below)
                with self.subTest(role=role, ref=ref), self.assertRaises(GovernanceError) as ctx:
                    self.mint(role, ["aria-kernel/aria_kernel/cycle.py:10", ref])
                self.assertIn("request_evidence_not_agent_citable", str(ctx.exception))
                self.assertIn(ref, str(ctx.exception))
        self.assertEqual(list_agent_invocation_requests(base_dir=self.tools), [])

    def test_a_citable_ref_and_a_kernel_ledger_pointer_still_mint(self) -> None:
        row = self.mint("verification", ["aria-kernel/aria_kernel/cycle.py:10", "human-required:AIR-x-1"])
        self.assertEqual(row["evidence_refs"], ["aria-kernel/aria_kernel/cycle.py:10", "human-required:AIR-x-1"])

    def test_an_arbitration_role_leaves_a_recorded_output_to_the_submit_law(self) -> None:
        # ORPHAN-CRITICAL-734: the submit law admits a kernel-recorded agent
        # output for these roles by its results ledger, a check the shape law
        # cannot make; a malformed pointer is refused for them all the same.
        row = self.mint("consensus_arbitration", ["aria-tools/agent-invocations/outputs/judge.md"])
        self.assertTrue(row["request_id"])

    def test_a_sealed_row_is_returned_not_judged_again(self) -> None:
        with mock.patch("aria_kernel.evidence_validator.agent_ref_mint_refusal", return_value=None):
            sealed = self.mint("verification", ["plan:plan-385"])
        self.assertEqual(self.mint("verification", ["plan:plan-385"]), sealed)


class ChangeIntelligenceNamesItsSubjectApart(_Store):
    def _merge(self, pr_number: int = 7, head_sha: str = "c" * 40) -> None:
        from aria_kernel.merge_record import MERGED_BY_MERGE_LANE, record_merge

        record_merge(
            pr={"number": pr_number, "head_sha": head_sha, "base_branch": "main",
                "changed_files": ["apps/farm-service/src/batch/batch.service.ts"]},
            merged_by=MERGED_BY_MERGE_LANE, base_dir=self.tools, head_lineage="delivered",
        )

    def test_the_merge_rides_as_the_subject_and_only_its_files_as_evidence(self) -> None:
        from aria_kernel.pr_tracking import (
            CHANGE_INTELLIGENCE_ROLE,
            change_intelligence_subject_ref,
            dispatch_change_intelligence,
        )

        self._merge()
        dispatch_change_intelligence(cycle_id="cyc-1", base_dir=self.tools)
        [row] = list_agent_invocation_requests(base_dir=self.tools, role=CHANGE_INTELLIGENCE_ROLE)
        self.assert_citable(row)
        self.assertEqual(row["evidence_refs"], ["apps/farm-service/src/batch/batch.service.ts"])
        self.assertEqual(row["subject_ref"], change_intelligence_subject_ref(pr_number=7, head_sha="c" * 40))
        second = dispatch_change_intelligence(cycle_id="cyc-2", base_dir=self.tools)
        self.assertEqual(second["minted"], [])

    def test_a_merge_asked_before_the_subject_field_is_not_asked_again(self) -> None:
        # The live ledger holds one such row (AIR-aria-change-intelligence-3b9613e70633).
        from aria_kernel.pr_tracking import (
            CHANGE_INTELLIGENCE_AGENT,
            CHANGE_INTELLIGENCE_ROLE,
            change_intelligence_subject_ref,
            dispatch_change_intelligence,
        )

        subject = change_intelligence_subject_ref(pr_number=7, head_sha="c" * 40)
        # The row as the pre-385 kernel sealed it: no subject_ref field, the
        # subject spelled as the first evidence ref.
        append_declared_fixture(
            self.tools / "agent-invocations" / "requests.jsonl",
            {
                "$schema": "aria/agent-request/v1", "schema_version": 1,
                "request_id": "AIR-aria-change-intelligence-3b9613e70633", "row_type": "request",
                "role": CHANGE_INTELLIGENCE_ROLE, "target_agent": CHANGE_INTELLIGENCE_AGENT,
                "suggested_prompt": "Plan the revalidation impact of this merge.",
                "must_satisfy": [{"id": "impact-map", "description": "impact map"}],
                "evidence_refs": [subject, "apps/farm-service/src/batch/batch.service.ts"],
                "allowed_scope": ["**"], "cycle_id": "cyc-0",
                "expected_output_path": str(self.tools / "out-ci.json"),
                "state": "pending", "created_at": "2026-10-13T10:39:52+00:00",
            },
            expected_surface="agent_invocation_requests",
        )
        self.assertIn(subject, minted_subject_refs(
            role=CHANGE_INTELLIGENCE_ROLE, target_agent=CHANGE_INTELLIGENCE_AGENT, base_dir=self.tools,
        ))
        self._merge()
        self.assertEqual(dispatch_change_intelligence(cycle_id="cyc-1", base_dir=self.tools)["minted"], [])


class GoldsetCurationNamesItsSubjectApart(_Store):
    def test_the_corpus_state_rides_as_the_subject(self) -> None:
        from aria_kernel.goldset import GOLDSET_CURATION_ROLE, propose_goldsets_for_labelled_tools
        from aria_kernel.feedback_store import record_operator_feedback

        for index, verdict in ((1, "true_positive"), (2, "false_positive")):
            record_operator_feedback(
                tool_id="tool-a", run_id=f"run-{index}", finding_id=f"F-{index}", verdict=verdict,
                severity="medium", note=f"label {index}",
                evidence_refs=[f"apps/hr-service/src/leave/leave.service.ts:{index}"], base_dir=self.tools,
            )
        propose_goldsets_for_labelled_tools(
            cycle_id="cyc-1", base_dir=self.tools, target_true_positives=1,
            target_known_false_positives=1, target_sha="a" * 40,
        )
        [row] = list_agent_invocation_requests(base_dir=self.tools, role=GOLDSET_CURATION_ROLE)
        self.assert_citable(row)
        self.assertTrue(row["subject_ref"].startswith("goldset-proposal:tool-a:"))


class GenesisDispatchersHandOutNoPointer(_Store):
    def test_the_drafter_and_judge_envelopes(self) -> None:
        from aria_kernel.dispatcher_factory import DispatcherConfig, select_drafter, select_judge

        # ARIA-HIGH-614 — the pack Phase 0 collected: observations over a
        # scan scope, bound to a commit. An envelope citing inside it is
        # answerable; the bare seed label no producer can answer from.
        pack = {
            "seed_id": "seed-385",
            "base_commit_sha": "a" * 40,
            "declared_scope": ["aria-kernel/"],
            "claim_types": ["api_contract"],
            "observations": [
                {"file_path": "aria-kernel/aria_kernel/cycle.py", "line": 10 + index,
                 "snippet": "def cycle():", "claim_class": "api_contract"}
                for index in range(3)
            ],
        }
        fast = DispatcherConfig({"poll_timeout_seconds": 0.05, "poll_interval_seconds": 0.01})
        drafter = select_drafter(role="primary_authoring", base_dir=self.tools, config=fast, cycle_id="cyc-385")
        drafter(seed_id="seed-385", must_satisfy=[{"id": "r", "description": "cite three refs"}],
                evidence_pack=pack, round_number=2)
        judge = select_judge(role="evidence_judgment", base_dir=self.tools, config=fast, cycle_id="cyc-385")
        judge(primary_draft={}, sandbox_result={"precision": 0.75}, evidence_pack=pack)

        drafted, judged = list_agent_invocation_requests(base_dir=self.tools)
        for row in (drafted, judged):
            self.assert_citable(row)
        self.assertEqual(drafted["round_number"], 2)
        self.assertIn("precision 0.75", judged["suggested_prompt"])


class ReviewEnvelopesCarryTheirCycleOnItsField(_Store):
    def _start_reviewed_plan(self, plan_id: str) -> None:
        # ARIA-HIGH-614 — Gate B derives the judge's citation box from the
        # plan it audits; production always reviews a plan the store holds.
        from aria_kernel.plan_convergence import start_plan

        start_plan(
            plan_id=plan_id,
            initial_revision_id=f"rev-{plan_id}-0",
            plan_content={
                "schema_version": 1,
                "title": f"Plan {plan_id}",
                "summary": "Review envelope fixture.",
                "key_changes": [{"id": "kc-1", "description": "fix the drift",
                                 "paths": ["aria-kernel/aria_kernel/cycle.py"]}],
                "evidence_refs": ["aria-kernel/aria_kernel/cycle.py:10"],
                "validation_commands": [{"cmd": "nx affected --target=test"}],
                "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/cycle.py"]}],
                "architectural_tier": 2,
            },
            base_dir=self.tools,
        )

    def test_the_post_implementation_judge(self) -> None:
        from aria_kernel.review_runner import run_review_runner

        self._start_reviewed_plan("plan-385")
        run_review_runner(
            cycle_id="cyc-385", base_dir=self.tools, workspace_root=None, plan_id="plan-385",
            convergence_id="plan-385", impl_artifacts_ref="cyc-385:sha256:abc",
            worker_artifact_hash="sha256:abc",
            must_satisfy=[{"id": "MS-1", "description": "the implementation closes the plan"}],
            max_review_rounds=1, judge_timeout_seconds=0.05,
        )
        [row] = list_agent_invocation_requests(base_dir=self.tools)
        self.assert_citable(row)
        self.assertEqual(row["cycle_id"], "cyc-385")

    def test_the_specialist_without_a_workspace(self) -> None:
        from aria_kernel.specialist_review_runner import run_specialist_review_runner

        self._start_reviewed_plan("plan-385")
        # The store's workspace routes the touched service to its specialist (SE-2).
        write_routing_table(bound_workspace_root(self.tools), {"apps/farm-service/**": ("farm-expert", "")})
        run_specialist_review_runner(
            cycle_id="cyc-385", base_dir=self.tools, workspace_root=None, plan_id="plan-385",
            convergence_id="plan-385", touched_services=["apps/farm-service/"], pressures=[],
            profile="standard", max_specialists_per_cycle=1, specialist_timeout_seconds=0.05,
        )
        rows = list_agent_invocation_requests(base_dir=self.tools)
        self.assertTrue(rows)
        for row in rows:
            self.assert_citable(row)
            self.assertEqual(row["cycle_id"], "cyc-385")


class DecisionQuestioningNamesThePlanByItsId(_QuestioningFixture):
    def test_the_verification_envelope(self) -> None:
        from aria_kernel.decision_questioning import QUESTIONING_ROLE, open_decision_questioning

        self._converge("plan-closed")
        open_decision_questioning(base_dir=self.tools_dir)
        [row] = list_agent_invocation_requests(base_dir=self.tools_dir, role=QUESTIONING_ROLE)
        refused = [ref for ref in row["evidence_refs"] if agent_ref_shape_refusal(ref) is not None]
        self.assertEqual(refused, [])
        self.assertEqual(row["convergence_id"], "plan-closed")


class PanelReMintOfAnUncitableRequestGoesToTheOperator(_PanelCase):
    """A dead request minted before the law, citing a pointer the submit law
    refuses, cannot be asked again as it was: the successor would be refused
    for citing it. The record is the operator's, as an obligation the
    contract refuses is (``dead_request_obligations_unmintable``)."""

    def _seed_dead_work_request(self, request_id: str) -> None:
        requests_path = self.tools / "agent-invocations" / "requests.jsonl"
        requests_path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(
            requests_path,
            {
                "$schema": "aria/agent-invocation-request/v1", "schema_version": 1, "request_id": request_id,
                # A live shape: challenger_plan rows of 2026-08-16 on aria/state
                # cite a gh-run-list pointer (agent_evidence_ref_malformed).
                "role": "challenger_plan", "target_agent": "aria-challenger-planner",
                "suggested_prompt": "plan the thing",
                "must_satisfy": [{"id": "S1", "description": "satisfy S1"}],
                "evidence_refs": ["gh-run-list:ci-run-31967879294", "aria-kernel/aria_kernel/cycle.py:10"],
                "allowed_scope": ["aria-kernel/**"],
                "expected_output_path": str(self.tools / f"out-{request_id}.json"),
                "state": "pending", "created_at": "2026-08-16T20:11:30Z",
            },
            expected_surface="agent_invocation_requests",
        )

    def test_the_record_is_stamped_not_re_asked(self) -> None:
        for rid, agent in zip(self._open(), ("judge-a", "judge-b", "judge-c")):
            self._seed_opinion(rid, agent_id=agent, verdict=hra.RESOLVE_VERDICT, disposition=hra.DISPOSITION_RE_MINT)
        hra.adjudicate_human_required(escalation_request_id=self.escalation_id, base_dir=self.tools)
        record = self._record()
        self.assertEqual(record["status"], "open")
        self.assertEqual(record["panel_escalation_reason"], "dead_request_evidence_not_agent_citable")
        self.assertIn("human_required_remint_evidence_not_agent_citable", self._governance_kinds())
        self.assertEqual(self._successors(), [])


class JudgeFanoutHandsOutOnlyCitableRefs(unittest.TestCase):
    def test_an_adapter_ref_the_law_refuses_stays_on_the_finding(self) -> None:
        from aria_kernel.judge_fanout import _evidence_refs

        item = {"path": "apps/farm-service/src/a.ts", "evidence": ["apps/farm-service/src/a.ts:3", "src/a.ts:10-20"]}
        self.assertEqual(_evidence_refs(item), ["apps/farm-service/src/a.ts", "apps/farm-service/src/a.ts:3"])


if __name__ == "__main__":
    unittest.main()
