"""ARIA-HIGH-426 — the kernel refuses to write into a tree another account owns.

2026-10-08 19:24Z to 10-09 06:27Z: every self-hosted ARIA job failed in under
30 s at "Reset the persistent workspace" (runner diag logs
``Worker_20261008-192425-utc.log``, ``-220137``, ``-220229``) because a
root-run rescue publish had left root-owned files in the runner's workspace
that ``git clean`` cannot remove.

The process is made to look like root through the module's euid seam; the
"foreign" tree is a scratch directory owned by a non-root account (chowned
to ``nobody`` when the suite itself runs as root). So the same pins hold on
the runner (gharunner) and on an operator host (root).

Pins:

* a tools root inside a foreign tree is refused, by every resolution path
  (``--tools-dir``, ``ARIA_TOOLS_DIR``), before ``ensure_tools_dir`` creates
  anything, and the refusal names the owner and ``sudo -u <owner>``;
* a state checkout of a foreign repository is refused before the lifecycle
  lock file exists;
* a root-owned ancestor (``/tmp``, ``/var/lib/aria/code``) and an own tree
  stay writable, and so does the checkout this suite runs from.
"""
from __future__ import annotations

import os
import pwd
import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from aria_kernel import write_root_owner
from aria_kernel.state_store import _LIFECYCLE_LOCK_TARGET, checkout_state_store
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir, tools_dir
from aria_kernel.write_root_owner import FOREIGN_OWNER_TOKEN, refuse_foreign_owned_root

_NOBODY = 65534


def _as_uid(uid: int) -> mock._patch:
    return mock.patch.object(write_root_owner, "_effective_uid", return_value=uid)


class _Trees(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-426-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def foreign_tree(self) -> tuple[Path, str]:
        """A directory owned by a non-root account, and that account's name."""
        tree = self.tmp / f"workspace-{uuid.uuid4().hex[:8]}"
        tree.mkdir()
        if os.geteuid() == 0:
            os.chown(tree, _NOBODY, _NOBODY)
        owner_uid = tree.stat().st_uid
        self.assertNotEqual(owner_uid, 0)
        return tree, pwd.getpwuid(owner_uid).pw_name


class AForeignTreeIsRefused(_Trees):
    def test_every_tools_root_resolution_is_refused_before_anything_is_created(self) -> None:
        tree, owner = self.foreign_tree()
        store = tree / ".aria-state-store" / "tools"
        with _as_uid(0):
            with self.assertRaises(GovernanceError) as explicit:
                tools_dir(store)
            with mock.patch.dict(os.environ, {"ARIA_TOOLS_DIR": str(store)}):
                with self.assertRaises(GovernanceError):
                    tools_dir(None)
            with self.assertRaises(GovernanceError):
                ensure_tools_dir(store)
        message = str(explicit.exception)
        self.assertTrue(message.startswith(f"{FOREIGN_OWNER_TOKEN}: "))
        self.assertIn(f"owned by {owner}", message)
        self.assertIn(f"sudo -u {owner}", message)
        self.assertFalse((tree / ".aria-state-store").exists(), "nothing was created in the foreign tree")

    def test_a_state_checkout_of_a_foreign_repository_creates_no_lock(self) -> None:
        tree, _owner = self.foreign_tree()
        subprocess.run(["git", "init", "-q", str(tree)], check=True, capture_output=True)
        if os.geteuid() == 0:
            subprocess.run(["chown", "-R", f"{_NOBODY}:{_NOBODY}", str(tree)], check=True)
        with _as_uid(0), self.assertRaisesRegex(GovernanceError, FOREIGN_OWNER_TOKEN):
            checkout_state_store(tree, fetch=False)
        self.assertFalse((tree / ".git" / _LIFECYCLE_LOCK_TARGET).exists())
        self.assertFalse((tree / ".aria-state-store").exists())


class OwnAndRootTreesStayWritable(_Trees):
    def test_a_root_owned_ancestor_is_left_to_the_os(self) -> None:
        # /tmp-like: the nearest existing ancestor of a store not created yet
        # is "/", owned by root; a non-root account may resolve it.
        absent = Path("/") / f"aria-426-absent-{uuid.uuid4().hex}" / "tools"
        with _as_uid(4242):
            self.assertEqual(tools_dir(absent), absent)
        self.assertFalse(absent.parent.exists())

    def test_an_own_tree_is_writable(self) -> None:
        own = self.tmp / "aria-tools"
        with _as_uid(self.tmp.stat().st_uid):
            self.assertEqual(ensure_tools_dir(own), own)
        self.assertTrue(own.is_dir())

    def test_the_checkout_this_suite_runs_from_is_writable(self) -> None:
        # The operator's own worktrees (root on root-owned /var/aqua-saas) and
        # the runner's checkout (gharunner on its own _work) are this case.
        checkout = Path(__file__).resolve().parents[2]
        refuse_foreign_owned_root(checkout / "aria-tools", role="tools root")


if __name__ == "__main__":
    unittest.main()
