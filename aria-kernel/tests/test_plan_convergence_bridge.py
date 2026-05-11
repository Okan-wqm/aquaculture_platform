"""Plan 026R §C.1 — planner-role auto-bridge for submit_claim_result.

6 tests:

* PLANNER_BRIDGE_ROLES = frozenset({"primary_plan", "challenger_plan",
  "cross_review"}) — constant shape.
* primary_plan → record_revision dispatch + payload mapping.
* challenger_plan → submit_challenger_plan dispatch + payload mapping.
* cross_review → record_cross_review dispatch + payload mapping.
* Non-planner role (judge / supporting / None) returns None (no-op).
* Missing plan_id raises GovernanceError.

The bridge is a thin dispatcher; the underlying plan_convergence
primitives have their own state-machine tests. These tests use mocks
to assert the bridge calls the RIGHT primitive with the RIGHT
payload — fully integrating the state machine would just re-test the
plan_convergence layer.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from aria_kernel.plan_convergence_bridge import (
    PLANNER_BRIDGE_ROLES,
    is_planner_bridge_role,
    record_plan_result,
)
from aria_kernel.tool_registry import GovernanceError


class PlannerBridgeRoleConstantsTests(unittest.TestCase):
    def test_planner_bridge_roles_set_shape(self) -> None:
        self.assertEqual(
            PLANNER_BRIDGE_ROLES,
            frozenset({"primary_plan", "challenger_plan", "cross_review"}),
        )

    def test_is_planner_bridge_role_predicate(self) -> None:
        for role in PLANNER_BRIDGE_ROLES:
            self.assertTrue(is_planner_bridge_role(role))
        for non_planner in (
            "evidence_judgment",
            "adversarial_judgment",
            "consensus_arbitration",
            "change_intelligence",
            "goldset_curation",
            None,
            "",
        ):
            self.assertFalse(is_planner_bridge_role(non_planner))


class RecordPlanResultDispatchTests(unittest.TestCase):
    """Each planner role dispatches to the correct plan_convergence
    primitive with the correct payload."""

    def test_primary_plan_routes_to_record_revision(self) -> None:
        request = {"plan_id": "plan-p1", "role": "primary_plan"}
        response = {
            "role": "primary_plan",
            "details": {
                "revision": {
                    "revision_id": "rev-1",
                    "summary": "tighten scope",
                },
            },
        }
        with patch(
            "aria_kernel.plan_convergence.record_revision",
            return_value={"event_id": "ev-pp-1", "event_type": "revision_recorded"},
        ) as mock_rev:
            result = record_plan_result(
                role="primary_plan",
                request=request,
                response=response,
                base_dir=None,
            )
        mock_rev.assert_called_once()
        kwargs = mock_rev.call_args.kwargs
        self.assertEqual(kwargs["plan_id"], "plan-p1")
        self.assertEqual(kwargs["revision"]["revision_id"], "rev-1")
        self.assertEqual(result["event_id"], "ev-pp-1")

    def test_challenger_plan_routes_to_submit_challenger_plan(self) -> None:
        request = {"plan_id": "plan-c1", "role": "challenger_plan"}
        response = {
            "role": "challenger_plan",
            "details": {
                "challenger": {
                    "challenger_id": "ch-1",
                    "round_number": 1,
                },
            },
        }
        with patch(
            "aria_kernel.plan_convergence.submit_challenger_plan",
            return_value={"event_id": "ev-ch-1", "event_type": "challenger_plan_drafted"},
        ) as mock_ch:
            result = record_plan_result(
                role="challenger_plan",
                request=request,
                response=response,
                base_dir=None,
            )
        mock_ch.assert_called_once()
        kwargs = mock_ch.call_args.kwargs
        self.assertEqual(kwargs["plan_id"], "plan-c1")
        self.assertEqual(kwargs["challenger"]["challenger_id"], "ch-1")
        self.assertEqual(result["event_type"], "challenger_plan_drafted")

    def test_cross_review_routes_to_record_cross_review(self) -> None:
        request = {
            "plan_id": "plan-cr1",
            "role": "cross_review",
            "workspace_root": "/tmp/workspace",
        }
        response = {
            "role": "cross_review",
            "details": {
                "review": {
                    "task_id": "cr-task-1",
                    "verdict": "agree",
                },
            },
        }
        with patch(
            "aria_kernel.plan_convergence.record_cross_review",
            return_value={"event_id": "ev-cr-1", "event_type": "cross_review_recorded"},
        ) as mock_cr:
            result = record_plan_result(
                role="cross_review",
                request=request,
                response=response,
                base_dir=None,
            )
        mock_cr.assert_called_once()
        kwargs = mock_cr.call_args.kwargs
        self.assertEqual(kwargs["plan_id"], "plan-cr1")
        self.assertEqual(kwargs["review"]["task_id"], "cr-task-1")
        self.assertEqual(kwargs["workspace_root"], "/tmp/workspace")
        self.assertEqual(result["event_type"], "cross_review_recorded")

    def test_non_planner_role_returns_none(self) -> None:
        for non_planner in (
            "evidence_judgment",
            "adversarial_judgment",
            "consensus_arbitration",
            "change_intelligence",
            "goldset_curation",
            None,
        ):
            result = record_plan_result(
                role=non_planner,
                request={"plan_id": "plan-x"},
                response={"role": non_planner, "details": {}},
                base_dir=None,
            )
            self.assertIsNone(result, f"role={non_planner!r} should be no-op")

    def test_missing_plan_id_raises_governance_error(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            record_plan_result(
                role="primary_plan",
                request={"role": "primary_plan"},  # no plan_id
                response={"role": "primary_plan", "details": {}},
                base_dir=None,
            )
        self.assertIn("missing_plan_id", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
