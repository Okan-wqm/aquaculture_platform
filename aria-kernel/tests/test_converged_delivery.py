"""ARIA-HIGH-362 — a CONVERGED plan is offered to the V9 runner until it leaves CONVERGED.

Pre-fix world: the runner was called only by the cycle whose drainer
returned ``converged``. A NoOp refusal under ``standard``, a staging
GovernanceError or a runner exception in that one cycle left the plan
CONVERGED — terminal for every adoption reader — and nothing ever offered it
again. These tests drive real plans through the real ledger; only the runner
(or the staging step under the real runner) is substituted.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import apply_engine, cross_review_bridge
from aria_kernel.converged_delivery import (
    AUTHORITY_ABSENT_CYCLES,
    AUTHORITY_ABSENT_REASON,
    DELIVERY_WITHHELD_REASON,
    WITHHELD_WORKSPACE_DIRTY,
    authority_absent_request_id,
    escalate_exhausted_plan,
    DELIVERY_EXHAUSTED_REASON,
    HUMAN_REQUIRED_CONTEXT_KIND,
    MAX_DELIVERY_ATTEMPTS,
    ORIGIN_CONVERGED,
    ORIGIN_REDELIVERY,
    WITHHELD_NO_AUTHORITY,
    WITHHELD_OFFERED_THIS_CYCLE,
    WITHHELD_REQUEST_LIVE,
    converged_plan_ids,
    deliver_converged_plan,
    human_required_request_id,
    live_implementation_request_ids,
    redeliver_stranded_converged_plans,
)
from aria_kernel.cycle_phases.implementer import (
    AutonomousV9ImplementationRunner,
    NoOpV9ImplementationRunner,
    V9ImplementationResult,
)
from aria_kernel.human_required import list_human_required
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import (
    PlanStateRefused,
    counted_delivery_attempts,
    force_plan_human_required,
    fold_plan_state,
    record_implementation_delivery_attempt,
    request_implementation,
)
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.request_admission import admit_request
from tests._helpers.operator_acts import operator_set_profile
from tests.test_implementation_lifecycle_continuity import (
    converging_plan_content,
    drive_plan_to_converged,
    seed_reviewer_agent,
)

PLAN = "plan-362"


class _DispatchingRunner:
    """What the real runner does on success: the mint IS the transition."""

    delivers_implementation = True

    def __init__(self) -> None:
        self.calls: list[str] = []

    def run(self, *, cycle_id, plan_id, workspace_root, base_dir, cross_review_summary, profile):
        self.calls.append(cycle_id)
        state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
        request_implementation(
            plan_id=plan_id, implementer_agent="aria-implementer",
            converged_plan_revision_id=state["latest_revision"]["revision_id"],
            converged_plan_content_hash=state["latest_revision"]["content_hash"],
            base_dir=base_dir,
        )
        return V9ImplementationResult(
            terminal_state="IMPLEMENTATION_DISPATCHED", pr_url=None,
            rejection_class=None, specialist_review_signal="review_converged_plan",
        )


class _RaisingRunner:

    delivers_implementation = True
    def __init__(self) -> None:
        self.calls: list[str] = []

    def run(self, *, cycle_id, **_kwargs):
        self.calls.append(cycle_id)
        raise RuntimeError("fixture runner fault")


class ConvergedDeliveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.tools = root / "aria-tools"
        self.workspace = root / "workspace"
        seed_reviewer_agent(self.workspace)
        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        drive_plan_to_converged(
            plan_id=PLAN, tools=self.tools, workspace_root=self.workspace,
            plan_content=converging_plan_content(
                "ARIA-HIGH-362 plan",
                affected_surfaces=[{"paths": ["apps/farm-service/src/sample.ts"]}],
                key_changes=[{"id": "kc-1", "description": "set the interval",
                              "paths": ["apps/farm-service/src/sample.ts"], "imports": []}],
            ),
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _state(self) -> dict:
        return fold_plan_state(plan_id=PLAN, base_dir=self.tools)

    def _deliver(self, runner, *, cycle_id: str, profile: str) -> dict:
        return deliver_converged_plan(
            runner=runner, cycle_id=cycle_id, plan_id=PLAN, workspace_root=self.workspace,
            base_dir=self.tools, cross_review_summary={"revision_id": "rev-0"},
            profile=profile, origin=ORIGIN_CONVERGED,
        )

    def _sweep(self, runner, *, cycle_id: str, profile: str = "strict") -> dict:
        return redeliver_stranded_converged_plans(
            runner=runner, cycle_id=cycle_id, base_dir=self.tools,
            workspace_root=self.workspace, profile=profile,
        )

    # (a) ---------------------------------------------------------------
    def test_refused_under_standard_then_implemented_under_strict_next_cycle(self) -> None:
        refused = self._deliver(NoOpV9ImplementationRunner(), cycle_id="cyc-n", profile="standard")
        self.assertEqual(refused["rejection_class"], "no_op_v9_runner")
        # The NoOp's refusal is the night's, not the plan's: nothing counted.
        self.assertIsNone(refused["delivery"]["attempt"])
        self.assertEqual(self._state()["implementation_delivery_attempts"], [])
        self.assertEqual(converged_plan_ids(base_dir=self.tools), [PLAN])

        # A standard night's sweep neither offers nor spends the bound.
        idle = self._sweep(NoOpV9ImplementationRunner(), cycle_id="cyc-n1", profile="standard")
        self.assertEqual(idle["withheld"], {PLAN: WITHHELD_NO_AUTHORITY})
        self.assertEqual(idle["offered"], [])

        runner = _DispatchingRunner()
        report = self._sweep(runner, cycle_id="cyc-n2")
        self.assertEqual(runner.calls, ["cyc-n2"])
        self.assertEqual(report["offered"], [{
            "plan_id": PLAN, "terminal_state": "IMPLEMENTATION_DISPATCHED",
            "rejection_class": None, "attempt": 1,
        }])
        state = self._state()
        self.assertEqual(state["state"], "IMPLEMENTATION_REQUESTED")
        self.assertEqual([row["attempt"] for row in state["implementation_delivery_attempts"]], [1])
        self.assertEqual(state["implementation_delivery_attempts"][0]["cycle_id"], "cyc-n2")
        # Delivered: nothing left to re-offer.
        self.assertEqual(converged_plan_ids(base_dir=self.tools), [])
        self.assertEqual(self._sweep(runner, cycle_id="cyc-n3")["stranded"], [])
        self.assertEqual(runner.calls, ["cyc-n2"])

    # (b) ---------------------------------------------------------------
    def test_a_staging_governance_error_is_re_offered_through_the_real_runner(self) -> None:
        staged = {"proposal_id": "proposal-362", "change_id": "chg-362",
                  "branch": "aria-impl-0123456789abcdef", "base_sha": "0" * 40,
                  "baseline_ref": "validation:baseline-362"}
        outcomes = [GovernanceError("stage_requires_architectural_tier: fixture"), staged]

        def stage(**_kwargs):
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        runner = AutonomousV9ImplementationRunner()
        with patch.object(apply_engine, "stage_converged_plan_for_pr", side_effect=stage):
            first = self._deliver(runner, cycle_id="cyc-1", profile="strict")
            self.assertEqual(first["rejection_class"], "staging_governance_error")
            self.assertEqual(first["delivery"]["attempt"], 1)
            self.assertEqual(self._state()["state"], "CONVERGED")
            # The same cycle does not offer it twice.
            again = self._deliver(runner, cycle_id="cyc-1", profile="strict")
            self.assertEqual(again["delivery"]["withheld"], WITHHELD_OFFERED_THIS_CYCLE)

            report = self._sweep(runner, cycle_id="cyc-2")
        self.assertEqual(report["offered"][0]["terminal_state"], "IMPLEMENTATION_DISPATCHED")
        self.assertEqual(report["offered"][0]["attempt"], 2)
        self.assertEqual(self._state()["state"], "IMPLEMENTATION_REQUESTED")
        self.assertEqual(outcomes, [])

    def test_a_runner_exception_is_counted_and_re_offered(self) -> None:
        raising = _RaisingRunner()
        failed = self._deliver(raising, cycle_id="cyc-1", profile="strict")
        self.assertEqual(failed["rejection_class"], "runner_exception:RuntimeError")
        self.assertEqual(failed["specialist_review_signal"], "review_converged_plan")
        self.assertEqual(failed["delivery"]["attempt"], 1)
        governance = [json.loads(line) for line in (self.tools / "governance.jsonl").read_text().splitlines()]
        failures = [row["details"] for row in governance if row.get("kind") == "v9_implementation_phase_failed"]
        self.assertEqual(failures[-1]["plan_id"], PLAN)
        self.assertEqual(failures[-1]["delivery_attempt"], 1)

        runner = _DispatchingRunner()
        self.assertEqual(self._sweep(runner, cycle_id="cyc-2")["offered"][0]["attempt"], 2)
        self.assertEqual(self._state()["state"], "IMPLEMENTATION_REQUESTED")

    # (c) ---------------------------------------------------------------
    def test_exhaustion_ends_the_plan_in_human_required_with_the_named_reason(self) -> None:
        raising = _RaisingRunner()
        self._deliver(raising, cycle_id="cyc-1", profile="strict")
        self._sweep(raising, cycle_id="cyc-2")
        last = self._sweep(raising, cycle_id="cyc-3")
        self.assertEqual(raising.calls, ["cyc-1", "cyc-2", "cyc-3"])
        self.assertEqual(MAX_DELIVERY_ATTEMPTS, 3)
        self.assertEqual(last["offered"][0]["attempt"], 3)

        state = self._state()
        self.assertEqual(state["state"], "HUMAN_REQUIRED")
        evaluated = [event for event in state["events"] if event["event_type"] == "plan_evaluated"]
        self.assertEqual(evaluated[-1]["payload"]["reason_codes"], [DELIVERY_EXHAUSTED_REASON])
        records = [row for row in list_human_required(base_dir=self.tools)
                   if row["request_id"] == human_required_request_id(PLAN)]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["context"]["kind"], HUMAN_REQUIRED_CONTEXT_KIND)
        self.assertEqual(records[0]["context"]["reason_code"], DELIVERY_EXHAUSTED_REASON)
        self.assertEqual([row["attempt"] for row in records[0]["context"]["attempts"]], [1, 2, 3])
        self.assertEqual(records[0]["context"]["last_rejection_class"], "runner_exception:RuntimeError")

        # Terminal: never offered again.
        self.assertEqual(self._sweep(raising, cycle_id="cyc-4")["stranded"], [])
        self.assertEqual(raising.calls, ["cyc-1", "cyc-2", "cyc-3"])

    def test_a_spent_plan_found_by_the_sweep_is_escalated_without_an_offer(self) -> None:
        # The process died after recording the third attempt: the bound is read
        # from the ledger, so the next sweep escalates instead of offering a fourth.
        for attempt in range(1, MAX_DELIVERY_ATTEMPTS + 1):
            record_implementation_delivery_attempt(
                plan_id=PLAN, attempt=attempt, cycle_id=f"cyc-{attempt}",
                profile="strict", runner_class="AutonomousV9ImplementationRunner",
                base_dir=self.tools,
            )
        runner = _DispatchingRunner()
        report = self._sweep(runner, cycle_id="cyc-9")
        self.assertEqual(runner.calls, [])
        self.assertEqual(report["escalated"][0]["status"], "escalated")
        self.assertEqual(self._state()["state"], "HUMAN_REQUIRED")

    def test_attempts_are_idempotent_per_plan_and_attempt(self) -> None:
        first = record_implementation_delivery_attempt(
            plan_id=PLAN, attempt=1, cycle_id="cyc-a", profile="strict",
            runner_class="R", base_dir=self.tools,
        )
        raced = record_implementation_delivery_attempt(
            plan_id=PLAN, attempt=1, cycle_id="cyc-b", profile="strict",
            runner_class="R", base_dir=self.tools,
        )
        self.assertTrue(first["event_appended"])
        self.assertTrue(raced["idempotent"])
        self.assertEqual(len(self._state()["implementation_delivery_attempts"]), 1)
        with self.assertRaisesRegex(GovernanceError, "implementation_delivery_attempt_out_of_order"):
            record_implementation_delivery_attempt(
                plan_id=PLAN, attempt=3, cycle_id="cyc-c", profile="strict",
                runner_class="R", base_dir=self.tools,
            )

    # (d) ---------------------------------------------------------------
    def test_no_second_mint_while_an_implementation_request_is_live(self) -> None:
        # The mint appends the request row, then writes the plan transition.
        # A process that dies in between leaves a live request on a plan that
        # still folds to CONVERGED.
        with patch.object(cross_review_bridge, "request_implementation",
                          side_effect=RuntimeError("process died after the request row")):
            with self.assertRaises(RuntimeError):
                cross_review_bridge.issue_implementation_envelope(
                    plan_id=PLAN, cross_review_revision_id="cr-1",
                    cross_review_summary_text="{}", proposal_id="proposal-362",
                    change_id="chg-362", branch="aria-impl-0123456789abcdef",
                    base_sha="0" * 40, base_dir=self.tools, cycle_id="cyc-0",
                    admission=admit_request("implementer.converged_plan", "implementation", base_dir=self.tools),
                )
        self.assertEqual(self._state()["state"], "CONVERGED")
        live = live_implementation_request_ids(PLAN, base_dir=self.tools)
        self.assertEqual(len(live), 1)

        runner = _DispatchingRunner()
        report = self._sweep(runner, cycle_id="cyc-1")
        self.assertEqual(report["withheld"], {PLAN: WITHHELD_REQUEST_LIVE})
        self.assertEqual(runner.calls, [])
        # Withholding costs the plan nothing.
        self.assertEqual(self._state()["implementation_delivery_attempts"], [])
        direct = self._deliver(runner, cycle_id="cyc-1", profile="strict")
        self.assertEqual(direct["delivery"]["withheld"], WITHHELD_REQUEST_LIVE)
        self.assertEqual(runner.calls, [])


class ReviewCorrectionTests(unittest.TestCase):
    """The independent review's M3-M6 against the same real plan ledger."""

    setUp = ConvergedDeliveryTests.setUp
    tearDown = ConvergedDeliveryTests.tearDown
    _state = ConvergedDeliveryTests._state
    _deliver = ConvergedDeliveryTests._deliver
    _sweep = ConvergedDeliveryTests._sweep

    def _spend(self, count: int = MAX_DELIVERY_ATTEMPTS) -> None:
        for attempt in range(1, count + 1):
            record_implementation_delivery_attempt(
                plan_id=PLAN, attempt=attempt, cycle_id=f"cyc-spent-{attempt}", profile="strict",
                runner_class="AutonomousV9ImplementationRunner", base_dir=self.tools,
            )

    def _live_request(self) -> None:
        with patch.object(cross_review_bridge, "request_implementation",
                          side_effect=RuntimeError("process died after the request row")):
            with self.assertRaises(RuntimeError):
                cross_review_bridge.issue_implementation_envelope(
                    plan_id=PLAN, cross_review_revision_id="cr-1",
                    cross_review_summary_text="{}", proposal_id="proposal-362",
                    change_id="chg-362", branch="aria-impl-0123456789abcdef",
                    base_sha="0" * 40, base_dir=self.tools, cycle_id="cyc-0",
                    admission=admit_request("implementer.converged_plan", "implementation", base_dir=self.tools),
                )

    def _records(self) -> list[str]:
        return [row["request_id"] for row in list_human_required(base_dir=self.tools)]

    # M5 ----------------------------------------------------------------
    def test_a_runner_that_cannot_deliver_is_never_counted_whatever_the_profile_string(self) -> None:
        outcome = self._deliver(NoOpV9ImplementationRunner(), cycle_id="cyc-1", profile="strict")
        self.assertEqual(outcome["rejection_class"], "no_op_v9_runner")
        self.assertIsNone(outcome["delivery"]["attempt"])
        self.assertEqual(self._state()["implementation_delivery_attempts"], [])

    def test_a_profile_refusal_at_staging_voids_the_attempt(self) -> None:
        from aria_kernel.runtime_profile import ProfileActionRefused

        with patch.object(apply_engine, "stage_converged_plan_for_pr",
                          side_effect=ProfileActionRefused("profile_violation: fixture demotion")):
            outcome = self._deliver(AutonomousV9ImplementationRunner(), cycle_id="cyc-1", profile="strict")
        self.assertEqual(outcome["rejection_class"], "staging_profile_refused")
        self.assertEqual(outcome["delivery"]["voided"], "profile_refused_at_staging")
        state = self._state()
        self.assertEqual(state["state"], "CONVERGED")
        self.assertEqual(state["implementation_delivery_attempts"][0]["voided"], "profile_refused_at_staging")
        self.assertEqual(counted_delivery_attempts(state), [])
        runner = _DispatchingRunner()
        self.assertEqual(self._sweep(runner, cycle_id="cyc-2")["offered"][0]["attempt"], 2)
        # Two attempts on the ledger, one of them counted.
        self.assertEqual([row["attempt"] for row in self._state()["implementation_delivery_attempts"]], [1, 2])
        self.assertEqual([row["attempt"] for row in counted_delivery_attempts(self._state())], [2])
        self.assertEqual(self._state()["state"], "IMPLEMENTATION_REQUESTED")

    # M6 ----------------------------------------------------------------
    def test_a_dirty_tree_withholds_the_offer_uncounted(self) -> None:
        subprocess.run(["git", "init", "-q"], cwd=self.workspace, check=True)
        (self.workspace / "baseline-artefact.txt").write_text("left by a baseline run\n", encoding="utf-8")
        runner = _DispatchingRunner()
        outcome = self._deliver(runner, cycle_id="cyc-1", profile="strict")
        self.assertEqual(outcome["delivery"]["withheld"], WITHHELD_WORKSPACE_DIRTY)
        self.assertEqual(runner.calls, [])
        self.assertEqual(self._state()["implementation_delivery_attempts"], [])

    # M3 ----------------------------------------------------------------
    def test_no_escalation_while_an_implementation_request_is_live(self) -> None:
        self._spend()
        self._live_request()
        report = self._sweep(_DispatchingRunner(), cycle_id="cyc-9")
        self.assertEqual(report["withheld"], {PLAN: WITHHELD_REQUEST_LIVE})
        self.assertEqual(report["escalated"], [])
        self.assertEqual(self._state()["state"], "CONVERGED")
        self.assertNotIn(human_required_request_id(PLAN), self._records())

    def test_the_human_required_write_is_guarded_against_a_concurrent_mint(self) -> None:
        from aria_kernel import plan_convergence

        self._spend()
        stale = self._state()
        _DispatchingRunner().run(cycle_id="cyc-mint", plan_id=PLAN, workspace_root=self.workspace,
                                 base_dir=self.tools, cross_review_summary={}, profile="strict")
        self.assertEqual(self._state()["state"], "IMPLEMENTATION_REQUESTED")
        real = plan_convergence.fold_plan_state
        reads: list[int] = []

        def stale_first(**kwargs):
            reads.append(1)
            return stale if len(reads) == 1 else real(**kwargs)

        with patch.object(plan_convergence, "fold_plan_state", side_effect=stale_first):
            outcome = escalate_exhausted_plan(PLAN, base_dir=self.tools)
        self.assertEqual(outcome["status"], "not_converged")
        self.assertEqual(self._state()["state"], "IMPLEMENTATION_REQUESTED")
        self.assertNotIn(human_required_request_id(PLAN), self._records())
        with self.assertRaises(PlanStateRefused):
            force_plan_human_required(plan_id=PLAN, round_number=1, reason_codes=["fixture"],
                                      from_states=frozenset({"CONVERGED"}), base_dir=self.tools)

    def test_a_missing_operator_record_after_the_transition_is_repaired(self) -> None:
        from aria_kernel import human_required

        self._spend()
        with patch.object(human_required, "record_human_required", side_effect=OSError("disk full")):
            report = self._sweep(_DispatchingRunner(), cycle_id="cyc-9")
        self.assertEqual(report["escalated"][0]["status"], "escalation_failed")
        self.assertEqual(self._state()["state"], "HUMAN_REQUIRED")
        self.assertNotIn(human_required_request_id(PLAN), self._records())
        repaired = self._sweep(_DispatchingRunner(), cycle_id="cyc-10")
        self.assertEqual(repaired["repaired"], [PLAN])
        self.assertIn(human_required_request_id(PLAN), self._records())

    # M4 ----------------------------------------------------------------
    def test_a_long_run_without_authority_is_surfaced_without_a_transition(self) -> None:
        noop = NoOpV9ImplementationRunner()
        for night in range(1, AUTHORITY_ABSENT_CYCLES):
            report = self._sweep(noop, cycle_id=f"cyc-{night}", profile="standard")
            self.assertEqual(report["surfaced"], [])
        self.assertNotIn(authority_absent_request_id(PLAN), self._records())
        # The same cycle noted twice is one cycle.
        self._sweep(noop, cycle_id=f"cyc-{AUTHORITY_ABSENT_CYCLES - 1}", profile="standard")
        self.assertNotIn(authority_absent_request_id(PLAN), self._records())
        last = self._sweep(noop, cycle_id=f"cyc-{AUTHORITY_ABSENT_CYCLES}", profile="standard")
        self.assertEqual(last["surfaced"], [PLAN])
        record = next(row for row in list_human_required(base_dir=self.tools)
                      if row["request_id"] == authority_absent_request_id(PLAN))
        self.assertEqual(record["context"]["reason_code"], AUTHORITY_ABSENT_REASON)
        self.assertEqual(len(record["context"]["uncounted_cycles"]), AUTHORITY_ABSENT_CYCLES)
        # Surfaced, not ended: the authority may return.
        self.assertEqual(self._state()["state"], "CONVERGED")
        self.assertEqual(self._sweep(_DispatchingRunner(), cycle_id="cyc-back")["offered"][0]["attempt"], 1)


    # Review of #1813 ---------------------------------------------------
    def test_a_ledger_fault_while_noting_an_uncounted_cycle_never_ends_the_cycle(self) -> None:
        from aria_kernel import converged_delivery

        with patch.object(converged_delivery, "note_uncounted_cycle", side_effect=OSError("fixture disk")):
            report = self._sweep(NoOpV9ImplementationRunner(), cycle_id="cyc-1", profile="standard")
            outcome = self._deliver(NoOpV9ImplementationRunner(), cycle_id="cyc-2", profile="standard")
        self.assertEqual(report["withheld"], {PLAN: WITHHELD_NO_AUTHORITY})
        self.assertEqual(outcome["delivery"]["uncounted"]["status"], "unrecorded")
        kinds = [row.get("kind") or row.get("event") for row in load_jsonl(self.tools / "governance.jsonl")]
        self.assertGreaterEqual(kinds.count("converged_delivery_uncounted_unrecorded"), 2)

    def test_a_void_that_cannot_be_written_keeps_the_attempt_counted_and_the_cycle_alive(self) -> None:
        from aria_kernel import plan_convergence
        from aria_kernel.runtime_profile import ProfileActionRefused

        with patch.object(apply_engine, "stage_converged_plan_for_pr",
                          side_effect=ProfileActionRefused("profile_violation: fixture demotion")), \
                patch.object(plan_convergence, "void_implementation_delivery_attempt",
                             side_effect=GovernanceError("fixture: plan moved")):
            outcome = self._deliver(AutonomousV9ImplementationRunner(), cycle_id="cyc-1", profile="strict")
        self.assertEqual(outcome["rejection_class"], "staging_profile_refused")
        self.assertEqual(outcome["delivery"]["void_error_class"], "GovernanceError")
        self.assertEqual(len(counted_delivery_attempts(self._state())), 1)

    def test_a_lane_that_keeps_its_tree_dirty_is_surfaced_not_silent(self) -> None:
        subprocess.run(["git", "init", "-q"], cwd=self.workspace, check=True)
        (self.workspace / "left-by-a-baseline.txt").write_text("x\n", encoding="utf-8")
        for night in range(1, AUTHORITY_ABSENT_CYCLES + 1):
            outcome = self._deliver(_DispatchingRunner(), cycle_id=f"cyc-{night}", profile="strict")
            self.assertEqual(outcome["delivery"]["withheld"], WITHHELD_WORKSPACE_DIRTY)
        self.assertTrue(outcome["delivery"]["uncounted"]["surfaced"])
        record = next(row for row in list_human_required(base_dir=self.tools)
                      if row["request_id"] == authority_absent_request_id(PLAN))
        self.assertEqual(record["context"]["reason_code"], DELIVERY_WITHHELD_REASON)
        self.assertEqual(record["context"]["withheld_reasons"], [WITHHELD_WORKSPACE_DIRTY])
        self.assertEqual(self._state()["state"], "CONVERGED")
        self.assertEqual(self._state()["implementation_delivery_attempts"], [])


class SweepBoundTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.tools = root / "aria-tools"
        self.workspace = root / "workspace"
        seed_reviewer_agent(self.workspace)
        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        for plan_id in ("plan-old", "plan-new"):
            drive_plan_to_converged(plan_id=plan_id, tools=self.tools, workspace_root=self.workspace)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_one_re_offer_per_cycle_oldest_convergence_first(self) -> None:
        self.assertEqual(converged_plan_ids(base_dir=self.tools), ["plan-old", "plan-new"])
        runner = _DispatchingRunner()
        first = redeliver_stranded_converged_plans(
            runner=runner, cycle_id="cyc-1", base_dir=self.tools,
            workspace_root=self.workspace, profile="strict",
        )
        self.assertEqual([row["plan_id"] for row in first["offered"]], ["plan-old"])
        self.assertEqual(first["withheld"], {"plan-new": "per_cycle_bound"})
        second = redeliver_stranded_converged_plans(
            runner=runner, cycle_id="cyc-2", base_dir=self.tools,
            workspace_root=self.workspace, profile="strict",
        )
        self.assertEqual([row["plan_id"] for row in second["offered"]], ["plan-new"])
        self.assertEqual(ORIGIN_REDELIVERY, "stranded_redelivery")


class OrchestratorWiringTests(unittest.TestCase):
    """(a) through the real orchestrator: the plan a `standard` night converged
    and refused is implemented by the next `strict` night's sweep."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.tools = root / "aria-tools"
        self.workspace = root / "workspace"
        seed_reviewer_agent(self.workspace)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _run(self, *, profile: str, runner, converge) -> dict:
        from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator
        from tests import test_autonomy_orchestrator as fixtures

        operator_set_profile(profile, base_dir=self.tools, scheduler_ceiling=profile)
        return run_autonomy_orchestrator(
            base_dir=self.tools, workspace_root=str(self.workspace), max_cycles=1,
            max_iterations_per_phase=3, cycle_runner=fixtures._fake_cycle_runner,
            planner_drainer=fixtures._fake_planner_drainer,
            worker_drainer=fixtures._fake_worker_drainer,
            bridge_drainer=fixtures._fake_bridge_drainer,
            auto_merge_runner=fixtures._fake_auto_merge_runner,
            github_adapter=fixtures._fake_github_adapter,
            convergence_runner=converge, review_runner=fixtures._fake_review_runner,
            specialist_review_runner=fixtures._fake_specialist_review_runner,
            plan_synthesizer=fixtures._fake_plan_synthesizer,
            skill_genesis_drainer=fixtures._fake_skill_genesis_drainer,
            v9_implementation_runner=runner, profile=profile,
        )

    def test_standard_refusal_is_implemented_by_the_next_strict_cycle(self) -> None:
        from tests import test_autonomy_orchestrator as fixtures

        converged: list[str] = []

        def converge_once(**kwargs):
            drive_plan_to_converged(plan_id=kwargs["plan_id"], tools=self.tools,
                                    workspace_root=self.workspace)
            converged.append(kwargs["plan_id"])
            return fixtures._fake_convergence_runner(**kwargs)

        def split(**kwargs):
            return {**fixtures._fake_convergence_runner(**kwargs), "arbiter_verdict": "split"}

        first = self._run(profile="standard", runner=NoOpV9ImplementationRunner(), converge=converge_once)
        night_one = first["per_cycle"][0]
        self.assertEqual(night_one["v9_implementation"]["rejection_class"], "no_op_v9_runner")
        self.assertEqual(night_one["converged_redelivery"]["stranded"], [])
        plan_id = converged[0]
        self.assertEqual(fold_plan_state(plan_id=plan_id, base_dir=self.tools)["state"], "CONVERGED")

        runner = _DispatchingRunner()
        second = self._run(profile="strict", runner=runner, converge=split)
        night_two = second["per_cycle"][0]
        self.assertEqual(night_two["converged_redelivery"]["offered"][0]["plan_id"], plan_id)
        self.assertEqual(len(runner.calls), 1)
        self.assertEqual(fold_plan_state(plan_id=plan_id, base_dir=self.tools)["state"],
                         "IMPLEMENTATION_REQUESTED")


if __name__ == "__main__":
    unittest.main()


class OperatorWithdrawConvergedTests(unittest.TestCase):
    """ARIA-HIGH-362 (review M3) — the guarded default refuses a CONVERGED
    plan; the operator CLI names the state it withdraws from, and only then
    does the transition run (inside the plan lock, as for every caller)."""

    # The converged fixture only; inheriting the class would re-run its tests.
    setUp = ConvergedDeliveryTests.setUp
    tearDown = ConvergedDeliveryTests.tearDown
    _state = ConvergedDeliveryTests._state

    def _cli(self, *extra: str) -> int:
        from aria_kernel.cli import main

        return main(["plan", "force-human-required", "--tools-dir", str(self.tools), "--plan-id", PLAN,
                     "--round-number", "1", "--reason-code", "operator_withdrawn", *extra])

    def test_the_cli_refuses_a_converged_plan_unless_the_operator_names_it(self) -> None:
        with self.assertRaises(GovernanceError):
            self._cli()
        self.assertEqual(self._state()["state"], "CONVERGED")
        self.assertEqual(self._cli("--from-state", "CONVERGED"), 0)
        self.assertEqual(self._state()["state"], "HUMAN_REQUIRED")

    def test_a_named_state_the_plan_is_not_in_is_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            self._cli("--from-state", "IMPLEMENTATION_REQUESTED")
        self.assertEqual(self._state()["state"], "CONVERGED")
