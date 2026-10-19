"""ARIA-MEDIUM-552 — a CONVERGED plan whose body the ledger cannot prove is
parked once, not re-offered and re-refused every cycle forever.

``plan_body_from_state`` refuses a plan whose latest revision has no
``content_hash`` or no recorded body that hashes to it. Since the
``plan_contract_complete`` gate (test_plan_convergence: "a prose revision
cannot converge") no new plan converges that way, but a plan that converged
on a prose revision before it is in the ledger for good. The delivery door
asked for that body inside the attempt claim, the refusal became the
uncounted ``attempt_unrecorded`` withhold, which never reaches
``MAX_DELIVERY_ATTEMPTS`` or the operator, and the sweep offered the plan
again every cycle.

The refusal is a property of the append-only plan ledger, so it is a mint
refusal like a readonly scope (ARIA-HIGH-416): the plan is moved CONVERGED →
HUMAN_REQUIRED on its first offer, before staging, with one governance row
and the plan's one operator item.
"""
from __future__ import annotations

import hashlib
import unittest

from aria_kernel import converged_delivery
from aria_kernel.convergence_outcome import PARKED_PLAN_CONTEXT_KIND, parked_plan_request_id
from aria_kernel.failure_attribution import KERNEL_FORCED_CODES, attribute_evaluation
from aria_kernel.plan_convergence import (
    PlanBodyUnprovable,
    _append_event,
    counted_delivery_attempts,
    plan_body_from_state,
)
from tests.test_converged_delivery_scope_precheck import FARM, FORCER, _ScopeCase

# Persisted tokens, pinned by value.
REASON = "implementation_envelope_body_unprovable"
WITHHELD = "body_unprovable"
KIND = "converged_delivery_body_unprovable"


class _LegacyBodyCase(_ScopeCase):
    def converge_on_prose(self, plan_id: str) -> str:
        """A plan that converged on a prose revision before the body gate:
        a real convergence, then the two events the pre-gate kernel wrote."""
        self.converge(plan_id, [FARM])
        state = self.state(plan_id)
        prose = "round two: tighten the sampling interval as discussed"
        legacy = [
            ("revision_recorded", {
                "revision_id": f"{plan_id}-r2", "round": int(state["current_round"]) + 1,
                "content_hash": "sha256:" + hashlib.sha256(prose.encode("utf-8")).hexdigest(),
                "parent_revision_hash": state["latest_revision"]["content_hash"], "content": prose,
            }),
            ("plan_evaluated", {
                "terminal_state": "CONVERGED", "round_number": int(state["current_round"]) + 1,
                "risks_rollup_summary": {}, "gate_decisions": [], "reason_codes": [],
            }),
        ]
        for event_type, payload in legacy:
            _append_event(root=self.tools, plan_id=plan_id, event_type=event_type, payload=payload,
                          idempotency_key="sha256:" + hashlib.sha256(
                              f"{plan_id}:{event_type}:legacy".encode()).hexdigest())
        return plan_id


class UnprovableBodyIsParkedOnce(_LegacyBodyCase):
    def test_the_fixture_is_the_refusal_production_meets(self) -> None:
        plan_id = self.converge_on_prose("plan-legacy-prose")
        state = self.state(plan_id)
        self.assertEqual(state["state"], "CONVERGED")
        with self.assertRaisesRegex(PlanBodyUnprovable, "plan_body_unavailable_for_revision"):
            plan_body_from_state(state)

    def test_a_revision_with_no_content_hash_is_the_same_refusal(self) -> None:
        # The finding's own shape: a pre-validator ledger whose latest
        # revision names no content_hash. The event validator refuses that
        # row today, so it is a fold the reducer can no longer produce; the
        # door reads the same type for it.
        plan_id = self.converge("plan-legacy-unhashed", [FARM])
        state = self.state(plan_id)
        state["latest_revision"] = {key: value for key, value in state["latest_revision"].items()
                                    if key != "content_hash"}
        with self.assertRaisesRegex(PlanBodyUnprovable, "plan_body_no_revision_hash"):
            plan_body_from_state(state)

    def test_the_first_offer_parks_it_and_no_later_cycle_offers_it(self) -> None:
        plan_id = self.converge_on_prose("plan-legacy-prose")

        first = self.deliver(plan_id, cycle_id="cyc-1")
        later = [self.sweep(cycle_id=f"cyc-{n}") for n in (2, 3, 4)]

        state = self.state(plan_id)
        self.assertEqual(first["delivery"]["withheld"], WITHHELD)
        self.assertEqual(state["state"], "HUMAN_REQUIRED")
        self.assertEqual((*self.staged(), len(counted_delivery_attempts(state))), (0, 0, 0, 0))
        for report in later:
            self.assertEqual((report["stranded"], report["offered"], report["withheld"]), ([], [], {}))
        # The loop this closes: one uncounted fault row per cycle, forever.
        self.assertEqual(self.governance("converged_delivery_attempt_unrecorded"), [])

    def test_the_rows_name_the_ledger_refusal(self) -> None:
        plan_id = self.converge_on_prose("plan-legacy-prose")
        self.deliver(plan_id, cycle_id="cyc-1")

        [row] = self.human_required_evaluations(plan_id)
        self.assertEqual((row["reason_codes"], row["forced_by"]), ([REASON], FORCER))
        self.assertIsNone(attribute_evaluation(row, plan_id=plan_id, drafter="agent:drafter", ledgers=None))
        [governance] = self.governance(KIND)
        self.assertTrue(governance["refusal"].startswith("plan_body_unavailable_for_revision:"), governance)
        item = self.operator_items()[parked_plan_request_id(plan_id)]
        self.assertEqual(
            {key: item["context"][key] for key in ("kind", "plan_id", "verdict", "reason_codes", "origin")},
            {"kind": PARKED_PLAN_CONTEXT_KIND, "plan_id": plan_id, "verdict": WITHHELD,
             "reason_codes": [REASON], "origin": "converged_delivery"},
        )

    def test_a_provable_plan_is_still_staged_and_dispatched(self) -> None:
        plan_id = self.converge("plan-farm", [FARM])
        summary = self.deliver(plan_id, cycle_id="cyc-1")
        self.assertEqual(summary["terminal_state"], "IMPLEMENTATION_DISPATCHED", summary)
        self.assertEqual(self.governance(KIND), [])

    def test_the_persisted_tokens(self) -> None:
        self.assertEqual((converged_delivery.BODY_UNPROVABLE_REASON, converged_delivery.WITHHELD_BODY_UNPROVABLE,
                          converged_delivery.BODY_UNPROVABLE_KIND), (REASON, WITHHELD, KIND))
        self.assertIn(REASON, KERNEL_FORCED_CODES)


if __name__ == "__main__":
    unittest.main()
