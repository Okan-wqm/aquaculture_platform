"""Plan 026R §D.1 — validation_runs.jsonl ledger + log_hash binding.

7 tests:

* happy path: record + read + verify (round-trip).
* runner_identity missing → raise.
* commit_sha missing/short → raise.
* log_path missing on disk → raise (cannot hash).
* self-attestation: runner_identity == change_author_identity → raise.
* verify with tampered log file → raise (hash mismatch).
* cmd correlation: change_id filter returns the right rows.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.validation_runs_ledger import (
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


if __name__ == "__main__":
    unittest.main()
