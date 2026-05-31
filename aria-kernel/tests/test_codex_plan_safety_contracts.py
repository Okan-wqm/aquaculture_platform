"""Safety contracts from the 2026-05-25 Codex ARIA plan."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.auto_merge_runners import evaluate_v9_implementation_merge
from aria_kernel.autonomous_host_lease import (
    acquire_remote_cas_lease,
    remote_cas_lease_state,
)
from aria_kernel.state_manifest import iter_surfaces, surface_by_name
from aria_kernel.tool_registry import GovernanceError


class V9MergeDemotionTests(unittest.TestCase):
    def test_v9_merge_path_is_disabled(self) -> None:
        decision = evaluate_v9_implementation_merge(
            plan_id="plan-1",
            pr_number=123,
            diff_hash="sha256:diff",
            branch_tip_sha="abc123",
            base_branch="main",
            profile="autonomous",
        )
        self.assertFalse(decision.eligible)
        self.assertEqual(
            decision.rejection_class,
            "v9_merge_path_disabled_use_merge_if_green",
        )
        self.assertIsNone(decision.merge_sha)


class RemoteCasLeaseTests(unittest.TestCase):
    def test_remote_cas_lease_blocks_different_owner_when_fresh(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-cas-") as tmp:
            root = Path(tmp)
            first = acquire_remote_cas_lease(
                base_dir=root,
                target_ref="main",
                head_sha="abc123",
                owner="local:a",
            )
            state = remote_cas_lease_state(root)
            self.assertEqual(state["lease_id"], first.lease_id)
            self.assertEqual(state["state"], "fresh")
            with self.assertRaises(GovernanceError):
                acquire_remote_cas_lease(
                    base_dir=root,
                    target_ref="main",
                    head_sha="abc123",
                    owner="gha-runner:b",
                )


class StateManifestTests(unittest.TestCase):
    def test_manifest_has_required_write_driving_surfaces(self) -> None:
        names = {surface.name for surface in iter_surfaces()}
        self.assertIn("agent_invocation_claims", names)
        self.assertIn("ack_ledger", names)
        self.assertIn("autonomous_host_remote_cas_lease", names)
        self.assertTrue(surface_by_name("ack_ledger").strict_read)


if __name__ == "__main__":
    unittest.main()
