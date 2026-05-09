"""Plan 023 v3 §R-3 — validation matrix cmd correlation.

Pre-Plan-023 validation_matrix_gate._check_run_pass_layer accepted
ANY validation_run_ref with structured shape + exit_code=0 as proof
of "RUN-PASS". A `cmd: 'echo ok'` ref cleared the gate even when
the required test was 'nx test auth-service'. The correlation
between required test and the cmd that ran was never validated.

Plan 023 v3 §R-3 fix: each required test gains an optional
expected_cmd_substring field. _check_required_test_cmd_correlation
validates that for every required test with a populated substring,
at least one candidate ref's cmd contains it. Mismatch surfaces as
'validation_run_ref_does_not_match_required_test_cmd' failure.

Tests:
1. ref cmd contains substring → passes correlation.
2. ref cmd does not match → cmd correlation failure.
3. required test without expected_cmd_substring → legacy fallback
   (no correlation enforcement).
4. multiple required tests + multiple refs with mixed match → only
   the missing-substring tests fail.
"""
from __future__ import annotations

import unittest

from aria_kernel.validation_matrix_gate import (
    _check_required_test_cmd_correlation,
)


class CmdCorrelationTests(unittest.TestCase):
    def test_ref_cmd_contains_substring_passes(self) -> None:
        required = [
            {"name": "use_guards_test",
             "expected_cmd_substring": "nx test auth-service"},
        ]
        candidate_refs = [
            {"cmd": "nx test auth-service --testFile=apps/auth/x.spec.ts",
             "exit_code": 0, "log_path": "log.txt", "ran_at": "2026-05-09T00:00:00Z"},
        ]
        failures = _check_required_test_cmd_correlation(
            required_tests=required, candidate_refs=candidate_refs,
        )
        self.assertEqual(failures, [])

    def test_echo_ok_does_not_satisfy_required_test(self) -> None:
        """Plan 023 v3 §R-3: pre-fix this slipped through — `echo ok`
        with exit_code=0 cleared the gate for any required test."""
        required = [
            {"name": "use_guards_test",
             "expected_cmd_substring": "nx test auth-service"},
        ]
        candidate_refs = [
            {"cmd": "echo ok", "exit_code": 0,
             "log_path": "log.txt", "ran_at": "2026-05-09T00:00:00Z"},
        ]
        failures = _check_required_test_cmd_correlation(
            required_tests=required, candidate_refs=candidate_refs,
        )
        self.assertEqual(len(failures), 1)
        self.assertIn("validation_run_ref_does_not_match_required_test_cmd", failures[0])
        self.assertIn("nx test auth-service", failures[0])

    def test_legacy_spec_without_expected_cmd_substring_no_enforcement(self) -> None:
        """Backward compatibility: required tests that do not declare
        expected_cmd_substring (legacy specs awaiting migration) are
        not yet correlation-enforced."""
        required = [
            {"name": "legacy_test"},  # No expected_cmd_substring.
        ]
        candidate_refs = [
            {"cmd": "echo ok", "exit_code": 0,
             "log_path": "log.txt", "ran_at": "2026-05-09T00:00:00Z"},
        ]
        failures = _check_required_test_cmd_correlation(
            required_tests=required, candidate_refs=candidate_refs,
        )
        self.assertEqual(failures, [])

    def test_mixed_required_tests_only_missing_fail(self) -> None:
        required = [
            {"name": "guards_test",
             "expected_cmd_substring": "nx test auth-service"},
            {"name": "tenant_test",
             "expected_cmd_substring": "nx test farm-service"},
        ]
        candidate_refs = [
            {"cmd": "nx test auth-service", "exit_code": 0,
             "log_path": "a.log", "ran_at": "2026-05-09T00:00:00Z"},
            # No farm-service cmd.
        ]
        failures = _check_required_test_cmd_correlation(
            required_tests=required, candidate_refs=candidate_refs,
        )
        self.assertEqual(len(failures), 1)
        self.assertIn("nx test farm-service", failures[0])


if __name__ == "__main__":
    unittest.main()
