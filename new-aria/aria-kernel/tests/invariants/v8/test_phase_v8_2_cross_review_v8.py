"""Plan ARIA-V8.2 — single-step V8 P+C+CR cross_review state transition.

Closes Bug 6 (live observation 2026-05-18 run 4): drainer minted
cross_review envelope, ci_executor submitted, kernel result_accepted,
but bridge fired `agent_bridge_warning: cannot record cross-review
from state CHALLENGER_DRAFTED`. Root cause: the legacy 3-event kernel
flow (request_cross_review → record_cross_review × 2 → CROSS_REVIEWED)
expected the operator-side to mediate task creation BEFORE the review
record; V8 P+C+CR drainer minted only the review envelope.

Tier-1 architectural fix: `submit_cross_review_v8` wraps the 3 events
into a single kernel call. The agent emits the substantive review
(reviewer_agent + verdict + risks); the kernel synthesizes the task
metadata + state transitions from plan state. End-to-end architectural
solution, NOT a workaround — the agent contract is simpler AND the
state machine remains the legacy 3-event one (replay reconstructable).

Invariants:

- I-V8.2-CR-01 — `submit_cross_review_v8` exported from plan_convergence
- I-V8.2-CR-02 — `plan_convergence_bridge.record_plan_result` dispatches
  role=cross_review to `submit_cross_review_v8` (source-substring pin)
- I-V8.2-CR-03 — `submit_cross_review_v8` requires CHALLENGER_DRAFTED state
- I-V8.2-CR-04 — `submit_cross_review_v8` synthesizes BOTH required
  cross-review directions (primary_to_challenger + challenger_to_primary)
- I-V8.2-CR-05 — End-to-end: from CHALLENGER_DRAFTED state with risks,
  produces a CROSS_REVIEWED state in a single function call (via
  request_cross_review + record_cross_review × 2 sequencing).
"""
from __future__ import annotations

import inspect
import unittest
from unittest import mock

from . import _helpers  # noqa: F401

from aria_kernel import plan_convergence, plan_convergence_bridge


