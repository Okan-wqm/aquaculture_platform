"""Plan 022 C-3 — ensure_tools_binding fail-closed on repo hash mismatch."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.tool_registry import (
    GovernanceError,
    ensure_tools_binding,
    ensure_tools_dir,
)
from aria_kernel.workspace import repo_hash


def _make_repo(tmp: Path, *, name: str) -> Path:
    repo = tmp / name
    repo.mkdir()
    (repo / "README.md").write_text(f"# {name}\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@t.invalid"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", f"init {name}"], cwd=repo, check=True, capture_output=True)
    return repo


class EnsureToolsBindingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-binding-c3-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_bind_to_first_repo_succeeds(self) -> None:
        repo_a = _make_repo(self.tmp, name="repo_a")
        tools = self.tmp / "aria-tools"
        ensure_tools_dir(tools)
        result = ensure_tools_binding(tools, workspace_root=repo_a)
        self.assertEqual(result, tools)
        identity = json.loads((tools / "repo_identity.json").read_text())
        self.assertEqual(identity["bound_repo_hash"], repo_hash(repo_a))

    def test_re_bind_same_repo_idempotent(self) -> None:
        repo_a = _make_repo(self.tmp, name="repo_a")
        tools = self.tmp / "aria-tools"
        ensure_tools_dir(tools)
        ensure_tools_binding(tools, workspace_root=repo_a)
        # Re-binding to the same repo is a no-op (no error).
        result = ensure_tools_binding(tools, workspace_root=repo_a)
        self.assertEqual(result, tools)

    def test_cross_repo_re_bind_rejected(self) -> None:
        repo_a = _make_repo(self.tmp, name="repo_a")
        repo_b = _make_repo(self.tmp, name="repo_b")
        tools = self.tmp / "aria-tools"
        ensure_tools_dir(tools)
        ensure_tools_binding(tools, workspace_root=repo_a)
        # Plan ARIA-V2 §3.2 (formerly Plan 022 C-3): binding to a
        # different repo MUST raise. v3 renamed the error code from
        # ``tools_root_repo_hash_mismatch`` to ``tools_root_canonical_identity_mismatch``
        # because the underlying identity is now canonical (path-
        # independent) rather than env-bound. Plan ARIA-V2 §3.2 locks
        # this rename via the v3 schema bump.
        with self.assertRaises(GovernanceError) as cm:
            ensure_tools_binding(tools, workspace_root=repo_b)
        self.assertIn("tools_root_canonical_identity_mismatch", str(cm.exception))
        # Error includes both bound and current hashes for operator triage.
        self.assertIn(repo_hash(repo_a), str(cm.exception))
        self.assertIn(repo_hash(repo_b), str(cm.exception))


if __name__ == "__main__":
    unittest.main()
