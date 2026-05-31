"""Tests for the Plan 016 Faz 0 worktree preflight gate."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import verify_jsonl
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths
from aria_kernel.worktree import preflight


def _git(args: list[str], cwd: Path) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=True,
        env={
            **os.environ,
            "GIT_AUTHOR_NAME": "ARIA Test",
            "GIT_AUTHOR_EMAIL": "aria@test.local",
            "GIT_COMMITTER_NAME": "ARIA Test",
            "GIT_COMMITTER_EMAIL": "aria@test.local",
        },
    )
    return proc.stdout.strip()


class WorktreePreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self._stack = tempfile.TemporaryDirectory()
        self.tmp = Path(self._stack.name)

        # Build a fake "origin" remote (bare repo) and a working clone.
        self.origin = self.tmp / "origin.git"
        subprocess.run(
            ["git", "init", "--bare", "--initial-branch=main", str(self.origin)],
            check=True,
            capture_output=True,
        )

        self.repo = self.tmp / "repo"
        subprocess.run(
            ["git", "init", "--initial-branch=main", str(self.repo)],
            check=True,
            capture_output=True,
        )
        _git(["remote", "add", "origin", str(self.origin)], self.repo)
        (self.repo / "README.md").write_text("seed\n", encoding="utf-8")
        _git(["add", "README.md"], self.repo)
        _git(["commit", "-m", "seed"], self.repo)
        _git(["push", "-u", "origin", "main"], self.repo)

        # Wire a workspace + tools-dir under the temp tree so preflight can record events.
        self.workspace_base = self.tmp / "workspaces"
        self.tools_dir = self.tmp / "aria-tools"
        paths = workspace_paths(self.repo, self.workspace_base)
        ensure_workspace(paths)
        ensure_tools_dir(self.tools_dir)

    def tearDown(self) -> None:
        self._stack.cleanup()

    def _governance_path(self) -> Path:
        return self.tools_dir / "governance.jsonl"

    def _governance_rows(self) -> list[dict]:
        if not self._governance_path().exists():
            return []
        return [
            json.loads(line)
            for line in self._governance_path().read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_clean_main_passes_gate_and_records_event(self) -> None:
        result = preflight(
            workspace_root=self.repo,
            base_dir=self.tools_dir,
            expected_branch="main",
            skip_fetch=True,
        )
        self.assertTrue(result["gate_pass"], result)
        details = result["details"]
        self.assertEqual(details["actual_branch"], "main")
        self.assertTrue(details["branch_ok"])
        self.assertTrue(details["clean"])
        self.assertEqual(details["dirty_files_count"], 0)

        rows = self._governance_rows()
        worktree_rows = [r for r in rows if r.get("kind") == "worktree_preflight"]
        self.assertEqual(len(worktree_rows), 1)
        self.assertEqual(worktree_rows[0]["details"]["actual_branch"], "main")
        self.assertEqual(worktree_rows[0]["schema_version"], 2)
        self.assertTrue(worktree_rows[0]["ledger_hash"].startswith("sha256:"))

        chain = verify_jsonl(self._governance_path())
        self.assertTrue(chain["valid"], chain)

    def test_dirty_tree_fails_gate_and_records_dirty_sample(self) -> None:
        (self.repo / "scratch.txt").write_text("uncommitted\n", encoding="utf-8")

        result = preflight(
            workspace_root=self.repo,
            base_dir=self.tools_dir,
            expected_branch="main",
            skip_fetch=True,
        )
        self.assertFalse(result["gate_pass"])
        self.assertGreaterEqual(result["details"]["dirty_files_count"], 1)
        self.assertIn("dirty_sample", result["details"])

        chain = verify_jsonl(self._governance_path())
        self.assertTrue(chain["valid"], chain)

    def test_wrong_branch_fails_gate(self) -> None:
        _git(["checkout", "-b", "feature/other"], self.repo)
        result = preflight(
            workspace_root=self.repo,
            base_dir=self.tools_dir,
            expected_branch="main",
            skip_fetch=True,
        )
        self.assertFalse(result["gate_pass"])
        self.assertFalse(result["details"]["branch_ok"])
        self.assertEqual(result["details"]["actual_branch"], "feature/other")

    def test_runtime_dirty_paths_do_not_block_gate(self) -> None:
        """Source-dirty vs runtime-dirty: only source dirty blocks the gate.

        ARIA's own runtime ledgers (aria-tools/**, aria-findings/**, etc.) are
        written by the kernel itself on every cycle. Counting them as dirty
        creates a chicken-and-egg gate where preflight always fails.
        """
        (self.repo / "aria-tools").mkdir(exist_ok=True)
        (self.repo / "aria-tools" / "scratch.jsonl").write_text("{}\n", encoding="utf-8")
        (self.repo / "aria-findings").mkdir(exist_ok=True)
        (self.repo / "aria-findings" / "F-001.md").write_text("# F-001\n", encoding="utf-8")

        result = preflight(
            workspace_root=self.repo,
            base_dir=self.tools_dir,
            expected_branch="main",
            skip_fetch=True,
        )
        self.assertTrue(result["gate_pass"], result)
        details = result["details"]
        self.assertEqual(details["dirty_files_count"], 0)
        self.assertEqual(details["runtime_dirty_count"], 2)
        self.assertIn("runtime_dirty_sample", details)

    def test_mixed_source_and_runtime_dirty_only_source_blocks(self) -> None:
        (self.repo / "aria-tools").mkdir(exist_ok=True)
        (self.repo / "aria-tools" / "runtime.jsonl").write_text("{}\n", encoding="utf-8")
        (self.repo / "src.txt").write_text("real source change\n", encoding="utf-8")

        result = preflight(
            workspace_root=self.repo,
            base_dir=self.tools_dir,
            expected_branch="main",
            skip_fetch=True,
        )
        self.assertFalse(result["gate_pass"])
        self.assertEqual(result["details"]["dirty_files_count"], 1)
        self.assertEqual(result["details"]["runtime_dirty_count"], 1)
        self.assertIn("src.txt", result["details"]["dirty_sample"][0])

    def test_ahead_behind_recorded_when_upstream_known(self) -> None:
        # Add a local commit so HEAD is ahead of origin/main.
        (self.repo / "ahead.txt").write_text("ahead\n", encoding="utf-8")
        _git(["add", "ahead.txt"], self.repo)
        _git(["commit", "-m", "ahead"], self.repo)

        result = preflight(
            workspace_root=self.repo,
            base_dir=self.tools_dir,
            expected_branch="main",
            skip_fetch=True,
        )
        details = result["details"]
        self.assertTrue(details["upstream_known"], details)
        self.assertEqual(details["commits_ahead"], 1)
        self.assertEqual(details["commits_behind"], 0)


if __name__ == "__main__":
    unittest.main()
