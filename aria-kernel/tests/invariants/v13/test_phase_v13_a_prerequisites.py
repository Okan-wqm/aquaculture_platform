"""Plan 033 Faz 033a — the security lane refuses to run on a half-built kernel.

Invariants:
  I-V13-BOOT-01  against the real kernel every required v12 capability is present;
                 the gate is READY (exit 0).
  I-V13-BOOT-02  a single absent capability makes the gate fail closed (exit 3) and
                 names it — trusting a commit label is never the proof.
  I-V13-BOOT-03  finding CRITICAL severity is one of the checked capabilities, and a
                 module present without the CRITICAL rank still fails closed.
  I-V13-BOOT-04  the CLI exposes `security prerequisites` and returns the gate's code.
"""
from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

from tests.invariants.v13 import _helpers  # noqa: F401 — sys.path

from aria_kernel.security import prerequisites as prereq

_REPO_ROOT = Path(__file__).resolve().parents[4]


class PrerequisiteGate(unittest.TestCase):
    def test_I_V13_BOOT_01_real_kernel_is_ready(self) -> None:
        report = prereq.run_prerequisites()
        self.assertTrue(report.ready, report.missing)
        self.assertEqual(report.exit_code, prereq.EXIT_READY)
        self.assertEqual(report.missing, [])
        self.assertGreaterEqual(len(report.results), 25)
        # every declared capability actually resolved
        self.assertTrue(all(r.present for r in report.results))

    def test_I_V13_BOOT_02_one_absent_capability_fails_closed(self) -> None:
        checks = (*prereq.REQUIRED_CAPABILITIES,
                  ("ghost_capability", "aria_kernel.does_not_exist_033", "nope"))
        report = prereq.run_prerequisites(capabilities=checks)
        self.assertFalse(report.ready)
        self.assertEqual(report.exit_code, prereq.EXIT_NOT_READY)
        self.assertIn("ghost_capability", report.missing)
        ghost = next(r for r in report.results if r.capability == "ghost_capability")
        self.assertTrue(ghost.detail.startswith("import_failed:"))
        # a present module missing its symbol also fails closed
        checks2 = (("bad_symbol", "aria_kernel.finding", "NOT_A_REAL_SYMBOL_033"),)
        r2 = prereq.run_prerequisites(capabilities=checks2)
        self.assertFalse(r2.ready)
        self.assertEqual(next(iter(r2.results)).detail, "symbol_absent")

    def test_I_V13_BOOT_03_critical_severity_is_gated(self) -> None:
        self.assertTrue(any(c[0] == "finding_critical_severity" for c in prereq.REQUIRED_CAPABILITIES))
        # the content check catches a rank map without CRITICAL
        checks = (("finding_critical_severity", "aria_kernel.release_reason", "RELEASE_REASON_CODES"),)
        report = prereq.run_prerequisites(capabilities=checks)
        self.assertFalse(report.ready)
        self.assertEqual(next(iter(report.results)).detail, "critical_not_in_rank")

    def test_I_V13_BOOT_04_cli_exposes_the_gate(self) -> None:
        proc = subprocess.run(
            [sys.executable, "-m", "aria_kernel", "security", "prerequisites", "--json"],
            cwd=str(_REPO_ROOT / "aria-kernel"), capture_output=True, text=True, timeout=120,
            env={"PYTHONPATH": str(_REPO_ROOT / "aria-kernel"), "PATH": _os_path()},
        )
        self.assertEqual(proc.returncode, prereq.EXIT_READY, proc.stderr[-400:])
        payload = json.loads(proc.stdout)
        self.assertTrue(payload["ready"])
        self.assertEqual(payload["missing"], [])


def _os_path() -> str:
    import os

    return os.environ.get("PATH", "/usr/bin:/bin")


if __name__ == "__main__":
    unittest.main()
