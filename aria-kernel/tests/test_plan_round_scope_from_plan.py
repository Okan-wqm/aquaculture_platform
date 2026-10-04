"""ARIA-HIGH-345 — a plan's round envelopes carry THAT plan's scope and obligations.

Measured 2026-10-04 (cycle ``cyc-20261004T151152Z-auto``): the round-1
cross_review of the operator plan for F-007 (hr-module / hr-service surfaces)
was minted with ``allowed_scope: ['.github/workflows/ci-affected.yml']`` and a
``key-change-0`` obligation naming ``ci-run-37215065518-key-change-001``. Both
belonged to the FAILING_CI candidate the same cycle had synthesized. The
orchestrator adopts the mid-convergence plan
(``resume_candidate_plan_id``) and synthesizes a fresh candidate in the same
cycle. It then derived ``must_satisfy`` / ``allowed_scope`` /
``evidence_refs`` from the fresh candidate and handed them to the drainer,
which minted every round envelope of the ADOPTED plan with them. The drainer's
"adopted plans use plan_started.must_satisfy" branch read a key that
``start_plan`` never records, so it always fell through to the caller's value.

The fix removes the shared parameters: the drainer derives each envelope's
scope and obligations from the plan's own ``plan_started`` record and
admission bound (``plan_round_scope.plan_round_contract``). The request mint
refuses, with a named reason, a planning-round envelope whose scope or
key-change obligations lie outside the plan it names.

Fixture: the four-project workspace of ``test_revision_scope_bound`` (farm
imports shared, gateway imports farm), an operator plan for ``F-007`` on the
farm surface, and a failing_ci candidate on ``.github/workflows/ci-affected.yml``
synthesized by the cycle that adopts it.
"""
from __future__ import annotations

import functools
import inspect
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import Mock

