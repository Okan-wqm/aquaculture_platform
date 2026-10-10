"""ARIA-HIGH-416 — a plan the envelope mint must refuse for its scope is never staged.

Production (aria/state f5c5c86a1): plans ``cyc-20261008T120143Z`` and
``cyc-20261008T151306Z`` each declared one surface, under ``.github/workflows/``,
which ``READONLY_PATHS`` refuses. The refusal lived only in the envelope mint
(``implementation_envelope_no_writable_scope``), and the mint runs AFTER
staging. Each of the plans' three counted offers therefore recorded a proposal,
an apply action and a change chain, ran the plan's baseline suite (24
validation runs, 45.6 minutes), and then raised; the third exhausted the plan.

Pinned here, through the real runner, the real staging and the real mint (only
the validation children are answered without spawning):

* a plan whose every surface is readonly is moved CONVERGED → HUMAN_REQUIRED on
  its first offer, before anything is staged and without a counted attempt;
* the plan-ledger row, the governance row and the one operator item are the
  ones the ARIA-HIGH-375 move writes (the single parked-plan item);
* a scope outside the plan's admission bound, or a bound the plan never
  recorded, is the same refusal;
* a plan with one writable surface is staged and dispatched as before, and the
  mint still refuses on its own (second line);
* the move never races a live request or a concurrent transition.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import converged_delivery
from aria_kernel import validation as validation_module
from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.apply_engine import list_apply_actions
from aria_kernel.bridge_exceptions import BridgeContractViolation
from aria_kernel.convergence_outcome import (
    PARKED_PLAN_CONTEXT_KIND,
    parked_plan_request_id,
    record_parked_plan,
)
from aria_kernel.converged_delivery import (
    ORIGIN_EXECUTOR,
    WITHHELD_NOT_CONVERGED,
    WITHHELD_REQUEST_LIVE,
    deliver_converged_plan,
    human_required_request_id,
    redeliver_stranded_converged_plans,
)
from aria_kernel.cross_review_bridge import issue_implementation_envelope
from aria_kernel.cycle_phases.implementer import AutonomousV9ImplementationRunner
from aria_kernel.failure_attribution import KERNEL_FORCED_CODES, attribute_evaluation
from aria_kernel.human_required import list_human_required
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import (
    CROSS_REVIEW_SELF_AGREEMENT_REASON,
    PlanStateRefused,
    counted_delivery_attempts,
    fold_plan_state,
)
from aria_kernel.plan_origin import ADMISSION_SCOPE_MISSING, REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE
from aria_kernel.proposal import list_proposals
from aria_kernel.request_admission import admit_request
from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding
from tests._helpers.git_fixtures import commit_files, make_repo_with_initial_commit
from tests._helpers.operator_acts import operator_set_profile
from tests._helpers.production_shaped import production_converged_plan
from tests.test_implementation_lifecycle_continuity import (
    converging_plan_content,
    drive_plan_to_converged,
    seed_reviewer_agent,
)
from tests.test_pr_manager_e2e import _fake_child_process

# The tokens this change persists are pinned by VALUE: the reason code lands on
# the plan ledger, the withheld reason in the cycle summary, the kind on
# governance. A rename would orphan every row already written under the old one.
REASON = "implementation_envelope_no_writable_scope"
WITHHELD = "no_writable_scope"
KIND = "converged_delivery_no_writable_scope"
FORCER = "kernel:converged_delivery"

# The two production plans' surfaces, one each.
WORKFLOW = ".github/workflows/ci-affected.yml"
WORKFLOW_2 = ".github/workflows/deploy-capacity-maintenance.yml"
FARM = "apps/farm-service/src/farm/services/water-quality.service.ts"


class _ScopeCase(unittest.TestCase):
    """A strict lane, a clean committed workspace and the real V9 runner."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-416-")
        fixture = Path(self.tmp.name).resolve()
        self.repo = make_repo_with_initial_commit(fixture, {
            WORKFLOW: "name: ci-affected\n",
            WORKFLOW_2: "name: deploy-capacity-maintenance\n",
            FARM: "export const INTERVAL_MS = 60000;\n",
        }, name="workspace")
        self.tools = fixture / "aria-tools"
        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        ensure_tools_binding(self.tools, workspace_root=self.repo)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def converge(self, plan_id: str, paths: list[str]) -> str:
        plan = production_converged_plan(
            tools_dir=self.tools, workspace_root=self.repo, plan_id=plan_id, affected_paths=paths,
        )
        self.commit_reviewer()
        return plan.plan_id

    def converge_body(self, plan_id: str, plan_content: dict) -> str:
        """A body ``production_converged_plan`` cannot express, through the same real gate."""
        seed_reviewer_agent(self.repo)
        drive_plan_to_converged(plan_id=plan_id, tools=self.tools, workspace_root=self.repo,
                                plan_content=plan_content)
        self.commit_reviewer()
        return plan_id

    def commit_reviewer(self) -> None:
        # The fixtures write their reviewer agent into the workspace (once; a
        # later plan rewrites the same bytes). Staging and the delivery door
        # both refuse a dirty tree, as production's would, so it is committed.
        status = subprocess.run(["git", "status", "--porcelain"], cwd=self.repo,
                                capture_output=True, text=True, check=True).stdout
        if status.strip():
            reviewer = ".claude/agents/farm-expert.md"
            commit_files(self.repo, {reviewer: (self.repo / reviewer).read_text(encoding="utf-8")},
                         message="fixture: plan reviewer")

    def deliver(self, plan_id: str, *, cycle_id: str, origin: str = ORIGIN_EXECUTOR) -> dict:
        with _fake_child_process(validation_module):
            return deliver_converged_plan(
                runner=AutonomousV9ImplementationRunner(), cycle_id=cycle_id, plan_id=plan_id,
                workspace_root=self.repo, base_dir=self.tools,
                cross_review_summary={"revision_id": "cr-416"}, profile="strict", origin=origin,
            )

    def sweep(self, *, cycle_id: str) -> dict:
        with _fake_child_process(validation_module):
            return redeliver_stranded_converged_plans(
                runner=AutonomousV9ImplementationRunner(), cycle_id=cycle_id, base_dir=self.tools,
                workspace_root=self.repo, profile="strict",
            )

    def state(self, plan_id: str) -> dict:
        return fold_plan_state(plan_id=plan_id, base_dir=self.tools)

    def governance(self, kind: str) -> list[dict]:
        return [row["details"] for row in load_jsonl(self.tools / "governance.jsonl") if row.get("kind") == kind]

    def governance_kinds(self) -> list[str]:
        return [str(row.get("kind")) for row in load_jsonl(self.tools / "governance.jsonl")]

    def validation_runs(self) -> list[dict]:
        return load_jsonl(self.tools / "validation" / "validation-runs.jsonl")

    def operator_items(self) -> dict[str, dict]:
        return {row["request_id"]: row for row in list_human_required(base_dir=self.tools)}

    def human_required_evaluations(self, plan_id: str) -> list[dict]:
        return [event["payload"] for event in self.state(plan_id)["events"]
                if event["event_type"] == "plan_evaluated"
                and event["payload"].get("terminal_state") == "HUMAN_REQUIRED"]

    def staged(self) -> tuple[int, int, int]:
        """(proposals, apply actions, baseline validation runs) the stagings left."""
        proposals = {row.get("proposal_id") for row in list_proposals(base_dir=self.tools)}
        actions = {row.get("action_id") or row.get("proposal_id") for row in list_apply_actions(base_dir=self.tools)}
        return len(proposals), len(actions), len(self.validation_runs())

    def assert_nothing_staged(self) -> None:
        self.assertEqual(self.staged(), (0, 0, 0))


