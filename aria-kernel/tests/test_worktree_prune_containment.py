"""Prune containment — the dispatch ledger is untrusted input to deletion.

The 2026-09-01 controlled reproduction: a dispatch row whose
``worktree_path`` held an ABSOLUTE path outside the repository drove
``git worktree remove --force`` and, when git refused the unknown
worktree, the unconditional ``shutil.rmtree`` fallback deleted the
directory anyway. ``--acknowledge`` acknowledges pruning worktrees of
THIS workspace, not whatever a ledger row happens to name.

These cases pin the containment contract:
* an out-of-repo absolute path is refused, recorded, and left on disk;
* the repository root itself is refused;
* a legitimate worktree inside the repository root is still pruned.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.worker_dispatch import prune_worktrees


def _append_jsonl(path: Path, row: dict) -> None:
    from aria_kernel.ledger import append_jsonl

    path.parent.mkdir(parents=True, exist_ok=True)
    append_jsonl(path, row, test_fixture=True)


class WorktreePruneContainmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-prune-"))
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.repo = self.tmp / "repo"
        self.tools = ensure_tools_dir(self.tmp / "aria-tools")
        self.requests = self.tools / "dispatch" / "requests.jsonl"
        self.old_created = (
            datetime.now(timezone.utc) - timedelta(days=30)
        ).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _seed_row(self, assignment_id: str, worktree_path: str) -> dict:
        row = {
            "$schema": "aria/dispatch-request/v1",
            "schema_version": 1,
            "assignment_id": assignment_id,
            "pressure_event_id": f"P-{assignment_id}",
            "target_agent": "aria-worker",
            "triage_tier": "auto_fix_safe",
            "worktree_path": worktree_path,
            "base_sha": "deadbeef",
            "required_tests": [],
            "expected_trailer": f"Closes-Pressure: P-{assignment_id}",
            "state": "completed",
            "created_at": self.old_created,
        }
        _append_jsonl(self.requests, row)
        return row

    def test_out_of_repo_absolute_path_is_refused_and_left_on_disk(self) -> None:
        victim = Path(tempfile.mkdtemp(prefix="aria-prune-victim-"))
        self.addCleanup(lambda: shutil.rmtree(victim, ignore_errors=True))
        (victim / "keep.txt").write_text("must survive", encoding="utf-8")
        self._seed_row("A-ESC-1", str(victim))

        result = prune_worktrees(self.repo, self.tools, acknowledge=True)

        self.assertTrue(victim.exists(), "out-of-repo path must never be deleted")
        self.assertEqual((victim / "keep.txt").read_text(encoding="utf-8"), "must survive")
        self.assertEqual(result["pruned"], [])
        self.assertEqual(result["skipped"][0]["reason"], "worktree_outside_repo")
        self.assertEqual(result["status"], "ok")

    def test_the_repository_root_itself_is_refused(self) -> None:
        self.repo.mkdir(parents=True, exist_ok=True)
        self._seed_row("A-ESC-2", str(self.repo))

        result = prune_worktrees(self.repo, self.tools, acknowledge=True)

        self.assertTrue(self.repo.exists())
        self.assertEqual(result["pruned"], [])
        self.assertEqual(result["skipped"][0]["reason"], "worktree_outside_repo")

    def test_relative_path_inside_repo_is_still_pruned(self) -> None:
        worktree = self.repo / ".worktrees" / "wt-1"
        worktree.mkdir(parents=True)
        (worktree / "w.txt").write_text("x", encoding="utf-8")
        self._seed_row("A-OK-1", ".worktrees/wt-1")

        result = prune_worktrees(self.repo, self.tools, acknowledge=True)

        self.assertFalse(worktree.exists(), "legitimate worktree must be pruned")
        self.assertEqual(result["pruned"][0]["assignment_id"], "A-OK-1")


if __name__ == "__main__":
    unittest.main()
