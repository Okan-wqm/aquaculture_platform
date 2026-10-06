"""ARIA-HIGH-357 (ADR-0021 D9) — a planning round may cite the contracts its plan consumes.

Measured 2026-10-05 on the F-007 plan. Its admission bound is the admitted
surfaces (`LeavesPage.tsx`, `leave-request.entity.ts`) and their changed and
downstream project roots (`apps/hr-service`, `web/modules/hr-module`). The
contract the leave filter should render is the generated `LeaveRequestStatus`
in `web/shared-ui/src/generated/graphql-types.ts`. hr-module already imports
`@aquaculture/shared-ui`, but shared-ui is upstream of the change, so it lies
outside the bound. The response law refuses a cited ref outside the envelope's
allowed scope. No planner or reviewer could cite the shared contract. The
round-1 challenger imported the backend entity into the web module instead,
and the reviewer flagged it (CR-005) and asked for "scope widening to a shared
contract library".

D9 records the roots of the projects the admitted surfaces import as a
read-only evidence scope. Every planning-round envelope carries it, derived by
the mint from the plan's record. The response law admits a citation there. The
write bound (D2-D4) is unchanged: a body naming such a path is still refused.

Fixture: the four-project workspace of `test_revision_scope_bound`, in which
farm-service imports shared-lib and gateway imports farm-service.
"""
from __future__ import annotations

import subprocess
import unittest

from aria_kernel.agent_invocations import create_agent_invocation_request, render_invocation_prompt
from aria_kernel.evidence_validator import validate_agent_response_evidence
from aria_kernel.plan_origin import REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE, validate_admission_scope
from aria_kernel.plan_round_scope import plan_round_contract
from aria_kernel.plan_convergence import fold_plan_state
from aria_kernel.tool_registry import GovernanceError
from tests.test_revision_scope_bound import FARM, SHARED, _body, _ScopeBoundFixture, _seed


class DependencyEvidenceScope(_ScopeBoundFixture):
    def _farm_plan(self) -> str:
        return self._start(_seed(self.root, "operator_feedback", "F-007", [FARM]))

    def _challenger_envelope(self, plan_id: str) -> dict:
        state = fold_plan_state(plan_id=plan_id, base_dir=self.tools)
        contract = plan_round_contract(state)
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.root, text=True,
                              capture_output=True, check=True).stdout.strip()
        return create_agent_invocation_request(
            target_agent="aria-challenger-planner", role="challenger_plan", suggested_prompt="plan",
            convergence_id=plan_id, round_number=1, must_satisfy=list(contract.must_satisfy),
            allowed_scope=list(contract.allowed_scope), evidence_refs=[f"{FARM}:1"],
            base_dir=self.tools, target_sha=head,
        )

    def test_the_record_names_the_imported_projects_roots_and_writes_none_of_them(self) -> None:
        scope = self._scope(self._farm_plan())
        self.assertEqual(scope["schema_version"], 3)
        self.assertEqual(scope["closure_roots"], ["apps/farm-service", "apps/gateway"])
        self.assertEqual(scope["dependency_roots"], ["libs/shared-lib"])

    def test_every_round_envelope_carries_the_plans_read_only_scope(self) -> None:
        row = self._challenger_envelope(self._farm_plan())
        self.assertEqual(row["evidence_scope"], ["libs/shared-lib/**"])
        self.assertNotIn("libs/shared-lib/**", row["allowed_scope"])
        self.assertIn("## Read-only evidence scope", render_invocation_prompt(row))

    def test_a_citation_of_the_consumed_contract_passes_the_response_law(self) -> None:
        row = self._challenger_envelope(self._farm_plan())
        response = {"evidence_refs": [f"{SHARED}:1"],
                    "satisfaction_matrix": [{"id": "key-change-0", "evidence_refs": [f"{SHARED}:1"]}]}
        verdict = validate_agent_response_evidence(response=response, workspace_root=self.root, request=row)
        self.assertNotIn("agent_evidence_outside_allowed_scope", [e["code"] for e in verdict["errors"]])
        self.assertTrue(verdict["valid"], verdict["errors"])

    def test_a_body_writing_the_consumed_contract_is_still_refused(self) -> None:
        plan_id = self._farm_plan()
        self._critiqued(plan_id)
        with self.assertRaisesRegex(GovernanceError, REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE):
            self._revise(plan_id, _body(_seed(self.root, "operator_feedback", "F-007", [FARM]), [FARM, SHARED]))


class ARecordThatPredatesD9(_ScopeBoundFixture):
    """A plan started before D9 carries a version-2 record: it keeps its bound and cites nothing more."""

    def _v2_state(self) -> dict:
        plan_id = self._start(_seed(self.root, "operator_feedback", "F-007", [FARM]))
        state = fold_plan_state(plan_id=plan_id, base_dir=self.tools)
        scope = dict(state["plan_started"]["admission_scope"])
        scope.pop("dependency_roots")
        scope["schema_version"] = 2
        state["plan_started"] = {**state["plan_started"], "admission_scope": scope}
        return state

    def test_a_version_two_record_validates_and_grants_no_evidence_scope(self) -> None:
        state = self._v2_state()
        validate_admission_scope(state["plan_started"]["admission_scope"], state["plan_started"]["plan_content"])
        contract = plan_round_contract(state)
        self.assertEqual(contract.evidence_scope, ())
        self.assertIn("apps/farm-service/**", contract.allowed_scope)

    def test_a_version_two_record_naming_dependency_roots_is_refused(self) -> None:
        state = self._v2_state()
        scope = {**state["plan_started"]["admission_scope"], "dependency_roots": ["libs/shared-lib"]}
        with self.assertRaisesRegex(GovernanceError, "predates dependency_roots"):
            validate_admission_scope(scope, state["plan_started"]["plan_content"])

    def test_a_version_three_record_with_a_non_canonical_root_is_refused(self) -> None:
        state = self._v2_state()
        scope = {**state["plan_started"]["admission_scope"], "schema_version": 3,
                 "dependency_roots": ["libs/shared-lib/../../etc"]}
        with self.assertRaisesRegex(GovernanceError, "dependency_roots must be an array of canonical"):
            validate_admission_scope(scope, state["plan_started"]["plan_content"])


if __name__ == "__main__":
    unittest.main()
