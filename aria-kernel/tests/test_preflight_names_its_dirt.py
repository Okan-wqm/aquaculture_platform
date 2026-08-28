"""ORPHAN-HIGH-793 — a gate that refuses must name its subject.

The nightly cycle died on `workspace_worktree_not_clean` three runs in a
row with no path anywhere in the log — on a persistent self-hosted runner
the dirt is evidence (which lane left it?), and unprinted evidence does
not exist. The workflow preflight now carries the offending paths in its
reasons (capped) and the audit verdict.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.preflight import _git_worktree_clean, _git_worktree_offending_paths


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
        env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
             "GIT_COMMITTER_EMAIL": "t@t", "HOME": str(cwd), "PATH": "/usr/bin:/bin"},
    )


class CleanGateNamesItsDirt(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(tempfile.mkdtemp(prefix="aria-793-"))
        _git(["init", "-q", "-b", "main"], self.repo)
        (self.repo / "tracked.txt").write_text("x\n", encoding="utf-8")
        _git(["add", "."], self.repo)
        _git(["commit", "-q", "-m", "init"], self.repo)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.repo, ignore_errors=True)

    def test_dirty_source_file_is_named(self) -> None:
        (self.repo / "tracked.txt").write_text("modified\n", encoding="utf-8")
        (self.repo / "surprise.txt").write_text("untracked\n", encoding="utf-8")
        offenders = _git_worktree_offending_paths(self.repo)
        self.assertIn("tracked.txt", offenders)
        self.assertIn("surprise.txt", offenders)
        self.assertIs(_git_worktree_clean(self.repo), False)

    def test_designed_write_set_still_passes(self) -> None:
        designed = self.repo / "docs" / "aria" / "generated"
        designed.mkdir(parents=True)
        (designed / "JUDGE-DIGEST.md").write_text("regenerated\n", encoding="utf-8")
        (self.repo / "aria-tools").mkdir()
        (self.repo / "aria-tools" / "governance.jsonl").write_text("{}\n", encoding="utf-8")
        self.assertEqual(_git_worktree_offending_paths(self.repo), [])
        self.assertIs(_git_worktree_clean(self.repo), True)

    def test_non_repo_is_unknown_not_clean(self) -> None:
        empty = Path(tempfile.mkdtemp(prefix="aria-793-norepo-"))
        try:
            self.assertIsNone(_git_worktree_clean(empty))
        finally:
            import shutil

            shutil.rmtree(empty, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