class ReadonlyOnlyPlanIsNeverStaged(_ScopeCase):
    def test_the_production_timeline_parks_on_the_first_offer_and_stages_nothing(self) -> None:
        """120143Z's three offers: the executor's in-run seam, then two cycle sweeps."""
        plan_id = self.converge("plan-cyc-20261008T120143Z-auto", [WORKFLOW_2])

        first = self.deliver(plan_id, cycle_id="executor-37785407758-1")
        second = self.sweep(cycle_id="cyc-20261008T151306Z-auto")
        third = self.sweep(cycle_id="cyc-20261008T175911Z-auto")

        # Production paid three stagings and three counted attempts here.
        state = self.state(plan_id)
        self.assertEqual((*self.staged(), len(counted_delivery_attempts(state))), (0, 0, 0, 0))
        self.assertEqual(state["state"], "HUMAN_REQUIRED")
        self.assertEqual(state["implementation_delivery_attempts"], [])
        self.assertEqual(first["delivery"]["withheld"], WITHHELD)
        self.assertIsNone(first["delivery"]["attempt"])
        self.assertEqual(first["rejection_class"], f"delivery_withheld:{WITHHELD}")
        # Parked: the later cycles find nothing stranded and offer nothing.
        for report in (second, third):
            self.assertEqual((report["stranded"], report["offered"], report["escalated"]), ([], [], []))
        # Neither the mint's refusal nor a runner failure was ever reached.
        kinds = self.governance_kinds()
        for absent in ("implementation_envelope_bridge_violation", "v9_implementation_phase_failed",
                       "implementation_staging_governance_error", "implementation_dispatched"):
            self.assertNotIn(absent, kinds)

    def test_the_plan_row_is_a_kernel_forced_escalation_naming_the_scope(self) -> None:
        plan_id = self.converge("plan-cyc-20261008T151306Z-auto", [WORKFLOW])
        self.deliver(plan_id, cycle_id="executor-37811678748-1")

        evaluations = self.human_required_evaluations(plan_id)
        self.assertEqual(len(evaluations), 1)
        row = evaluations[0]
        self.assertEqual(row["reason_codes"], [REASON])
        self.assertEqual(row["forced_by"], FORCER)
        self.assertEqual(row["gate_decisions"], [{
            "gate": "forced_escalation", "decision": "human_escalation", "reason_codes": [REASON],
        }])
        self.assertEqual(row["round_number"], self.state(plan_id)["current_round"])
        # The plan is sound; the lane's authority stops it. Never the drafter's lesson.
        self.assertIsNone(attribute_evaluation(row, plan_id=plan_id, drafter="agent:drafter", ledgers=None))

    def test_one_governance_row_and_the_plans_one_operator_item(self) -> None:
        plan_id = self.converge("plan-cyc-20261008T151306Z-auto", [WORKFLOW])
        self.deliver(plan_id, cycle_id="executor-37811678748-1")

        [row] = self.governance(KIND)
        self.assertEqual({key: row[key] for key in ("plan_id", "round_number")},
                         {"plan_id": plan_id, "round_number": self.state(plan_id)["current_round"]})
        # The mint's own refusal, word for word: the door asked the mint's gate.
        self.assertTrue(row["refusal"].startswith(f"{REASON}: every declared surface of plan {plan_id!r}"))
        self.assertIn(f"readonly_surface_declared:{WORKFLOW}", row["refusal"])
        item_id = parked_plan_request_id(plan_id)
        items = self.operator_items()
        self.assertEqual(sorted(items), [item_id])
        item = items[item_id]
        self.assertEqual(item["status"], "open")
        self.assertEqual(item["severity"], "HIGH")
        self.assertEqual(
            {key: item["context"][key] for key in ("kind", "plan_id", "verdict", "reason_codes", "origin")},
            {"kind": PARKED_PLAN_CONTEXT_KIND, "plan_id": plan_id, "verdict": WITHHELD,
             "reason_codes": [REASON], "origin": "converged_delivery"},
        )
        # The single owner: the parked-plan writer hands back this record, and
        # the sweep's reconcile adds none — no exhaustion record either.
        self.assertEqual(record_parked_plan(plan_id=plan_id, base_dir=self.tools, verdict="again",
                                            origin="test")["request_id"], item_id)
        report = self.sweep(cycle_id="cyc-later")
        self.assertEqual(report["parked"], {"recorded": [], "resolved": [], "failed": []})
        self.assertEqual(sorted(self.operator_items()), [item_id])
        self.assertNotIn(human_required_request_id(plan_id), self.operator_items())

    def test_the_sweep_parks_a_stranded_plan_and_still_offers_the_next(self) -> None:
        parked = self.converge("plan-readonly", [WORKFLOW])
        normal = self.converge("plan-farm", [FARM])

        report = self.sweep(cycle_id="cyc-1")

        self.assertEqual(report["withheld"], {parked: WITHHELD})
        # Parking ran no suite, so it does not spend the cycle's one re-offer.
        self.assertEqual([row["plan_id"] for row in report["offered"]], [normal])
        self.assertEqual(self.state(parked)["state"], "HUMAN_REQUIRED")
        self.assertEqual(self.state(normal)["state"], "IMPLEMENTATION_REQUESTED")

    def test_a_plan_that_declares_no_surface_is_parked_too(self) -> None:
        # Review of ad6774791 (security): the door kept its own copy of the
        # mint's condition and read "nothing refused" as "mintable", so a body
        # declaring no surface (its paths only in key_changes) was staged for
        # a mint that refuses a scope with nothing in it.
        plan_id = self.converge_body("plan-no-surface", converging_plan_content(
            "No declared surface", affected_surfaces=[{"paths": []}],
            key_changes=[{"id": "kc-1", "description": "set the interval", "paths": [FARM], "imports": []}],
        ))

        summary = self.deliver(plan_id, cycle_id="cyc-1")

        state = self.state(plan_id)
        self.assertEqual((*self.staged(), len(counted_delivery_attempts(state))), (0, 0, 0, 0))
        self.assertEqual(summary["delivery"]["withheld"], WITHHELD)
        self.assertEqual(state["state"], "HUMAN_REQUIRED")
        self.assertEqual(self.human_required_evaluations(plan_id)[-1]["reason_codes"], [REASON])


