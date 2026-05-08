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


if __name__ == "__main__":
    unittest.main()
