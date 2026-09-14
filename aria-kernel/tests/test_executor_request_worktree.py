"""B8 (2026-09-12) — one worktree per drained request, at its own target_sha.

Under managed_subscription the native admission binds request.target_sha to
the checkout's HEAD; the shared checkout is main and moves nightly, so every
request minted before its last advance was refused (target_revision_mismatch)
and the drain read the summary-less exit 0 as a green night. The operator
turned `worktree_per_request` on; these pin what the drain provisions and
what the child in it needs:

* the worktree is INSIDE the checkout (node resolution walks up to the
  parent's node_modules — measured with require.resolve and `npx
  --no-install` from a nested worktree) and git-ignored there, so the
  persistent workspace's `git status` never sees one;
* a leftover from a run reaped mid-child — registered-and-missing, or
  registered-and-present — is reconciled with git's own prune/remove before
  the add, so tomorrow's drain of the same request id does not fall back to
  the shared checkout and its target mismatch;
* the child in the worktree passes the native task binding: the identity
  check compares git common directories, and the worktree's HEAD is the
  request's target_sha.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
for _path in (str(_POC_DIR), str(_REPO_ROOT / "aria-kernel")):
    if _path not in sys.path:
        sys.path.insert(0, str(_path))

import ci_executor_drain as drain  # noqa: E402
from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit  # noqa: E402


class TheWorktreeIsProvisionedWhereTheChildNeedsIt(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory(prefix="aria-request-worktree-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.repo = make_repo_with_initial_commit(self.root, {"README.md": "one\n", ".gitignore": "aria-worktrees/\n"})
        self.target_sha = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        (self.repo / "README.md").write_text("two\n", encoding="utf-8")
        _git(["commit", "-qam", "main moved on"], cwd=self.repo)
        self.assertNotEqual(_git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip(), self.target_sha)

    def _add(self, request_id: str, target_sha: str) -> Path:
        """The worktree git created — the answer, not the receipt. The drain's
        receipt (`_RequestWorktree`) also carries "git did not answer"
        (`unanswered_reason`), which these fixtures never provoke."""
        provisioned = drain._add_request_worktree(self.repo, request_id, target_sha)
        self.assertIsNone(provisioned.unanswered_reason)
        self.assertIsNotNone(provisioned.path)
        assert provisioned.path is not None
        return provisioned.path

    def test_the_worktree_sits_inside_the_checkout_at_the_target_sha(self) -> None:
        path = self._add("AIR-1", self.target_sha)
        self.assertEqual(path.parent, self.repo / drain.REQUEST_WORKTREES_DIR,
                         "inside the checkout: node resolution walks UP to <checkout>/node_modules")
        self.assertEqual(_git(["rev-parse", "HEAD"], cwd=path).stdout.strip(), self.target_sha)
        self.assertEqual((path / "README.md").read_text(encoding="utf-8"), "one\n")
        # Invisible to the parent's status: the directory is ignored, so a
        # persistent workspace never carries a stray untracked worktree.
        self.assertEqual(_git(["status", "--porcelain"], cwd=self.repo).stdout, "")
        drain._remove_request_worktree(self.repo, path)
        self.assertFalse(path.exists())

    def test_a_registered_but_missing_leftover_is_pruned_before_the_add(self) -> None:
        # A run reaped mid-child, then the next checkout's clean: the
        # directory is gone, `.git/worktrees/req-AIR-1` is not. Bare `git
        # worktree add` refuses "missing but already registered".
        first = self._add("AIR-1", self.target_sha)
        shutil.rmtree(first)
        refused = subprocess.run(["git", "worktree", "add", "--detach", str(first), self.target_sha],
                                 cwd=self.repo, capture_output=True, text=True, check=False)
        self.assertNotEqual(refused.returncode, 0, "the fixture must reproduce git's refusal")
        second = self._add("AIR-1", self.target_sha)
        self.assertEqual(second, first)
        self.assertEqual(_git(["rev-parse", "HEAD"], cwd=first).stdout.strip(), self.target_sha)
        drain._remove_request_worktree(self.repo, first)

    def test_a_registered_and_present_leftover_is_removed_before_the_add(self) -> None:
        # A run reaped mid-child with no clean in between: the worktree is
        # still there. Bare `git worktree add` refuses "already exists".
        first = self._add("AIR-1", self.target_sha)
        (first / "scratch.txt").write_text("half-written by the reaped child\n", encoding="utf-8")
        second = self._add("AIR-1", self.target_sha)
        self.assertEqual(second, first)
        self.assertFalse((first / "scratch.txt").exists(), "a fresh tree, not the reaped child's leftovers")
        self.assertEqual(_git(["rev-parse", "HEAD"], cwd=first).stdout.strip(), self.target_sha)
        drain._remove_request_worktree(self.repo, first)

    def test_an_unreachable_target_sha_falls_back_to_the_shared_checkout(self) -> None:
        # Git ANSWERED that it could not add the tree: no path, and no
        # "did not answer" reason — the shared checkout is used instead.
        self.assertEqual(drain._add_request_worktree(self.repo, "AIR-2", "0" * 40),
                         drain._RequestWorktree(path=None, unanswered_reason=None))
        self.assertFalse((self.repo / drain.REQUEST_WORKTREES_DIR / "req-AIR-2").exists())


class TheRepositoryIgnoresTheWorktreeDirectory(unittest.TestCase):
    def test_the_real_gitignore_hides_a_request_worktree(self) -> None:
        # The drain runs in the persistent self-hosted workspace, a checkout
        # of THIS repository; `git check-ignore` asks its .gitignore directly.
        probe = f"{drain.REQUEST_WORKTREES_DIR}/req-AIR-probe/README.md"
        ignored = subprocess.run(["git", "check-ignore", "-q", probe], cwd=_REPO_ROOT,
                                 capture_output=True, text=True, check=False)
        self.assertEqual(ignored.returncode, 0, f"{probe} is not git-ignored in {_REPO_ROOT}")


if __name__ == "__main__":
    unittest.main()
