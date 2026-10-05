"""ARIA-HIGH-349 — a set-aside hollow store never dirties the lane's worktree.

``state_store._set_aside_hollow_store`` moves a store directory whose worktree
link is gone to ``<store>.hollow-<stamp>`` next to itself, inside the runner's
checkout, and deletes nothing (forensics). Every ARIA lane gates on a clean
worktree; on 2026-10-04 burn-in run 37227217146 refused with
``observe_burn_in_pre_worktree_not_clean: 1 path(s)`` for exactly
``.aria-state-store.hollow-20261004T191433Z/``. The set-aside is host-local
runtime material like the store itself, so it is ignored like the store.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel import state_store

REPO_ROOT = Path(__file__).resolve().parents[2]


def _git_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}


class HollowStoreSetAsideIsIgnored(unittest.TestCase):
    def test_the_kernel_named_set_aside_is_ignored_by_the_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / ".aria-state-store"
            store.mkdir()
            aside = state_store._set_aside_hollow_store(store)
            relative = f"{aside.name}/tools/plans/events.jsonl"
        result = subprocess.run(
            ["git", "check-ignore", "--no-index", "-q", relative],
            cwd=REPO_ROOT, env=_git_env(), capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, f"{relative} is not ignored: {result.stderr}")

    def test_a_suffixed_set_aside_is_ignored_too(self) -> None:
        result = subprocess.run(
            ["git", "check-ignore", "--no-index", "-q", ".aria-state-store.hollow-20261004T191433Z-2/x"],
            cwd=REPO_ROOT, env=_git_env(), capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
