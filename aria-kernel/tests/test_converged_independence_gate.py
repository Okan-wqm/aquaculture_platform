"""ARIA-HIGH-375 — a self-agreeing round is never CONVERGED, so no path delivers it.

The independence check (ORPHAN-HIGH-421) ran AFTER `evaluate_plan` had
recorded CONVERGED: the converging cycle downgraded its own verdict to
`cross_review_self_agreement` and withheld delivery, but the plan stayed
CONVERGED, and the next cycle's stranded-plan sweep (ARIA-HIGH-362) offered it
to the implementer by state alone. Pinned here:

* a round that fails the gate is recorded HUMAN_REQUIRED in its one
  evaluation event; neither the sweep nor `deliver_converged_plan` offers it;
* the executor's in-run advance (ARIA-HIGH-368) never reaches its seam;
* a plan already CONVERGED without the gate (the operator's `plan evaluate`)
  leaves CONVERGED the next time the drainer judges it;
* a clean round still converges, with the gate on record, and is delivered.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest import mock

from aria_kernel import convergence_drainer as cd
from aria_kernel import executor_convergence as ec
from aria_kernel.converged_delivery import (
    ORIGIN_CONVERGED,
    WITHHELD_NOT_CONVERGED,
    deliver_converged_plan,
    redeliver_stranded_converged_plans,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import (
    CROSS_REVIEW_INDEPENDENCE_GATE,
    CROSS_REVIEW_SELF_AGREEMENT_REASON,
    evaluate_plan,
    events_path,
    plan_status,
)
from tests.test_executor_event_driven_planning import _LEASE, _PlanCase

_ECHO = (False, ["cross_review_echoes_primary"])
_CLEAN = (True, [])


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
        with mock.patch.object(cd, "verify_independence", return_value=independence):
            return cd.run_convergence_drainer(
                cycle_id="cyc-2", base_dir=self.tools, workspace_root=self.root, plan_id="plan-1",
                plan_seed=self.plan(), max_rounds=cd.AUTONOMY_CYCLE_MAX_ROUNDS,
            )

    def sweep(self, runner) -> dict:
        return redeliver_stranded_converged_plans(
            runner=runner, cycle_id="cyc-3", base_dir=self.tools, workspace_root=self.root,
            profile="strict",
        )

    def last_evaluation(self) -> dict:
        rows = [row for row in load_jsonl(events_path(self.tools))
                if row.get("event_type") == "plan_evaluated" and row.get("plan_id") == "plan-1"]
        return rows[-1]["payload"]


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
        report = self.sweep(runner)
        runner.run.assert_not_called()
        self.assertEqual(report["stranded"], [])

    def test_the_one_delivery_door_refuses_it(self) -> None:
        self.cycle_step(_ECHO)
        runner = _runner()
        summary = deliver_converged_plan(
            runner=runner, cycle_id="cyc-2", plan_id="plan-1", workspace_root=self.root,
            base_dir=self.tools, cross_review_summary={}, profile="strict", origin=ORIGIN_CONVERGED,
        )
        runner.run.assert_not_called()
        self.assertEqual(summary["delivery"]["withheld"], WITHHELD_NOT_CONVERGED)

    def test_the_executor_advance_never_reaches_its_converged_seam(self) -> None:
        seam = mock.Mock()
        with mock.patch.object(cd, "verify_independence", return_value=_ECHO):
            outcome = ec.advance_after_accepted_step(
                request=self.requests("cross_review")[0], tools_dir=self.tools,
                workspace_root=self.root, run_id="run-1", budget=ec.AdvanceBudget(),
                drain_remaining_seconds=None, environ=_LEASE, converged_seam=seam,
            )
        self.assertEqual(outcome["verdict"], "cross_review_self_agreement")
        seam.assert_not_called()
        self.assertEqual(self.state(), "HUMAN_REQUIRED")


class PlanConvergedWithoutTheGate(_ReviewedCase):
    def test_a_plan_converged_outside_the_drainer_leaves_converged_when_judged(self) -> None:
        # The operator's `plan evaluate` (and every ledger from before the
        # gate) converges without an independence verdict.
        evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools, max_rounds=2)
        self.assertEqual(self.state(), "CONVERGED")
        result = self.cycle_step(_ECHO)
        self.assertEqual(result["arbiter_verdict"], "cross_review_self_agreement")
        self.assertEqual(self.state(), "HUMAN_REQUIRED")
        runner = _runner()
        self.sweep(runner)
        runner.run.assert_not_called()


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
        self.assertEqual(plan_status(plan_id="plan-1", base_dir=self.tools)["state"], "CONVERGED")