class OnlyTheMintsOwnRefusalsPark(_ScopeCase):
    def test_a_plan_with_a_writable_surface_is_staged_and_dispatched(self) -> None:
        plan_id = self.converge("plan-farm", [FARM])

        summary = self.deliver(plan_id, cycle_id="cyc-1")

        self.assertEqual(summary["terminal_state"], "IMPLEMENTATION_DISPATCHED")
        self.assertEqual(summary["delivery"]["attempt"], 1)
        self.assertEqual(self.state(plan_id)["state"], "IMPLEMENTATION_REQUESTED")
        proposals, actions, baseline_runs = self.staged()
        self.assertEqual((proposals, actions), (1, 1))
        self.assertGreater(baseline_runs, 0)
        self.assertEqual(self.governance(KIND), [])
        self.assertEqual(self.operator_items(), {})

    def test_a_partly_readonly_plan_is_offered_and_the_mint_subtracts(self) -> None:
        plan_id = self.converge("plan-mixed", [WORKFLOW, FARM])

        summary = self.deliver(plan_id, cycle_id="cyc-1")

        self.assertEqual(summary["terminal_state"], "IMPLEMENTATION_DISPATCHED")
        [request] = [row for row in list_agent_invocation_requests(base_dir=self.tools, convergence_id=plan_id)
                     if row.get("role") == "implementation"]
        self.assertEqual(request["allowed_scope"], [FARM])
        self.assertEqual(self.governance(KIND), [])

    def test_the_mint_still_refuses_on_its_own_with_the_same_token(self) -> None:
        plan_id = self.converge("plan-readonly", [WORKFLOW])

        with self.assertRaises(BridgeContractViolation) as raised:
            issue_implementation_envelope(
                plan_id=plan_id, cross_review_revision_id="cr-416", cross_review_summary_text="{}",
                proposal_id="proposal-416", change_id="chg-416", branch="aria-impl-0123456789abcdef",
                base_sha="0" * 40, base_dir=self.tools, cycle_id="cyc-416",
                admission=admit_request("implementer.converged_plan", "implementation", base_dir=self.tools),
            )
        self.assertTrue(str(raised.exception).startswith(f"{REASON}:"))
        self.assertEqual(self.state(plan_id)["state"], "CONVERGED")

    def test_a_scope_outside_the_admission_bound_is_the_same_refusal(self) -> None:
        plan_id = self.converge("plan-farm", [FARM])
        bound = {"admitted_surfaces": ["apps/auth-service/src/x.ts"], "closure_roots": [], "policy_pins": []}

        # The bound the MINT reads: the door asks the mint's gate, so it sees it too.
        with patch("aria_kernel.cross_review_bridge.admission_scope_for_plan", return_value=bound):
            summary = self.deliver(plan_id, cycle_id="cyc-1")

        self.assertEqual(summary["delivery"]["withheld"], WITHHELD)
        self.assert_nothing_staged()
        self.assertEqual(self.state(plan_id)["state"], "HUMAN_REQUIRED")
        # One plan-keyed bound row, stamped by the door that refused.
        self.assertEqual(self.governance(REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE), [
            {"plan_id": plan_id, "stage": "converged_delivery", "offending_paths": [FARM]},
        ])
        self.assertTrue(self.governance(KIND)[0]["refusal"].startswith(REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE))

    def test_a_plan_without_its_admission_record_is_the_same_refusal(self) -> None:
        plan_id = self.converge("plan-farm", [FARM])
        missing = GovernanceError(f"{ADMISSION_SCOPE_MISSING}: plan 'plan-farm' started from F-416 without it")

        with patch("aria_kernel.plan_origin.admission_scope_for_plan", side_effect=missing):
            summary = self.deliver(plan_id, cycle_id="cyc-1")

        self.assertEqual(summary["delivery"]["withheld"], WITHHELD)
        self.assert_nothing_staged()
        self.assertEqual(self.state(plan_id)["state"], "HUMAN_REQUIRED")
        self.assertEqual(self.governance(KIND)[0]["refusal"], str(missing))


