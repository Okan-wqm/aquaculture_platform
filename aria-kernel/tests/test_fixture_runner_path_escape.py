"""Plan 023 v3 §A-2 — fixture runner path traversal guard.

Pre-Plan-023 fixture_runner.resolve_fixture_dir reads
`Path(tool["fixture_set"])` and returns it if it exists, else
`base_dir / fixture_set`, else `base_dir / 'fixtures' / fixture_set.name`,
else the candidate. No `relative_to(repo_root)` guard. A tool
definition with `fixture_set: '../../etc/passwd'` resolves OUTSIDE the
repo and the fixture loader proceeds.

Same gap on resolve_case_workspace — case.workspace_root could escape
the repo via `../../../`.

Plan 023 v3 §A-2: enforce `result.resolve().relative_to(repo_root.
resolve())` on both helpers. Path escape → GovernanceError(
'fixture_path_escape_outside_repo: <path>').
"""
from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.fixture_runner import resolve_case_workspace, resolve_fixture_dir
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class FixturePathEscapeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-a2-"))
        self.base = self.tmp / "aria-tools"
        ensure_tools_dir(self.base)
        # repo_root for relative_to() guard purposes is the tmp parent.
        self.repo_root = self.tmp
        # Save + clear the env var that ensure_tools_dir reads.
        self._saved_aria_tools_dir = os.environ.get("ARIA_TOOLS_DIR")
        os.environ["ARIA_TOOLS_DIR"] = str(self.base)
        # Plan 023 v3 §A-2 — opt the helpers into the new path-escape
        # guard via the ARIA_REPO_ROOT env var when set. (The helper
        # falls back to base_dir.parent.parent when unset.)
        os.environ["ARIA_REPO_ROOT"] = str(self.repo_root)

    def tearDown(self) -> None:
        if self._saved_aria_tools_dir is None:
            os.environ.pop("ARIA_TOOLS_DIR", None)
        else:
            os.environ["ARIA_TOOLS_DIR"] = self._saved_aria_tools_dir
        os.environ.pop("ARIA_REPO_ROOT", None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_in_repo_relative_fixture_set_passes(self) -> None:
        """Baseline: a normal in-repo relative path resolves inside
        repo_root and produces a valid fixture_dir."""
        # Create the fixture dir so fixture_set.exists() short-circuits.
        in_repo = self.repo_root / "tools" / "aria-poc" / "fixtures" / "alpha"
        in_repo.mkdir(parents=True)
        tool = {"fixture_set": str(in_repo)}
        result = resolve_fixture_dir(tool, self.base)
        self.assertEqual(result.resolve(), in_repo.resolve())

    def test_relative_traversal_path_rejects(self) -> None:
        """Plan 023 v3 §A-2: '../../etc/passwd' resolves outside repo →
        rejected."""
        tool = {"fixture_set": "../../etc/passwd"}
        with self.assertRaises(GovernanceError) as ctx:
            resolve_fixture_dir(tool, self.base)
        self.assertIn("fixture_path_escape_outside_repo", str(ctx.exception))

    def test_absolute_outside_repo_rejects(self) -> None:
        """Plan 023 v3 §A-2: absolute path outside repo_root → reject."""
        tool = {"fixture_set": "/etc/passwd"}
        with self.assertRaises(GovernanceError) as ctx:
            resolve_fixture_dir(tool, self.base)
        self.assertIn("fixture_path_escape_outside_repo", str(ctx.exception))

    def test_case_workspace_outside_repo_rejects(self) -> None:
        """Plan 023 v3 §A-2: case.workspace_root traversal → reject."""
        fixture_dir = self.repo_root / "fixtures"
        fixture_dir.mkdir()
        case = {"workspace_root": "../../../etc"}
        with self.assertRaises(GovernanceError) as ctx:
            resolve_case_workspace(
                case, fixture_dir, default_workspace_root=str(self.repo_root),
            )
        self.assertIn("fixture_path_escape_outside_repo", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
