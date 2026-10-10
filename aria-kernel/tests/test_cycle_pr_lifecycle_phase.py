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


class _PrPhaseFixture(unittest.TestCase):
    """A bound tools root, a cwd inside it, and the proposal seeder."""

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


class PrLifecyclePhaseTests(_PrPhaseFixture):
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


# ARIA-HIGH-408 — the live shape that failed every cycle after PR #1906.
# Field values are the ones on aria/state (2026-10-10): the F-015 proposal,
# its gated action's change, and the PR the executor opened and a person merged.
_LIVE_PROPOSAL = "proposal-cc0c546b-c10b-48fc-9b97-50995d1f0243"
_LIVE_CHANGE = "chg_8c3e6311c4475b1b"
_LIVE_PR = 1906
_LIVE_HEAD = "1ac2048c2a7adf14f0e62505caeacb68447d68a9"
_LIVE_MERGE = "528c63c0d0921af1645f027dc76e4a594431f5c6"
# What `open_pr_for_action` raised for it on a fresh runner checkout (the
# executor's local branch does not exist there): reproduced against an
# archive of aria/state.
_LIVE_REFUSAL = (
    "open_pr_head_sha_unresolvable: git rev-parse "
    "'aria-impl-7c52b7f387ab21ab5550aa4148a71306' failed with returncode=128"
)


