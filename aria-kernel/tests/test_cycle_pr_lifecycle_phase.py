"""Tests for Plan 025 §C — cycle.pr_lifecycle closed-loop wiring.

Pre-fix the pr_lifecycle extended phase emitted an informational
notice ("invoke the PR CLI outside the cycle"); the cycle never
invoked pr_manager.open_pr_for_action even though the primitive
existed. Post-fix the phase iterates approved-for-apply proposals,
invokes the action per proposal (dry_run=True default), and
aggregates per-id results.

Target: aria_kernel.cycle._run_pr_lifecycle_phase.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from aria_kernel.cycle import (
    _run_pr_lifecycle_phase,
    _run_validation_matrix_phase,
    build_phase_context,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


class PrLifecyclePhaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-pr-phase-"))
        self.tools_root = ensure_tools_dir(self.tmp / "aria-tools")
        self._old_cwd = os.getcwd()
        os.chdir(self.tmp)
        self._env = patch.dict(os.environ, {
            "ARIA_WORKSPACE_BASE": str(self.tmp / "workspaces"),
        })
        self._env.start()

    def tearDown(self) -> None:
        import shutil
        self._env.stop()
        os.chdir(self._old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_proposal(self, *, proposal_id: str, status: str) -> None:
        proposals_path = self.tools_root / "proposals" / "proposals.jsonl"
        proposals_path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "$schema": "aria/proposal/v1",
            "schema_version": 1,
            "proposal_id": proposal_id,
            "kind": "test_proposal",
            "status": status,
            "blocked_by": [],
            "recorded_at": datetime.now(timezone.utc).isoformat().replace(
                "+00:00", "Z"
            ),
        }
        append_declared_fixture(
            proposals_path,
            row,
            expected_surface="proposals",
        )

    def test_no_open_proposals_returns_no_op(self) -> None:
        # No seed; phase returns no_op.
        context = build_phase_context(
            cycle_id="cyc-pr-1",
            workspace_root=self.tmp,
            base_dir=self.tools_root,
            cycle_started_at=datetime.now(timezone.utc),
        )
        result = {'pr_lifecycle': _run_pr_lifecycle_phase(context)}
        self.assertEqual(result["pr_lifecycle"]["status"], "no_op")
        self.assertEqual(result["pr_lifecycle"]["total"], 0)
        self.assertEqual(result["pr_lifecycle"]["proposals"], [])

    def test_approved_proposal_invokes_action_pass(self) -> None:
        self._seed_proposal(proposal_id="prop-A", status="approved_for_apply")
        # Plus one ineligible proposal (status=open) — must be filtered out.
        self._seed_proposal(proposal_id="prop-OPEN", status="open")
        with patch(
            "aria_kernel.pr_manager.open_pr_for_action"
        ) as mock_action:
            mock_action.return_value = {
                "event": "pr_dry_run", "proposal_id": "prop-A",
                "branch": "aria/auto/prop-A", "title": "test",
            }
            context = build_phase_context(
                cycle_id="cyc-pr-2",
                workspace_root=self.tmp,
                base_dir=self.tools_root,
                cycle_started_at=datetime.now(timezone.utc),
            )
            result = {'pr_lifecycle': _run_pr_lifecycle_phase(context)}
        # Only the approved proposal triggered the action.
        self.assertEqual(mock_action.call_count, 1)
        kwargs = mock_action.call_args.kwargs
        self.assertEqual(kwargs["proposal_id"], "prop-A")
        self.assertEqual(kwargs["dry_run"], True)
        self.assertEqual(result["pr_lifecycle"]["status"], "ok")
        self.assertEqual(result["pr_lifecycle"]["total"], 1)
        self.assertEqual(result["pr_lifecycle"]["ok"], 1)
        self.assertEqual(
            result["pr_lifecycle"]["proposals"][0]["proposal_id"], "prop-A"
        )

    def test_failed_action_status_fail_with_per_proposal_error(self) -> None:
        self._seed_proposal(proposal_id="prop-FAIL", status="approved_for_apply")
        with patch(
            "aria_kernel.pr_manager.open_pr_for_action"
        ) as mock_action:
            mock_action.side_effect = GovernanceError(
                "no apply action exists for proposal"
            )
            context = build_phase_context(
                cycle_id="cyc-pr-3",
                workspace_root=self.tmp,
                base_dir=self.tools_root,
                cycle_started_at=datetime.now(timezone.utc),
            )
            result = {'pr_lifecycle': _run_pr_lifecycle_phase(context)}
        self.assertEqual(result["pr_lifecycle"]["status"], "fail")
        self.assertEqual(result["pr_lifecycle"]["fail"], 1)
        per_prop = result["pr_lifecycle"]["proposals"][0]
        self.assertEqual(per_prop["passed"], False)
        self.assertIn("apply action", per_prop["error"])

    def _seed_apply_action(self, *, proposal_id: str, status: str) -> None:
        actions_path = self.tools_root / "apply" / "actions.jsonl"
        actions_path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(
            actions_path,
            {
                "$schema": "aria/apply-action/v1",
                "schema_version": 1,
                "proposal_id": proposal_id,
                "status": status,
                "branch": "aria-impl-0123456789abcdef",
                "base_sha": "0" * 40,
                "workspace_root": str(self.tmp),
                "recorded_at": datetime.now(timezone.utc).isoformat().replace(
                    "+00:00", "Z",
                ),
            },
            expected_surface="apply_actions",
        )

    def test_staged_work_is_in_flight_not_a_cycle_failure(self) -> None:
        """ORPHAN-CRITICAL-728 — the defect that made every later cycle FAILED.

        `stage_converged_plan_for_pr` approves the proposal and opens its
        apply action in `staged_for_implementation`, because the implementer
        has not run yet. This phase then selected it (status is
        `approved_for_apply`), `open_pr_for_action` correctly refused
        anything that is not `ready_for_pr`, and `ok < total` made the phase
        report `fail` — which `cycle.py` propagates to the cycle's terminal
        row. From the first staging onward every cycle terminated FAILED,
        forever, and nothing cleared the proposal.

        Work that has not finished is not work that failed.
        """
        self._seed_proposal(proposal_id="prop-STAGED", status="approved_for_apply")
        self._seed_apply_action(
            proposal_id="prop-STAGED", status="staged_for_implementation",
        )
        with patch("aria_kernel.pr_manager.open_pr_for_action") as mock_action:
            context = build_phase_context(
                cycle_id="cyc-pr-4",
                workspace_root=self.tmp,
                base_dir=self.tools_root,
                cycle_started_at=datetime.now(timezone.utc),
            )
            payload = _run_pr_lifecycle_phase(context)
        # Not attempted at all — the refusal was never worth provoking.
        self.assertEqual(mock_action.call_count, 0)
        self.assertEqual(payload["status"], "no_op")
        self.assertEqual(payload["total"], 0)
        # Reported, so an operator can see the staged work that is waiting.
        self.assertEqual(
            payload["in_flight"],
            [{
                "proposal_id": "prop-STAGED",
                "apply_action_status": "staged_for_implementation",
            }],
        )

    def test_a_gated_proposal_is_still_a_candidate(self) -> None:
        """In-flight must not become a way to stop opening PRs at all."""
        self._seed_proposal(proposal_id="prop-READY", status="approved_for_apply")
        self._seed_apply_action(proposal_id="prop-READY", status="ready_for_pr")
        with patch("aria_kernel.pr_manager.open_pr_for_action") as mock_action:
            mock_action.return_value = {"event": "pr_dry_run"}
            context = build_phase_context(
                cycle_id="cyc-pr-5",
                workspace_root=self.tmp,
                base_dir=self.tools_root,
                cycle_started_at=datetime.now(timezone.utc),
            )
            payload = _run_pr_lifecycle_phase(context)
        self.assertEqual(mock_action.call_count, 1)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["in_flight"], [])


if __name__ == "__main__":
    unittest.main()
