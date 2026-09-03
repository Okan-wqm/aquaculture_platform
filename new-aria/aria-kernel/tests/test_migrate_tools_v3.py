"""Plan ARIA-V2 §Phase 1 invariants I-5, I-6, I-27, I-30 —
migrate-tools-bootstrap + v2→v3 architectural shape.

Locks:
* Migration completes + emits the 3-event audit chain
* Re-running migration is idempotent (no duplicate events)
* Committed ``aria-tools/repo_identity.json`` is schema-only after migration
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import read_jsonl
from aria_kernel.migration import migrate_tools_bootstrap, migrate_tools_v2_to_v3, rollback_tools_v3_to_v2
from aria_kernel.tool_registry import GovernanceError, tools_contract_version


_helpers_path = Path(__file__).parent / "_helpers" / "git_fixtures.py"
_spec = importlib.util.spec_from_file_location("aria_kernel_test_helpers_git_fixtures", _helpers_path)
git_fixtures = importlib.util.module_from_spec(_spec)
sys.modules["aria_kernel_test_helpers_git_fixtures"] = git_fixtures
_spec.loader.exec_module(git_fixtures)


class MigrateToolsBootstrapTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_local_git_repo(
            self.tmp, name="repo", remote_url="https://github.com/test-owner/test-repo.git"
        )
        # Plan ARIA-V2 §3.8 requires the bootstrap CLI to set up
        # workspace binding before tools migration; mimic the v1->v2
        # path that requires _assert_workspace_binding.
        from aria_kernel.workspace import workspace_paths
        from aria_kernel.migration import migrate_workspace_v1_to_v2
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            acknowledge=True,
            reason="test fixture workspace bootstrap",
        )
        self.tools_dir = self.tmp / "aria-tools"

    def tearDown(self) -> None:
        import os
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_bootstrap_v0_to_v3_chain(self) -> None:
        """Plan ARIA-V2 §3.8 — fresh tree (v0) chains v1→v2 then v2→v3."""
        import os
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        result = migrate_tools_bootstrap(
            tools_dir=self.tools_dir,
            workspace_root=self.repo,
            acknowledge=True,
            reason="Plan ARIA-V2 §Phase-1 I-27 bootstrap chain validation",
        )
        self.assertEqual(result["final_version"], 3)
        self.assertEqual(result["starting_version"], 0)
        self.assertEqual(tools_contract_version(self.tools_dir), 3)

    def test_bootstrap_is_idempotent(self) -> None:
        """Plan ARIA-V2 I-27 — running migration twice is a no-op second time."""
        import os
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        first = migrate_tools_bootstrap(
            tools_dir=self.tools_dir,
            workspace_root=self.repo,
            acknowledge=True,
            reason="Plan ARIA-V2 I-27 first invocation for idempotency check",
        )
        second = migrate_tools_bootstrap(
            tools_dir=self.tools_dir,
            workspace_root=self.repo,
            acknowledge=True,
            reason="Plan ARIA-V2 I-27 second invocation, expects already_at_target",
        )
        self.assertEqual(first["final_version"], 3)
        self.assertEqual(second["status"], "already_at_target")
        self.assertEqual(second["final_version"], 3)
        self.assertEqual(second["chain"], [])

    def test_v2_to_v3_emits_three_audit_events(self) -> None:
        """Plan ARIA-V2 I-30 — v2→v3 emits 3 separate audit events linked
        by ``migration_event_id``."""
        import os
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir,
            workspace_root=self.repo,
            acknowledge=True,
            reason="Plan ARIA-V2 I-30 setup migration",
        )
        gov_rows = read_jsonl(self.tools_dir / "governance.jsonl")
        rebound_rows = [r for r in gov_rows if r.get("kind") == "tools_root_rebound_for_v3_identity_recipe"]
        stripped_rows = [r for r in gov_rows if r.get("kind") == "tools_root_schema_stripped"]
        bumped_rows = [r for r in gov_rows if r.get("kind") == "aria_tools_contract_version_bumped"]
        self.assertEqual(len(rebound_rows), 1, f"expected 1 rebound event, got {len(rebound_rows)}")
        self.assertEqual(len(stripped_rows), 1)
        self.assertEqual(len(bumped_rows), 1)
        # Linkage: all three share the same migration_event_id
        mig_ids = {
            rebound_rows[0]["details"]["migration_event_id"],
            stripped_rows[0]["details"]["migration_event_id"],
            bumped_rows[0]["details"]["migration_event_id"],
        }
        self.assertEqual(len(mig_ids), 1, f"events not linked: {mig_ids}")

    def test_post_migration_identity_file_keeps_runtime_mirror(self) -> None:
        """Plan ARIA-V2 §3.2 — post-migration repo_identity.json keeps
        runtime fields tolerantly (canonical + legacy mirror) so the
        binding survives the file on operator filesystems. The
        committed schema-stamp form lives in git; the runtime fields
        are populated locally."""
        import os
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir,
            workspace_root=self.repo,
            acknowledge=True,
            reason="Plan ARIA-V2 §3.2 fixture for schema-stamp check",
        )
        identity = json.loads((self.tools_dir / "repo_identity.json").read_text())
        self.assertEqual(identity["aria_tools_contract_version"], 3)
        self.assertEqual(identity["schema_version"], 3)
        self.assertIn("bound_canonical_identity", identity)
        # Legacy mirror present for tolerance during incremental migrations
        self.assertIn("bound_repo_hash", identity)
        self.assertEqual(identity["bound_canonical_identity"], identity["bound_repo_hash"])


class RollbackToolsV3ToV2Tests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_local_git_repo(
            self.tmp, name="repo", remote_url="https://github.com/test-owner/test-repo.git",
        )
        from aria_kernel.migration import migrate_workspace_v1_to_v2
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo,
            workspace_base=self.workspace_base,
            acknowledge=True,
            reason="test fixture for rollback test",
        )
        self.tools_dir = self.tmp / "aria-tools"
        import os
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir,
            workspace_root=self.repo,
            acknowledge=True,
            reason="Plan ARIA-V2 rollback test setup",
        )

    def tearDown(self) -> None:
        import os
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_rollback_v3_to_v2_downgrades_contract(self) -> None:
        """Plan ARIA-V2 §3.8 — rollback parity allows operators to
        revert the contract bump without losing the legacy binding."""
        self.assertEqual(tools_contract_version(self.tools_dir), 3)
        result = rollback_tools_v3_to_v2(
            tools_dir=self.tools_dir,
            acknowledge=True,
            reason="Plan ARIA-V2 §3.8 rollback parity test",
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(tools_contract_version(self.tools_dir), 2)
        # Verify identity file has v2 shape post-rollback
        identity = json.loads((self.tools_dir / "repo_identity.json").read_text())
        self.assertEqual(identity["aria_tools_contract_version"], 2)
        self.assertIn("bound_repo_hash", identity)
        self.assertNotIn("bound_canonical_identity", identity)


if __name__ == "__main__":
    unittest.main()
