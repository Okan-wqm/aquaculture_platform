"""ARIA-HIGH-065 — the suite establishes its own isolation; the caller cannot break it.

What this pins, one property per test:

* An inherited ``ARIA_REPO_STATE_ROOT`` is UNBOUND at package import, and the
  bootstrap says so on stderr. A fixed root makes every fixture repository
  share one ``aria-findings/`` history, so a finding emitted by one test is
  replayed by the next as a malformed prefix (``F-901 ... before its
  finding_emitted row``). On 2026-09-11 a publication push exported exactly
  that for the pre-push gate and reported 41 errors on a commit CI had already
  passed. Unbound rather than refused because the restore-aria-state action
  exports the durable store's binding into the whole job and an in-cycle
  self-validation of this suite inherits it: refusing would fail every kernel
  self-change, honouring it would write fixture findings into the store.
* With ``ARIA_REPO_STATE_ROOT`` unset, two fixture repositories resolve to two
  state roots — the property the unbinding exists to restore.
* ``ARIA_WORKSPACE_BASE`` defaults to a session temp directory, so
  ``workspace_paths`` never falls back to ``~/.aria/workspaces``. 4,927 fixture
  workspaces (each recording a ``/tmp`` repo_root) had accumulated there.
* An explicit ``ARIA_WORKSPACE_BASE`` is honoured, not overwritten: CI lanes
  that point the suite at a restore-action store keep working.
* ``ARIA_TOOLS_DIR`` keeps its ORPHAN-MEDIUM-767 contract (real mirror refused,
  temp default) — the same owner, pinned here because nothing pinned it.

The subprocess tests run ``import tests`` in a fresh interpreter because the
bootstrap executes once per process; asserting on THIS process would only
observe whatever state the suite runner happened to start with.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel.workspace import repo_state_root, workspace_paths

ARIA_KERNEL_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = ARIA_KERNEL_DIR.parent


def _import_tests_in_fresh_interpreter(
    env_overrides: dict[str, str | None],
) -> subprocess.CompletedProcess[str]:
    """``import tests`` in a child, then print the variables the bootstrap owns."""
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("ARIA_")
    }
    env["PYTHONPATH"] = f"{ARIA_KERNEL_DIR}{os.pathsep}{REPO_ROOT}"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    for key, value in env_overrides.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    # The bootstrap's scratch roots live exactly as long as the child
    # process (ARIA-LOW-116: removed at interpreter exit), so whether the
    # bound base EXISTS is answered inside the child, before it exits.
    probe = (
        "import json, os\n"
        "import tests\n"
        "print(json.dumps({**{k: os.environ.get(k) for k in "
        "('ARIA_REPO_STATE_ROOT', 'ARIA_WORKSPACE_BASE', 'ARIA_TOOLS_DIR')}, "
        "'workspace_base_is_dir': os.path.isdir(os.environ.get('ARIA_WORKSPACE_BASE') or '')}))\n"
    )
    return subprocess.run(
        [sys.executable, "-c", probe],
        cwd=ARIA_KERNEL_DIR,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )


class InheritedStateRootIsUnbound(unittest.TestCase):
    def test_an_inherited_repo_state_root_is_unbound_and_announced(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            shared = str(Path(tmp) / "shared-root")
            result = _import_tests_in_fresh_interpreter({"ARIA_REPO_STATE_ROOT": shared})
        self.assertEqual(result.returncode, 0, result.stderr)
        seen = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertIsNone(seen["ARIA_REPO_STATE_ROOT"], "the suite must not keep a shared root")
        self.assertIn(shared, result.stderr, "the unbound value must be named, not scrubbed silently")
        self.assertIn("finding_emitted", result.stderr)
        self.assertIn("ARIA-HIGH-065", result.stderr)

    def test_an_absent_repo_state_root_is_not_announced(self) -> None:
        result = _import_tests_in_fresh_interpreter({"ARIA_REPO_STATE_ROOT": None})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("ARIA_REPO_STATE_ROOT", result.stderr)

    def test_two_fixture_repositories_have_two_state_roots_when_unset(self) -> None:
        self.assertIsNone(
            os.environ.get("ARIA_REPO_STATE_ROOT"),
            "the bootstrap must have left the variable unset in the suite process",
        )
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            self.assertNotEqual(
                repo_state_root(Path(first)),
                repo_state_root(Path(second)),
                "with no shared root, each fixture repo is its own state root",
            )
            self.assertEqual(repo_state_root(Path(first)), Path(first))


class WorkspaceBaseIsIsolatedByDefault(unittest.TestCase):
    def test_an_unset_workspace_base_defaults_to_a_session_temp_dir(self) -> None:
        result = _import_tests_in_fresh_interpreter({"ARIA_WORKSPACE_BASE": None})
        self.assertEqual(result.returncode, 0, result.stderr)
        seen = json.loads(result.stdout.strip().splitlines()[-1])
        base = seen["ARIA_WORKSPACE_BASE"]
        self.assertTrue(base, "bootstrap must bind a workspace base")
        self.assertTrue(seen["workspace_base_is_dir"], "the bound base exists while the child runs")
        self.assertFalse(Path(base).is_dir(), "and is removed when the child exits (ARIA-LOW-116)")
        self.assertNotIn(
            str(Path.home() / ".aria"), base,
            "the default must not be the operator's ~/.aria tree",
        )

    def test_an_explicit_workspace_base_is_honoured(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = _import_tests_in_fresh_interpreter({"ARIA_WORKSPACE_BASE": tmp})
            self.assertEqual(result.returncode, 0, result.stderr)
            seen = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertEqual(seen["ARIA_WORKSPACE_BASE"], tmp)

    def test_this_suite_never_resolves_a_workspace_under_the_home_tree(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            paths = workspace_paths(Path(repo))
        home_tree = (Path.home() / ".aria").resolve()
        self.assertFalse(
            paths.workspace_root.is_relative_to(home_tree),
            f"{paths.workspace_root} resolved under {home_tree}",
        )


class ToolsDirContractIsPinned(unittest.TestCase):
    def test_the_real_tools_mirror_is_refused(self) -> None:
        result = _import_tests_in_fresh_interpreter(
            {"ARIA_TOOLS_DIR": str(REPO_ROOT / "aria-tools")},
        )
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("ORPHAN-MEDIUM-767", result.stderr)

    def test_an_unset_tools_dir_defaults_to_a_temp_dir(self) -> None:
        result = _import_tests_in_fresh_interpreter({"ARIA_TOOLS_DIR": None})
        self.assertEqual(result.returncode, 0, result.stderr)
        seen = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertTrue(seen["ARIA_TOOLS_DIR"])
        self.assertNotEqual(Path(seen["ARIA_TOOLS_DIR"]).resolve(), (REPO_ROOT / "aria-tools").resolve())


if __name__ == "__main__":
    unittest.main()
