"""ARIA-HIGH-098 (fixture half) — the fixture path guard survives a linked worktree.

Trial eleven (``cyc-20260912T221237Z-auto``, 2026-09-12) ran the kernel in a
workspace created by ``git worktree add``: its ``.git`` is a FILE carrying a
``gitdir:`` pointer, and so is the state store's nested inside it. The
pre-fix walker (``fixture_runner._discover_git_root``) accepted only a
``.git`` DIRECTORY, stepped past both, found nothing, and the guard fell back
to ``tools_root.parent`` — the state store — so nine registry fixture paths
inside the checkout were refused as ``fixture_path_escape_outside_repo``
and no fixture suite ran. The executor's per-request worktrees
(``aria-worktrees/``) share the shape.

These tests build REAL worktrees with git, never stubs, so the marker under
test is the one git writes.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.checkout_root import (
    discover_checkout_root,
    is_checkout_root,
    is_state_store_worktree,
    read_gitdir_pointer,
    same_repository,
)
from aria_kernel.fixture_runner import _repo_root_for_path_guard, resolve_fixture_dir
from aria_kernel.state_store import GENESIS_FILENAME
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.git_fixtures import make_git_worktree, make_repo_with_initial_commit


def _tool(fixture_set: str) -> dict:
    return {"tool_id": "x-adapter", "fixture_set": fixture_set}


class LinkedWorktreeFixtureGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_env = {key: os.environ.get(key) for key in ("ARIA_TOOLS_DIR", "ARIA_REPO_ROOT")}
        os.environ.pop("ARIA_REPO_ROOT", None)
        os.environ.pop("ARIA_TOOLS_DIR", None)
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-098-wt-"))
        self.main = make_repo_with_initial_commit(
            self.tmp, {"tools/aria-adapters/fixtures/x-adapter/cases/clean.json": "{}\n"}, name="main",
        )
        # The trial-eleven shape: the kernel's workspace is a LINKED worktree.
        self.linked = make_git_worktree(self.main, self.tmp / "linked", branch="lane-098")
        self.assertTrue((self.linked / ".git").is_file(), "git worktree add writes a pointer FILE")
        # The state store nested inside it, as the nightly and the trial lay
        # it out: a second linked worktree carrying the kernel's GENESIS
        # record, with the tools root two levels below the checkout.
        self.store = make_git_worktree(self.main, self.linked / ".aria-state-store", branch="state-098")
        (self.store / GENESIS_FILENAME).write_text(
            json.dumps({"$schema": "aria/state-genesis/v1", "branch": "aria/state"}) + "\n",
            encoding="utf-8",
        )
        self.tools = ensure_tools_dir(self.store / "tools")
        self._saved_cwd = os.getcwd()
        self.neutral_cwd = Path(tempfile.mkdtemp(prefix="aria-098-cwd-"))
        os.chdir(self.neutral_cwd)

    def tearDown(self) -> None:
        os.chdir(self._saved_cwd)
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        # Worktrees are unregistered before the tree goes so the main
        # repository's metadata does not outlive its fixtures.
        subprocess.run(["git", "worktree", "prune"], cwd=self.main, check=False, capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)
        shutil.rmtree(self.neutral_cwd, ignore_errors=True)

    def test_a_gitdir_pointer_file_marks_a_checkout_root(self) -> None:
        self.assertIsNotNone(read_gitdir_pointer(self.linked / ".git"))
        self.assertTrue(is_checkout_root(self.linked))
        self.assertTrue(is_checkout_root(self.main), "a .git directory still counts")
        self.assertFalse(is_checkout_root(self.linked / "tools"))

    def test_the_state_store_is_recognised_by_its_genesis_record_not_its_git_shape(self) -> None:
        self.assertTrue(is_checkout_root(self.store), "the store IS a worktree")
        self.assertTrue(is_state_store_worktree(self.store))
        self.assertFalse(is_state_store_worktree(self.linked))

    def test_discovery_from_the_nested_store_lands_on_the_linked_checkout(self) -> None:
        # Pre-fix: pointer files skipped → None → tools_root.parent (the store).
        self.assertEqual(discover_checkout_root(self.tools), self.linked.resolve())
        self.assertEqual(_repo_root_for_path_guard(self.tools), self.linked.resolve())

    def test_discovery_inside_a_lane_worktree_never_climbs_to_the_enclosing_checkout(self) -> None:
        # A worktree checked out UNDER the main checkout (the repo's
        # .worktrees/<lane> convention) owns its own fixture corpus; the
        # enclosing main checkout is a different tree.
        nested = make_git_worktree(self.main, self.main / ".worktrees" / "lane", branch="nested-lane")
        self.assertEqual(discover_checkout_root(nested / "aria-tools"), nested.resolve())

    def test_a_repo_relative_fixture_path_inside_the_linked_worktree_is_inside_the_repo(self) -> None:
        resolved = resolve_fixture_dir(_tool("tools/aria-adapters/fixtures/x-adapter"), self.tools)
        self.assertEqual(
            resolved, (self.linked / "tools" / "aria-adapters" / "fixtures" / "x-adapter").resolve(),
        )

    def test_a_path_outside_the_checkout_still_escapes(self) -> None:
        with self.assertRaises(GovernanceError) as caught:
            resolve_fixture_dir(_tool("../../etc/passwd"), self.tools)
        self.assertIn("fixture_path_escape_outside_repo", str(caught.exception))

    def _declare_binding(self, bound_repo_root: Path) -> None:
        (self.tools / "repo_identity.json").write_text(
            json.dumps({"schema_version": 3, "bound_repo_root": str(bound_repo_root)}) + "\n",
            encoding="utf-8",
        )

    def test_a_stale_binding_of_the_same_repository_does_not_outrank_the_enclosing_worktree(self) -> None:
        # ``ensure_tools_binding`` writes ``bound_repo_root`` on the FIRST bind
        # only, and every worktree of one repository binds identically, so a
        # store carried from the main checkout into this linked worktree still
        # declares the main checkout. Readers with no ``workspace_root`` in
        # hand (``readiness``, ``promotion``) must hash THIS worktree's fixture
        # corpus — the one the registry was synced from — not the corpus of
        # the checkout the store was born in.
        self._declare_binding(self.main)
        self.assertEqual(_repo_root_for_path_guard(self.tools), self.linked.resolve())
        resolved = resolve_fixture_dir(_tool("tools/aria-adapters/fixtures/x-adapter"), self.tools)
        self.assertEqual(
            resolved, (self.linked / "tools" / "aria-adapters" / "fixtures" / "x-adapter").resolve(),
        )

    def test_a_binding_to_another_repository_outranks_a_checkout_that_merely_encloses_the_store(self) -> None:
        # A store kept under some OTHER git-tracked tree (a home directory in
        # git, a parent monorepo) serves the repository its binding names,
        # not the tree that happens to enclose it.
        elsewhere = make_repo_with_initial_commit(self.tmp, {"README": "x\n"}, name="elsewhere")
        self._declare_binding(elsewhere)
        self.assertEqual(_repo_root_for_path_guard(self.tools), elsewhere.resolve())

    def test_a_store_outside_every_checkout_is_anchored_by_its_binding(self) -> None:
        # The trial-eight layout: ``trial/store/tools`` with nothing git-shaped
        # above it. Discovery has no answer; the binding is the whole one.
        outside = ensure_tools_dir(self.tmp / "loose" / "store" / "tools")
        self.assertIsNone(discover_checkout_root(outside))
        (outside / "repo_identity.json").write_text(
            json.dumps({"schema_version": 3, "bound_repo_root": str(self.linked)}) + "\n",
            encoding="utf-8",
        )
        self.assertEqual(_repo_root_for_path_guard(outside), self.linked.resolve())

    def test_same_repository_is_the_shared_common_directory(self) -> None:
        self.assertTrue(same_repository(self.linked, self.main))
        self.assertTrue(same_repository(self.main, self.linked))
        elsewhere = make_repo_with_initial_commit(self.tmp, {"README": "x\n"}, name="elsewhere")
        self.assertFalse(same_repository(self.linked, elsewhere))
        self.assertFalse(same_repository(self.linked, self.tmp / "not-a-checkout"))
        self.assertFalse(same_repository(self.tmp / "not-a-checkout", self.linked))

    def test_an_explicit_workspace_root_outranks_the_binding(self) -> None:
        self._declare_binding(self.main)
        self.assertEqual(
            _repo_root_for_path_guard(self.tools, workspace_root=self.linked), self.linked.resolve(),
        )


if __name__ == "__main__":
    unittest.main()
