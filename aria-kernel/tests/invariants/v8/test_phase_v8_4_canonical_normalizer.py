"""Plan ARIA-V8.4 — ci_executor canonical plan_content normalizer.

Closes Bug 8 (live observation 2026-05-18 run 6): aria-challenger-
planner Opus produced 6 of 7 canonical plan_content fields correctly
but non-deterministically omitted `evidence_refs` from inside
plan_content (the same array existed at envelope top level). The
pre-submit validator rejected the envelope, cycle iterated; each
retry burned $0.35 of Opus tokens with no architectural gain.

Tier-1 architectural fix: ci_executor introduces a canonical
normalizer that auto-fills missing plan_content fields from
compatible sources WITHIN the envelope before validation runs. The
normalizer is conservative — it only mirrors values the agent
already produced (e.g. top-level evidence_refs into plan_content)
and never fabricates evidence. The agent's substantive output stays
intact; the system becomes resilient to non-substantive agent drift.

Invariants:

- I-V8.4-NORM-01 — `_canonicalize_plan_content` helper exists in
  ci_executor.py
- I-V8.4-NORM-02 — auto-fills `evidence_refs` into plan_content
  when missing inside plan_content but present at envelope top-level
- I-V8.4-NORM-03 — auto-defaults `schema_version` to 1 when missing
- I-V8.4-NORM-04 — wraps flat list-of-strings `affected_surfaces`
  into the kernel-canonical `[{paths: [...]}]` shape
- I-V8.4-NORM-05 — wraps bare-string validation_commands into
  `{cmd, expected_exit, timeout_ms}` dicts
- I-V8.4-NORM-06 — DOES NOT fabricate values (no plan_content drives
  an empty envelope into validity)
- I-V8.4-NORM-07 — normalizer is invoked BEFORE
  _pre_submit_validate_envelope in the dispatch path (source-substring
  pin)
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
CI_EXECUTOR_PATH = REPO_ROOT / "tools" / "aria-poc" / "ci_executor.py"


def _load_ci_executor():
    spec = importlib.util.spec_from_file_location("ci_executor", CI_EXECUTOR_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["ci_executor"] = mod
    spec.loader.exec_module(mod)
    return mod


class TestV8CanonicalNormalizer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ci = _load_ci_executor()

    def test_i_v8_4_norm_01_helper_exists(self):
        """ci_executor MUST define _canonicalize_plan_content."""
        self.assertTrue(hasattr(self.ci, "_canonicalize_plan_content"))

    def test_i_v8_4_norm_02_fills_evidence_refs_from_top_level(self):
        envelope = {
            "evidence_refs": ["aria-kernel/cli.py:42"],
            "plan_content": {
                "schema_version": 1,
                "title": "x",
                "summary": "y",
                "affected_surfaces": [{"paths": ["a.py"]}],
                "key_changes": ["A"],
                "validation_commands": [{"cmd": "echo"}],
                # evidence_refs intentionally missing inside plan_content
            },
        }
        mutated = self.ci._canonicalize_plan_content(envelope)
        self.assertTrue(mutated)
        self.assertEqual(
            envelope["plan_content"]["evidence_refs"],
            ["aria-kernel/cli.py:42"],
        )

    def test_i_v8_4_norm_03_defaults_schema_version(self):
        envelope = {
            "plan_content": {
                "title": "x",
                "summary": "y",
                "affected_surfaces": [],
                "key_changes": ["A"],
                "validation_commands": [],
                "evidence_refs": [],
            },
        }
        mutated = self.ci._canonicalize_plan_content(envelope)
        self.assertTrue(mutated)
        self.assertEqual(envelope["plan_content"]["schema_version"], 1)

    def test_i_v8_4_norm_04_wraps_affected_surfaces(self):
        envelope = {
            "plan_content": {
                "schema_version": 1,
                "title": "x",
                "summary": "y",
                "affected_surfaces": ["a.py", "b.ts"],  # flat strings
                "key_changes": ["A"],
                "validation_commands": [],
                "evidence_refs": [],
            },
        }
        mutated = self.ci._canonicalize_plan_content(envelope)
        self.assertTrue(mutated)
        self.assertEqual(
            envelope["plan_content"]["affected_surfaces"],
            [{"paths": ["a.py", "b.ts"]}],
        )

    def test_i_v8_4_norm_05_wraps_string_validation_commands(self):
        envelope = {
            "plan_content": {
                "schema_version": 1,
                "title": "x",
                "summary": "y",
                "affected_surfaces": [{"paths": ["a.py"]}],
                "key_changes": ["A"],
                "validation_commands": ["pytest aria-kernel/tests/"],  # bare string
                "evidence_refs": [],
            },
        }
        mutated = self.ci._canonicalize_plan_content(envelope)
        self.assertTrue(mutated)
        self.assertEqual(
            envelope["plan_content"]["validation_commands"][0],
            {"cmd": "pytest aria-kernel/tests/", "expected_exit": 0, "timeout_ms": 60000},
        )

    def test_i_v8_4_norm_06_does_not_fabricate_evidence(self):
        """If neither plan_content.evidence_refs nor envelope.evidence_refs
        exist, the normalizer MUST NOT fabricate them. The validator
        then correctly rejects the envelope as missing the required
        field; that's better than auto-filling with `[]` which would
        let an evidenceless plan slip through."""
        envelope = {
            "plan_content": {
                "schema_version": 1,
                "title": "x",
                "summary": "y",
                "affected_surfaces": [{"paths": ["a.py"]}],
                "key_changes": ["A"],
                "validation_commands": [{"cmd": "echo"}],
                # NO evidence_refs anywhere
            },
        }
        self.ci._canonicalize_plan_content(envelope)
        # Validator should still flag evidence_refs as missing
        self.assertNotIn("evidence_refs", envelope["plan_content"])

    def test_i_v8_4_norm_07_invoked_before_validator(self):
        """Source-substring pin: ci_executor calls
        _canonicalize_plan_content BEFORE _pre_submit_validate_envelope
        in the dispatch path."""
        src = CI_EXECUTOR_PATH.read_text(encoding="utf-8")
        canon_idx = src.index("_canonicalize_plan_content(")
        validate_idx = src.index("_pre_submit_validate_envelope(")
        # First call to canonicalize must precede the validator call.
        self.assertLess(
            canon_idx, validate_idx,
            "_canonicalize_plan_content MUST be called BEFORE "
            "_pre_submit_validate_envelope in ci_executor dispatch",
        )


if __name__ == "__main__":
    unittest.main()
