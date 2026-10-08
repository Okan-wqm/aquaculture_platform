"""ARIA-HIGH-388 — every implementation request ends on the plan ledger.

Measured 2026-10-08: ``AIR-aria-implementer-e056f97fe09b`` was refused by its
agent; the executor wrote HUMAN_REQUIRED and a claim release and nothing else,
so its plan sat IMPLEMENTATION_REQUESTED until the orphan reaper relabelled it
unattributable, and ``memory/procedural`` never held one implementer episode.
Pinned here:

* the stage → (class, fault domain) table covers every request-class delivery
  stage and only those, with classes the validator accepts;
* an agent refusal and a delivery refusal settle the plan with their class,
  stage, fault domain and request, once (a second settle is reported);
* the settled event reaches the scorecard (attributed only when the change
  was the implementer's) and the loop guard's lane-fault rule;
* a store fault while settling is a row, never an exception in the executor.
"""
from __future__ import annotations

import json
import unittest
from unittest import mock

from aria_kernel import convergence_drainer as cd
from aria_kernel.implementation_delivery import DELIVERY_STAGES, HOST_STAGES
from aria_kernel.implementation_rejections import (
    DELIVERY_STAGE_SETTLEMENT,
    IMPLEMENTER_REFUSED,
    VALID_IMPLEMENTATION_REJECTION_CLASSES,
)
from aria_kernel.implementation_settlement import (
    ALREADY_SETTLED,
    FAILED,
    NOT_AN_IMPLEMENTATION,
    SETTLED,
    SETTLEMENT_FAILED_KIND,
    settle_agent_refusal,
    settle_delivery_refusal,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import events_path, plan_status
from aria_kernel.release_reason import FAULT_DOMAINS
from tests.test_executor_event_driven_planning import _PlanCase

_VERIFY = "aria_kernel.round_independence.verify_independence"


class SettlementTableIsComplete(unittest.TestCase):
    def test_every_request_class_stage_and_no_host_stage_is_settled(self) -> None:
        self.assertEqual(set(DELIVERY_STAGE_SETTLEMENT), set(DELIVERY_STAGES) - set(HOST_STAGES))
        for stage, (rejection_class, fault_domain) in DELIVERY_STAGE_SETTLEMENT.items():
            self.assertIn(rejection_class, VALID_IMPLEMENTATION_REJECTION_CLASSES, stage)
            self.assertIn(fault_domain, FAULT_DOMAINS, stage)
        self.assertIn(IMPLEMENTER_REFUSED, VALID_IMPLEMENTATION_REJECTION_CLASSES)

    def test_a_host_stage_is_never_settled(self) -> None:
        for stage in HOST_STAGES:
            with self.assertRaises(ValueError):
                settle_delivery_refusal(request_id="AIR-x", stage=stage, base_dir=None)


class _ImplementationRequested(_PlanCase):
    """Plan-1 CONVERGED and its implementation request minted (the state the
    executor's implementer child ends in)."""

    def setUp(self) -> None:
        super().setUp()
        from aria_kernel.cross_review_bridge import issue_implementation_envelope
        from aria_kernel.request_admission import admit_request

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

    def last_rejection(self) -> dict:
        rows = [row for row in load_jsonl(events_path(self.tools))
                if row.get("event_type") == "implementation_rejected"]
        return rows[-1]["payload"]

    def implementer_episodes(self) -> list[dict]:
        from aria_kernel.agent_eval import _performance_episodes
        from aria_kernel.failure_attribution import InvocationLedgersSource

        episodes = _performance_episodes(load_jsonl(events_path(self.tools)), {}, InvocationLedgersSource(self.tools))
        return [row for row in episodes if row["role"] == "implementer"]


class AgentRefusalSettles(_ImplementationRequested):
    def test_the_refusal_ends_the_plan_once_with_its_class(self) -> None:
        first = settle_agent_refusal(request_id=self.request_id, base_dir=self.tools)
        self.assertEqual(first["status"], SETTLED)
        self.assertEqual(self.state(), "IMPLEMENTATION_REJECTED")
        payload = self.last_rejection()
        self.assertEqual(
            {key: payload[key] for key in ("rejection_class", "stage", "fault_domain", "request_id")},
            {"rejection_class": IMPLEMENTER_REFUSED, "stage": "agent_refusal",
             "fault_domain": "request", "request_id": self.request_id},
        )
        again = settle_agent_refusal(request_id=self.request_id, base_dir=self.tools)
        self.assertEqual((again["status"], again["plan_state"]), (ALREADY_SETTLED, "IMPLEMENTATION_REJECTED"))

    def test_the_scorecard_records_the_episode_without_blaming_the_implementer(self) -> None:
        settle_agent_refusal(request_id=self.request_id, base_dir=self.tools)
        episodes = self.implementer_episodes()
        self.assertEqual([(row["failure_mode"], row["attributable"]) for row in episodes],
                         [(IMPLEMENTER_REFUSED, False)])

    def test_a_request_of_another_role_is_not_settled(self) -> None:
        challenger = self.requests("challenger_plan")[0]["request_id"]
        self.assertEqual(settle_agent_refusal(request_id=challenger, base_dir=self.tools)["status"],
                         NOT_AN_IMPLEMENTATION)
        self.assertEqual(self.state(), "IMPLEMENTATION_REQUESTED")


class DeliveryRefusalSettles(_ImplementationRequested):
    def test_a_failed_gate_is_the_implementers_and_cools_the_subject(self) -> None:
        from aria_kernel.outage_attribution import failure_is_lane_fault

        settle_delivery_refusal(request_id=self.request_id, stage="apply_gate", base_dir=self.tools)
        self.assertEqual(self.last_rejection()["rejection_class"], "validation_failed")
        self.assertEqual([(row["failure_mode"], row["attributable"]) for row in self.implementer_episodes()],
                         [("validation_failed", True)])
        event = {"event_type": "implementation_rejected", "payload": self.last_rejection()}
        self.assertFalse(failure_is_lane_fault(event, waited_since=None, at=None, clock=mock.Mock()))

    def test_a_refused_push_is_the_lanes_never_the_findings(self) -> None:
        from aria_kernel.outage_attribution import failure_is_lane_fault

        settle_delivery_refusal(request_id=self.request_id, stage="push", base_dir=self.tools)
        payload = self.last_rejection()
        self.assertEqual((payload["rejection_class"], payload["fault_domain"]), ("push_refused", "harness"))
        self.assertTrue(failure_is_lane_fault({"event_type": "implementation_rejected", "payload": payload},
                                              waited_since=None, at=None, clock=mock.Mock()))
        self.assertEqual([row["attributable"] for row in self.implementer_episodes()], [False])

    def test_a_store_fault_is_a_row_not_an_exception(self) -> None:
        from aria_kernel.tool_registry import GovernanceError

        with mock.patch("aria_kernel.plan_convergence.record_implementation_rejected",
                        side_effect=GovernanceError("plan lock timeout")):
            outcome = settle_delivery_refusal(request_id=self.request_id, stage="apply_gate", base_dir=self.tools)
        self.assertEqual(outcome["status"], FAILED)
        kinds = [json.loads(line).get("kind") for line in
                 (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertIn(SETTLEMENT_FAILED_KIND, kinds)
        self.assertEqual(self.state(), "IMPLEMENTATION_REQUESTED")
