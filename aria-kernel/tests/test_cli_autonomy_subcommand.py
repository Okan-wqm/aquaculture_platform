"""Plan 026R §F.1 + §F.3 — CLI autonomy subcommand wiring.

3 tests:

* `aria-kernel autonomy run` parser exists + accepts the four
  documented kwargs (--workspace-root, --max-cycles,
  --max-iterations-per-phase, --daemon-id).
* `aria-kernel autonomy status` parser exists.
* main() dispatches autonomy run → run_autonomy_orchestrator
  (asserted via injected callable, NOT subprocess shell-out, so
  the smoke is hermetic).
"""
from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from aria_kernel.cli import main as cli_main
from aria_kernel.runtime_profile import set_profile


class CliAutonomyRunTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-cli-autonomy-"))
        self.base = self.tmp / "aria-tools"
        set_profile(
            "standard", operator_approval_ref="cli-auto-t",
            base_dir=self.base,
        )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_autonomy_run_parser_accepts_documented_kwargs(self) -> None:
        captured: dict[str, object] = {}

        def fake_runner(**kwargs):  # type: ignore[no-untyped-def]
            captured.update(kwargs)
            return {
                "cycles_completed": 1,
                "planner_claims_dispatched": 0,
                "worker_assignments_dispatched": 0,
                "auto_merges_completed": 0,
                "exit_reason": "max_cycles",
                "exits_clean": True,
                "per_cycle": [],
            }

        with patch(
            "aria_kernel.autonomy_orchestrator.run_autonomy_orchestrator",
            fake_runner,
        ), redirect_stdout(io.StringIO()) as buf:
            rc = cli_main([
                "--tools-dir", str(self.base),
                "autonomy", "run",
                "--workspace-root", str(self.tmp),
                "--max-cycles", "3",
                "--max-iterations-per-phase", "7",
                "--daemon-id", "test-autonomy",
            ])
        self.assertEqual(rc, 0)
        self.assertEqual(captured.get("max_cycles"), 3)
        self.assertEqual(captured.get("max_iterations_per_phase"), 7)
        self.assertEqual(captured.get("daemon_id"), "test-autonomy")
        # workspace_root passed through.
        self.assertEqual(captured.get("workspace_root"), str(self.tmp))
        # Stdout is JSON.
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["exit_reason"], "max_cycles")

    def test_autonomy_run_returns_nonzero_on_lock_contention(
        self,
    ) -> None:
        def fake_runner(**kwargs):  # type: ignore[no-untyped-def]
            return {
                "cycles_completed": 0,
                "planner_claims_dispatched": 0,
                "worker_assignments_dispatched": 0,
                "auto_merges_completed": 0,
                "exit_reason": "daemon_already_running",
                "exits_clean": False,
                "per_cycle": [],
            }

        with patch(
            "aria_kernel.autonomy_orchestrator.run_autonomy_orchestrator",
            fake_runner,
        ), redirect_stdout(io.StringIO()):
            rc = cli_main([
                "--tools-dir", str(self.base),
                "autonomy", "run",
                "--max-cycles", "1",
            ])
        self.assertEqual(rc, 1)

    def test_autonomy_status_prints_canonical_state(self) -> None:
        with redirect_stdout(io.StringIO()) as buf:
            rc = cli_main([
                "--tools-dir", str(self.base),
                "autonomy", "status",
            ])
        self.assertEqual(rc, 0)
        payload = json.loads(buf.getvalue())
        # Empty state on a fresh tools dir.
        self.assertEqual(payload["cycles_completed"], 0)
        self.assertEqual(payload["transition_count"], 0)
        self.assertFalse(payload["aria_stop_active"])


if __name__ == "__main__":
    unittest.main()
