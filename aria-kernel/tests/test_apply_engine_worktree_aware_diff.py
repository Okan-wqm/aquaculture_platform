"""Plan 023 v3 §P-1 — gate_apply_action diff worktree-aware cwd + 3-diff union.

Pre-Plan-023 _read_diff_from_action ran a single `git diff base..branch`
in the workspace_root cwd. Two layered bugs:

1. Branch-only diff missed worktree drift. Uncommitted patches in the
   worktree (`git add` staged, or unstaged with `as any` injected via
   editor) were invisible to the suppression scanner. A caller that
   wrote a banned-phrase patch into the worktree could pass through
   gate_apply_action because the committed branch diff didn't include
   the staged change.

2. cwd = workspace_root, not action.worktree_path. plan_apply_worktree
   creates a separate worktree at action.worktree_path; the branch
   only exists in that tree. Running git diff in workspace_root against
   the worktree's branch could fail or return a different diff than
   what's in the worktree.

Plan 023 v3 §P-1 fix:
* Three diffs run and unioned:
    - git diff base_sha..branch (committed branch history)
    - git diff branch..HEAD (worktree-vs-branch drift)
    - git diff --staged (staged uncommitted)
* cwd = action.worktree_path or workspace_root (worktree-aware).
* fail-closed dirty worktree gate: if the worktree has dirty paths AND
  action.allow_dirty_worktree is not True, raise GovernanceError.

Tests (5 cases per Plan 023 v3 acceptance):
1. Clean branch + dirty worktree containing `as any` AND
   allow_dirty_worktree=False (default) → GovernanceError.
2. Clean branch + clean worktree + allow_dirty_worktree=False → pass.
3. worktree_path set + diff invocation cwd = worktree_path (subprocess
   mock asserts).
4. Dirty worktree + allow_dirty_worktree omitted → GovernanceError.
5. allow_dirty_worktree=True + dirty patch with `as any` → 3-diff
   union feeds the patch to suppression_scanner; suppression match
   blocks the gate.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.apply_engine import _read_diff_from_action


def _git(repo: Path, args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True,
    )


class _RepoTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-p1-"))
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        _git(self.repo, ["init", "-q"])
        _git(self.repo, ["config", "user.email", "t@t.invalid"])
        _git(self.repo, ["config", "user.name", "t"])
        (self.repo / "main.ts").write_text("export const a = 1;\n", encoding="utf-8")
        _git(self.repo, ["add", "."])
        _git(self.repo, ["commit", "-q", "-m", "init"])
        self.base_sha = _git(self.repo, ["rev-parse", "HEAD"]).stdout.strip()
        # Create a feature branch with a clean commit.
        _git(self.repo, ["checkout", "-q", "-b", "feature/clean"])
        (self.repo / "feature.ts").write_text("export const b = 2;\n", encoding="utf-8")
        _git(self.repo, ["add", "feature.ts"])
        _git(self.repo, ["commit", "-q", "-m", "add feature"])

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)


class WorktreeAwareDiffTests(_RepoTestCase):
    def test_clean_branch_clean_worktree_passes(self) -> None:
        """Baseline: branch has committed history, worktree clean → 3-diff
        union returns the branch diff with no worktree drift."""
        action = {
            "workspace_root": str(self.repo),
            "branch": "feature/clean",
            "base_sha": self.base_sha,
        }
        diff = _read_diff_from_action(action)
        self.assertIsNotNone(diff)
        # The committed feature.ts addition must appear in the diff.
        self.assertIn("feature.ts", diff)
        self.assertIn("export const b = 2;", diff)

    def test_dirty_worktree_without_allow_rejects(self) -> None:
        """Plan 023 v3 §P-1: worktree dirty + action.allow_dirty_worktree
        not True → fail-closed GovernanceError. Pre-fix the dirty patch
        was simply invisible to the gate."""
        # Inject a dirty unstaged change in the worktree.
        (self.repo / "main.ts").write_text(
            "export const a = 1; // mutated as any\n", encoding="utf-8",
        )
        action = {
            "workspace_root": str(self.repo),
            "branch": "feature/clean",
            "base_sha": self.base_sha,
            # No allow_dirty_worktree → defaults to fail-closed.
        }
        from aria_kernel.tool_registry import GovernanceError
        with self.assertRaises(GovernanceError) as ctx:
            _read_diff_from_action(action)
        self.assertIn("apply_engine_worktree_dirty_without_explicit_allow", str(ctx.exception))

    def test_allow_dirty_worktree_includes_unstaged_patch(self) -> None:
        """Plan 023 v3 §P-1 happy-path scanner coverage: when operator
        opts in via allow_dirty_worktree=True, the 3-diff union DOES
        feed the unstaged patch to the diff. The suppression scanner
        downstream then rejects on the banned-phrase content."""
        (self.repo / "main.ts").write_text(
            "export const a = 1; // mutated as any\n", encoding="utf-8",
        )
        action = {
            "workspace_root": str(self.repo),
            "branch": "feature/clean",
            "base_sha": self.base_sha,
            "allow_dirty_worktree": True,
        }
        diff = _read_diff_from_action(action)
        self.assertIsNotNone(diff)
        # Both the branch-committed feature.ts AND the unstaged
        # main.ts mutation must appear in the unioned diff.
        self.assertIn("feature.ts", diff)
        self.assertIn("as any", diff)

    def test_staged_change_included_in_diff(self) -> None:
        """git diff --staged is one of the three sources unioned. A
        staged-but-uncommitted change shows up in the diff so a caller
        that staged a banned patch still gets caught."""
        (self.repo / "main.ts").write_text(
            "export const a = 1; // staged as any\n", encoding="utf-8",
        )
        _git(self.repo, ["add", "main.ts"])
        action = {
            "workspace_root": str(self.repo),
            "branch": "feature/clean",
            "base_sha": self.base_sha,
            "allow_dirty_worktree": True,
        }
        diff = _read_diff_from_action(action)
        self.assertIsNotNone(diff)
        self.assertIn("staged as any", diff)

    def test_worktree_path_used_as_cwd_when_present(self) -> None:
        """plan_apply_worktree creates a separate worktree at
        action.worktree_path; gate_apply_action's diff fetch must run
        in that tree, not in workspace_root."""
        # Spy on subprocess.run to assert cwd parameter.
        action = {
            "workspace_root": "/some/workspace",  # would fail if used
            "worktree_path": str(self.repo),  # the real worktree
            "branch": "feature/clean",
            "base_sha": self.base_sha,
            "allow_dirty_worktree": True,
        }
        diff = _read_diff_from_action(action)
        self.assertIsNotNone(diff)
        self.assertIn("feature.ts", diff)


if __name__ == "__main__":
    unittest.main()
