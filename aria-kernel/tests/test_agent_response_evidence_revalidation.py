"""Tests for the Plan 016 Faz C7 agent response evidence revalidation (V-24)."""
from __future__ import annotations

import tempfile
import subprocess
import unittest
from pathlib import Path

from aria_kernel.evidence_validator import validate_agent_response_evidence


class AgentResponseEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        # Seed two files an agent might cite.
        (self.repo / "src.txt").write_text("line1\nline2\nline3\n", encoding="utf-8")
        (self.repo / "deep").mkdir()
        (self.repo / "deep" / "nested.ts").write_text("a\nb\nc\nd\ne\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.email", "aria-test@example.invalid"], cwd=self.repo, check=True)
        subprocess.run(["git", "config", "user.name", "ARIA Test"], cwd=self.repo, check=True)
        subprocess.run(["git", "add", "src.txt", "deep/nested.ts"], cwd=self.repo, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "fixture: evidence"], cwd=self.repo, check=True)
        self.target_sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=self.repo,
            text=True,
        ).strip()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_valid_refs_pass(self) -> None:
        response = {
            "evidence_refs": ["src.txt:2", "deep/nested.ts:5"],
            "satisfaction_matrix": [
                {"id": "MS-1", "verdict": "satisfied"},
            ],
        }
        result = validate_agent_response_evidence(
            response=response,
            workspace_root=self.repo,
            request={"target_sha": self.target_sha, "allowed_scope": ["**"]},
        )
        self.assertTrue(result["valid"], result)
        self.assertEqual(
            result["checked_refs"], ["deep/nested.ts", "src.txt"]
        )

    def test_missing_path_rejected(self) -> None:
        response = {"evidence_refs": ["does/not/exist.ts:1"], "satisfaction_matrix": []}
        result = validate_agent_response_evidence(
            response=response, workspace_root=self.repo
        )
        self.assertFalse(result["valid"])
        codes = {e["code"] for e in result["errors"]}
        self.assertIn("agent_evidence_path_missing", codes)

    def test_line_beyond_eof_rejected(self) -> None:
        response = {"evidence_refs": ["src.txt:99"], "satisfaction_matrix": []}
        result = validate_agent_response_evidence(
            response=response, workspace_root=self.repo
        )
        self.assertFalse(result["valid"])
        codes = {e["code"] for e in result["errors"]}
        self.assertIn("agent_evidence_line_missing", codes)

    def test_path_escape_rejected(self) -> None:
        response = {"evidence_refs": ["../etc/passwd:1"], "satisfaction_matrix": []}
        result = validate_agent_response_evidence(
            response=response, workspace_root=self.repo
        )
        self.assertFalse(result["valid"])
        codes = {e["code"] for e in result["errors"]}
        # Either escape or missing is acceptable depending on resolution
        self.assertTrue(
            "agent_evidence_path_escapes_workspace" in codes
            or "agent_evidence_path_missing" in codes
        )

    def test_self_output_evidence_rejected(self) -> None:
        # An agent citing aria-tools/ as evidence is a hard reject.
        (self.repo / "aria-tools").mkdir(exist_ok=True)
        (self.repo / "aria-tools" / "report.md").write_text("# report\n", encoding="utf-8")
        response = {"evidence_refs": ["aria-tools/report.md:1"], "satisfaction_matrix": []}
        result = validate_agent_response_evidence(
            response=response, workspace_root=self.repo
        )
        self.assertFalse(result["valid"])
        codes = {e["code"] for e in result["errors"]}
        self.assertIn("agent_evidence_self_output", codes)

    def test_satisfaction_matrix_evidence_revalidated(self) -> None:
        response = {
            "evidence_refs": [],
            "satisfaction_matrix": [
                {
                    "id": "MS-1",
                    "verdict": "blocked",
                    "note": "evidence pointed at unreachable path",
                    "evidence_refs": ["does/not/exist.ts:1"],
                }
            ],
        }
        result = validate_agent_response_evidence(
            response=response, workspace_root=self.repo
        )
        self.assertFalse(result["valid"])
        codes = {e["code"] for e in result["errors"]}
        self.assertIn("agent_evidence_path_missing", codes)

    def test_malformed_ref_string_rejected(self) -> None:
        response = {
            "evidence_refs": ["", "  ", 42],
            "satisfaction_matrix": [],
        }
        result = validate_agent_response_evidence(
            response=response, workspace_root=self.repo
        )
        self.assertFalse(result["valid"])

    def test_request_scope_constraint_rejects_outside_paths(self) -> None:
        # Agent cites a real file that is OUTSIDE the request's allowed_scope.
        (self.repo / "off_scope.ts").write_text("a\n", encoding="utf-8")
        response = {
            "evidence_refs": ["off_scope.ts:1"],
            "satisfaction_matrix": [],
        }
        request = {
            "allowed_scope": ["deep/**"],
            "evidence_refs": ["deep/nested.ts:1"],
        }
        result = validate_agent_response_evidence(
            response=response, workspace_root=self.repo, request=request
        )
        self.assertFalse(result["valid"])
        codes = {e["code"] for e in result["errors"]}
        self.assertIn("agent_evidence_outside_allowed_scope", codes)

    def test_request_scope_accepts_paths_inside_allowed_glob(self) -> None:
        # Plan 024 §B-2 — the focus of this test is scope-glob acceptance,
        # not the satisfaction matrix shape. The pre-fix evidence_validator
        # silently accepted satisfaction_matrix=[] which combined with the
        # empty-allowed_scope skip masked the same gap. Now the test
        # carries either a non-empty matrix matching the criterion OR
        # the explicit allow_empty_satisfaction_matrix opt-in. Picking the
        # latter keeps the test focused on glob matching only.
        response = {
            "evidence_refs": ["deep/nested.ts:3"],
            "satisfaction_matrix": [],
        }
        request = {
            "allowed_scope": ["deep/**"],
            "evidence_refs": [],
            "allow_empty_satisfaction_matrix": True,
            "target_sha": self.target_sha,
        }
        result = validate_agent_response_evidence(
            response=response, workspace_root=self.repo, request=request
        )
        self.assertTrue(result["valid"], result)


if __name__ == "__main__":
    unittest.main()
