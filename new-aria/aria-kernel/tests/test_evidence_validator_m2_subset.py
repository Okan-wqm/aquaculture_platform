"""Plan 022 M-2 — evidence_validator read_paths subset enforcement.

Pre-Plan-022 a tool could report read_paths=['a.ts'] but emit
findings citing evidence in 'b.ts' that wasn't in read_paths. The
dispatch path trusted the self-report list without verifying that
finding evidence stayed inside it.

Fix: validate_tool_output_evidence collects declared_read_paths and
emits an 'evidence_outside_declared_read_paths' error for any
finding-evidence or evidence_sources entry outside the set.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.evidence_validator import validate_tool_output_evidence


def _tool() -> dict:
    return {
        "tool_id": "fake",
        "kind": "adapter",
        "version": "0.1.0",
        "status": "SHADOW",
        "declared_scope": ["**/*.ts"],
        "allowed_read_globs": ["**/*.ts"],
        "forbidden_read_globs": [".git/**"],
    }


class EvidenceReadPathsSubsetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(tempfile.mkdtemp(prefix="aria-m2-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_evidence_path_inside_read_paths_passes(self) -> None:
        # Create file the tool will reference.
        (self.repo / "a.ts").write_text("const x = 1;\n", encoding="utf-8")
        output = {
            "observations": [],
            "findings": [
                {"id": "f1", "evidence": [{"path": "a.ts", "line": 1}]},
            ],
            "read_paths": ["a.ts"],
            "evidence_sources": ["a.ts"],
        }
        result = validate_tool_output_evidence(_tool(), output, self.repo)
        # No 'evidence_outside_declared_read_paths' code should appear.
        codes = [e.get("code") for e in result["errors"]]
        self.assertNotIn("evidence_outside_declared_read_paths", codes)

    def test_evidence_path_outside_read_paths_rejected(self) -> None:
        (self.repo / "a.ts").write_text("const x = 1;\n", encoding="utf-8")
        (self.repo / "b.ts").write_text("const y = 2;\n", encoding="utf-8")
        output = {
            "observations": [],
            "findings": [
                # Tool declared reading a.ts but cites b.ts in evidence.
                {"id": "f1", "evidence": [{"path": "b.ts", "line": 1}]},
            ],
            "read_paths": ["a.ts"],
            "evidence_sources": ["a.ts"],
        }
        result = validate_tool_output_evidence(_tool(), output, self.repo)
        codes = [e.get("code") for e in result["errors"]]
        self.assertIn("evidence_outside_declared_read_paths", codes)
        # Error includes path + finding_id for triage.
        bad = [e for e in result["errors"] if e.get("code") == "evidence_outside_declared_read_paths"]
        self.assertTrue(any(e.get("path") == "b.ts" for e in bad))

    def test_evidence_sources_outside_read_paths_rejected(self) -> None:
        (self.repo / "a.ts").write_text("const x = 1;\n", encoding="utf-8")
        output = {
            "observations": [],
            "findings": [],
            "read_paths": ["a.ts"],
            "evidence_sources": ["c.ts"],  # NOT in read_paths
        }
        result = validate_tool_output_evidence(_tool(), output, self.repo)
        codes = [e.get("code") for e in result["errors"]]
        self.assertIn("evidence_outside_declared_read_paths", codes)

    def test_committed_snapshot_rejects_worktree_candidate_evidence(self) -> None:
        self.init_git()
        (self.repo / "a.ts").write_text("const x = 1;\n", encoding="utf-8")
        subprocess.run(["git", "add", "a.ts"], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=self.repo, check=True)
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.repo, text=True).strip()
        (self.repo / "a.ts").write_text("const x = 2;\n", encoding="utf-8")

        result = validate_tool_output_evidence(
            _tool(),
            {
                "observations": [],
                "findings": [{"id": "f1", "evidence": [{"path": "a.ts", "line": 1}]}],
                "read_paths": ["a.ts"],
                "evidence_sources": ["a.ts"],
            },
            self.repo,
            repo_snapshot={
                "snapshot_mode": "committed",
                "base_commit_sha": head,
                "allowed_paths": ["a.ts"],
            },
        )

        codes = [e.get("code") for e in result["errors"]]
        self.assertIn("tool_output_evidence_not_repo_verified", codes)

    def test_working_tree_snapshot_keeps_candidate_evidence_advisory(self) -> None:
        self.init_git()
        (self.repo / "a.ts").write_text("const x = 1;\n", encoding="utf-8")
        subprocess.run(["git", "add", "a.ts"], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=self.repo, check=True)
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.repo, text=True).strip()
        (self.repo / "a.ts").write_text("const x = 2;\n", encoding="utf-8")

        result = validate_tool_output_evidence(
            _tool(),
            {
                "observations": [],
                "findings": [{"id": "f1", "evidence": [{"path": "a.ts", "line": 1}]}],
                "read_paths": ["a.ts"],
                "evidence_sources": ["a.ts"],
            },
            self.repo,
            repo_snapshot={
                "snapshot_mode": "working_tree",
                "base_commit_sha": head,
                "dirty_snapshot": True,
                "allowed_paths": ["a.ts"],
            },
        )

        self.assertTrue(result["valid"], f"errors: {result['errors']!r}")
        grades = {row.get("trust_grade") for row in result["evidence_envelopes"]}
        self.assertIn("worktree_candidate", grades)

    def init_git(self) -> None:
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.name", "Test User"], cwd=self.repo, check=True)


if __name__ == "__main__":
    unittest.main()
