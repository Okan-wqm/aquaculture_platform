"""Plan 025 §E — worker_dispatch claim/release/retry/PR primitives.

Six cases covering the new primitives the autonomous worker
scheduler daemon depends on:

* next_pending_assignment — picks pending/prepared rows; skips
  picked_up / completed / cancelled / expired.
* claim_assignment — atomic-locked CAS; raises GovernanceError on
  unfindable assignment, on wrong state, on state-changed-during-
  lock; mints lease token; emits dispatch_claim_created governance.
* release_claim_assignment — verifies lease token hash; emits
  dispatch_claim_released; rolls state back to pending.
* assignment_retry_count — counts verification_gate_failed events
  scoped to assignment_id from governance.jsonl.
* pr_for_assignment — looks up pr-lifecycle.jsonl by assignment_id;
  returns None for legacy rows lacking the bridge.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel.tool_registry import GovernanceError
from aria_kernel.worker_dispatch import (
    assignment_retry_count,
    claim_assignment,
    next_pending_assignment,
    pr_for_assignment,
    release_claim_assignment,
)
from tests._helpers.declared_fixtures import append_declared_fixture, init_test_tools_root


class WorkerDispatchPrimitivesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-wd-prim-"))
        self.tools_root = self.tmp / "aria-tools"
        init_test_tools_root(self.tools_root)
        self._old_cwd = os.getcwd()
        os.chdir(self.tmp)

    def tearDown(self) -> None:
        import shutil
        os.chdir(self._old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_dispatch_row(
        self,
        *,
        assignment_id: str,
        pressure_event_id: str,
        target_agent: str = "aria-worker",
        state: str = "pending",
    ) -> None:
        path = self.tools_root / "dispatch" / "requests.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "$schema": "aria/dispatch-request/v1",
            "schema_version": 1,
            "assignment_id": assignment_id,
            "pressure_event_id": pressure_event_id,
            "target_agent": target_agent,
            "triage_tier": "auto_fix_safe",
            "worktree_path": str(self.tmp / "worktrees" / assignment_id),
            "base_sha": "deadbeef",
            "required_tests": [],
            "expected_trailer": "Closes-Pressure: " + pressure_event_id,
            "state": state,
            "created_at": "2026-05-10T00:00:00Z",
        }
        append_declared_fixture(
            path,
            row,
            expected_surface="dispatch_requests",
        )

    def _seed_governance(self, kind: str, details: dict[str, Any]) -> None:
        path = self.tools_root / "governance.jsonl"
        row = {"kind": kind, "details": details}
        append_declared_fixture(
            path,
            row,
            expected_surface="tools_governance",
        )

    def test_next_pending_assignment_picks_first_pending_skips_others(self) -> None:
        self._seed_dispatch_row(
            assignment_id="A-1", pressure_event_id="P-1",
            state="picked_up",
        )
        self._seed_dispatch_row(
            assignment_id="A-2", pressure_event_id="P-2",
            state="completed",
        )
        # Plan 026R derives live worker state by assignment_id, not governance.
        self._seed_dispatch_row(
            assignment_id="A-3", pressure_event_id="P-3",
        )
        result = next_pending_assignment(base_dir=self.tools_root)
        self.assertIsNotNone(result)
        self.assertEqual(result["assignment_id"], "A-3")

    def test_claim_assignment_emits_lease_and_state_transition(self) -> None:
        self._seed_dispatch_row(
            assignment_id="A-CLAIM", pressure_event_id="P-CLAIM",
        )
        result = claim_assignment(
            assignment_id="A-CLAIM",
            agent_id="daemon:test:1",
            lease_seconds=60,
            base_dir=self.tools_root,
        )
        self.assertEqual(result["assignment_id"], "A-CLAIM")
        self.assertTrue(result["claim_id"].startswith("DC-"))
        self.assertTrue(result["lease_token"])
        self.assertIn("lease_token_hash", result)
        # Claim row persisted.
        claims = (self.tools_root / "dispatch" / "claims.jsonl").read_text(
            encoding="utf-8"
        )
        self.assertIn("A-CLAIM", claims)
        # Governance trail: dispatch_request_state_changed (pending → picked_up)
        # + dispatch_claim_created.
        gov = (self.tools_root / "governance.jsonl").read_text(encoding="utf-8")
        self.assertIn("dispatch_claim_created", gov)
        self.assertIn("picked_up", gov)
        # next_pending_assignment now skips this assignment.
        self.assertIsNone(next_pending_assignment(base_dir=self.tools_root))

    def test_claim_assignment_missing_raises(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            claim_assignment(
                assignment_id="A-NONE", agent_id="daemon:test:2",
                base_dir=self.tools_root,
            )
        self.assertIn("assignment_not_found", str(ctx.exception))

    def test_release_claim_returns_assignment_to_pending(self) -> None:
        self._seed_dispatch_row(
            assignment_id="A-REL", pressure_event_id="P-REL",
        )
        claim = claim_assignment(
            assignment_id="A-REL",
            agent_id="daemon:test:3",
            base_dir=self.tools_root,
        )
        # Confirm it's now in picked_up state (no longer pending).
        self.assertIsNone(next_pending_assignment(base_dir=self.tools_root))
        # Release with the correct lease token.
        rel = release_claim_assignment(
            claim_id=claim["claim_id"],
            lease_token=claim["lease_token"],
            reason="test_release",
            base_dir=self.tools_root,
        )
        self.assertEqual(rel["event"], "released")
        # Assignment now back to pending → discoverable again.
        again = next_pending_assignment(base_dir=self.tools_root)
        self.assertIsNotNone(again)
        self.assertEqual(again["assignment_id"], "A-REL")
        # Wrong-token release raises.
        # Re-claim first to get a fresh claim row.
        claim2 = claim_assignment(
            assignment_id="A-REL", agent_id="daemon:test:3b",
            base_dir=self.tools_root,
        )
        with self.assertRaises(GovernanceError) as ctx:
            release_claim_assignment(
                claim_id=claim2["claim_id"],
                lease_token="bogus-token",
                reason="bad",
                base_dir=self.tools_root,
            )
        self.assertIn("lease_token mismatch", str(ctx.exception))

    def test_assignment_retry_count_scans_governance(self) -> None:
        # Three failures for A-RETRY, one for A-OTHER → 3.
        for _ in range(3):
            self._seed_governance(
                "verification_gate_failed",
                {"assignment_id": "A-RETRY"},
            )
        self._seed_governance(
            "verification_gate_failed",
            {"assignment_id": "A-OTHER"},
        )
        # Plus an unrelated event kind that mentions the same id.
        self._seed_governance(
            "dispatch_request_state_changed",
            {"assignment_id": "A-RETRY"},
        )
        self.assertEqual(
            assignment_retry_count(
                assignment_id="A-RETRY", base_dir=self.tools_root,
            ),
            3,
        )
        self.assertEqual(
            assignment_retry_count(
                assignment_id="A-OTHER", base_dir=self.tools_root,
            ),
            1,
        )
        self.assertEqual(
            assignment_retry_count(
                assignment_id="A-NONE", base_dir=self.tools_root,
            ),
            0,
        )

    def test_pr_for_assignment_resolves_via_pr_lifecycle(self) -> None:
        # No pr-lifecycle.jsonl yet → None.
        self.assertIsNone(
            pr_for_assignment(
                assignment_id="A-PR", base_dir=self.tools_root,
            )
        )
        pr_path = self.tools_root / "pr-lifecycle.jsonl"
        # Legacy row WITHOUT assignment_id → still None for our id.
        legacy = {
            "schema_version": 1,
            "event": "opened",
            "pr_number": 99,
            "proposal_id": "PROP-LEGACY",
        }
        append_declared_fixture(
            pr_path,
            legacy,
            expected_surface="pr_lifecycle",
        )
        self.assertIsNone(
            pr_for_assignment(
                assignment_id="A-PR", base_dir=self.tools_root,
            )
        )
        # New row WITH assignment_id → resolves.
        new_row = {
            "schema_version": 1,
            "event": "opened",
            "pr_number": 142,
            "assignment_id": "A-PR",
            "proposal_id": "PROP-NEW",
        }
        append_declared_fixture(
            pr_path,
            new_row,
            expected_surface="pr_lifecycle",
        )
        self.assertEqual(
            pr_for_assignment(
                assignment_id="A-PR", base_dir=self.tools_root,
            ),
            142,
        )


if __name__ == "__main__":
    unittest.main()
