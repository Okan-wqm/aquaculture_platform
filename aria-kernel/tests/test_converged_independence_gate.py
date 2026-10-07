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
from aria_kernel.agent_eval import UNATTRIBUTABLE_FAILURE_MODES
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
        self.assertIn(CROSS_REVIEW_SELF_AGREEMENT_REASON, UNATTRIBUTABLE_FAILURE_MODES)


class LegacyConvergedPlan(_ReviewedCase):
    """A plan CONVERGED before the gate existed: its evaluation has no
    independence decision."""

    def setUp(self) -> None:
        super().setUp()
        with _plan_lock(self.tools):
            _append_event(
                root=self.tools, plan_id="plan-1", event_type="plan_evaluated",
                payload={"round_number": 1, "terminal_state": "CONVERGED",
                         "risks_rollup_summary": {}, "gate_decisions": [], "reason_codes": []},
                idempotency_key=_idempotency_key("plan-1", "evaluate", {"round_number": 1}),
            )
        self.assertEqual(self.state(), "CONVERGED")

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
