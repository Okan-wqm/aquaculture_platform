"""Plan 026R §C.1 — planner-role auto-bridge for submit_claim_result.

6 tests:

* PLANNER_BRIDGE_ROLES = frozenset({"primary_plan", "challenger_plan",
  "cross_review", "implementation"}) — constant shape (V9.3 extended
  with "implementation" for the aria-implementer writer agent).
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
        """Plan ARIA-V9.3 — extends the set with "implementation" for
        the writer-agent dispatch path (record_implementation_outcome)."""
        self.assertEqual(
            PLANNER_BRIDGE_ROLES,
            frozenset({
                "primary_plan", "challenger_plan", "cross_review",
                "implementation",
            }),
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
        """Plan ARIA-V8 v2 §4 Phase 8.2 (B-V2-06) — record_revision is
        only called when plan state is in {CRITIQUED, CROSS_REVIEWED}.
        Mock fold_plan_state to return CRITIQUED so the dispatch table
        legally maps role=primary_plan → record_revision."""
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
            "aria_kernel.plan_convergence.fold_plan_state",
            return_value={"state": "CRITIQUED"},
        ), patch(
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

    def test_revision_round_and_parent_are_kernel_facts_not_agent_claims(self) -> None:
        """ARIA-HIGH-080 — the round-2 primary of trial eight echoed the
        request's round_number (2) as details.revision.round while the
        plan's critique round was 1; the bridge passed it through, the
        reducer refused, and an accepted 1,133 s revision was declared
        dead. The agent cannot read plan state, so what it says about the
        round or the parent hash is a guess; the kernel's own state is
        the only source for both. Its revision_id label still counts."""
        from aria_kernel.plan_convergence_bridge import _canonicalize_revision_payload

        response = {
            "request_id": "AIR-aria-primary-planner-f3c9a608e939", "agent_id": "ci-executor:gha-7",
            "plan_content": {"schema_version": 2, "title": "t", "summary": "s", "affected_surfaces": [],
                             "key_changes": ["k"], "validation_commands": [], "evidence_refs": ["a.ts:1"]},
            "details": {"agent_subagent_type": "aria-primary-planner",
                        "revision": {"round": 2, "parent_revision_hash": "sha256:" + "b" * 64,
                                     "revision_id": "rev-agent-label", "prior_round_artifacts_found": False}},
        }
        with patch(
            "aria_kernel.plan_convergence.fold_plan_state",
            return_value={"state": "CROSS_REVIEWED", "current_round": 1,
                          "latest_revision": {"revision_id": "flow-x-r1", "content_hash": "sha256:" + "a" * 64}},
        ):
            payload = _canonicalize_revision_payload(
                response=response, details=response["details"], plan_id="flow-x", base_dir=None,
            )
        self.assertEqual(payload["round"], 1)
        self.assertEqual(payload["parent_revision_hash"], "sha256:" + "a" * 64)
        self.assertEqual(payload["revision_id"], "rev-agent-label")
        # ARIA-HIGH-193 — the author is the executor-stamped subagent, never
        # the envelope's executor-shaped agent_id.
        self.assertEqual(payload["revised_by_agent"], "aria-primary-planner")

    def test_primary_plan_on_draft_raises_bridge_contract_violation(self) -> None:
        """Plan ARIA-V8 v2 §4 Phase 8.2 (B-V2-06) — DRAFT state refuses
        primary_plan dispatch via BridgeContractViolation. V8 v1's
        no_op path was structurally unreachable here (refused before
        envelope is minted by cross_review_bridge.issue_primary_envelope)."""
        from aria_kernel.bridge_exceptions import BridgeContractViolation
        request = {"plan_id": "plan-p1-draft", "role": "primary_plan"}
        response = {"role": "primary_plan", "details": {"revision": {}}}
        with patch(
            "aria_kernel.plan_convergence.fold_plan_state",
            return_value={"state": "DRAFT"},
        ):
            with self.assertRaises(BridgeContractViolation) as ctx:
                record_plan_result(
                    role="primary_plan",
                    request=request,
                    response=response,
                    base_dir=None,
                )
        self.assertIn("primary_plan_invalid_state", str(ctx.exception))
        self.assertIn("DRAFT", str(ctx.exception))

    def test_challenger_plan_routes_to_submit_challenger_plan(self) -> None:
        """Plan ARIA-V8.1 — bridge canonicalizes the agent envelope
        before passing to submit_challenger_plan. Agent emits
        plan_content (here at top-level per V8.1 contract); bridge
        wraps with source revision metadata from fold_plan_state."""
        canonical_pc = {
            "schema_version": 1,
            "title": "test",
            "summary": "test plan",
            "affected_surfaces": [{"paths": ["x.py"]}],
            "key_changes": ["A"],
            "validation_commands": [{"cmd": "echo"}],
            "evidence_refs": ["x.py:1"],
        }
        request = {"plan_id": "plan-c1", "role": "challenger_plan"}
        response = {
            "role": "challenger_plan",
            "request_id": "AIR-ch-001",
            "agent_id": "ci-executor:gha-7",
            "plan_content": canonical_pc,
            "details": {"agent_subagent_type": "aria-challenger-planner"},
        }
        kernel_state = {
            "latest_revision": {
                "revision_id": "rev-primary-001",
                "content_hash": "sha256:abc",
            },
        }
        with patch(
            "aria_kernel.plan_convergence.submit_challenger_plan",
            return_value={"event_id": "ev-ch-1", "event_type": "challenger_plan_drafted"},
        ) as mock_ch, patch(
            "aria_kernel.plan_convergence.fold_plan_state",
            return_value=kernel_state,
        ):
            result = record_plan_result(
                role="challenger_plan",
                request=request,
                response=response,
                base_dir=None,
            )
        mock_ch.assert_called_once()
        kwargs = mock_ch.call_args.kwargs
        self.assertEqual(kwargs["plan_id"], "plan-c1")
        challenger = kwargs["challenger"]
        self.assertEqual(challenger["plan_content"], canonical_pc)
        self.assertEqual(challenger["source_revision_id"], "rev-primary-001")
        self.assertEqual(challenger["source_plan_content_hash"], "sha256:abc")
        self.assertEqual(challenger["challenger_agent"], "aria-challenger-planner")
        self.assertTrue(challenger["challenger_revision_id"].startswith("chal-plan-c1-"))
        self.assertEqual(result["event_type"], "challenger_plan_drafted")

    def test_cross_review_routes_to_submit_cross_review_v8(self) -> None:
        """Plan ARIA-V8.2 — bridge dispatches role=cross_review to
        submit_cross_review_v8 (NOT raw record_cross_review). The V8
        wrapper synthesizes task metadata + state transitions from
        kernel state so the agent's bidirectional review envelope
        translates to the 3-event kernel ledger flow atomically."""
        request = {
            "plan_id": "plan-cr1",
            "role": "cross_review",
            "workspace_root": "/tmp/workspace",
        }
        response = {
            "role": "cross_review",
            "agent_id": "aria-cross-reviewer",
            "details": {
                "cross_review": {
                    "verdict": "agreed",
                    "risks": [],
                },
            },
        }
        with patch(
            "aria_kernel.plan_convergence.submit_cross_review_v8",
            return_value={"event_id": "ev-cr-v8-1", "event_type": "cross_review_recorded"},
        ) as mock_v8:
            result = record_plan_result(
                role="cross_review",
                request=request,
                response=response,
                base_dir=None,
            )
        mock_v8.assert_called_once()
        kwargs = mock_v8.call_args.kwargs
        self.assertEqual(kwargs["plan_id"], "plan-cr1")
        # Bridge enriches the review payload with reviewer_agent from
        # response.agent_id when the agent's payload omitted it.
        self.assertEqual(kwargs["review"]["reviewer_agent"], "aria-cross-reviewer")
        self.assertEqual(kwargs["review"]["verdict"], "agreed")
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

    def test_submitted_plan_content_is_one_table_for_bridge_and_submit_check(self) -> None:
        """The body the kernel judges at submit is the body the bridge records.

        Both canonicalizers and `submit_claim_result`'s plan-contract check
        read `submitted_plan_content`; a second extraction order would let
        the kernel accept one body and bridge another.
        """
        from aria_kernel.plan_convergence_bridge import submitted_plan_content

        nested = {"title": "nested"}
        top = {"title": "top"}
        self.assertEqual(
            submitted_plan_content("challenger_plan", {"details": {"challenger": {"plan_content": nested}}, "plan_content": top}),
            nested,
        )
        self.assertEqual(
            submitted_plan_content("primary_plan", {"details": {"revision": {"plan_content": nested}}, "plan_content": top}),
            nested,
        )
        # A revision wrapper without a body does not shadow the top-level one.
        self.assertEqual(
            submitted_plan_content("primary_plan", {"details": {"revision": {"round": 2}}, "plan_content": top}),
            top,
        )
        self.assertEqual(submitted_plan_content("challenger_plan", {"details": {"plan_content": nested}}), nested)
        self.assertIsNone(submitted_plan_content("challenger_plan", {"details": {}}))
        # The role-specific wrapper of the OTHER role is not read.
        self.assertEqual(
            submitted_plan_content("challenger_plan", {"details": {"revision": {"plan_content": nested}}, "plan_content": top}),
            top,
        )

    def test_implementation_completed_at_is_a_kernel_fact_not_an_agent_field(self) -> None:
        """No contract ever asked the implementer for `completed_at`, and the
        outcome recorder refuses an empty one — so every result that reached
        the bridge died on a field nobody was told about. The bridge stamps
        acceptance time when the agent omits it and keeps the agent's when
        given."""
        request = {"plan_id": "plan-impl", "role": "implementation", "request_id": "AIR-impl-1"}
        implementation = {
            "pr_url": "https://github.com/o/r/pull/1", "diff_hash": "sha256:" + "c" * 64,
            "branch_tip_sha": "d" * 40, "base_branch_sha": "e" * 40, "validation_results": [],
        }
        for supplied, expected in ((None, None), ("2026-09-12T11:18:24+00:00", "2026-09-12T11:18:24+00:00")):
            details = {"implementation": {**implementation, **({"completed_at": supplied} if supplied else {})}}
            with patch(
                "aria_kernel.plan_convergence.fold_plan_state",
                return_value={"state": "IMPLEMENTATION_IN_FLIGHT"},
            ), patch(
                "aria_kernel.plan_convergence.record_implementation_outcome",
                return_value={"event_type": "implementation_outcome_recorded"},
            ) as recorded, patch(
                # The claimed commit is a fixture sha with no repository behind
                # it; the verification boundary is its own property
                # (`test_implementation_signature_boundary`).
                "aria_kernel.plan_convergence_bridge.verify_implementation_commit",
            ):
                record_plan_result(role="implementation", request=request,
                                   response={"role": "implementation", "details": details}, base_dir=None)
            stamped = recorded.call_args.kwargs["completed_at"]
            self.assertTrue(stamped, "completed_at must never reach the recorder empty")
            if expected is not None:
                self.assertEqual(stamped, expected)
            self.assertEqual(recorded.call_args.kwargs["pr_url"], implementation["pr_url"])

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
