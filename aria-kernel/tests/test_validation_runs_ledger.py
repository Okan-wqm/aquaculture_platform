"""Plan 026R §D.1 — validation_runs.jsonl ledger + log_hash binding.

7 tests:

* happy path: record + read + verify (round-trip).
* runner_identity missing → raise.
* commit_sha missing/short → raise.
* log_path missing on disk → raise (cannot hash).
* self-attestation: runner_identity == change_author_identity → raise.
* verify with tampered log file → raise (hash mismatch).
* cmd correlation: change_id filter returns the right rows.

D5 — the failure-reason class is derived from the bound log, per runner.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.validation_runs_ledger import (
    derive_validation_failure_reason,
    find_validation_run_by_id,
    list_validation_runs_for_change,
    record_validation_run,
    verify_validation_run,
)


class ValidationRunsLedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-d1-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        self.log = self.tmp / "log.txt"
        self.log.write_text("validation log output line 1\nline 2\n", encoding="utf-8")

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _record(self, **overrides) -> dict:
        defaults = dict(
            change_id="ch-d1",
            cmd="nx affected --target=test",
            exit_code=0,
            duration_ms=1_500,
            log_path=str(self.log),
            commit_sha="abc1234567890",
            runner_identity="ci-executor:gha-1234",
            change_author_identity="agent:planner-x",
            started_at="2026-05-11T13:00:00+00:00",
            completed_at="2026-05-11T13:01:00+00:00",
            base_dir=self.base,
        )
        defaults.update(overrides)
        return record_validation_run(**defaults)

    def test_happy_path_record_read_verify(self) -> None:
        row = self._record()
        self.assertTrue(row["log_hash"].startswith("sha256:"))
        self.assertTrue(row["validation_run_id"].startswith("vrun-"))
        # Round-trip verify.
        verified = verify_validation_run(
            row["validation_run_id"], base_dir=self.base,
        )
        self.assertEqual(verified["log_hash"], row["log_hash"])

    def test_runner_identity_missing_raises(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            self._record(runner_identity="")
        self.assertIn("runner_identity_required", str(ctx.exception))

    def test_commit_sha_short_raises(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            self._record(commit_sha="abc")  # too short
        self.assertIn("commit_sha", str(ctx.exception))

    def test_log_path_missing_raises(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            self._record(log_path=str(self.tmp / "nonexistent.txt"))
        self.assertIn("log_missing", str(ctx.exception))

    def test_self_attestation_rejects(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            self._record(
                runner_identity="agent:planner-x",
                change_author_identity="agent:planner-x",
            )
        self.assertIn("self_attestation", str(ctx.exception))

    def test_verify_detects_tampered_log_file(self) -> None:
        row = self._record()
        # Tamper the log file AFTER recording.
        self.log.write_text("TAMPERED CONTENT\n", encoding="utf-8")
        with self.assertRaises(GovernanceError) as ctx:
            verify_validation_run(
                row["validation_run_id"], base_dir=self.base,
            )
        self.assertIn("log_hash_mismatch", str(ctx.exception))

    def test_cmd_correlation_by_change_id(self) -> None:
        self._record(change_id="ch-a", cmd="nx test:a")
        self._record(change_id="ch-a", cmd="nx test:b")
        self._record(change_id="ch-b", cmd="nx test:c")
        a_runs = list_validation_runs_for_change("ch-a", base_dir=self.base)
        b_runs = list_validation_runs_for_change("ch-b", base_dir=self.base)
        self.assertEqual(len(a_runs), 2)
        self.assertEqual(len(b_runs), 1)
        self.assertEqual(b_runs[0]["cmd"], "nx test:c")

    def test_failure_reason_is_stamped_from_the_bound_log(self) -> None:
        self.assertIsNone(self._record()["failure_reason"])
        self.log.write_text("argv: ['x']\n--- stdout ---\nAssertionError: 1 != 2\n", encoding="utf-8")
        self.assertEqual(self._record(exit_code=1)["failure_reason"], "assertion")
        self.assertEqual(self._record(exit_code=None, timed_out=True)["failure_reason"], "timeout")

    def test_failure_reason_reads_the_command_output_never_the_log_header(self) -> None:
        # D5-R1-SSOT-B1: the header carries the command line, which a caller
        # chooses (a ``-k ECONNREFUSED`` filter, an embedded newline); only
        # the streams after ``--- stdout ---`` are what the command printed.
        self.log.write_text(
            "command: python3 -m unittest tests.test_probe -k ECONNREFUSED\n"
            "ConnectionRefusedError: [Errno 111] Connection refused\n"
            "argv: ['python3', '-m', 'unittest', 'tests.test_probe', '-k', 'ECONNREFUSED']\n"
            "--- stdout ---\n\n--- stderr ---\n"
            "FAIL: test_claim (tests.test_probe.Probe.test_claim)\nAssertionError: 1 != 2\n",
            encoding="utf-8",
        )
        self.assertEqual(self._record(exit_code=1)["failure_reason"], "assertion")


class FailureReasonClassTests(unittest.TestCase):
    """The class each admitted runner's red output reads as (D5 / F3.2)."""

    def test_each_runner_output_reads_as_its_class(self) -> None:
        cases = (
            ("ImportError: Failed to import test module: t\nModuleNotFoundError: No module named 'x'", "import"),
            ("  ● Test suite failed to run\n\n    Cannot find module './calc' from 'calc.spec.ts'", "import"),
            ("ImportError: Failed to import test module: t\nNameError: name 'x' is not defined", "collection"),
            ("  File \"t.py\", line 4\nSyntaxError: invalid syntax", "collection"),
            ("  ● Test suite failed to run\n\n    SyntaxError: Unexpected token", "collection"),
            ("error: could not compile `gateway` (lib test) due to 1 previous error", "collection"),
            ("ConnectionRefusedError: [Errno 111] Connection refused\nAssertionError: 0 != 1", "infra_required"),
            ("connect ECONNREFUSED 127.0.0.1:5432", "infra_required"),
            ("Error: connect ECONNREFUSED 127.0.0.1:5432", "infra_required"),
            ("Error: getaddrinfo EAI_AGAIN db.internal", "infra_required"),
            ("socket.gaierror: [Errno -3] Temporary failure in name resolution", "infra_required"),
            # D5-R1-SSOT-B1: an assertion whose message NAMES an infra token
            # is an assertion, not a refused connection.
            ("FAIL: test_claim (t.P.test_claim)\nAssertionError: 'ETIMEDOUT' != 'ECONNREFUSED'", "assertion"),
            ("AssertionError: 'EAI_AGAIN' not found in 'ok'", "assertion"),
            ("    expect(received).toBe(expected)\n    Expected: \"Temporary failure in name resolution\"", "assertion"),
            ("command: python3 -m unittest t -k ECONNREFUSED\nFAIL: test_a (t.P.test_a)\nAssertionError: 1 != 2",
             "assertion"),
            ("FAIL: test_add (tests.test_calc.T.test_add)\nAssertionError: -1 != 5", "assertion"),
            ("    expect(received).toBe(expected) // Object.is equality", "assertion"),
            ("thread 'tests::add' panicked at src/lib.rs:9:5:", "assertion"),
            ("AttributeError: module 'calc' has no attribute 'sub'", None),
        )
        for output, reason in cases:
            with self.subTest(output=output):
                self.assertEqual(derive_validation_failure_reason(status="failed", output=output), reason)

    def test_an_ok_run_has_no_class_whatever_it_printed(self) -> None:
        self.assertIsNone(derive_validation_failure_reason(status="ok", output="AssertionError: logged"))


if __name__ == "__main__":
    unittest.main()
