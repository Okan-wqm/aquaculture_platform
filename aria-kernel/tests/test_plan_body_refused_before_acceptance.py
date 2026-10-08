"""ARIA-HIGH-354 / ARIA-HIGH-355 review — a body the bridge would refuse is refused before acceptance.

Review of #1797 (2026-10-06): the submit judgment ran only the plan contract
before accepting a planner's answer. The bridge then judged the body's shape,
its origin, the admission bound (ADR-0021) and its evidence. An answer the
bridge refuses after acceptance is ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL. That
is an outcome no successor can change, so the plan died at once, while the
same mistake refused at the submit is reminted with its reasons.

Separately, a body's ``evidence_refs`` become the refs of every later planning
envelope of the plan, and the request mint refuses a state-store record. A
body citing one made every later mint for the plan raise, so the plan stalled
for 72 h. A coverage pointer is citable only for a round this plan measured.

The round-2 half: a synthetic coverage risk cites its manifest by pointer, so
every later planning envelope of the plan carries the pointer of every
measured round, and a planner citing the risk passes the law.
"""
from __future__ import annotations

import subprocess
import unittest

from aria_kernel.agent_invocations import create_agent_invocation_request, judge_claim_submission
from aria_kernel.evidence_validator import coverage_manifest_pointer, validate_agent_response_evidence
from aria_kernel.plan_convergence import (
    PLAN_EVIDENCE_POINTER_UNBOUND,
    PLAN_EVIDENCE_STATE_STORE_RECORD,
    _planning_source_context,
    fold_plan_state,
    plan_body_refusals,
)
from aria_kernel.plan_coverage import build_synthetic_risk
from aria_kernel.plan_origin import REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE
from aria_kernel.plan_round_scope import plan_round_contract
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.request_admission import admit_request
from tests.test_revision_scope_bound import FARM, SHARED, _body, _ScopeBoundFixture, _seed


class _Plan(_ScopeBoundFixture):
    def setUp(self) -> None:
        super().setUp()
        self.seed = _seed(self.root, "operator_feedback", "F-007", [FARM])
        self.plan_id = self._start(self.seed)
        self.manifest_ref = f"{self.tools.name}/coverage/{self.plan_id}-r1.json"
        (self.tools / "coverage").mkdir(parents=True, exist_ok=True)
        (self.tools / "coverage" / f"{self.plan_id}-r1.json").write_text("{}", encoding="utf-8")

    def state(self) -> dict:
        return fold_plan_state(plan_id=self.plan_id, base_dir=self.tools)

    def codes(self, body: dict) -> list[str]:
        return [code for code, _ in plan_body_refusals(self.state(), body, root=self.tools)]


class TheBridgeLawIsAskedBeforeAcceptance(_Plan):
    def test_a_body_inside_the_bound_with_repo_evidence_has_no_refusal(self) -> None:
        self.assertEqual(self.codes(_body(self.seed, [FARM])), [])

    def test_a_surface_outside_the_admission_bound(self) -> None:
        self.assertEqual(self.codes(_body(self.seed, [FARM, SHARED])), [REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE])

    def test_a_state_store_record_in_the_body_evidence(self) -> None:
        body = _body(self.seed, [FARM], evidence_refs=[*self.seed["evidence_refs"], self.manifest_ref])
        self.assertEqual(self.codes(body), [PLAN_EVIDENCE_STATE_STORE_RECORD])

    def test_a_coverage_pointer_for_a_round_the_plan_never_measured(self) -> None:
        pointer = coverage_manifest_pointer(self.manifest_ref)
        body = _body(self.seed, [FARM], evidence_refs=[*self.seed["evidence_refs"], pointer])
        self.assertEqual(self.codes(body), [PLAN_EVIDENCE_POINTER_UNBOUND])

    def test_the_bridge_keeps_the_evidence_refusal_as_its_last_line(self) -> None:
        self._critiqued(self.plan_id)
        body = _body(self.seed, [FARM], evidence_refs=[*self.seed["evidence_refs"], self.manifest_ref])
        with self.assertRaisesRegex(GovernanceError, PLAN_EVIDENCE_STATE_STORE_RECORD):
            self._revise(self.plan_id, body)

    def test_the_submit_judgment_rejects_the_answer_so_a_successor_can_be_minted(self) -> None:
        contract = plan_round_contract(self.state())
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.root, text=True,
                              capture_output=True, check=True).stdout.strip()
        request = create_agent_invocation_request(
            target_agent="aria-challenger-planner", role="challenger_plan", suggested_prompt="plan",
            convergence_id=self.plan_id, round_number=1, must_satisfy=list(contract.must_satisfy),
            allowed_scope=list(contract.allowed_scope), evidence_refs=[f"{FARM}:1"],
            base_dir=self.tools, target_sha=head,
            admission=admit_request("operator_cli.request", "challenger_plan", base_dir=self.tools),
        )
        envelope = {"request_id": request["request_id"], "role": "challenger_plan",
                    "plan_content": _body(self.seed, [FARM, SHARED])}
        judgment = judge_claim_submission(
            root=self.tools, claim_id="claim-1", agent_id="aria-challenger-planner", request=request,
            envelope=envelope, output=self.tools / "out.json", workspace_root=self.root,
        )
        self.assertIn(REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE, judgment.rejection_codes)