class APullRequestThatExistsIsNotACandidate(_PrPhaseFixture):
    """A gated change whose PR the kernel already opened is delivered, not pending.

    `ready_for_pr` is the gate's verdict on the change, and it stays true after
    the PR opens; whether the PR exists, merged or closed is the
    ``pr-lifecycle`` ledger's fact (``opened`` by the one ``gh pr create``,
    ``merged`` / ``closed_unmerged`` by ``merge_record``). The phase used to
    read only the first, so the executor's PR #1906 — opened, then merged by
    a person — was "opened" again by every cycle, refused, and every cycle
    terminated FAILED.
    """

    def _seed_live_action(self, *, proposal_id: str = _LIVE_PROPOSAL,
                          change_id: str | None = _LIVE_CHANGE) -> None:
        append_declared_fixture(
            self.tools_root / "apply" / "actions.jsonl",
            {
                "schema_version": 1,
                "proposal_id": proposal_id,
                "status": "ready_for_pr",
                "branch": "aria-impl-7c52b7f387ab21ab5550aa4148a71306",
                "base_sha": "83cc73af44cfa6d6be11acadf89dbf8e2689e259",
                "change_id": change_id,
                "plan_id": "plan-cyc-20261008T175911Z-auto",
                "validation_gate_ref": "sha256:" + "7" * 64,
                "validation_gate_status": "ready_for_pr",
                "workspace_root": str(self.tmp),
                "worktree_path": None,
                "recorded_at": "2026-10-09T09:59:13+00:00",
            },
            expected_surface="apply_actions",
        )

    def _open(self, *, proposal_id: str = _LIVE_PROPOSAL, change_id: str = _LIVE_CHANGE,
              number: int = _LIVE_PR) -> dict:
        # The writer `pr_manager._create_pull_request` calls after `gh pr create`.
        from aria_kernel.auto_merge import record_pr_lifecycle
        return record_pr_lifecycle(
            {
                "number": number, "base_branch": "main", "head_sha": _LIVE_HEAD,
                "task_id": "plan-cyc-20261008T175911Z-auto", "proposal_id": proposal_id,
                "change_id": change_id,
                "changed_files": ["web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"],
            },
            event="opened", base_dir=self.tools_root,
        )

    def _phase(self, mock_action) -> dict:
        mock_action.side_effect = GovernanceError(_LIVE_REFUSAL)
        context = build_phase_context(
            cycle_id="cyc-20261010T025128Z-auto",
            workspace_root=self.tmp,
            base_dir=self.tools_root,
            cycle_started_at=datetime.now(timezone.utc),
        )
        return _run_pr_lifecycle_phase(context)

    def test_the_live_shape_opened_by_the_executor_and_merged_by_a_person(self) -> None:
        from aria_kernel.merge_record import (
            LINEAGE_BACKFILLED_UNVERIFIED, MERGED_BY_OBSERVED, record_merge,
        )
        self._seed_proposal(proposal_id=_LIVE_PROPOSAL, status="approved_for_apply")
        self._seed_live_action()
        opened = self._open()
        record_merge(
            pr=opened, merged_by=MERGED_BY_OBSERVED, base_dir=self.tools_root,
            merge_sha=_LIVE_MERGE, merged_at="2026-10-10T01:03:06Z",
            head_lineage=LINEAGE_BACKFILLED_UNVERIFIED,
        )
        with patch("aria_kernel.pr_manager.open_pr_for_action") as mock_action:
            payload = self._phase(mock_action)
        # Never asked to open a PR that exists: the refusal is not provoked.
        self.assertEqual(mock_action.call_count, 0)
        self.assertEqual(payload["status"], "no_op")
        self.assertEqual((payload["total"], payload["fail"]), (0, 0))
        self.assertEqual(payload["delivered"], [{
            "proposal_id": _LIVE_PROPOSAL, "change_id": _LIVE_CHANGE,
            "pull_requests": [{"pr_number": _LIVE_PR, "pr_state": "merged"}],
        }])

    def test_a_pr_opened_and_still_in_review_is_not_opened_again(self) -> None:
        self._seed_proposal(proposal_id=_LIVE_PROPOSAL, status="approved_for_apply")
        self._seed_live_action()
        self._open()
        with patch("aria_kernel.pr_manager.open_pr_for_action") as mock_action:
            payload = self._phase(mock_action)
        self.assertEqual(mock_action.call_count, 0)
        self.assertEqual(payload["status"], "no_op")
        self.assertEqual(payload["delivered"][0]["pull_requests"],
                         [{"pr_number": _LIVE_PR, "pr_state": "open"}])

    def test_a_pr_closed_unmerged_is_an_outcome_not_a_reason_to_open_another(self) -> None:
        from aria_kernel.merge_record import EVENT_CLOSED_UNMERGED, record_pr_unmergeable
        self._seed_proposal(proposal_id=_LIVE_PROPOSAL, status="approved_for_apply")
        self._seed_live_action()
        opened = self._open()
        record_pr_unmergeable(pr=opened, event=EVENT_CLOSED_UNMERGED, reason="closed",
                              base_dir=self.tools_root)
        with patch("aria_kernel.pr_manager.open_pr_for_action") as mock_action:
            payload = self._phase(mock_action)
        self.assertEqual(mock_action.call_count, 0)
        self.assertEqual(payload["status"], "no_op")
        self.assertEqual(payload["delivered"][0]["pull_requests"],
                         [{"pr_number": _LIVE_PR, "pr_state": "closed_unmerged"}])

    def test_a_pr_for_another_change_of_the_proposal_does_not_hide_this_one(self) -> None:
        """Binding is by the action's change: a newer staging is still a candidate."""
        self._seed_proposal(proposal_id=_LIVE_PROPOSAL, status="approved_for_apply")
        self._seed_live_action(change_id="chg_newer")
        self._open(change_id=_LIVE_CHANGE)
        with patch("aria_kernel.pr_manager.open_pr_for_action") as mock_action:
            payload = self._phase(mock_action)
        self.assertEqual(mock_action.call_count, 1)
        self.assertEqual(payload["status"], "fail")
        self.assertEqual(payload["delivered"], [])

    def test_a_change_without_a_pr_is_still_a_candidate_beside_a_delivered_one(self) -> None:
        self._seed_proposal(proposal_id=_LIVE_PROPOSAL, status="approved_for_apply")
        self._seed_live_action()
        self._open()
        self._seed_proposal(proposal_id="prop-WAITING", status="approved_for_apply")
        self._seed_live_action(proposal_id="prop-WAITING", change_id="chg_waiting")
        with patch("aria_kernel.pr_manager.open_pr_for_action") as mock_action:
            mock_action.return_value = {"event": "pr_dry_run"}
            context = build_phase_context(
                cycle_id="cyc-pr-6", workspace_root=self.tmp, base_dir=self.tools_root,
                cycle_started_at=datetime.now(timezone.utc),
            )
            payload = _run_pr_lifecycle_phase(context)
        self.assertEqual([c.kwargs["proposal_id"] for c in mock_action.call_args_list], ["prop-WAITING"])
        self.assertEqual(payload["status"], "ok")
        self.assertEqual([d["proposal_id"] for d in payload["delivered"]], [_LIVE_PROPOSAL])

    def test_an_operator_lane_action_without_a_change_binds_by_proposal(self) -> None:
        """`plan_apply_worktree` mints no change_id; its PR is the proposal's."""
        self._seed_proposal(proposal_id="prop-OPERATOR", status="approved_for_apply")
        self._seed_live_action(proposal_id="prop-OPERATOR", change_id=None)
        self._open(proposal_id="prop-OPERATOR", change_id="chg_operator", number=77)
        with patch("aria_kernel.pr_manager.open_pr_for_action") as mock_action:
            payload = self._phase(mock_action)
        self.assertEqual(mock_action.call_count, 0)
        self.assertEqual(payload["delivered"][0]["pull_requests"],
                         [{"pr_number": 77, "pr_state": "open"}])


if __name__ == "__main__":
    unittest.main()
