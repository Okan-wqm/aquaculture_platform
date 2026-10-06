"""ARIA-HIGH-361 — a nested worktree sees the installed tree in place.

The checkout's tree, bound only at its own path (ARIA-HIGH-123), answered a
bare ``require`` from the worktree root and nothing more. Inside the sandbox:

- a workspace link (``node_modules/@aq/lib -> ../../libs/lib``) resolved into
  the checkout's hidden ``libs/``, which is another revision anyway;
- a nested workspace install (``web/modules/hr/node_modules``) was missing;
- ``<cwd>/node_modules/.bin/tsc`` did not exist.

Each test below fails on the ARIA-HIGH-123 binds and passes on the in-place
mounts.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel import implementation_safety as impl
from aria_kernel.dependency_tree import DependencyMount, dependency_mounts
from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class _InstalledCheckout(unittest.TestCase):
    """An npm-workspaces checkout as `npm ci` leaves it: a hoisted root tree
    with relative workspace links, one nested install, and a per-request
    worktree whose code differs from the checkout's."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-361-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.repo = make_repo_with_initial_commit(self.root, {
            ".gitignore": "node_modules\naria-worktrees/\n",
            "package.json": json.dumps({"workspaces": ["libs/*", "web/modules/*"]}),
            "libs/lib/index.js": "module.exports = 'checkout-revision';\n",
            "web/modules/hr/package.json": "{}\n",
            "web/modules/gone/package.json": "{}\n",
        }, name="checkout")
        tree = self.repo / "node_modules"
        _write(tree / "hoisted" / "index.js", "module.exports = 'hoisted';\n")
        _write(tree / ".bin" / "tsc", "#!/bin/sh\necho TSC_FROM_TREE\n")
        (tree / ".bin" / "tsc").chmod(0o755)
        (tree / "@aq").mkdir()
        (tree / "@aq" / "lib").symlink_to(Path("..") / ".." / "libs" / "lib")
        _write(self.repo / "web/modules/hr/node_modules/router/index.js", "module.exports = 'nested-router';\n")
        _write(self.repo / "web/modules/gone/node_modules/x/index.js", "\n")
        base = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        self.worktree = self.repo / "aria-worktrees" / "req-1"
        self.worktree.parent.mkdir()
        _git(["worktree", "add", "--detach", "-q", str(self.worktree), base], cwd=self.repo)
        # The request's revision of the workspace code, and a package the
        # request's tree no longer has.
        _write(self.worktree / "libs/lib/index.js", "module.exports = 'worktree-revision';\n")
        shutil.rmtree(self.worktree / "web/modules/gone")


class LayoutTests(_InstalledCheckout):
    def test_the_root_and_each_present_workspace_tree_are_listed_in_place(self) -> None:
        self.assertEqual(dependency_mounts(self.worktree), [
            DependencyMount(self.repo / "node_modules", self.worktree / "node_modules"),
            DependencyMount(self.repo / "web/modules/hr/node_modules",
                            self.worktree / "web/modules/hr/node_modules"),
        ])

    def test_a_workspace_outside_any_installed_checkout_has_none(self) -> None:
        with tempfile.TemporaryDirectory() as alone:
            self.assertEqual(dependency_mounts(Path(alone)), [])

    def test_the_mountpoints_stay_invisible_to_git(self) -> None:
        impl._dependency_tree_binds(self.worktree)
        self.assertTrue((self.worktree / "node_modules").is_dir())
        self.assertTrue((self.worktree / "web/modules/hr/node_modules").is_dir())
        status = _git(["status", "--porcelain", "--untracked-files=all"], cwd=self.worktree).stdout
        self.assertNotIn("node_modules", status)


class SandboxResolutionTests(_InstalledCheckout):
    def _inside(self, script: str, *, write_scope: list[str] | None = None) -> subprocess.CompletedProcess[str]:
        impl._bwrap_available.cache_clear()
        if impl.sandbox_backend() is None:
            self.skipTest("bwrap is not usable on this host; the sandbox refuses rather than degrading")
        argv = impl.wrap_bash_in_sandbox(["sh", "-c", script], workspace_root=self.worktree,
                                         allow_network=False, write_scope=write_scope)
        return subprocess.run(argv, capture_output=True, text=True, timeout=60)

    def test_a_workspace_link_resolves_to_the_worktrees_own_code(self) -> None:
        done = self._inside("cat node_modules/@aq/lib/index.js")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip(), "module.exports = 'worktree-revision';")

    def test_a_nested_workspace_install_is_present(self) -> None:
        done = self._inside("cat web/modules/hr/node_modules/router/index.js")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("nested-router", done.stdout)

    def test_the_cwd_relative_binary_path_runs(self) -> None:
        done = self._inside("./node_modules/.bin/tsc")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip(), "TSC_FROM_TREE")

    def test_the_tree_is_read_only_inside(self) -> None:
        done = self._inside("touch node_modules/probe 2>/dev/null && echo WRITABLE || echo READ_ONLY")
        self.assertEqual(done.stdout.strip(), "READ_ONLY")
        self.assertFalse((self.repo / "node_modules" / "probe").exists())

    def test_a_write_scoped_spawn_sees_the_same_tree(self) -> None:
        """A write-scoped spawn binds the workspace read-only, so bwrap could
        not create a mountpoint there; the host-side mountpoints hold."""
        done = self._inside("cat node_modules/@aq/lib/index.js web/modules/hr/node_modules/router/index.js",
                            write_scope=["web/modules/hr/src"])
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("worktree-revision", done.stdout)
        self.assertIn("nested-router", done.stdout)


if __name__ == "__main__":
    unittest.main()
