"""Plan 024 v3 §B-5 — validation matrix cmd correlation end-to-end tests.

Pre-fix list_required_tests projection (validation_matrix_gate.py:218-224)
serialised path_glob, path_substr, regex_pattern but OMITTED
expected_cmd_substring. The downstream gate
_check_required_test_cmd_correlation (line 320-322) saw None on every
spec.get('expected_cmd_substring') and silent-skipped — `cmd: 'echo ok'`
then satisfied any required test in production. Plan 023 §R-3 + §R-3.1
migrated the spec table; Plan 024 §B-5 closes the projection-time
strip so the field survives every hop from spec table → projection →
enforce_validation_matrix → correlation gate.

Tests:
1. Projection output for every risk_type carries expected_cmd_substring.
2. Gate receives the field and fires correlation against echo-ok.
3. cmd matching the substring passes correlation.
4. Spec mutation (test removes the field from one spec) → projection
   raises required_test_spec_missing_expected_cmd_substring at first
   call.
5. Direct call to _check_required_test_cmd_correlation with a spec
   missing the field raises validation_matrix_spec_missing_cmd_-
   correlation_field — fail-loud, not silent-skip.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from aria_kernel.tool_registry import GovernanceError
from aria_kernel.validation_matrix_gate import (
    _REQUIRED_TESTS_BY_RISK,
    _check_required_test_cmd_correlation,
    list_required_tests,
)


class CmdCorrelationEndToEndTests(unittest.TestCase):
    def test_projection_output_carries_expected_cmd_substring(self) -> None:
        """Plan 024 §B-5 acceptance (1)."""
        for risk_type in _REQUIRED_TESTS_BY_RISK:
            projection = list_required_tests([risk_type])
            for spec in projection:
                self.assertIn("expected_cmd_substring", spec,
                    f"projection for {risk_type}/{spec.get('name')} missing "
                    f"expected_cmd_substring")
                self.assertIsInstance(spec["expected_cmd_substring"], str)
                self.assertTrue(spec["expected_cmd_substring"].strip())

    def test_correlation_gate_fires_on_echo_ok(self) -> None:
        """Plan 024 §B-5 acceptance (2)."""
        projection = list_required_tests(["auth_change"])
        # Build a candidate_refs list with cmd='echo ok' which should
        # NOT satisfy the required test cmd substring.
        refs = [{"cmd": "echo ok", "exit_code": 0, "log_path": "/tmp/x", "ran_at": "2026-05-09T00:00:00Z"}]
        failures = _check_required_test_cmd_correlation(
            required_tests=projection, candidate_refs=refs,
        )
        # Every required test should fail-correlation since 'echo ok'
        # contains none of the expected substrings (e.g. 'nx test
        # auth-service').
        self.assertGreater(len(failures), 0,
            "echo ok must not satisfy the auth_change required tests")
        for f in failures:
            self.assertIn("validation_run_ref_does_not_match_required_test_cmd", f)

    def test_correlation_gate_passes_on_matching_cmd(self) -> None:
        """Plan 024 §B-5 acceptance (3)."""
        projection = list_required_tests(["auth_change"])
        # Pick the first spec's expected_cmd_substring as the cmd; that
        # should at least satisfy that spec.
        first_substr = projection[0]["expected_cmd_substring"]
        refs = [{
            "cmd": f"npx {first_substr} --skip-nx-cache",
            "exit_code": 0,
            "log_path": "/tmp/x",
            "ran_at": "2026-05-09T00:00:00Z",
        }]
        failures = _check_required_test_cmd_correlation(
            required_tests=projection, candidate_refs=refs,
        )
        # Filter for failures specifically about the first spec's name.
        first_name = projection[0]["name"]
        relevant = [f for f in failures if first_name in f]
        self.assertEqual(len(relevant), 0,
            f"cmd containing {first_substr!r} must satisfy first spec; "
            f"unexpected failures: {relevant!r}")

    def test_spec_mutation_raises_at_projection(self) -> None:
        """Plan 024 §B-5 acceptance (4): a future spec edit that drops
        the field surfaces at first list_required_tests call."""
        # Build a mutated registry that drops expected_cmd_substring
        # from one spec.
        first_risk = next(iter(_REQUIRED_TESTS_BY_RISK))
        mutated = {
            first_risk: tuple(
                {k: v for k, v in spec.items() if k != "expected_cmd_substring"}
                for spec in _REQUIRED_TESTS_BY_RISK[first_risk]
            ),
        }
        with patch(
            "aria_kernel.validation_matrix_gate._REQUIRED_TESTS_BY_RISK",
            mutated,
        ):
            with self.assertRaises(GovernanceError) as ctx:
                list_required_tests([first_risk])
            self.assertIn(
                "required_test_spec_missing_expected_cmd_substring",
                str(ctx.exception),
            )

    def test_correlation_gate_rejects_spec_without_field(self) -> None:
        """Plan 024 §B-5 acceptance (5): direct call surfaces the same
        guard, defense in depth even if a future caller bypasses
        list_required_tests."""
        rogue_spec = {
            "risk_type": "auth_change",
            "name": "rogue_test_without_substr",
            "path_glob": "**/*.spec.ts",
            "path_substr": "auth",
            "regex_pattern": ".",
        }
        with self.assertRaises(GovernanceError) as ctx:
            _check_required_test_cmd_correlation(
                required_tests=[rogue_spec],
                candidate_refs=[{"cmd": "x", "exit_code": 0, "log_path": "/x", "ran_at": "x"}],
            )
        self.assertIn(
            "validation_matrix_spec_missing_cmd_correlation_field",
            str(ctx.exception),
        )


if __name__ == "__main__":
    unittest.main()
