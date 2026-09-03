"""Plan ARIA-V2 §Phase 2 invariants I-8..I-13, I-35, I-36 — FATES on
snapshot value object + memory rebuild-fates + memory reset.

Locks the architectural decision that ``_verify_fates_integrity``
operates on the immutable snapshot (committed mode) or emits a drift
governance event (working_tree mode) — NOT on the live working tree.
Working-tree edits between discovery and memory write are no longer
false-positive errors blocking the cycle.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import read_jsonl
from aria_kernel.memory import (
    _verify_fates_integrity,
    rebuild_fates,
    reset_memory,
    update_memory,
)
from aria_kernel.migration import (
    migrate_tools_bootstrap,
    migrate_workspace_v1_to_v2,
)
from aria_kernel.tool_registry import GovernanceError


_helpers_path = Path(__file__).parent / "_helpers" / "git_fixtures.py"
_spec = importlib.util.spec_from_file_location("aria_kernel_test_helpers_git_fixtures", _helpers_path)
git_fixtures = importlib.util.module_from_spec(_spec)
sys.modules["aria_kernel_test_helpers_git_fixtures"] = git_fixtures
_spec.loader.exec_module(git_fixtures)


def _sha256_prefixed(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


class FatesIntegrityOnSnapshotBytesTests(unittest.TestCase):
    """Plan ARIA-V2 I-8 — committed-mode FATES verification reads from
    the immutable git tree at ``base_commit_sha``, NOT from the
    working tree. Working-tree edits between discovery and memory
    write CANNOT cause false-positive errors.
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            files={"hello.txt": "hello world\n"},
            remote_url="https://github.com/test-owner/i8.git",
            name="repo",
        )
        self.committed_bytes = (self.repo / "hello.txt").read_bytes()
        self.committed_hash = _sha256_prefixed(self.committed_bytes)
        self.base_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.repo, capture_output=True, text=True
        ).stdout.strip()

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_working_tree_edit_does_not_raise_in_committed_mode(self) -> None:
        fates = {"files": [{"path": "hello.txt", "content_hash": self.committed_hash}]}
        snapshot = {"snapshot_mode": "committed", "base_commit_sha": self.base_sha}
        (self.repo / "hello.txt").write_text("totally different content\n", encoding="utf-8")
        _verify_fates_integrity(fates, snapshot=snapshot, workspace_root=self.repo, base_dir=None)


class FatesIntegrityRaisesOnSnapshotTamperTests(unittest.TestCase):
    """Plan ARIA-V2 I-9 — tampered FATES content_hash (mismatch with
    git-tree bytes) raises memory_fates_content_hash_mismatch.
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            files={"hello.txt": "hello world\n"},
            remote_url="https://github.com/test-owner/i9.git",
            name="repo",
        )
        self.base_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.repo, capture_output=True, text=True
        ).stdout.strip()

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_tampered_stored_hash_raises(self) -> None:
        fates = {"files": [{"path": "hello.txt", "content_hash": "sha256:tampered-hash-value"}]}
        snapshot = {"snapshot_mode": "committed", "base_commit_sha": self.base_sha}
        with self.assertRaises(GovernanceError) as cm:
            _verify_fates_integrity(fates, snapshot=snapshot, workspace_root=self.repo, base_dir=None)
        self.assertIn("memory_fates_content_hash_mismatch", str(cm.exception))


class DirtyWorkingTreeCommittedModeSucceedsTests(unittest.TestCase):
    """Plan ARIA-V2 I-10 — operator with dirty working tree runs
    committed-mode cycles successfully (the user-facing payoff).
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            files={"hello.txt": "hello world\n"},
            remote_url="https://github.com/test-owner/i10.git",
            name="repo",
        )
        self.committed_hash = _sha256_prefixed((self.repo / "hello.txt").read_bytes())
        self.base_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.repo, capture_output=True, text=True
        ).stdout.strip()
        (self.repo / "hello.txt").write_text("operator edit during cycle\n", encoding="utf-8")

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_dirty_tree_committed_snapshot_does_not_raise(self) -> None:
        fates = {"files": [{"path": "hello.txt", "content_hash": self.committed_hash}]}
        snapshot = {"snapshot_mode": "committed", "base_commit_sha": self.base_sha}
        _verify_fates_integrity(fates, snapshot=snapshot, workspace_root=self.repo, base_dir=None)


