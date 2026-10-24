"""ARIA-MEDIUM-432 — the adapter room's workspace is what git tracks.

The view is built from git's own listing: an empty root at the workspace
path, each tracked top-level entry bound read-only into it, every untracked
path beneath those entries covered, and ``.git`` bound. These tests read the
flags without running bwrap; ``test_adapter_room`` runs the real room.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import implementation_safety as impl
from aria_kernel.workspace_view import WorkspaceViewRefused, build_workspace_view
from tests._helpers.git_fixtures import _git, commit_files, make_local_git_repo
from tests._helpers.sandbox_pins import require_bwrap_installed


def _pairs(flags: tuple[str, ...] | list[str], flag: str, width: int) -> list[tuple[str, ...]]:
    return [tuple(flags[i + 1:i + 1 + width]) for i in range(len(flags)) if flags[i] == flag]


class CheckoutFixture(unittest.TestCase):
    def setUp(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="aria-view-", dir="/var/tmp")).resolve()
        self.addCleanup(shutil.rmtree, base, True)
        self.base = base
        self.ws = make_local_git_repo(base, name="ws", initial_commit=False)
        commit_files(self.ws, {
            "src/app.ts": "export const app = 1;\n",
            "deploy/prod/values.yaml": "replicas: 1\n",
            "README.md": "x\n",
        })
        os.symlink("src", self.ws / "source-link")
        _git(["add", "source-link"], cwd=self.ws)
        _git(["commit", "-q", "-m", "link"], cwd=self.ws)
        for relative, content in {
            ".env": "API_SECRET=x\n",
            "deploy/prod/secret.yaml": "token: x\n",
            "src/wip.ts": "export const wip = 1;\n",
            ".aria-state-store/canary.jsonl": "{}\n",
            "src/__pycache__/m.pyc": "x",
        }.items():
            (self.ws / relative).parent.mkdir(parents=True, exist_ok=True)
            (self.ws / relative).write_text(content, encoding="utf-8")
        os.symlink("/etc/hostname", self.ws / "src" / "untracked-link")


class TrackedViewTests(CheckoutFixture):
    def test_the_view_holds_what_git_tracks_and_covers_the_rest(self) -> None:
        view = build_workspace_view(self.ws)
        ws = str(self.ws)
        self.assertEqual(view.flags[:2], ("--tmpfs", ws))
        binds = _pairs(view.flags, "--ro-bind", 2)
        self.assertEqual(
            sorted(dest for _, dest in binds if dest != f"{ws}/.git" and not dest.startswith(f"{ws}/deploy/prod/s")
                   and not dest.startswith(f"{ws}/src/wip")),
            [f"{ws}/README.md", f"{ws}/deploy", f"{ws}/src"],
        )
        self.assertIn(("src", f"{ws}/source-link"), _pairs(view.flags, "--symlink", 2))
        # Untracked beneath a tracked directory: a directory is an empty
        # tmpfs, a file an empty device; an untracked symlink is left alone.
        self.assertIn((f"{ws}/src/__pycache__",), _pairs(view.flags, "--tmpfs", 1))
        self.assertIn((os.devnull, f"{ws}/src/wip.ts"), binds)
        self.assertIn((os.devnull, f"{ws}/deploy/prod/secret.yaml"), binds)
        self.assertNotIn(f"{ws}/src/untracked-link", " ".join(view.flags))
        # Untracked at the top is simply never bound.
        for absent in (".env", ".aria-state-store"):
            self.assertFalse(any(f"{ws}/{absent}" in flag for flag in view.flags), absent)
        self.assertIn((f"{ws}/.git", f"{ws}/.git"), binds)

    def test_hides_answers_for_every_kind_of_path(self) -> None:
        view = build_workspace_view(self.ws)
        for relative, hidden in ((".env", True), (".aria-state-store/canary.jsonl", True), ("src/wip.ts", True),
                                 ("src/__pycache__/m.pyc", True), ("deploy/prod/secret.yaml", True),
                                 ("src/app.ts", False), ("deploy/prod/values.yaml", False)):
            with self.subTest(relative=relative):
                self.assertEqual(view.hides(self.ws / relative), hidden)
        with self.assertRaises(ValueError):
            view.hides(self.base)

    def test_the_callers_git_environment_does_not_decide_the_view(self) -> None:
        other = make_local_git_repo(self.base, name="other", initial_commit=False)
        commit_files(other, {".env": "tracked elsewhere\n"})
        expected = build_workspace_view(self.ws).flags
        with mock.patch.dict(os.environ, {"GIT_DIR": str(other / ".git"), "GIT_WORK_TREE": str(other)}):
            self.assertEqual(build_workspace_view(self.ws).flags, expected)

    def test_a_workspace_that_is_not_a_checkout_has_no_view(self) -> None:
        plain = self.base / "plain"
        plain.mkdir()
        with self.assertRaises(WorkspaceViewRefused) as raised:
            build_workspace_view(plain)
        self.assertEqual(raised.exception.reason, "workspace_view_not_a_checkout")

    def test_a_submodule_is_refused_because_its_untracked_files_are_another_repositorys(self) -> None:
        inner = make_local_git_repo(self.base, name="inner", initial_commit=True)
        head = _git(["rev-parse", "HEAD"], cwd=inner).stdout.strip()
        _git(["update-index", "--add", "--cacheinfo", f"160000,{head},vendor/inner"], cwd=self.ws)
        with self.assertRaisesRegex(WorkspaceViewRefused, "workspace_view_submodule_unsupported:vendor/inner"):
            build_workspace_view(self.ws)


class SandboxViewModeTests(CheckoutFixture):
    """``_sandbox_argv(workspace_view=...)`` — read without running it."""

    def test_the_view_replaces_the_workspace_bind_and_the_readonly_overlays(self) -> None:
        (self.ws / "infrastructure").mkdir()
        (self.ws / "infrastructure" / "server.pem").write_text("k\n", encoding="utf-8")
        view = build_workspace_view(self.ws)
        argv = impl._sandbox_argv(["true"], workspace_root=self.ws, write_scope=(), workspace_view=view)
        separator = argv.index("--")
        ws = str(self.ws)
        binds = _pairs(argv[:separator], "--ro-bind", 2)
        self.assertNotIn((ws, ws), binds)
        # READONLY_PATHS each re-bind a host path whole (`.env` is one): none
        # is applied over a view.
        for ro in impl.readonly_paths():
            if ro != ".git/":  # the view binds the git dir itself, once
                self.assertNotIn((f"{ws}/{ro}".rstrip("/"),) * 2, binds, ro)
        self.assertEqual(binds.count((f"{ws}/.git", f"{ws}/.git")), 1)
        remount = [i for i in range(separator) if argv[i] == "--remount-ro"]
        self.assertEqual([argv[i + 1] for i in remount], [ws])

    def test_a_view_is_read_only_and_only_for_its_own_workspace(self) -> None:
        view = build_workspace_view(self.ws)
        for kwargs in ({"write_scope": None}, {"write_scope": ("src",)}):
            with self.subTest(**kwargs), self.assertRaisesRegex(impl.SandboxUnavailable, "workspace_view_mismatch"):
                impl._sandbox_argv(["true"], workspace_root=self.ws, workspace_view=view, **kwargs)
        with self.assertRaisesRegex(impl.SandboxUnavailable, "workspace_view_mismatch"):
            impl._sandbox_argv(["true"], workspace_root=self.base, write_scope=(), workspace_view=view)


class ViewDependencyTreeTests(CheckoutFixture):
    def test_the_workspaces_own_tree_is_bound_in_place_from_its_resolved_source(self) -> None:
        elsewhere = self.base / "elsewhere" / "node_modules"
        elsewhere.mkdir(parents=True)
        (self.ws / "node_modules").symlink_to(elsewhere)
        commit_files(self.ws, {"package.json": '{"workspaces": ["packages/*"]}\n', "packages/a/index.ts": "x\n"})
        (self.ws / "packages" / "a" / "node_modules").mkdir()
        flags = impl._view_dependency_binds(self.ws)
        self.assertEqual(_pairs(flags, "--ro-bind", 2), [
            (str(elsewhere), str(self.ws / "node_modules")),
            (str(self.ws / "packages" / "a" / "node_modules"), str(self.ws / "packages" / "a" / "node_modules")),
        ])
        self.assertNotIn("--tmpfs", flags, "nothing is created in the trees")

    def test_a_nested_workspace_gets_the_ancestor_checkouts_tree_as_every_room_does(self) -> None:
        nested = self.ws / "aria-worktrees" / "req-1"
        nested.mkdir(parents=True)
        (self.ws / "node_modules").mkdir()
        self.assertEqual(impl._view_dependency_binds(nested), impl._dependency_tree_binds(nested))


class VerifiedBwrapTests(unittest.TestCase):
    """bwrap is exec'd by the absolute path the kernel resolved, never by a
    name the child's PATH resolves again."""

    def test_every_room_execs_the_resolved_absolute_path(self) -> None:
        found = require_bwrap_installed()
        with tempfile.TemporaryDirectory() as tmp:
            argv = impl._sandbox_argv(["true"], workspace_root=tmp)
        self.assertEqual(argv[0], os.path.realpath(found))
        self.assertEqual(impl._bwrap_probe_argv()[0], os.path.realpath(found))

    def test_a_relative_path_entry_never_names_the_sandbox(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / "bin" / "bwrap"
            fake.parent.mkdir()
            fake.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            fake.chmod(0o755)
            cwd = os.getcwd()
            os.chdir(tmp)
            try:
                with mock.patch.dict(os.environ, {"PATH": "bin"}):
                    self.assertIsNone(impl._bwrap_executable())
                    with self.assertRaisesRegex(impl.SandboxUnavailable, "bwrap is not on PATH"):
                        impl._sandbox_argv(["true"], workspace_root=tmp)
            finally:
                os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()
