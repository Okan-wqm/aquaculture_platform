"""Plan ARIA-V2 §3.6 + I-21 — runtime augmentation by ``git worktree list``.

``augmented_excluded_paths(repo_root)`` MUST union the basenames of
every worktree returned by ``git worktree list --porcelain`` into the
returned frozenset. Out-of-tree worktrees (e.g. ``/tmp/wt-foo``) are
covered by this augmentation; the static ``BASE_EXCLUDED_DIRS`` only
covers the canonical ``.worktrees/`` parent directory.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.shared.excluded_paths import (
    BASE_EXCLUDED_DIRS,
    augmented_excluded_paths,
)


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        text=True,
    )


def _init_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    _git(path, "init", "-q", "-b", "main")
    _git(path, "config", "user.email", "test@example.com")
    _git(path, "config", "user.name", "Test")
    (path / "README.md").write_text("seed\n", encoding="utf-8")
    _git(path, "add", "README.md")
    _git(path, "commit", "-q", "-m", "seed")


class AugmentedExcludedPathsIncludesGitWorktrees(unittest.TestCase):
    def test_worktree_basename_appears_in_augmented_set(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            primary = tdp / "primary"
            _init_repo(primary)
            wt_path = tdp / "wt-foo"
            _git(primary, "worktree", "add", str(wt_path), "-b", "feature/foo")

            augmented = augmented_excluded_paths(primary)

            self.assertIn("wt-foo", augmented)
            # Original frozenset still present
            for token in BASE_EXCLUDED_DIRS:
                self.assertIn(token, augmented)

    def test_augmented_falls_back_to_base_when_not_a_git_repo(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            # No git init.
            augmented = augmented_excluded_paths(tdp)
            self.assertEqual(augmented, BASE_EXCLUDED_DIRS)

    def test_augmented_returns_frozenset(self) -> None:
        result = augmented_excluded_paths(_REPO_ROOT)
        self.assertIsInstance(result, frozenset)
        self.assertIn(".worktrees", result)


if __name__ == "__main__":
    unittest.main()