from aria_kernel.agent_invocations import create_agent_invocation_request
from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator
from aria_kernel.convergence_drainer import ConvergenceRunner, run_convergence_drainer
from aria_kernel.convergent_planning_bridge import start_convergent_plan_drafted_by_primary
from aria_kernel.ledger import load_segments
from aria_kernel.must_satisfy import key_change_obligation
from aria_kernel.plan_coverage import environment_unable_payload
from aria_kernel.plan_convergence import (
    content_hash,
    fold_plan_state,
    record_cross_review,
    request_cross_review,
    submit_challenger_plan,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding
from tests.test_autonomy_orchestrator import (
    _fake_auto_merge_runner,
    _fake_bridge_drainer,
    _fake_cycle_runner,
    _fake_github_adapter,
    _fake_skill_genesis_drainer,
)
from tests.test_revision_scope_bound import FARM, _seed, _seed_workspace

CI_WORKFLOW = ".github/workflows/ci-affected.yml"
PLAN_ID = "plan-op-f007"


def _covered(**kwargs: Any) -> dict[str, Any]:
    """The witness verdict the runner computes; this fixture has no node toolchain to run it."""
    payload = environment_unable_payload(
        round_number=kwargs["round_number"], target_revision_id=kwargs["target_revision_id"],
        target_plan_content_hash=kwargs["target_plan_content_hash"],
        manifest_relpath=f"aria-tools/coverage/{kwargs['plan_id']}-r{kwargs['round_number']}.json",
        manifest_hash="sha256:" + "0" * 64, computed_at_sha="unknown", witness={"tool": "fixture"},
    )
    return {**payload, "verdict": "covered"}


def _failing_ci_candidate() -> dict[str, Any]:
    """The FAILING_CI plan body the cycle synthesizes beside the adopted plan."""
    return {
        "schema_version": 1,
        "title": "Fix failing CI workflow 'CI - Affected'",
        "summary": "Failing CI workflow 'CI - Affected' on main; diagnose the root cause.",
        "affected_surfaces": [CI_WORKFLOW],
        "key_changes": [{
            "id": "ci-run-37215065518-key-change-001",
            "description": "Diagnose and land the architectural fix for the failing workflow.",
            "paths": [CI_WORKFLOW],
        }],
        "validation_commands": [{"cmd": "nx affected --target=test"}],
        "evidence_refs": [CI_WORKFLOW + ":1"],
    }


class _TwoCandidateCycle(unittest.TestCase):
    """One adopted operator plan for F-007, one failing_ci candidate per cycle."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-round-scope-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "workspace"
        _seed_workspace(self.root)
        self.tools = ensure_tools_binding(Path(self.tmp.name) / "aria-tools", workspace_root=self.root)
        set_profile("standard", operator_approval_ref="round-scope-t", base_dir=self.tools)
        self.f_plan = _seed(self.root, "operator_feedback", "F-007", [FARM])
        start_convergent_plan_drafted_by_primary(
            plan_id=PLAN_ID, plan_content=self.f_plan, initial_revision_id=f"{PLAN_ID}-r1",
            base_dir=self.tools, workspace_root=self.root,
        )
        self.bound = fold_plan_state(plan_id=PLAN_ID, base_dir=self.tools)["plan_started"]["admission_scope"]

    # -- the cycle, exactly as production runs it ----------------------------

    def run_cycle(self, coverage: Any = None) -> dict[str, Any]:
        """One orchestrator cycle: adopt the F-007 plan, synthesize failing_ci."""
        blocked = Mock(side_effect=AssertionError("a non-converged plan must not reach dispatch"))
        blocked.profile = "standard"
        result = run_autonomy_orchestrator(
            base_dir=self.tools,
            workspace_root=str(self.root),
            max_cycles=1,
            max_iterations_per_phase=3,
            cycle_runner=_fake_cycle_runner,
            planner_drainer=lambda **kwargs: {"iterations": 0, "claims_dispatched": 0,
                                              "exits_clean": True, "exit_reason": "no_requests"},
            worker_drainer=blocked,
            bridge_drainer=_fake_bridge_drainer,
            auto_merge_runner=_fake_auto_merge_runner,
            github_adapter=_fake_github_adapter,
            convergence_runner=functools.partial(run_convergence_drainer, coverage_computer=coverage or _covered),
            review_runner=blocked,
            specialist_review_runner=blocked,
            plan_synthesizer=lambda **kwargs: _failing_ci_candidate(),
            skill_genesis_drainer=_fake_skill_genesis_drainer,
            profile="standard",
        )
        blocked.assert_not_called()
        self.assertEqual(result["per_cycle"][0]["convergence"]["plan_id"], PLAN_ID)
        return result

    # -- plan-state moves the executor lane would deliver --------------------

    def submit_challenger(self) -> None:
        state = fold_plan_state(plan_id=PLAN_ID, base_dir=self.tools)
        submit_challenger_plan(plan_id=PLAN_ID, challenger={
            "challenger_agent": "aria-challenger-planner", "challenger_revision_id": f"{PLAN_ID}-c1",
            "source_revision_id": state["latest_revision"]["revision_id"],
            "source_plan_content_hash": state["latest_revision"]["content_hash"],
            "plan_content": {**self.f_plan, "summary": "An independent challenger proposal.", "architectural_tier": 2},
        }, base_dir=self.tools)
        self.assertEqual(fold_plan_state(plan_id=PLAN_ID, base_dir=self.tools)["state"], "CHALLENGER_DRAFTED")

    def record_blocking_cross_review(self) -> None:
        latest = fold_plan_state(plan_id=PLAN_ID, base_dir=self.tools)["latest_revision"]
        tasks = []
        for task_id, direction in (("task-p2c", "primary_to_challenger"), ("task-c2p", "challenger_to_primary")):
            task = {"task_id": task_id, "reviewer_agent": "farm-expert", "review_direction": direction,
                    "target_revision_id": latest["revision_id"], "target_plan_content_hash": latest["content_hash"],
                    "sla_deadline": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()}
            task["task_packet_hash"] = content_hash(task)
            tasks.append(task)
        request_cross_review(plan_id=PLAN_ID, request={
            "round_number": 1, "target_revision_id": latest["revision_id"],
            "target_plan_content_hash": latest["content_hash"], "tasks": tasks,
        }, base_dir=self.tools)
        for index, task in enumerate(tasks):
            review = {key: task[key] for key in ("task_packet_hash", "target_revision_id",
                                                "target_plan_content_hash", "reviewer_agent", "review_direction")}
            review["risks"] = [{
                "risk_id": "CR-001", "risk_category": "architecture", "severity": "blocking",
                "summary": "The plan omits the divergence test the operator asked for",
                "affected_files": [FARM], "recommendation": "Add the divergence test",
                "evidence_refs": [FARM + ":1"],
            }] if index == 0 else []
            review["review_content_hash"] = content_hash(review)
            record_cross_review(plan_id=PLAN_ID, review=review, workspace_root=self.root, base_dir=self.tools)
        self.assertEqual(fold_plan_state(plan_id=PLAN_ID, base_dir=self.tools)["state"], "CROSS_REVIEWED")

    # -- assertions ----------------------------------------------------------

    def request(self, role: str, round_number: int) -> dict[str, Any]:
        rows = [row for row in load_segments(self.tools, "agent_invocation_requests")
                if row.get("convergence_id") == PLAN_ID and row.get("role") == role
                and row.get("round_number") == round_number]
        self.assertEqual(len(rows), 1, f"expected one {role} round {round_number} request")
        return rows[0]

    def expected_scope(self) -> list[str]:
        return [*self.bound["admitted_surfaces"], *(f"{root}/**" for root in self.bound["closure_roots"]),
                *self.bound["policy_pins"]]

    def assert_envelope_is_the_plans(self, row: dict[str, Any]) -> None:
        self.assertNotIn(CI_WORKFLOW, row["allowed_scope"], "another candidate's scope reached the plan's envelope")
        self.assertEqual(row["allowed_scope"], self.expected_scope())
        key_changes = [item for item in row["must_satisfy"] if item.get("kind") == "plan_key_change"]
        self.assertEqual([item["key_change_id"] for item in key_changes],
                         [change["id"] for change in self.f_plan["key_changes"]])
        self.assertEqual([item["paths"] for item in key_changes],
                         [change["paths"] for change in self.f_plan["key_changes"]])
        self.assertEqual(row["evidence_refs"], self.f_plan["evidence_refs"])


class CrossReviewOfTheAdoptedPlan(_TwoCandidateCycle):
    def test_cross_review_scope_and_obligations_come_from_the_adopted_plan(self) -> None:
        self.submit_challenger()
        self.run_cycle()
        self.assert_envelope_is_the_plans(self.request("cross_review", 1))


class RoundTwoOfTheAdoptedPlan(_TwoCandidateCycle):
    def test_round_two_primary_revision_carries_the_plans_scope(self) -> None:
        self.submit_challenger()
        self.run_cycle()
        self.record_blocking_cross_review()
        self.run_cycle()
        self.assert_envelope_is_the_plans(self.request("primary_plan", 2))


class CompletenessCriticOfTheAdoptedPlan(_TwoCandidateCycle):
    """The next live step of the F-007 plan: its challenger carries a coverage waiver."""

    def test_the_critic_is_minted_with_the_plans_scope_and_evidence(self) -> None:
        def waived(**kwargs: Any) -> dict[str, Any]:
            return {**_covered(**kwargs), "verdict": "covered_with_waivers",
                    "waived": [{"node_id": "migration:farm-service", "reason": "no column changes"}]}

        self.submit_challenger()
        self.run_cycle()
        self.record_blocking_cross_review()
        self.run_cycle(coverage=waived)
        row = self.request("completeness_critique", 1)
        self.assertNotIn(CI_WORKFLOW, row["allowed_scope"])
        self.assertEqual(row["allowed_scope"], self.expected_scope())
        self.assertNotIn(CI_WORKFLOW + ":1", row["evidence_refs"])
        self.assertEqual(row["evidence_refs"][1:], self.f_plan["evidence_refs"])


class FreshPlanRoundOne(_TwoCandidateCycle):
    def test_a_fresh_plans_challenger_is_scoped_to_its_admission_bound(self) -> None:
        """The plan the cycle starts is held to the same derivation as one it adopts."""
        result = run_convergence_drainer(
            cycle_id="cyc-fresh", base_dir=self.tools, workspace_root=self.root,
            plan_id="plan-fresh", plan_seed=self.f_plan, max_rounds=2,
        )
        self.assertEqual(result["arbiter_verdict"], "in_progress")
        rows = [row for row in load_segments(self.tools, "agent_invocation_requests")
                if row.get("convergence_id") == "plan-fresh"]
        self.assertEqual([row["role"] for row in rows], ["challenger_plan"])
        self.assertEqual(rows[0]["allowed_scope"], self.expected_scope())


class TheSharedParameterIsGone(unittest.TestCase):
    def test_neither_the_drainer_nor_its_protocol_accepts_a_cycle_scope(self) -> None:
        for name, target in (("run_convergence_drainer", run_convergence_drainer),
                             ("ConvergenceRunner.__call__", ConvergenceRunner.__call__)):
            params = set(inspect.signature(target).parameters)
            for shared in ("must_satisfy", "allowed_scope", "evidence_refs"):
                self.assertNotIn(shared, params, f"{name} still accepts the cycle-level {shared}")


class MintRefusesAForeignRoundEnvelope(_TwoCandidateCycle):
    """Any producer that still names a scope is held to the plan at mint."""

    def _mint(self, *, allowed_scope: list[str], must_satisfy: list[dict[str, Any]]) -> dict[str, Any]:
        return create_agent_invocation_request(
            target_agent="aria-challenger-planner", role="challenger_plan",
            suggested_prompt="Write a competing plan.", must_satisfy=must_satisfy,
            allowed_scope=allowed_scope, evidence_refs=list(self.f_plan["evidence_refs"]),
            convergence_id=PLAN_ID, round_number=1, base_dir=self.tools, cycle_id="cyc-mint",
        )

    def _plan_obligation(self) -> dict[str, Any]:
        change = self.f_plan["key_changes"][0]
        return key_change_obligation(id="key-change-0", index=0, plan_description=change["description"],
                                     paths=change["paths"], key_change_id=change["id"])

    def test_a_scope_outside_the_plan_is_refused_by_name(self) -> None:
        with self.assertRaises(GovernanceError) as caught:
            self._mint(allowed_scope=[CI_WORKFLOW], must_satisfy=[self._plan_obligation()])
        self.assertIn("plan_round_scope_foreign", str(caught.exception))
        self.assertIn(CI_WORKFLOW, str(caught.exception))

    def test_an_obligation_from_another_candidate_is_refused_by_name(self) -> None:
        foreign = key_change_obligation(
            id="key-change-0", index=0, plan_description="Fix the failing workflow.",
            paths=[CI_WORKFLOW], key_change_id="ci-run-37215065518-key-change-001",
        )
        with self.assertRaises(GovernanceError) as caught:
            self._mint(allowed_scope=self.expected_scope(), must_satisfy=[foreign])
        self.assertIn("plan_round_obligation_foreign", str(caught.exception))
        self.assertIn("ci-run-37215065518-key-change-001", str(caught.exception))

    def test_the_plans_own_scope_and_obligations_mint(self) -> None:
        row = self._mint(allowed_scope=self.expected_scope(), must_satisfy=[self._plan_obligation()])
        self.assertEqual(row["allowed_scope"], self.expected_scope())


class RoundControllerUsesThePlansScope(_TwoCandidateCycle):
    def test_controller_planner_requests_carry_the_plans_scope(self) -> None:
        from aria_kernel.plan_round_controller import advance_plan_rounds

        advance_plan_rounds(plan_id=PLAN_ID, base_dir=self.tools, workspace_root=self.root, max_rounds=2)
        rows = [row for row in load_segments(self.tools, "agent_invocation_requests")
                if row.get("convergence_id") == PLAN_ID]
        self.assertTrue(rows, "the controller minted no planner request")
        for row in rows:
            self.assertEqual(row["allowed_scope"], self.expected_scope(), row["role"])


if __name__ == "__main__":
    unittest.main()
