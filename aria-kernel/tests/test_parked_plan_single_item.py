"""ARIA-MEDIUM-429 — a plan parked by delivery exhaustion is ONE operator item.

aria/state f5c5c86a1, ``human-required/``: each of the two exhausted plans,
``plan-cyc-20261008T120143Z-auto`` and ``plan-cyc-20261008T151306Z-auto``,
has two open items for one parking.

* ``converged-delivery-exhausted-<plan>`` (kind ``converged_plan_delivery``)
  carries the attempts and ``runner_exception:BridgeContractViolation``.
* ``plan-human-required-<plan>`` was added 14 s and 17 s later by
  ``reconcile_parked_plans`` (origin ``reconcile``).

``convergence_outcome.record_parked_plan`` is the documented single owner of
"this parked plan needs an operator". Pins:

* exhaustion writes the plan's own item, with the attempts (from the plan's
  ledger) and the last rejection class, and the sweep's reconcile adds none;
* the reconcile folds an open legacy exhaustion item into the plan's item
  (append-only: facts moved, legacy resolved by the kernel naming the kept
  item, one governance row), and a second reconcile writes nothing;
* a legacy item of a plan that left HUMAN_REQUIRED is resolved with the
  plan's other items;
* a fold interrupted after its governance row completes once.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from aria_kernel import human_required
from aria_kernel.converged_delivery import DELIVERY_EXHAUSTED_REASON, escalate_exhausted_plan
from aria_kernel.convergence_outcome import (
    PARKED_DISPOSITION_FOLDED,
    PARKED_DUPLICATE_FOLDED_KIND,
    PARKED_PLAN_CONTEXT_KIND,
    legacy_exhaustion_request_id,
    parked_plan_request_id,
    reconcile_parked_plans,
)
from aria_kernel.human_required import list_human_required, record_human_required
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import abandon_plan, force_plan_human_required
from tests import test_converged_delivery as delivery_fixtures

# The real CONVERGED plan of the delivery suite, borrowed (not imported as a
# class, which would collect its tests here too).
PLAN = delivery_fixtures.PLAN

_EMPTY_RECONCILE = {"recorded": [], "resolved": [], "folded": [], "failed": []}
_LAST_REJECTION = "runner_exception:BridgeContractViolation"


class OneParkingOneItem(unittest.TestCase):
    setUp = delivery_fixtures.ConvergedDeliveryTests.setUp
    tearDown = delivery_fixtures.ConvergedDeliveryTests.tearDown
    _state = delivery_fixtures.ConvergedDeliveryTests._state
    _spend = delivery_fixtures.ReviewCorrectionTests._spend

    def items(self, *, include_resolved: bool = False) -> dict[str, dict]:
        return {
            row["request_id"]: row
            for row in list_human_required(base_dir=self.tools, include_resolved=include_resolved)
            if (row.get("context") or {}).get("plan_id") == PLAN
        }

    def folds(self) -> list[dict]:
        rows = load_jsonl(self.tools / "governance.jsonl")
        return [
            {key: value for key, value in row["details"].items() if key != "disclosure_fingerprint"}
            for row in rows if row.get("kind") == PARKED_DUPLICATE_FOLDED_KIND
        ]

    def store_bytes(self) -> dict[str, bytes]:
        directory = self.tools / "human-required"
        files = {path.name: path.read_bytes() for path in directory.glob("*.json")}
        files["governance.jsonl"] = (self.tools / "governance.jsonl").read_bytes()
        return files

    def park_as_before_the_fix(self) -> None:
        """The production pair: the exhaustion's own record, then the reconcile's item."""
        self._spend()
        force_plan_human_required(
            plan_id=PLAN, round_number=1, reason_codes=[DELIVERY_EXHAUSTED_REASON],
            from_states=frozenset({"CONVERGED"}), base_dir=self.tools, forced_by="kernel:converged_delivery",
        )
        attempts = [
            {key: row.get(key) for key in ("attempt", "cycle_id", "profile", "runner_class", "recorded_at", "voided")}
            for row in self._state()["implementation_delivery_attempts"]
        ]
        record_human_required(
            request_id=legacy_exhaustion_request_id(PLAN), severity="HIGH",
            reason=f"{DELIVERY_EXHAUSTED_REASON}: CONVERGED plan {PLAN} was offered 3 times",
            context={"kind": "converged_plan_delivery", "plan_id": PLAN, "reason_code": DELIVERY_EXHAUSTED_REASON,
                     "attempts": attempts, "last_rejection_class": _LAST_REJECTION, "finding_id": "ARIA-HIGH-362"},
            base_dir=self.tools,
        )
        record_human_required(
            request_id=parked_plan_request_id(PLAN), severity="HIGH",
            reason=f"plan {PLAN} ended convergence HUMAN_REQUIRED (human_required: {DELIVERY_EXHAUSTED_REASON})",
            context={"kind": PARKED_PLAN_CONTEXT_KIND, "plan_id": PLAN, "verdict": "human_required",
                     "reason_codes": [DELIVERY_EXHAUSTED_REASON], "round_number": 1, "origin": "reconcile",
                     "finding_id": "ARIA-HIGH-368"},
            base_dir=self.tools,
        )
        self.assertEqual(sorted(self.items()), sorted([legacy_exhaustion_request_id(PLAN), parked_plan_request_id(PLAN)]))

    def test_an_exhaustion_writes_the_plans_one_item(self) -> None:
        self._spend()
        outcome = escalate_exhausted_plan(PLAN, base_dir=self.tools, last_rejection_class=_LAST_REJECTION)
        self.assertEqual((outcome["status"], outcome["request_id"]), ("escalated", parked_plan_request_id(PLAN)))
        self.assertEqual(reconcile_parked_plans(base_dir=self.tools), _EMPTY_RECONCILE)
        self.assertEqual(list(self.items()), [parked_plan_request_id(PLAN)])
        context = self.items()[parked_plan_request_id(PLAN)]["context"]
        self.assertEqual([row["attempt"] for row in context["delivery_attempts"]], [1, 2, 3])
        self.assertEqual(context["last_rejection_class"], _LAST_REJECTION)

    def test_the_production_pair_folds_into_the_plans_item(self) -> None:
        self.park_as_before_the_fix()
        legacy, kept = legacy_exhaustion_request_id(PLAN), parked_plan_request_id(PLAN)

        report = reconcile_parked_plans(base_dir=self.tools)

        self.assertEqual(report, {**_EMPTY_RECONCILE, "folded": [legacy]})
        self.assertEqual(list(self.items()), [kept])
        context = self.items()[kept]["context"]
        self.assertEqual((context["kind"], context["origin"], context["folded_from"]),
                         (PARKED_PLAN_CONTEXT_KIND, "reconcile", legacy))
        self.assertEqual([row["attempt"] for row in context["delivery_attempts"]], [1, 2, 3])
        self.assertEqual(context["last_rejection_class"], _LAST_REJECTION)
        folded = self.items(include_resolved=True)[legacy]
        self.assertEqual((folded["status"], folded["resolved_by"]), ("resolved", "kernel"))
        self.assertEqual(
            (folded["kernel_disposition"]["disposition"], folded["kernel_disposition"]["kept_request_id"]),
            (PARKED_DISPOSITION_FOLDED, kept),
        )
        # The legacy record keeps what it said; only its status moved.
        self.assertEqual(folded["context"]["kind"], "converged_plan_delivery")
        self.assertEqual(self.folds(), [{"plan_id": PLAN, "folded_request_id": legacy, "kept_request_id": kept}])

        before = self.store_bytes()
        self.assertEqual(reconcile_parked_plans(base_dir=self.tools), _EMPTY_RECONCILE)
        self.assertEqual(self.store_bytes(), before, "a second reconcile writes nothing")

    def test_a_legacy_item_of_a_plan_that_left_is_resolved_with_it(self) -> None:
        self.park_as_before_the_fix()
        abandon_plan(plan_id=PLAN, reason="operator: superseded", base_dir=self.tools)
        report = reconcile_parked_plans(base_dir=self.tools)
        self.assertEqual(sorted(report["resolved"]),
                         sorted([parked_plan_request_id(PLAN), legacy_exhaustion_request_id(PLAN)]))
        self.assertEqual(self.items(), {})

    def test_a_fold_interrupted_after_its_governance_row_completes_once(self) -> None:
        self.park_as_before_the_fix()
        with patch.object(human_required, "write_kernel_disposition", side_effect=OSError("disk full")):
            report = reconcile_parked_plans(base_dir=self.tools)
        self.assertEqual(report["failed"], [PLAN])
        self.assertIn(legacy_exhaustion_request_id(PLAN), self.items())
        resumed = reconcile_parked_plans(base_dir=self.tools)
        self.assertEqual(resumed["folded"], [legacy_exhaustion_request_id(PLAN)])
        self.assertEqual(list(self.items()), [parked_plan_request_id(PLAN)])
        self.assertEqual(len(self.folds()), 1)


if __name__ == "__main__":
    unittest.main()
