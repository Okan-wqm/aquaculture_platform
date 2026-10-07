"""ARIA-HIGH-381 — a file a finding cites is not a file its plan must write.

Measured on plan ``plan-cyc-20261007T081056Z-auto`` (aria/state, 2026-10-07):
operator request OP-F015-20261007-1 asked for the F-015 fix "inside hr-module
(the contracts in shared-ui and hr-service are read-only evidence)". Admission
turned both cited files into ``affected_surfaces``; key-change-0's ``paths``
and the round obligation pinned ``leave-request.entity.ts``; both planners
narrowed the paths to honour the operator; the cross-reviewer flagged the
narrowing in both rounds (CR-006) because staging hands the same path set to
the change ledger, which refuses an intended file the diff leaves untouched.
The plan ended HUMAN_REQUIRED.

These pins drive the production provider over the shared operator-request
fixture with the F-015 subject (the hr-module filter drifting from the
hr-service enum), then start the plan, derive its round contract, and stage
its change the way ``apply_engine`` does. Imports of the new module are local
to the tests that need it, so each test fails on its own assertion before the
fix, not on a collection error.
"""
from __future__ import annotations

import sys
from pathlib import Path

from aria_kernel.apply_engine import _intended_files_from_plan
from aria_kernel.change_ledger import emit_change_planned, verify_change_scope
from aria_kernel.evidence_validator import _path_matches_any_glob
from aria_kernel.operator_feedback_signature import (
    SCHEMA_INVALID,
    operator_request_schema_reason,
    record_operator_request,
)
from aria_kernel.operator_request_signature import allowed_signers_for_checkout
from aria_kernel.plan_convergence import fold_plan_state, start_plan
from aria_kernel.plan_origin import paths_outside_admission_scope
from aria_kernel.plan_round_scope import plan_round_contract
from aria_kernel.tool_registry import GovernanceError
from tests.test_finding_plan_path import _ENTITY, _PAGE, _ProviderFixture

_SEEDER_DIR = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
_MOVED = {"verdict": "reproduces", "reason": "subject_in_scan", "wire": "ok",
          "matches": [f"{_PAGE}:389", f"{_ENTITY}:18"]}


class _F015(_ProviderFixture):
    """F-015 as minted: the copy (the hr-module filter) first, the contract (the hr-service enum) second."""

    def setUp(self) -> None:
        super().setUp()
        self.seed_drift("F-015", 389)
        self.verdict = dict(_MOVED)

    def request(self, request_id: str, **extra) -> dict:
        return record_operator_request(
            request="Fix F-015 at its root; keep every change inside hr-module.", priority="high",
            authored_by="okan", finding_id="F-015", signing_key=self.fx.key, signer_principal=self.fx.principal,
            actor_class="T0", request_id=request_id, base_dir=self.fx.tools, repo_root=self.fx.repo,
            subject_stream=self.fx.subjects, **extra)

    def started(self, content: dict, plan_id: str = "plan-f015") -> dict:
        start_plan(plan_id=plan_id, plan_content=content, initial_revision_id=f"{plan_id}-r1",
                   base_dir=self.fx.tools, workspace_root=self.fx.repo)
        return fold_plan_state(plan_id=plan_id, base_dir=self.fx.tools)


class ARequestSignedWithoutABoundary(_F015):
    """OP-F015's shape: signed before ``write_roots`` existed, so the finding's fix target decides."""

    def test_the_cited_contract_is_evidence_not_a_key_change_path(self) -> None:
        self.request("OP-F015-legacy")
        content = self.synthesize("cyc-f015").content
        self.assertEqual(content["affected_surfaces"], [_PAGE])
        self.assertEqual([change["paths"] for change in content["key_changes"]], [[_PAGE]])
        # Still cited: the planner reads the contract it must derive from.
        self.assertIn(f"{_ENTITY}:18", content["evidence_refs"])

    def test_the_round_obligation_and_scope_leave_the_contract_read_only(self) -> None:
        self.request("OP-F015-legacy")
        state = self.started(self.synthesize("cyc-f015").content)
        scope = state["plan_started"]["admission_scope"]
        self.assertEqual(scope["admitted_surfaces"], [_PAGE])
        self.assertEqual(scope["evidence_surfaces"], [_ENTITY])
        self.assertNotIn("apps/hr-service", scope["closure_roots"])
        contract = plan_round_contract(state)
        self.assertEqual([item["paths"] for item in contract.must_satisfy], [[_PAGE]])
        # The planner's prompt lists it under the read-only evidence scope ...
        self.assertIn(_ENTITY, contract.evidence_scope)
        # ... and no scope entry a round may write covers it.
        self.assertFalse(_path_matches_any_glob(_ENTITY, list(contract.allowed_scope)))
        # A revision that puts it back is refused by the bound.
        self.assertEqual(paths_outside_admission_scope(scope, [_PAGE, _ENTITY]), [_ENTITY])

    def test_the_conformance_gate_accepts_a_diff_that_leaves_the_contract_alone(self) -> None:
        self.request("OP-F015-legacy")
        content = self.synthesize("cyc-f015").content
        intended = _intended_files_from_plan(content)
        self.assertEqual(intended, [_PAGE])
        planned = emit_change_planned(plan_id="plan-f015", finding_id="F-015", intended_affected_files=intended,
                                      intended_validation_refs=["nx:test"], architectural_tier=1,
                                      base_dir=self.fx.tools)
        # No disposition is owed for a file the plan never intended to write.
        _row, uncovered, _dispositions = verify_change_scope(
            change_id=planned["change_id"], actual_affected_files=[_PAGE], base_dir=self.fx.tools)
        self.assertEqual(uncovered, [])
        # Writing the contract is drift, not completeness.
        with self.assertRaisesRegex(GovernanceError, "scope_drift_requires_human"):
            verify_change_scope(change_id=planned["change_id"], actual_affected_files=[_PAGE, _ENTITY],
                                base_dir=self.fx.tools)