class TestV8CrossReviewStateTransition(unittest.TestCase):

    def test_i_v8_2_cr_01_kernel_function_exported(self):
        """submit_cross_review_v8 MUST exist in plan_convergence module."""
        self.assertTrue(
            hasattr(plan_convergence, "submit_cross_review_v8"),
            "plan_convergence.submit_cross_review_v8 MUST exist for V8.2 bridge dispatch",
        )

    def test_i_v8_2_cr_02_bridge_dispatches_to_v8_fn(self):
        """plan_convergence_bridge.record_plan_result MUST dispatch
        role=cross_review to submit_cross_review_v8 (source-substring
        pin so a future regression to raw record_cross_review flips
        a test, not a runtime warning).

        Plan ARIA-V9.0-B refactor split record_plan_result into
        match/case + ``_dispatch_cross_review`` helper for typing
        exhaustiveness (assert_never). Substring check now spans the
        full bridge module so the dispatch can live in either the
        primary function or its helper without losing invariant
        coverage."""
        bridge_src = inspect.getsource(plan_convergence_bridge)
        self.assertIn(
            "submit_cross_review_v8(", bridge_src,
            "bridge module MUST call submit_cross_review_v8 for cross_review role",
        )
        # Also confirm record_plan_result routes cross_review through
        # the dispatch helper (refactor invariant — V9.0-B Tier-1
        # match/case exhaustiveness; the helper holds the actual
        # submit_cross_review_v8 call).
        rpr_src = inspect.getsource(plan_convergence_bridge.record_plan_result)
        self.assertIn(
            '_dispatch_cross_review', rpr_src,
            "record_plan_result MUST route cross_review through _dispatch_cross_review (V9.0-B factor)",
        )

    def test_i_v8_2_cr_03_requires_challenger_drafted_state(self):
        """submit_cross_review_v8 MUST raise GovernanceError when state
        is NOT CHALLENGER_DRAFTED (Tier-1 state-guard at function
        entry)."""
        from aria_kernel.tool_registry import GovernanceError
        with mock.patch(
            "aria_kernel.plan_convergence.fold_plan_state",
            return_value={
                "state": "DRAFT",
                "plan_started": "2026-05-18T09:00:00+00:00",
                "latest_revision": {},
            },
        ), mock.patch(
            "aria_kernel.plan_convergence.ensure_tools_dir",
            return_value=None,
        ):
            with self.assertRaises(GovernanceError) as ctx:
                plan_convergence.submit_cross_review_v8(
                    plan_id="plan-x",
                    review={"reviewer_agent": "aria-cross-reviewer", "risks": []},
                    workspace_root=".",
                    base_dir=None,
                )
            # Kernel error reports the BAD state ("from state DRAFT")
            # rather than the required state. Both assertions pin the
            # state-guard message format.
            self.assertIn("DRAFT", str(ctx.exception))
            self.assertIn("submit V8 cross-review", str(ctx.exception))

    def test_i_v8_2_cr_04_synthesizes_both_directions(self):
        """submit_cross_review_v8 MUST call request_cross_review with
        tasks covering BOTH primary_to_challenger AND
        challenger_to_primary (REQUIRED_CROSS_REVIEW_DIRECTIONS)."""
        captured_request = {}

        def _fake_request(**kwargs):
            captured_request.update(kwargs)
            return {"event_type": "cross_review_tasks_requested"}

        def _fake_record(**kwargs):
            return {"event_type": "cross_review_recorded"}

        kernel_state = {
            "state": "CHALLENGER_DRAFTED",
            "plan_started": "2026-05-18T09:00:00+00:00",
            "latest_revision": {
                "revision_id": "rev-primary-001",
                "content_hash": "sha256:abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca",
            },
            "current_round": 1,
            "cross_reviews": {},
        }
        with mock.patch(
            "aria_kernel.plan_convergence.fold_plan_state",
            return_value=kernel_state,
        ), mock.patch(
            "aria_kernel.plan_convergence.ensure_tools_dir",
            return_value=None,
        ), mock.patch(
            "aria_kernel.plan_convergence.request_cross_review",
            side_effect=_fake_request,
        ), mock.patch(
            "aria_kernel.plan_convergence.record_cross_review",
            side_effect=_fake_record,
        ):
            plan_convergence.submit_cross_review_v8(
                plan_id="plan-x",
                review={"reviewer_agent": "aria-cross-reviewer", "risks": []},
                workspace_root=".",
                base_dir=None,
            )

        tasks = captured_request["request"]["tasks"]
        directions = {t["review_direction"] for t in tasks}
        self.assertEqual(
            directions, plan_convergence.REQUIRED_CROSS_REVIEW_DIRECTIONS,
            f"V8 cross_review MUST cover both directions; got {directions}",
        )
        # Both tasks must reference the kernel-state's latest revision
        for t in tasks:
            self.assertEqual(t["target_revision_id"], "rev-primary-001")
            self.assertEqual(t["target_plan_content_hash"], "sha256:abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca")
            self.assertEqual(t["status_after"], "PENDING")
            self.assertEqual(t["target_agent"], "aria-cross-reviewer")

    def test_i_v8_2_cr_05_records_per_direction(self):
        """submit_cross_review_v8 MUST call record_cross_review EXACTLY
        twice (once per direction) so the kernel state machine
        observes BOTH ANSWERED and advances to CROSS_REVIEWED."""
        record_calls = []

        def _fake_record(**kwargs):
            record_calls.append(kwargs)
            return {"event_type": "cross_review_recorded", "direction": kwargs["review"]["review_direction"]}

        kernel_state = {
            "state": "CHALLENGER_DRAFTED",
            "plan_started": "2026-05-18T09:00:00+00:00",
            "latest_revision": {
                "revision_id": "rev-primary-001",
                "content_hash": "sha256:" + "f" * 64,
            },
            "current_round": 1,
            "cross_reviews": {},
        }
        with mock.patch(
            "aria_kernel.plan_convergence.fold_plan_state",
            return_value=kernel_state,
        ), mock.patch(
            "aria_kernel.plan_convergence.ensure_tools_dir",
            return_value=None,
        ), mock.patch(
            "aria_kernel.plan_convergence.request_cross_review",
            return_value={"event_type": "cross_review_tasks_requested"},
        ), mock.patch(
            "aria_kernel.plan_convergence.record_cross_review",
            side_effect=_fake_record,
        ):
            plan_convergence.submit_cross_review_v8(
                plan_id="plan-x",
                review={
                    "reviewer_agent": "aria-cross-reviewer",
                    "risks": [
                        {
                            "risk_id": "R1",
                            "risk_category": "test",
                            "severity": "LOW",
                            "summary": "test",
                            "recommendation": "test",
                            "affected_files": [],
                            "evidence_refs": [],
                        }
                    ],
                },
                workspace_root=".",
                base_dir=None,
            )

        self.assertEqual(
            len(record_calls), 2,
            f"V8 cross_review MUST emit 2 record_cross_review events (one per direction); got {len(record_calls)}",
        )
        directions_recorded = {c["review"]["review_direction"] for c in record_calls}
        self.assertEqual(directions_recorded, plan_convergence.REQUIRED_CROSS_REVIEW_DIRECTIONS)


if __name__ == "__main__":
    unittest.main()
