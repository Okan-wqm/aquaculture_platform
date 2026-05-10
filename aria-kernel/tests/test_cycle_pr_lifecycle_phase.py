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

import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from aria_kernel.cycle import _run_extended_phases
from aria_kernel.tool_registry import GovernanceError


class PrLifecyclePhaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-pr-phase-"))
        self.tools_root = self.tmp / "aria-tools"
        self.tools_root.mkdir()
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
        with proposals_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")

    def test_no_open_proposals_returns_no_op(self) -> None:
        # No seed; phase returns no_op.
        result = _run_extended_phases(
            phases=("pr_lifecycle",),
            workspace_root=self.tmp,
            cycle_id="cyc-pr-1",
            base_dir=self.tools_root,
            plan_id=None,
            cycle_started_at=datetime.now(timezone.utc),
        )
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
            result = _run_extended_phases(
                phases=("pr_lifecycle",),
                workspace_root=self.tmp,
                cycle_id="cyc-pr-2",
                base_dir=self.tools_root,
                plan_id=None,
                cycle_started_at=datetime.now(timezone.utc),
            )
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
            result = _run_extended_phases(
                phases=("pr_lifecycle",),
                workspace_root=self.tmp,
                cycle_id="cyc-pr-3",
                base_dir=self.tools_root,
                plan_id=None,
                cycle_started_at=datetime.now(timezone.utc),
            )
        self.assertEqual(result["pr_lifecycle"]["status"], "fail")
        self.assertEqual(result["pr_lifecycle"]["fail"], 1)
        per_prop = result["pr_lifecycle"]["proposals"][0]
        self.assertEqual(per_prop["passed"], False)
        self.assertIn("apply action", per_prop["error"])


if __name__ == "__main__":
    unittest.main()
