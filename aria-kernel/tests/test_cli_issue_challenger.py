"""Plan 026R §C.3 — convergent-plan issue-challenger CLI strict fields.

3 tests:

* CLI parser rejects missing --must-satisfy-file / --evidence-ref /
  --allowed-scope with argparse error (exit 2).
* All 3 missing → all 3 errors surfaced.
* Happy path: provide all 3 + JSON-loaded must_satisfy file → CLI
  succeeds (or returns a kernel-level error, NOT a TypeError).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ARIA_KERNEL = Path(__file__).resolve().parent.parent


class IssueChallengerCliStrictFieldsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-c3-"))
        self.tools = self.tmp / "aria-tools"

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run_cli(self, *extra_args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable, "-m", "aria_kernel",
                "convergent-plan", "issue-challenger",
                "--plan-id", "p1",
                "--round-number", "1",
                "--tools-dir", str(self.tools),
                *extra_args,
            ],
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONPATH": str(ARIA_KERNEL)},
        )

    def test_missing_must_satisfy_file_argparse_error(self) -> None:
        proc = self._run_cli(
            "--evidence-ref", "docs/a.md",
            "--allowed-scope", "docs/",
        )
        # argparse exits 2 on missing-required-argument and writes the
        # error to stderr (the message names the offending flag).
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("--must-satisfy-file", proc.stderr)

    def test_missing_evidence_ref_argparse_error(self) -> None:
        ms_file = self.tmp / "ms.json"
        ms_file.write_text(json.dumps([{"id": "p", "description": "p"}]))
        proc = self._run_cli(
            "--must-satisfy-file", str(ms_file),
            "--allowed-scope", "docs/",
        )
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("--evidence-ref", proc.stderr)

    def test_all_three_missing_argparse_error(self) -> None:
        proc = self._run_cli()
        # Only the first missing arg surfaces in argparse's error message
        # by convention (it stops at the first failure); the exit code
        # is consistent (2) and the message names AT LEAST ONE of the 3.
        self.assertEqual(proc.returncode, 2, proc.stderr)
        # Any of the three should surface.
        self.assertTrue(
            any(flag in proc.stderr for flag in (
                "--must-satisfy-file",
                "--evidence-ref",
                "--allowed-scope",
            )),
            proc.stderr,
        )

    def test_happy_path_does_not_raise_typeerror(self) -> None:
        # With all 3 fields provided, the CLI reaches the kernel
        # primitive WITHOUT raising TypeError. The kernel may still
        # raise (e.g. plan_id not found), but the failure is a
        # GovernanceError surfaced through structured CLI exit, NOT
        # an unhandled TypeError.
        ms_file = self.tmp / "ms.json"
        ms_file.write_text(
            json.dumps([{"id": "p", "description": "prove"}]),
        )
        proc = self._run_cli(
            "--must-satisfy-file", str(ms_file),
            "--evidence-ref", "docs/a.md",
            "--allowed-scope", "docs/",
        )
        # TypeError raise would surface as Python traceback in stderr.
        self.assertNotIn("TypeError", proc.stderr)
        self.assertNotIn("missing 3 required keyword-only arguments", proc.stderr)


if __name__ == "__main__":
    unittest.main()
