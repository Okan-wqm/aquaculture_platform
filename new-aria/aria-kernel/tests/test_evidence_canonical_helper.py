"""Plan 024 v3 §H-5 — evidence canonical-resolve helper tests.

Pre-fix _check_agent_ref (string agent refs, evidence_validator.py:201)
and validate_evidence_path (dict ref, line 146) both applied
normalize_path (lexical) THEN startswith(SELF_OUTPUT_MARKERS) prefix
match BEFORE .resolve(). A path like src/../aria-tools/output.json
could lexically normalise to aria-tools/output.json (depending on
normalize_path's implementation) but the prefix match operated on
the lexical form, which a future normalize_path tweak could
un-stick. Post-fix the resolution runs first via the shared
_canonical_evidence_path helper; both code paths consume the
canonical posix-relative form for SELF_OUTPUT detection.

Tests:
1. _canonical_evidence_path returns canonical (rel_str, absolute)
   for a path inside the repo.
2. _canonical_evidence_path raises evidence_path_outside_repo for
   a ../-escape that resolves outside the workspace.
3. _canonical_evidence_path raises evidence_path_outside_repo for
   an absolute path outside the workspace.
4. _check_agent_ref source asserts the helper is called BEFORE the
   SELF_OUTPUT prefix check.
5. validate_evidence_path source asserts the helper is called
   BEFORE the SELF_OUTPUT prefix check.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.evidence_validator import _canonical_evidence_path
from aria_kernel.tool_registry import GovernanceError


class CanonicalEvidencePathTests(unittest.TestCase):
    def test_inside_repo_returns_canonical(self) -> None:
        """Plan 024 §H-5 acceptance (1)."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "apps").mkdir()
            (root / "apps" / "x.ts").write_text("ok", encoding="utf-8")
            rel_str, absolute = _canonical_evidence_path("apps/x.ts", root)
            self.assertEqual(rel_str, "apps/x.ts")
            self.assertEqual(absolute, (root / "apps" / "x.ts").resolve())

    def test_relative_traversal_outside_repo_raises(self) -> None:
        """Plan 024 §H-5 acceptance (2)."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "repo"
            root.mkdir()
            sibling = Path(td) / "sibling"
            sibling.mkdir()
            (sibling / "secret").write_text("x", encoding="utf-8")
            with self.assertRaises(GovernanceError) as ctx:
                _canonical_evidence_path("../sibling/secret", root)
            self.assertIn("evidence_path_outside_repo", str(ctx.exception))

    def test_absolute_path_outside_repo_raises(self) -> None:
        """Plan 024 §H-5 acceptance (3)."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "repo"
            root.mkdir()
            with self.assertRaises(GovernanceError) as ctx:
                _canonical_evidence_path("/etc/passwd", root)
            self.assertIn("evidence_path_outside_repo", str(ctx.exception))


class EvidenceValidatorSourceTests(unittest.TestCase):
    def test_check_agent_ref_uses_helper_before_self_output(self) -> None:
        """Plan 024 §H-5 acceptance (4)."""
        src = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel"
            / "evidence_validator.py"
        ).read_text(encoding="utf-8")
        # Inside _check_agent_ref the canonical helper must run before
        # the SELF_OUTPUT match. Find _check_agent_ref body and slice
        # to the agent_evidence_self_output line; the helper call must
        # appear before.
        body = src.split("def _check_agent_ref")[1]
        body = body.split("def ")[0]  # only this function
        helper_pos = body.find("_canonical_evidence_path(path, root)")
        self_output_pos = body.find("agent_evidence_self_output")
        self.assertGreaterEqual(helper_pos, 0,
            "Plan 024 §H-5 — _check_agent_ref must call _canonical_evidence_path")
        self.assertGreaterEqual(self_output_pos, 0)
        self.assertLess(helper_pos, self_output_pos,
            "Plan 024 §H-5 — canonical resolve must run BEFORE SELF_OUTPUT check")

    def test_validate_evidence_path_uses_helper_before_self_output(self) -> None:
        """Plan 024 §H-5 acceptance (5)."""
        src = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel"
            / "evidence_validator.py"
        ).read_text(encoding="utf-8")
        body = src.split("def validate_evidence_path")[1]
        body = body.split("def ")[0]
        helper_pos = body.find("_canonical_evidence_path(raw_path_str, root)")
        self_output_pos = body.find("self_output_evidence")
        self.assertGreaterEqual(helper_pos, 0,
            "Plan 024 §H-5 — validate_evidence_path must call _canonical_evidence_path")
        self.assertGreaterEqual(self_output_pos, 0)
        self.assertLess(helper_pos, self_output_pos,
            "Plan 024 §H-5 — canonical resolve must run BEFORE self_output_evidence check")


if __name__ == "__main__":
    unittest.main()
