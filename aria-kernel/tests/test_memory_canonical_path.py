"""Plan 026R §E.5 — memory canonical-path resolver via evidence_validator.

6 tests:

* Legacy path (workspace_root=None) preserves the original
  lexical-prefix block on aria-tools/.
* Canonical resolver rejects path traversal that would otherwise
  reach aria-tools via lexical-only normalisation.
* Canonical resolver rejects an absolute path outside the workspace.
* Canonical resolver allows a normal docs/ path.
* SELF_OUTPUT_PREFIXES extended (E.8): aria-findings rejected.
* SELF_OUTPUT_PREFIXES extended (E.8): aria-debts rejected.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.memory import SELF_OUTPUT_PREFIXES, validate_repo_evidence
from aria_kernel.tool_registry import GovernanceError


class MemoryCanonicalPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = Path(tempfile.mkdtemp(prefix="aria-e5-"))
        # Create directory structure for the canonical resolver to work.
        (self.workspace / "docs").mkdir()
        (self.workspace / "docs" / "ok.md").write_text("ok", encoding="utf-8")
        (self.workspace / "aria-tools").mkdir()
        (self.workspace / "aria-tools" / "secret.json").write_text("{}", encoding="utf-8")
        (self.workspace / "aria-findings").mkdir()
        (self.workspace / "aria-findings" / "F-001.json").write_text("{}", encoding="utf-8")
        (self.workspace / "aria-debts").mkdir()
        (self.workspace / "aria-debts" / "DEBT-001.json").write_text("{}", encoding="utf-8")

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.workspace, ignore_errors=True)

    def test_legacy_lexical_path_blocks_aria_tools(self) -> None:
        with self.assertRaises(GovernanceError):
            validate_repo_evidence(["aria-tools/secret.json"])

    def test_canonical_resolver_blocks_traversal(self) -> None:
        # docs/../aria-tools/secret.json lexically starts with docs/ —
        # the lexical check WOULD let it through. The canonical
        # resolver collapses the traversal and detects the SELF_OUTPUT
        # prefix.
        with self.assertRaises(GovernanceError) as ctx:
            validate_repo_evidence(
                ["docs/../aria-tools/secret.json"],
                workspace_root=self.workspace,
            )
        self.assertIn("self-output", str(ctx.exception).lower())

    def test_canonical_resolver_rejects_outside_workspace(self) -> None:
        # Absolute path outside the workspace → _canonical_evidence_path
        # raises (its own resolved-outside-repo error).
        outside = Path(tempfile.mkdtemp(prefix="aria-e5-outside-"))
        try:
            (outside / "external.md").write_text("x", encoding="utf-8")
            with self.assertRaises(GovernanceError):
                validate_repo_evidence(
                    [str(outside / "external.md")],
                    workspace_root=self.workspace,
                )
        finally:
            import shutil
            shutil.rmtree(outside, ignore_errors=True)

    def test_canonical_resolver_allows_normal_docs_path(self) -> None:
        # No raise.
        validate_repo_evidence(
            ["docs/ok.md"], workspace_root=self.workspace,
        )

    def test_e8_aria_findings_rejected(self) -> None:
        # §E.8 extended taxonomy — aria-findings/ now blocked.
        self.assertIn("aria-findings/", SELF_OUTPUT_PREFIXES)
        with self.assertRaises(GovernanceError):
            validate_repo_evidence(
                ["aria-findings/F-001.json"],
                workspace_root=self.workspace,
            )

    def test_e8_aria_debts_rejected(self) -> None:
        self.assertIn("aria-debts/", SELF_OUTPUT_PREFIXES)
        with self.assertRaises(GovernanceError):
            validate_repo_evidence(
                ["aria-debts/DEBT-001.json"],
                workspace_root=self.workspace,
            )


if __name__ == "__main__":
    unittest.main()