class EveryLaterPlanningEnvelopeCarriesTheMeasuredRoundsPointers(_Plan):
    def _measured(self) -> dict:
        state = self.state()
        state["coverage_by_round"] = {1: {"closure_manifest_path": self.manifest_ref}}
        return state

    def test_the_round_two_refs_carry_the_round_one_pointer(self) -> None:
        refs, _, _ = _planning_source_context(self._measured(), [f"{FARM}:1"])
        self.assertIn(coverage_manifest_pointer(self.manifest_ref), refs)
        self.assertEqual(refs.count(coverage_manifest_pointer(self.manifest_ref)), 1)

    def test_a_planner_citing_the_synthetic_risk_passes_the_law(self) -> None:
        risk = build_synthetic_risk({"node_id": "project:gateway", "kind": "nx_project", "why": "dependent"},
                                    round_number=1, closure_manifest_path=self.manifest_ref)
        self.assertEqual(risk["affected_files"], [], "a closure node names a project, not a file")
        refs, _, _ = _planning_source_context(self._measured(), [f"{FARM}:1"])
        request = {"role": "primary_plan", "allowed_scope": ["**"], "evidence_refs": refs}
        response = {"evidence_refs": risk["evidence_refs"],
                    "satisfaction_matrix": [{"id": "key-change-0", "evidence_refs": risk["evidence_refs"]}]}
        verdict = validate_agent_response_evidence(response=response, workspace_root=self.root, request=request)
        self.assertTrue(verdict["valid"], verdict["errors"])


class NoStepWaitsOnAStateNothingMovesOn(unittest.TestCase):
    """SUBMITTED (a legacy partial) has no exit; EXTERNAL_OUTAGE is retired (ARIA-HIGH-366)."""

    def disposition(self, state: str, role: str = "challenger_plan"):
        from unittest.mock import patch

        from aria_kernel import agent_invocations
        from aria_kernel.step_request import step_request_disposition

        with patch.object(agent_invocations, "derive_request_state", return_value=state):
            return step_request_disposition([{"request_id": "AIR-1"}], role=role, base_dir=".")

    def test_no_step_mints_a_successor_for_a_provider_outage_state(self) -> None:
        from aria_kernel.step_request import successor_eligible_states

        for role in ("challenger_plan", "completeness_critique"):
            with self.subTest(role=role):
                self.assertNotIn("EXTERNAL_OUTAGE", successor_eligible_states(role))

    def test_a_legacy_partial_is_an_outcome_not_a_wait(self) -> None:
        self.assertEqual(self.disposition("SUBMITTED").kind, "outcome")


class ThePromptNeverContradictsItsNewBlocks(unittest.TestCase):
    ROW = {"request_id": "AIR-1", "role": "primary_plan", "prompt_render_version": 6,
           "evidence_refs": ["a.ts:1"], "allowed_scope": ["a.ts"]}

    def test_the_corrective_instruction_renders_outside_the_data_tags(self) -> None:
        from aria_kernel.agent_invocations import render_invocation_prompt

        prompt = render_invocation_prompt({**self.ROW, "predecessor_rejection": {
            "request_id": "AIR-0", "rejection_codes": ["agent_evidence_path_missing"],
            "rejection_reasons": ["evidence: x"], "omitted_reasons": 0}})
        data_start = prompt.index('section="predecessor_rejection"')
        self.assertLess(prompt.index("Answer the same task without repeating them"), data_start)
        self.assertGreater(prompt.index("`agent_evidence_path_missing`"), data_start)

    def test_with_a_scope_every_rule_names_it_and_without_one_the_text_is_unchanged(self) -> None:
        from aria_kernel.agent_invocations import render_invocation_prompt

        scoped = render_invocation_prompt({**self.ROW, "evidence_scope": ["web/shared-ui/**"]})
        self.assertIn("with the read-only evidence scope below, the ONLY admissible evidence", scoped)
        self.assertIn("or files under the read-only evidence scope", scoped)
        plain = render_invocation_prompt(self.ROW)
        self.assertIn("## Evidence refs (file:line entries; the ONLY admissible evidence)", plain)
        self.assertIn("The envelope MUST cite ONLY evidence_refs present in this prompt + must stay "
                      "within allowed_scope. Output the JSON envelope", plain)
        self.assertNotIn("read-only evidence scope", plain)


if __name__ == "__main__":
    unittest.main()