class WorkingTreeModeDriftEventTests(unittest.TestCase):
    """Plan ARIA-V2 working_tree mode emits drift governance event."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            files={"hello.txt": "hello world\n"},
            remote_url="https://github.com/test-owner/i13.git",
            name="repo",
        )
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            acknowledge=True, reason="Plan ARIA-V2 working_tree mode test bootstrap",
        )
        self.tools_dir = self.tmp / "aria-tools"
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir, workspace_root=self.repo,
            acknowledge=True, reason="Plan ARIA-V2 working_tree mode tools bootstrap",
        )

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_working_tree_mode_emits_drift_event_no_raise(self) -> None:
        fates = {"files": [{"path": "hello.txt", "content_hash": "sha256:will-not-match"}]}
        snapshot = {"snapshot_mode": "working_tree", "base_commit_sha": "deadbeef", "dirty_snapshot": True}
        _verify_fates_integrity(fates, snapshot=snapshot, workspace_root=self.repo, base_dir=self.tools_dir)
        gov_rows = read_jsonl(self.tools_dir / "governance.jsonl")
        drift_events = [r for r in gov_rows if r.get("kind") == "memory_fates_working_tree_drift_observed"]
        self.assertGreaterEqual(len(drift_events), 1)
        self.assertEqual(drift_events[-1]["details"]["snapshot_mode"], "working_tree")


class RebuildFatesCliTests(unittest.TestCase):
    """Plan ARIA-V2 I-11 — rebuild_fates rewrites FATES.json + emits audit row."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp,
            files={"a.txt": "alpha\n"},
            remote_url="https://github.com/test-owner/i11.git",
            name="repo",
        )
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            acknowledge=True, reason="Plan ARIA-V2 I-11 workspace bootstrap fixture",
        )
        self.tools_dir = self.tmp / "aria-tools"
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir, workspace_root=self.repo,
            acknowledge=True, reason="Plan ARIA-V2 I-11 tools bootstrap fixture",
        )
        self.cycle_id = "test-i11"
        discovery_dir = self.tools_dir / "discovery" / self.cycle_id
        discovery_dir.mkdir(parents=True)
        self.stale_hash = "sha256:stale-hash-i11-fixture"
        (discovery_dir / "FATES.json").write_text(json.dumps({
            "schema_version": 1, "cycle_id": self.cycle_id,
            "files": [{"path": "a.txt", "content_hash": self.stale_hash, "fate": "tracked"}],
        }), encoding="utf-8")

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_rebuild_rewrites_fates_and_emits_audit_row(self) -> None:
        result = rebuild_fates(
            cycle_id=self.cycle_id, workspace_root=self.repo,
            workspace_base=self.workspace_base, base_dir=self.tools_dir,
            reason="Plan ARIA-V2 I-11 rebuild for stale-hash recovery",
            acknowledge=True,
        )
        self.assertEqual(result["result"], "SUCCESS")
        self.assertEqual(result["rebuilt_file_count"], 1)
        new_fates = json.loads((self.tools_dir / "discovery" / self.cycle_id / "FATES.json").read_text())
        new_hash = new_fates["files"][0]["content_hash"]
        self.assertEqual(new_hash, _sha256_prefixed(b"alpha\n"))
        self.assertNotEqual(new_hash, self.stale_hash)
        gov_rows = read_jsonl(self.tools_dir / "governance.jsonl")
        rebuilt_events = [r for r in gov_rows if r.get("kind") == "memory_fates_rebuilt"]
        self.assertEqual(len(rebuilt_events), 1)
        details = rebuilt_events[0]["details"]
        rebuilt = details["rebuilt_files"][0]
        self.assertEqual(rebuilt["path"], "a.txt")
        self.assertEqual(rebuilt["pre_state_content_hash"], self.stale_hash)
        self.assertEqual(rebuilt["post_state_content_hash"], new_hash)

    def test_rebuild_requires_acknowledge(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            rebuild_fates(
                cycle_id=self.cycle_id, workspace_root=self.repo,
                workspace_base=self.workspace_base, base_dir=self.tools_dir,
                reason="Plan ARIA-V2 I-11 acknowledge required",
                acknowledge=False,
            )
        self.assertIn("acknowledge", str(cm.exception))


class ResetMemoryRequiresBackupTests(unittest.TestCase):
    """Plan ARIA-V2 I-12 + I-35 + I-36 — reset_memory full discipline."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp, files={"a.txt": "alpha\n"},
            remote_url="https://github.com/test-owner/i12.git", name="repo",
        )
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            acknowledge=True, reason="Plan ARIA-V2 I-12 workspace bootstrap fixture",
        )
        self.tools_dir = self.tmp / "aria-tools"
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir, workspace_root=self.repo,
            acknowledge=True, reason="Plan ARIA-V2 I-12 tools bootstrap fixture",
        )
        from aria_kernel.workspace import workspace_paths, record_workspace_governance
        paths = workspace_paths(self.repo, workspace_base=self.workspace_base)
        record_workspace_governance(paths, "test_seed", {"seed_id": "i12-row"})
        self.paths = paths

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_reset_succeeds_with_backup(self) -> None:
        backup_to = self.tmp / "backup-i12"
        pre_gov_bytes = (self.paths.ledgers["governance"]).read_bytes()
        result = reset_memory(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            backup_to=backup_to, base_dir=self.tools_dir,
            reason="Plan ARIA-V2 I-12 reset for memory state recovery",
            acknowledge=True,
        )
        self.assertEqual(result["result"], "SUCCESS")
        self.assertTrue(backup_to.exists())
        backup_gov = backup_to / "governance.jsonl"
        self.assertTrue(backup_gov.exists())
        self.assertEqual(backup_gov.read_bytes(), pre_gov_bytes)
        self.assertTrue(self.paths.memory_dir.exists())

    def test_reset_rejects_existing_backup_path(self) -> None:
        backup_to = self.tmp / "preexisting-backup"
        backup_to.mkdir()
        with self.assertRaises(GovernanceError) as cm:
            reset_memory(
                workspace_root=self.repo, workspace_base=self.workspace_base,
                backup_to=backup_to, base_dir=self.tools_dir,
                reason="Plan ARIA-V2 I-12 reset rejects pre-existing backup",
                acknowledge=True,
            )
        self.assertIn("backup_path_exists", str(cm.exception))

    def test_reset_emits_to_workspace_ledger_not_tools(self) -> None:
        backup_to = self.tmp / "backup-i35"
        reset_memory(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            backup_to=backup_to, base_dir=self.tools_dir,
            reason="Plan ARIA-V2 I-35 reset emits to workspace ledger",
            acknowledge=True,
        )
        ws_rows = read_jsonl(self.paths.ledgers["governance"])
        ws_reset = [r for r in ws_rows if r.get("kind") == "memory_reset"]
        self.assertEqual(len(ws_reset), 1)
        tools_rows = read_jsonl(self.tools_dir / "governance.jsonl")
        tools_reset = [r for r in tools_rows if r.get("kind") == "memory_reset"]
        self.assertEqual(len(tools_reset), 0)

    def test_reset_row_shape(self) -> None:
        backup_to = self.tmp / "backup-i36"
        reset_memory(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            backup_to=backup_to, base_dir=self.tools_dir,
            reason="Plan ARIA-V2 I-36 reset row mandatory fields",
            acknowledge=True,
        )
        ws_rows = read_jsonl(self.paths.ledgers["governance"])
        reset_row = [r for r in ws_rows if r.get("kind") == "memory_reset"][0]
        details = reset_row["details"]
        self.assertIn("actor", details)
        self.assertIn("reason", details)
        self.assertIn("pre_reset_fates_hash", details)
        self.assertIn("backup_path", details)
        self.assertEqual(details["result"], "SUCCESS")


class RebuildBlockedInFrozenProfileTests(unittest.TestCase):
    """Plan ARIA-V2 I-13 — frozen profile rejects rebuild-fates."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmpdir.name)
        self.repo = git_fixtures.make_repo_with_initial_commit(
            self.tmp, files={"a.txt": "alpha\n"},
            remote_url="https://github.com/test-owner/i13b.git", name="repo",
        )
        self.workspace_base = self.tmp / "ws"
        self.workspace_base.mkdir()
        os.environ["ARIA_WORKSPACE_BASE"] = str(self.workspace_base)
        migrate_workspace_v1_to_v2(
            workspace_root=self.repo, workspace_base=self.workspace_base,
            acknowledge=True, reason="Plan ARIA-V2 I-13b workspace bootstrap fixture",
        )
        self.tools_dir = self.tmp / "aria-tools"
        migrate_tools_bootstrap(
            tools_dir=self.tools_dir, workspace_root=self.repo,
            acknowledge=True, reason="Plan ARIA-V2 I-13b tools bootstrap fixture",
        )

    def tearDown(self) -> None:
        os.environ.pop("ARIA_WORKSPACE_BASE", None)
        self._tmpdir.cleanup()

    def test_frozen_profile_rejects_rebuild_fates(self) -> None:
        from aria_kernel.runtime_profile import set_profile
        set_profile("frozen", operator_approval_ref="OPR-i13b-test", base_dir=str(self.tools_dir))
        with self.assertRaises(GovernanceError) as cm:
            rebuild_fates(
                cycle_id="frozen-test", workspace_root=self.repo,
                workspace_base=self.workspace_base, base_dir=self.tools_dir,
                reason="Plan ARIA-V2 I-13b should reject under frozen",
                acknowledge=True,
            )
        msg = str(cm.exception).lower()
        self.assertTrue(
            any(token in msg for token in ("frozen", "profile", "rejected", "violation")),
            f"expected frozen-profile rejection, got: {cm.exception}",
        )


if __name__ == "__main__":
    unittest.main()