class ARequestThatDeclaresItsBoundary(_F015):
    """``write_roots`` is signed with the row: it overrides the derivation either way."""

    def test_declared_roots_choose_the_write_set(self) -> None:
        row = self.request("OP-F015-backend", write_roots=["apps/hr-service"])
        self.assertEqual(row["write_roots"], ["apps/hr-service"])
        content = self.synthesize("cyc-backend").content
        self.assertEqual(content["affected_surfaces"], [_ENTITY])
        self.assertEqual([change["paths"] for change in content["key_changes"]], [[_ENTITY]])
        self.assertIn(f"{_PAGE}:389", content["evidence_refs"])

    def test_a_boundary_that_leaves_nothing_to_change_is_refused_before_signing(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "finding_write_scope_empty"):
            self.request("OP-F015-nowhere", write_roots=["libs/shared-contracts"])
        with self.assertRaisesRegex(GovernanceError, "operator_request_write_roots_invalid"):
            self.request("OP-F015-glob", write_roots=["web/modules/**"])

    def test_a_signed_row_with_a_malformed_boundary_is_schema_invalid(self) -> None:
        signers, _reason = allowed_signers_for_checkout(self.fx.repo, base_dir=self.fx.tools)
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
        for bad in (["../etc"], [], "web/modules/hr-module", ["aria-kernel/aria_kernel"]):
            row = self.fx.request_row(finding_id="F-015", write_roots=bad)
            self.assertEqual(operator_request_schema_reason(row, now=now, anchor=signers), SCHEMA_INVALID, bad)
        good = self.fx.request_row(finding_id="F-015", write_roots=["web/modules/hr-module"])
        self.assertIsNone(operator_request_schema_reason(good, now=now, anchor=signers))


class AnUnattendedDriftFinding(_F015):
    def test_the_f_plan_writes_only_the_copy_side(self) -> None:
        content = self.synthesize("cyc-unattended").content
        self.assertEqual(content["finding_id"], "F-015")
        self.assertEqual(content["affected_surfaces"], [_PAGE])
        self.assertEqual([change["paths"] for change in content["key_changes"]], [[_PAGE]])
        self.assertIn(f"Read-only evidence, never written: {_ENTITY}", content["summary"])


class TheSplitRule(_F015):
    def test_the_seeder_writes_the_copy_side_first(self) -> None:
        from aria_kernel.plan_write_scope import DRIFT_COPY_SIDES, DRIFT_SIDE_ORDER

        sys.path.insert(0, str(_SEEDER_DIR))
        import seed_drift_findings as seeder

        self.assertEqual(seeder.SIDE_KEYS, DRIFT_SIDE_ORDER)
        for copy, contract in (("ui", "source"), ("ts", "sql")):
            drift = {contract: {"reference": "b.ts:1", "declared_name": "B", "declared_values": []},
                     copy: {"reference": "a.ts:1", "declared_name": "A", "declared_values": []}}
            drift = {key: drift[key] for key in (contract, copy)}  # insertion order: contract first
            for key in drift:
                drift[key]["ref"] = drift[key]["reference"]
            self.assertIn(copy, DRIFT_COPY_SIDES)
            self.assertEqual(seeder.drift_evidences(drift)[0]["ref"], "a.ts:1")

    def test_a_finding_that_names_no_fix_target_stays_undivided(self) -> None:
        from aria_kernel.plan_write_scope import WRITE_BASIS_UNDIVIDED, split_surfaces

        split = split_surfaces([_PAGE, _ENTITY], record={"originating_skill": "ai_consensus:judgment_pipeline"},
                               write_roots=None, repo_root=self.fx.repo)
        self.assertEqual((split.write, split.evidence, split.basis), ((_PAGE, _ENTITY), (), WRITE_BASIS_UNDIVIDED))


if __name__ == "__main__":
    import unittest

    unittest.main()
