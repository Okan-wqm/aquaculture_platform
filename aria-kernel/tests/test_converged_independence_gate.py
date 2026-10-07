"""ARIA-HIGH-375 — a self-agreeing round is never CONVERGED, so no path delivers it.

The independence check (ORPHAN-HIGH-421) ran AFTER `evaluate_plan` had
recorded CONVERGED: the converging cycle downgraded its own verdict to
`cross_review_self_agreement` and withheld delivery, but the plan stayed
CONVERGED, and the next cycle's stranded-plan sweep (ARIA-HIGH-362) offered it
to the implementer by state alone. Pinned here:

* `evaluate_plan` derives the gate itself: a self-agreeing round is recorded
  HUMAN_REQUIRED by the drainer AND by the operator's direct call alike;
* neither the sweep, `deliver_converged_plan` nor the executor's in-run
  advance (ARIA-HIGH-368) offers it, and the plan gets one operator item;
* a plan CONVERGED before the gate (a legacy ledger) is judged by the sweep
  once, before anything is offered, and moved if it fails;
* a self-agreeing round is never the drafter's failure on its scorecard;
* a clean round still converges, with the gate on record, and is delivered.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest import mock

from aria_kernel import convergence_drainer as cd
from aria_kernel import executor_convergence as ec
from aria_kernel.converged_delivery import (
    INDEPENDENCE_MIGRATED_KIND,
    ORIGIN_CONVERGED,
    WITHHELD_NOT_CONVERGED,
    WITHHELD_NOT_INDEPENDENT,
    deliver_converged_plan,
    redeliver_stranded_converged_plans,
)
from aria_kernel.convergence_outcome import parked_plan_request_id
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import (
    CROSS_REVIEW_INDEPENDENCE_GATE,
    CROSS_REVIEW_SELF_AGREEMENT_REASON,
    _append_event,
    _idempotency_key,
    _plan_lock,
    evaluate_plan,
    events_path,
)
from tests.test_executor_event_driven_planning import _LEASE, _PlanCase

_ECHO = (False, ["cross_review_echoes_primary"])
_CLEAN = (True, [])
_VERIFY = "aria_kernel.round_independence.verify_independence"


def _runner() -> mock.Mock:
    return mock.Mock(
        delivers_implementation=True,
        run=mock.Mock(return_value=SimpleNamespace(
            terminal_state="IMPLEMENTATION_DISPATCHED", pr_url=None, rejection_class=None,
            specialist_review_signal="review_converged_plan",
        )),
    )


class _ReviewedCase(_PlanCase):
    """Plan-1 with its challenger and both cross-review directions answered."""

    def setUp(self) -> None:
        super().setUp()
        self.answer_challenger()
        self.cycle_step()
        self.answer_cross_review()
        self.assertEqual(self.state(), "CROSS_REVIEWED")

    def cycle_step(self, independence=_CLEAN) -> dict:
        """One cycle's convergence step, the round's independence verdict
        given (the native folds above carry no claim trail to measure)."""
        with mock.patch(_VERIFY, return_value=independence):
            return cd.run_convergence_drainer(
                cycle_id="cyc-2", base_dir=self.tools, workspace_root=self.root, plan_id="plan-1",
                plan_seed=self.plan(), max_rounds=cd.AUTONOMY_CYCLE_MAX_ROUNDS,
            )

    def sweep(self, runner, independence=_CLEAN) -> dict:
        with mock.patch(_VERIFY, return_value=independence):
            return redeliver_stranded_converged_plans(
                runner=runner, cycle_id="cyc-3", base_dir=self.tools, workspace_root=self.root,
                profile="strict",
            )

    def last_evaluation(self) -> dict:
        rows = [row for row in load_jsonl(events_path(self.tools))
                if row.get("event_type") == "plan_evaluated" and row.get("plan_id") == "plan-1"]
        return rows[-1]["payload"]

    def operator_items(self) -> list[str]:
        folder = self.tools / "human-required"
        return sorted(path.stem for path in folder.glob("*.json")) if folder.is_dir() else []

    def governance_kinds(self) -> list[str]:
        import json

        path = self.tools / "governance.jsonl"
        return [json.loads(line).get("kind") for line in path.read_text(encoding="utf-8").splitlines()]


class SelfAgreementIsNeverDelivered(_ReviewedCase):
    def test_the_round_is_recorded_human_required_and_the_next_sweep_offers_nothing(self) -> None:
        result = self.cycle_step(_ECHO)
        self.assertEqual(result["arbiter_verdict"], "cross_review_self_agreement")
        self.assertEqual(self.state(), "HUMAN_REQUIRED")
        payload = self.last_evaluation()
        self.assertEqual(payload["reason_codes"], [CROSS_REVIEW_SELF_AGREEMENT_REASON])
        self.assertIn(
            {"gate": CROSS_REVIEW_INDEPENDENCE_GATE, "passed": False,
             "violation_reasons": ["cross_review_echoes_primary"]},
            payload["gate_decisions"],
        )
        runner = _runner()
        report = self.sweep(runner, _ECHO)
        runner.run.assert_not_called()
        self.assertEqual(report["stranded"], [])

    def test_the_operator_evaluation_cannot_skip_the_gate(self) -> None:
        # `plan evaluate` / `plan advance-rounds` call evaluate_plan directly.
        with mock.patch(_VERIFY, return_value=_ECHO):
            evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools, max_rounds=2)
        self.assertEqual(self.state(), "HUMAN_REQUIRED")
        self.assertEqual(self.last_evaluation()["reason_codes"], [CROSS_REVIEW_SELF_AGREEMENT_REASON])

    def test_the_one_delivery_door_refuses_it(self) -> None:
        self.cycle_step(_ECHO)
        runner = _runner()
        summary = deliver_converged_plan(
            runner=runner, cycle_id="cyc-2", plan_id="plan-1", workspace_root=self.root,
            base_dir=self.tools, cross_review_summary={}, profile="strict", origin=ORIGIN_CONVERGED,
        )
        runner.run.assert_not_called()
        self.assertEqual(summary["delivery"]["withheld"], WITHHELD_NOT_CONVERGED)

    def test_the_executor_advance_never_reaches_its_seam_and_reports_the_parked_plan(self) -> None:
        seam = mock.Mock()
        with mock.patch(_VERIFY, return_value=_ECHO):
            outcome = ec.advance_after_accepted_step(
                request=self.requests("cross_review")[0], tools_dir=self.tools,
                workspace_root=self.root, run_id="run-1-1", budget=ec.AdvanceBudget(),
                drain_remaining=None, environ=_LEASE, converged_seam=seam,
            )
        self.assertEqual(outcome["verdict"], "cross_review_self_agreement")
        seam.assert_not_called()
        self.assertEqual(self.state(), "HUMAN_REQUIRED")
        # ARIA-HIGH-368 review — the outcome rows the cycle would have written,
        # and exactly one operator item for the parked plan.
        from aria_kernel.autonomy_state import autonomy_state_path

        rows = [row for row in load_jsonl(autonomy_state_path(self.tools))
                if (row.get("details") or {}).get("plan_id") == "plan-1"]
        self.assertEqual([(row["phase"], row["status"]) for row in rows], [
            ("convergence_resolved", "cross_review_self_agreement"),
            ("convergence_blocked", "cross_review_self_agreement"),
        ])
        self.assertEqual(self.operator_items(), [parked_plan_request_id("plan-1")])
        self.assertEqual(outcome["reported"]["operator_item"], parked_plan_request_id("plan-1"))

    def test_self_agreement_is_never_the_drafters_failure(self) -> None:
        # ARIA-HIGH-370 replaced the lane-token list with an allowlist of
        # evidence (``failure_attribution``): a row carrying the self-agreement
        # code is judged whole and never attributed to the drafter.
        from aria_kernel.failure_attribution import attribute_evaluation

        payload = {"terminal_state": "HUMAN_REQUIRED", "reason_codes": [CROSS_REVIEW_SELF_AGREEMENT_REASON],
                   "gate_decisions": [{"gate": "independence", "decision": "human_escalation",
                                       "reason_codes": [CROSS_REVIEW_SELF_AGREEMENT_REASON]}]}
        self.assertIsNone(attribute_evaluation(payload, plan_id="plan-1", drafter="agent:drafter",
                                               ledgers=None))


def _write_legacy_convergence(case: "_ReviewedCase") -> None:
    """A CONVERGED evaluation as written before the gate: no independence decision."""
    with _plan_lock(case.tools):
        _append_event(
            root=case.tools, plan_id="plan-1", event_type="plan_evaluated",
            payload={"round_number": 1, "terminal_state": "CONVERGED",
                     "risks_rollup_summary": {}, "gate_decisions": [], "reason_codes": []},
            idempotency_key=_idempotency_key("plan-1", "evaluate", {"round_number": 1}),
        )
    case.assertEqual(case.state(), "CONVERGED")


class LegacyConvergedPlan(_ReviewedCase):
    """A plan CONVERGED before the gate existed: its evaluation has no
    independence decision."""

    def setUp(self) -> None:
        super().setUp()
        _write_legacy_convergence(self)

    def test_the_sweep_judges_it_once_before_offering_and_moves_a_failure(self) -> None:
        runner = _runner()
        report = self.sweep(runner, _ECHO)
        runner.run.assert_not_called()
        self.assertEqual(report["independence_failed"], ["plan-1"])
        self.assertEqual(self.state(), "HUMAN_REQUIRED")
        self.assertEqual(self.operator_items(), [parked_plan_request_id("plan-1")])
        again = self.sweep(runner, _ECHO)
        self.assertEqual(again["independence_failed"], [])
        self.assertEqual(self.governance_kinds().count(INDEPENDENCE_MIGRATED_KIND), 1)

    def test_the_delivery_door_judges_it_too(self) -> None:
        runner = _runner()
        with mock.patch(_VERIFY, return_value=_ECHO):
            summary = deliver_converged_plan(
                runner=runner, cycle_id="cyc-2", plan_id="plan-1", workspace_root=self.root,
                base_dir=self.tools, cross_review_summary={}, profile="strict", origin=ORIGIN_CONVERGED,
            )
        runner.run.assert_not_called()
        self.assertEqual(summary["delivery"]["withheld"], WITHHELD_NOT_INDEPENDENT)
        self.assertEqual(self.state(), "HUMAN_REQUIRED")

    def test_a_legacy_plan_that_passes_stays_converged_and_is_offered(self) -> None:
        runner = _runner()
        self.sweep(runner, _CLEAN)
        runner.run.assert_called_once()
        self.assertEqual(self.state(), "CONVERGED")


class CleanRoundStillDelivers(_ReviewedCase):
    def test_a_clean_round_converges_with_the_gate_on_record_and_is_delivered(self) -> None:
        result = self.cycle_step(_CLEAN)
        self.assertEqual(result["arbiter_verdict"], "converged")
        self.assertEqual(self.state(), "CONVERGED")
        self.assertIn(
            {"gate": CROSS_REVIEW_INDEPENDENCE_GATE, "passed": True, "violation_reasons": []},
            self.last_evaluation()["gate_decisions"],
        )
        runner = _runner()
        report = self.sweep(runner)
        runner.run.assert_called_once()
        self.assertEqual([row["plan_id"] for row in report["offered"]], ["plan-1"])


class RefusedDispatchRecordIsDisclosedOnce(_ReviewedCase):
    def test_a_refused_round_record_writes_one_row_per_plan_and_round(self) -> None:
        from aria_kernel.plan_convergence import fold_plan_state
        from aria_kernel.round_independence import ROUND_DISPATCH_REFUSED_KIND, round_dispatches

        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        with mock.patch("aria_kernel.round_independence.requests_for_step", return_value=[{"request_id": " "}]):
            for _ in range(3):
                round_dispatches(plan_id="plan-1", round_number=1, state=state, base_dir=self.tools)
        # One per refused role (primary, challenger, cross review), never per read.
        self.assertEqual(self.governance_kinds().count(ROUND_DISPATCH_REFUSED_KIND), 3)


class SecondReviewParkedItems(_ReviewedCase):
    """ARIA-HIGH-375 second review — the sweep cannot be ended by the
    migration, and every parked plan has exactly one live operator item."""

    def items(self) -> dict[str, dict]:
        import json

        folder = self.tools / "human-required"
        return {path.stem: json.loads(path.read_text(encoding="utf-8"))
                for path in folder.glob("*.json")} if folder.is_dir() else {}

    def test_a_store_fault_in_the_migration_is_a_row_and_the_plan_is_not_offered(self) -> None:
        from aria_kernel.converged_delivery import (
            INDEPENDENCE_MIGRATION_FAILED_KIND,
            WITHHELD_INDEPENDENCE_UNJUDGED,
        )
        from aria_kernel.tool_registry import GovernanceError

        self.cycle_step(_CLEAN)
        runner = _runner()
        with mock.patch("aria_kernel.converged_delivery.withhold_ungated_self_agreement",
                        side_effect=GovernanceError("plan lock timeout")):
            report = self.sweep(runner)
        runner.run.assert_not_called()
        self.assertEqual(report["withheld"], {"plan-1": WITHHELD_INDEPENDENCE_UNJUDGED})
        self.assertIn(INDEPENDENCE_MIGRATION_FAILED_KIND, self.governance_kinds())

    def test_the_sweep_writes_the_missing_item_once_and_resolves_it_when_the_plan_leaves(self) -> None:
        from aria_kernel.plan_convergence import abandon_plan

        # The drainer parks the plan; nothing wrote its item (a fault between
        # the transition and the item, or a writer that predates the item).
        self.cycle_step(_ECHO)
        self.assertEqual(self.operator_items(), [])
        self.sweep(_runner(), _ECHO)
        self.sweep(_runner(), _ECHO)
        self.assertEqual(self.operator_items(), [parked_plan_request_id("plan-1")])
        self.assertEqual(self.items()[parked_plan_request_id("plan-1")]["status"], "open")
        abandon_plan(plan_id="plan-1", reason="operator: superseded", base_dir=self.tools)
        report = self.sweep(_runner(), _ECHO)
        self.assertEqual(report["parked"]["resolved"], [parked_plan_request_id("plan-1")])
        item = self.items()[parked_plan_request_id("plan-1")]
        self.assertEqual((item["status"], item["resolved_by"]), ("resolved", "kernel"))
        self.assertEqual(self.sweep(_runner(), _ECHO)["parked"]["resolved"], [])

    def test_a_plan_the_operator_parked_is_recorded_already_resolved(self) -> None:
        from aria_kernel.plan_convergence import force_plan_human_required

        force_plan_human_required(plan_id="plan-1", round_number=1,
                                  reason_codes=["operator_withdrawn"], base_dir=self.tools)
        self.sweep(_runner())
        item = self.items()[parked_plan_request_id("plan-1")]
        self.assertEqual((item["status"], item["kernel_disposition"]["disposition"]),
                         ("resolved", "parked_by_operator"))

    def test_a_re_parked_plan_gets_a_fresh_item_never_the_old_resolved_one(self) -> None:
        from aria_kernel.convergence_outcome import record_parked_plan
        from aria_kernel.human_required import resolve_human_required

        self.cycle_step(_ECHO)
        first = record_parked_plan(plan_id="plan-1", base_dir=self.tools, verdict="v", origin="test")
        resolve_human_required(request_id=first["request_id"], resolution_note="re-staged",
                               base_dir=self.tools)
        # A second parking of the same plan (a re-opened plan escalating again).
        with _plan_lock(self.tools):
            _append_event(
                root=self.tools, plan_id="plan-1", event_type="plan_evaluated",
                payload={"round_number": 2, "terminal_state": "HUMAN_REQUIRED",
                         "risks_rollup_summary": {}, "gate_decisions": [],
                         "reason_codes": ["max_rounds_reached"]},
                idempotency_key=_idempotency_key("plan-1", "evaluate", {"round_number": 2}),
            )
        second = record_parked_plan(plan_id="plan-1", base_dir=self.tools, verdict="v", origin="test")
        self.assertEqual(second["request_id"], parked_plan_request_id("plan-1", 2))
        self.assertEqual(second["request_id"], "plan-human-required-plan-1-2")
        self.assertEqual(second["status"], "open")
        self.assertEqual(self.items()[first["request_id"]]["status"], "resolved")


class MigratedConvergenceIsNotTheDraftersSuccess(_ReviewedCase):
    def setUp(self) -> None:
        super().setUp()
        _write_legacy_convergence(self)

    def test_the_escalation_supersedes_the_converged_credit(self) -> None:
        from aria_kernel.agent_eval import _performance_episodes
        from aria_kernel.failure_attribution import InvocationLedgersSource

        self.sweep(_runner(), _ECHO)
        episodes = _performance_episodes(load_jsonl(events_path(self.tools)), {},
                                         InvocationLedgersSource(self.tools))
        drafter = [row for row in episodes if row["role"] == "drafter" and row["plan_id"] == "plan-1"]
        converged = [row for row in drafter if row["outcome"] == "converged"]
        escalated = [row for row in drafter if row["outcome"] == "escalated"]
        self.assertEqual(len(converged), 1)
        self.assertEqual(escalated[-1]["supersedes"], converged[0]["episode_id"])
        self.assertFalse(escalated[-1]["attributable"])
