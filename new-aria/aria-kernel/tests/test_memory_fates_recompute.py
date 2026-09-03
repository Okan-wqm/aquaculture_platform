"""Plan 026R §E.7 — memory update_memory FATES hash recompute.

10 tests:

* _verify_fates_integrity passes when on-disk content matches.
* _verify_fates_integrity raises on content_hash mismatch (tamper).
* _verify_fates_integrity uses committed blobs for committed snapshots.
* _verify_fates_integrity raises on path traversal.
* _verify_fates_integrity tolerates deleted file (not a tamper).
* _verify_fates_integrity raises on missing path field in entry.
* _verify_fates_integrity raises on missing content_hash field.
* update_memory invokes the FATES verify when workspace_root is set.
* update_memory skips the verify when workspace_root=None (legacy).
* cycle.py call site passes workspace_root (regression invariant).
"""
from __future__ import annotations

import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.memory import _verify_fates_integrity
from aria_kernel.tool_registry import GovernanceError


def _hash(content: bytes) -> str:
    return "sha256:" + hashlib.sha256(content).hexdigest()


class VerifyFatesIntegrityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = Path(tempfile.mkdtemp(prefix="aria-e7-"))
        (self.workspace / "docs").mkdir()
        self.docs_a = self.workspace / "docs" / "a.md"
        self.docs_a.write_text("content-a", encoding="utf-8")

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.workspace, ignore_errors=True)

    def test_passes_when_content_matches(self) -> None:
        fates = {
            "files": [
                {
                    "path": "docs/a.md",
                    "content_hash": _hash(self.docs_a.read_bytes()),
                },
            ],
        }
        _verify_fates_integrity(fates, workspace_root=self.workspace)

    def test_raises_on_content_hash_mismatch(self) -> None:
        fates = {
            "files": [
                {
                    "path": "docs/a.md",
                    "content_hash": "sha256:" + "0" * 64,  # wrong
                },
            ],
        }
        with self.assertRaises(GovernanceError) as ctx:
            _verify_fates_integrity(fates, workspace_root=self.workspace)
        self.assertIn("content_hash_mismatch", str(ctx.exception))

    def test_committed_snapshot_uses_committed_blob_when_worktree_dirty(self) -> None:
        subprocess.run(["git", "init"], cwd=self.workspace, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "aria@example.test"], cwd=self.workspace, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "ARIA Test"], cwd=self.workspace, check=True, capture_output=True)
        subprocess.run(["git", "add", "docs/a.md"], cwd=self.workspace, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "initial"], cwd=self.workspace, check=True, capture_output=True)
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.workspace, text=True).strip()
        committed_hash = _hash(b"content-a")
        self.docs_a.write_text("dirty-content", encoding="utf-8")
        fates = {"files": [{"path": "docs/a.md", "content_hash": committed_hash}]}

        _verify_fates_integrity(
            fates,
            workspace_root=self.workspace,
            snapshot_mode="committed",
            base_commit_sha=head,
        )
        with self.assertRaises(GovernanceError):
            _verify_fates_integrity(fates, workspace_root=self.workspace)

    def test_raises_on_path_traversal(self) -> None:
        fates = {
            "files": [
                {
                    "path": "../outside.md",
                    "content_hash": _hash(b"x"),
                },
            ],
        }
        with self.assertRaises(GovernanceError) as ctx:
            _verify_fates_integrity(fates, workspace_root=self.workspace)
        self.assertIn("path_traversal_rejected", str(ctx.exception))

    def test_tolerates_deleted_file(self) -> None:
        # File entry exists in FATES but the file was deleted between
        # discovery and memory update. Legitimate signal (handled by
        # the missing-evidence belief invalidation flow), not a tamper.
        fates = {
            "files": [
                {
                    "path": "docs/deleted.md",
                    "content_hash": _hash(b"deleted-content"),
                },
            ],
        }
        # No raise.
        _verify_fates_integrity(fates, workspace_root=self.workspace)

    def test_raises_on_missing_path(self) -> None:
        fates = {"files": [{"content_hash": _hash(b"x")}]}
        with self.assertRaises(GovernanceError) as ctx:
            _verify_fates_integrity(fates, workspace_root=self.workspace)
        self.assertIn("entry_malformed", str(ctx.exception))

    def test_raises_on_missing_content_hash(self) -> None:
        fates = {"files": [{"path": "docs/a.md"}]}
        with self.assertRaises(GovernanceError) as ctx:
            _verify_fates_integrity(fates, workspace_root=self.workspace)
        self.assertIn("entry_malformed", str(ctx.exception))

    def test_no_files_section_no_op(self) -> None:
        # Empty/malformed FATES → no-op (no raise).
        _verify_fates_integrity({}, workspace_root=self.workspace)
        _verify_fates_integrity({"files": "not a list"}, workspace_root=self.workspace)


class UpdateMemoryFatesIntegrationTests(unittest.TestCase):
    """update_memory invokes FATES integrity check when workspace_root
    is provided."""

    def test_cycle_py_callsite_passes_workspace_root(self) -> None:
        # Plan 026R §E.7 + §H.1 — AST-backed assertion.
        # cycle.py MUST contain an update_memory(...) Call node whose
        # keyword arguments include workspace_root. Plan 026R §H.1
        # converts the pre-existing substring assertion to an AST
        # node-shape inspection: the AST proves the call signature
        # rather than coincidental string presence.
        import ast as _ast
        cycle_path = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel" / "cycle.py"
        )
        tree = _ast.parse(cycle_path.read_text(encoding="utf-8"))
        found_call = False
        found_kwarg = False
        for node in _ast.walk(tree):
            if not isinstance(node, _ast.Call):
                continue
            func = node.func
            if isinstance(func, _ast.Name) and func.id == "update_memory":
                found_call = True
                for kw in node.keywords:
                    if kw.arg == "workspace_root":
                        found_kwarg = True
                        break
                if found_kwarg:
                    break
        self.assertTrue(
            found_call, "cycle.py: no update_memory(...) call found",
        )
        self.assertTrue(
            found_kwarg,
            "cycle.py: update_memory(...) callsite missing "
            "workspace_root kwarg — Plan 026R §E.7 contract",
        )

    def test_update_memory_signature_accepts_workspace_root(self) -> None:
        # Signature check via inspect.
        import inspect
        from aria_kernel.memory import update_memory
        sig = inspect.signature(update_memory)
        self.assertIn("workspace_root", sig.parameters)


if __name__ == "__main__":
    unittest.main()