class TheMoveNeverRaces(_ScopeCase):
    def test_a_live_request_is_never_parked_over(self) -> None:
        # Review M3 of ARIA-HIGH-362: a live implementation request is the
        # plan's delivery; the delivery door withholds before judging scope.
        plan_id = self.converge("plan-readonly", [WORKFLOW])

        with patch.object(converged_delivery, "live_implementation_request_ids", return_value=["req-416"]):
            summary = self.deliver(plan_id, cycle_id="cyc-1")

        self.assertEqual(summary["delivery"]["withheld"], WITHHELD_REQUEST_LIVE)
        self.assertEqual(self.state(plan_id)["state"], "CONVERGED")
        self.assertEqual(self.governance(KIND), [])
        self.assertEqual(self.operator_items(), {})

    def test_a_plan_that_left_converged_under_the_lock_is_not_parked_again(self) -> None:
        plan_id = self.converge("plan-readonly", [WORKFLOW])
        moved = PlanStateRefused("force_human_required_from_state_refused: fixture")

        with patch("aria_kernel.plan_convergence.force_plan_human_required", side_effect=moved):
            summary = self.deliver(plan_id, cycle_id="cyc-1")

        self.assertEqual(summary["delivery"]["withheld"], WITHHELD_NOT_CONVERGED)
        self.assert_nothing_staged()
        self.assertEqual(self.governance(KIND), [])
        self.assertEqual(self.operator_items(), {})

    def test_a_body_the_ledger_cannot_prove_is_not_a_scope_verdict(self) -> None:
        # Only the gate's refusals park. A body-proof error is the ledger's,
        # so it reaches the door's own fault row, uncounted, plan untouched.
        plan_id = self.converge("plan-readonly", [WORKFLOW])
        unproven = GovernanceError("plan_body_unavailable_for_revision: fixture")

        with patch("aria_kernel.plan_convergence.plan_body_from_state", side_effect=unproven):
            summary = self.deliver(plan_id, cycle_id="cyc-1")

        self.assertEqual(summary["delivery"]["withheld"], "attempt_unrecorded")
        self.assertEqual((*self.staged(), len(counted_delivery_attempts(self.state(plan_id)))), (0, 0, 0, 0))
        self.assertEqual(self.state(plan_id)["state"], "CONVERGED")
        self.assertEqual(self.governance(KIND), [])


class PersistedTokens(unittest.TestCase):
    def test_the_module_names_the_pinned_tokens(self) -> None:
        self.assertEqual(converged_delivery.NO_WRITABLE_SCOPE_REASON, REASON)
        self.assertEqual(converged_delivery.WITHHELD_NO_WRITABLE_SCOPE, WITHHELD)
        self.assertEqual(converged_delivery.NO_WRITABLE_SCOPE_KIND, KIND)
        from aria_kernel.plan_convergence import KERNEL_FORCERS

        self.assertIn(FORCER, KERNEL_FORCERS)

    def test_every_code_converged_delivery_forces_is_a_kernel_forced_code(self) -> None:
        # `failure_attribution` reads a forced row whose code it does not list
        # as the operator's; converged_delivery forces these three.
        self.assertLessEqual(
            {REASON, converged_delivery.DELIVERY_EXHAUSTED_REASON, CROSS_REVIEW_SELF_AGREEMENT_REASON},
            KERNEL_FORCED_CODES,
        )


if __name__ == "__main__":
    unittest.main()
