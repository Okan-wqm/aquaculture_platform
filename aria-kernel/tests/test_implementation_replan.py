"""ARIA-HIGH-397 — a scope refusal that names a surface inside the signed write roots re-plans, bounded.

The fixture is a converged operator plan waiting on its implementation, in a
checkout whose allowed-signers file is committed on main: the operator
request is signed with a throwaway key and read back from the signed ledger,
exactly as the kernel reads it in production.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import convergence_drainer as cd
from aria_kernel import executor_convergence as ec
from aria_kernel.implementation_replan import (
    INELIGIBLE,
    MAX_REPLANS_PER_LINEAGE,
    REPLANNED,
    REPLANNED_KIND,
    implementer_surfaces,
    replan_after_refusal,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.operator_feedback_ingestion import PROVENANCE_REF_PREFIX, ingestion_ledger_path
from aria_kernel.plan_convergence import events_path, fold_plan_state
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.operator_requests import OperatorRequestFixture
from tests.test_executor_event_driven_planning import _PlanCase

_VERIFY = "aria_kernel.round_independence.verify_independence"
_LEASE = {ec.WRITER_LEASE_ENV: ec.WRITER_LEASE_HELD}
REQUEST_ID = "OP-T-REPLAN-1"
WRITE_SURFACE = "apps/farm-service/src/farm/farm.service.ts"
ENABLING = "apps/farm-service/tsconfig.json"


class _ConvergedOperatorPlan(_PlanCase):
    """An operator plan CONVERGED and its implementation request minted, in a signed checkout."""

    write_roots: list[str] | None = ["apps/farm-service"]

    def setUp(self) -> None:  # noqa: D401 — replaces _PlanCase.setUp: the store lives in the signed checkout
        from aria_kernel.cross_review_bridge import issue_implementation_envelope
        from aria_kernel.request_admission import admit_request

        self.tmp = tempfile.TemporaryDirectory(prefix="aria-replan-")
        self.addCleanup(self.tmp.cleanup)
        self.fx = OperatorRequestFixture(Path(self.tmp.name))
        self.root, self.tools = self.fx.repo, self.fx.tools
        agents = self.root / ".claude" / "agents"
        agents.mkdir(parents=True, exist_ok=True)
        for name, owns in (("farm-expert", "apps/farm-service/**"), ("access-boundary-auditor", "web/**")):
            (agents / f"{name}.md").write_text(f"---\nname: {name}\ndescription: r\n---\n\nOwns `{owns}`.\n",
                                               encoding="utf-8")
        extra = {} if self.write_roots is None else {"write_roots": self.write_roots}
        self.row = self.fx.append_raw(self.fx.sign(self.fx.request_row(id=REQUEST_ID, **extra)))
        cd.run_convergence_drainer(cycle_id="cyc-1", base_dir=self.tools, workspace_root=self.root,
                                   plan_id="plan-1", plan_seed=self.plan(), max_rounds=2)
        self.bind_synthesis("plan-1")
        self.answer_challenger()
        cd.run_convergence_drainer(cycle_id="cyc-2", base_dir=self.tools, workspace_root=self.root,
                                   plan_id="plan-1", plan_seed=self.plan(), max_rounds=2)
        self.answer_cross_review()
        with mock.patch(_VERIFY, return_value=(True, [])):
            cd.run_convergence_drainer(cycle_id="cyc-3", base_dir=self.tools, workspace_root=self.root,
                                       plan_id="plan-1", plan_seed=self.plan(), max_rounds=2)
        self.assertEqual(self.state(), "CONVERGED")
        issue_implementation_envelope(
            plan_id="plan-1", cross_review_revision_id="cr-1", cross_review_summary_text="{}",
            proposal_id="prop-1", change_id="chg-1", branch="aria-impl-1", base_sha="0" * 40,
            cycle_id="cyc-3", base_dir=self.tools,
            admission=admit_request("implementer.converged_plan", "implementation", base_dir=self.tools),
        )
        self.assertEqual(self.state(), "IMPLEMENTATION_REQUESTED")
        self.request_id = self.requests("implementation")[0]["request_id"]

    @staticmethod
    def plan() -> dict:
        plan = _PlanCase.plan()
        plan["affected_surfaces"] = [{"paths": [WRITE_SURFACE]}]
        plan["provenance_refs"] = [PROVENANCE_REF_PREFIX + REQUEST_ID]
        return plan

    def bind_synthesis(self, plan_id: str) -> None:
        """The ingestion that admitted the request and the binding the synthesizer writes."""
        from aria_kernel.operator_request_signature import request_subject_digest

        entry = {"id": REQUEST_ID, "ledger_hash": self.row["ledger_hash"], "signer": self.fx.principal,
                 "subject_digest": request_subject_digest(self.row)}
        path = ingestion_ledger_path(self.tools)
        ingestion = append_declared_fixture(path, {
            "schema_version": 3, "row_type": "ingestion", "cycle_id": "cyc-1", "admitted": [entry],
            "dropped": [], "spent": [], "refused": [],
        }, expected_surface="operator_feedback_ingestion")
        started = fold_plan_state(plan_id=plan_id, base_dir=self.tools)["plan_started"]["content_hash"]
        append_declared_fixture(path, {
            "schema_version": 3, "row_type": "synthesis_bound", "cycle_id": "cyc-1",
            "ingestion_ledger_hash": ingestion["ledger_hash"], "plan_content_hash": started,
            "candidate_id": REQUEST_ID, "source_type": "operator_feedback", "consumed": [entry],
        }, expected_surface="operator_feedback_ingestion")

    def replan(self, *, reason_class: str = "scope", named: tuple[str, ...] = (ENABLING,),
               environ: dict | None = None) -> dict:
        return replan_after_refusal(request_id=self.request_id, reason_class=reason_class, implementer_named=named,
                                    base_dir=self.tools, workspace_root=self.root, cycle_id="executor-run-1",
                                    environ=_LEASE if environ is None else environ)

    def rejection_of(self, plan_id: str) -> dict:
        return [row["payload"] for row in load_jsonl(events_path(self.tools))
                if row.get("plan_id") == plan_id and row.get("event_type") == "implementation_rejected"][-1]


class AScopeRefusalInsideTheSignedRootsReplans(_ConvergedOperatorPlan):
    def test_the_plan_is_handed_back_to_planning_as_a_bound_successor(self) -> None:
        outcome = self.replan()
        self.assertEqual(outcome["status"], REPLANNED, outcome)
        self.assertEqual(outcome["successor_plan_id"], "plan-1-rp1")
        payload = self.rejection_of("plan-1")
        self.assertEqual((payload["rejection_class"], payload["fault_domain"], payload["cause"]),
                         ("implementation_replanned", "harness", "scope"))
        successor = fold_plan_state(plan_id="plan-1-rp1", base_dir=self.tools)
        content = successor["plan_started"]["plan_content"]
        added = content["key_changes"][-1]
        self.assertEqual(added["paths"], [ENABLING])
        self.assertIn("apps/farm-service", added["description"])
        self.assertEqual(content["provenance_refs"], [PROVENANCE_REF_PREFIX + REQUEST_ID])
        # The successor's challenger is minted: planning advances it in this run.
        self.assertTrue([row for row in self.requests("challenger_plan")
                         if row.get("convergence_id") == "plan-1-rp1"])
        # Its provenance binds to the same consumed request, by its own content hash.
        bindings = [row for row in load_jsonl(ingestion_ledger_path(self.tools))
                    if row.get("row_type") == "synthesis_bound"]
        self.assertEqual(bindings[-1]["plan_content_hash"], successor["plan_started"]["content_hash"])
        self.assertEqual(bindings[-1]["replan_of"]["plan_id"], "plan-1")
        self.assertEqual(bindings[-1]["consumed"], bindings[0]["consumed"])
        rows = [row for row in load_jsonl(self.tools / "governance.jsonl") if row.get("kind") == REPLANNED_KIND]
        self.assertEqual([row["details"]["surfaces"][0]["basis"] for row in rows], ["implementer_named"])

    def test_the_pre_merge_join_proves_the_successors_provenance(self) -> None:
        # The merge owner's own observation, over the ledgers as they stand.
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.operator_feedback_observation import observe_operator_feedback_for_plan
        from aria_kernel.operator_request_signature import allowed_signers_for_checkout

        self.assertEqual(self.replan()["status"], REPLANNED)
        signers, reason = allowed_signers_for_checkout(self.root, base_dir=self.tools)
        self.assertIsNone(reason)
        observed = observe_operator_feedback_for_plan(
            plan_id="plan-1-rp1",
            plan_started=fold_plan_state(plan_id="plan-1-rp1", base_dir=self.tools)["plan_started"],
            ingestion_rows=load_jsonl(ingestion_ledger_path(self.tools)),
            feedback_rows=load_declared_jsonl(self.tools / "operator-feedback.jsonl", expected_surface="operator_feedback"),
            plan_events=load_jsonl(events_path(self.tools)), allowed_signers=signers,
        )
        self.assertNotIn("operator_feedback_unavailable_reason", observed, observed)
        self.assertTrue(observed["operator_feedback_verified"])

    def test_the_successors_ending_is_transparent_to_the_loop_guard(self) -> None:
        from aria_kernel.outage_attribution import failure_is_lane_fault

        self.replan()
        event = {"event_type": "implementation_rejected", "payload": self.rejection_of("plan-1")}
        self.assertTrue(failure_is_lane_fault(event, waited_since=None, at=None, clock=None))


class ARefusalTheKernelCannotStandOnStaysWithAPerson(_ConvergedOperatorPlan):
    def test_a_surface_outside_the_signed_roots_is_refused_by_name(self) -> None:
        outcome = self.replan(named=("web/modules/hr-module/tsconfig.json",))
        self.assertEqual((outcome["status"], outcome["reason"]), (INELIGIBLE, "no_eligible_enabling_surface"))
        self.assertEqual(outcome["refused_surfaces"][0]["reason"], "outside_signed_write_roots")
        self.assertEqual(self.state(), "IMPLEMENTATION_REQUESTED")

    def test_a_surface_already_in_the_write_set_is_not_an_enabling_surface(self) -> None:
        outcome = self.replan(named=(WRITE_SURFACE,))
        self.assertEqual(outcome["refused_surfaces"][0]["reason"], "already_in_the_write_set")

    def test_an_evidence_or_safety_refusal_is_not_replanned(self) -> None:
        self.assertEqual(self.replan(reason_class="evidence")["reason"], "reason_class_not_replannable")
        self.assertEqual(self.replan(reason_class="safety")["reason"], "reason_class_not_replannable")

    def test_without_the_writer_lease_nothing_starts(self) -> None:
        self.assertEqual(self.replan(environ={})["reason"], "writer_lease_not_held")
        self.assertEqual(self.state(), "IMPLEMENTATION_REQUESTED")

    def test_a_tampered_request_row_is_not_trusted(self) -> None:
        # Widen the roots on the stored row after signing: the signature no
        # longer verifies, so its roots bound nothing.
        ledger = self.tools / "operator-feedback.jsonl"
        lines = ledger.read_text(encoding="utf-8").splitlines()
        rows = [json.loads(line) for line in lines]
        rows[-1]["write_roots"] = ["apps"]
        ledger.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        outcome = self.replan()
        self.assertEqual(outcome["status"], INELIGIBLE)
        self.assertNotEqual(outcome["reason"], "no_eligible_enabling_surface")

    def test_the_lineage_is_bounded(self) -> None:
        from aria_kernel.tool_registry import append_tools_governance

        for depth in range(1, MAX_REPLANS_PER_LINEAGE + 1):
            parent = "plan-0" if depth == 1 else f"plan-0-rp{depth - 1}"
            child = "plan-1" if depth == MAX_REPLANS_PER_LINEAGE else f"plan-0-rp{depth}"
            append_tools_governance(self.tools, REPLANNED_KIND, {"plan_id": parent, "successor_plan_id": child})
        outcome = self.replan()
        self.assertEqual((outcome["status"], outcome["reason"]), (INELIGIBLE, "replan_bound_reached"))

    def test_a_plan_no_longer_waiting_is_not_replanned(self) -> None:
        from aria_kernel.implementation_settlement import settle_agent_refusal

        settle_agent_refusal(request_id=self.request_id, reason_class="scope", base_dir=self.tools)
        self.assertEqual(self.replan()["reason"], "plan_not_awaiting_implementation")


class ARequestSignedWithoutWriteRoots(_ConvergedOperatorPlan):
    write_roots = None

    def test_without_signed_roots_nothing_is_eligible(self) -> None:
        outcome = self.replan()
        self.assertEqual((outcome["status"], outcome["reason"]), (INELIGIBLE, "no_signed_write_roots"))


class TheRefusalsSurfacesAreOnlyPaths(unittest.TestCase):
    def test_only_bounded_repo_paths_survive(self) -> None:
        raw = [ENABLING, "../etc/passwd", "/abs/path", "a.ts:12", 7, ENABLING, *[f"a/{n}.ts" for n in range(20)]]
        surfaces = implementer_surfaces(raw)
        self.assertEqual(surfaces[0], ENABLING)
        self.assertNotIn("../etc/passwd", surfaces)
        self.assertNotIn("/abs/path", surfaces)
        self.assertNotIn("a.ts:12", surfaces)
        self.assertEqual(len(surfaces), 10)
        self.assertEqual(implementer_surfaces("not a list"), ())

