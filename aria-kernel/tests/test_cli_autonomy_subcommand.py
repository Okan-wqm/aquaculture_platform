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
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
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
        self.assertEqual(rc, 3)

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

    def test_autonomy_status_evidence_accepts_optional_full_target_sha(self) -> None:
        target = "a" * 40
        expected = {
            "target_sha": target,
            "derived_at": "2026-08-22T00:00:00Z",
            "overall_state": "declared",
            "blockers": [],
            "capabilities": {},
        }
        status = unittest.mock.Mock()
        status.to_dict.return_value = expected
        with patch(
            "aria_kernel.autonomy_evidence.derive_autonomy_evidence_status",
            return_value=status,
        ) as derive, redirect_stdout(io.StringIO()) as buf:
            rc = cli_main([
                "--tools-dir", str(self.base),
                "autonomy", "status",
                "--evidence",
                "--target-sha", target,
            ])

        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(buf.getvalue()), expected)
        self.assertEqual(derive.call_args.kwargs["target_sha"], target)

    def test_target_sha_without_evidence_and_non_full_sha_are_rejected(self) -> None:
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            cli_main([
                "--tools-dir", str(self.base),
                "autonomy", "status",
                "--target-sha", "a" * 40,
            ])
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            cli_main([
                "--tools-dir", str(self.base),
                "autonomy", "status",
                "--evidence",
                "--target-sha", "short",
            ])

    def test_evidence_mode_resolves_git_top_level_below_repository_root(self) -> None:
        repo = self.tmp / "repo"
        repo.mkdir()
        subprocess.run(
            ["git", "-C", str(repo), "init", "--initial-branch=main", "."],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "-C", str(repo), "config", "user.name", "ARIA Test"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(repo), "config", "user.email", "aria@example.invalid"],
            check=True,
        )
        policy = repo / "docs" / "aria" / "policy" / "autonomy-closure-findings.json"
        policy.parent.mkdir(parents=True)
        policy.write_text(json.dumps({
            "entries": [{
                "finding_id": "ORPHAN-MEDIUM-789",
                "required_predicate": "mode_a_signed_readiness_live_proven",
                "operator_prerequisite": {
                    "capability": "enterprise_readiness",
                    "blocker": "github_app_mode_a_unconfigured",
                },
            }],
        }), encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
        subprocess.run(
            ["git", "-C", str(repo), "commit", "-m", "seed"],
            check=True,
            capture_output=True,
        )
        target = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        nested = repo / "nested" / "dir"
        nested.mkdir(parents=True)

        with patch("aria_kernel.cli.Path.cwd", return_value=nested), redirect_stdout(
            io.StringIO(),
        ) as buf:
            rc = cli_main([
                "--tools-dir", str(repo / "missing-tools"),
                "autonomy", "status", "--evidence",
            ])

        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(buf.getvalue())["target_sha"], target)

    def test_autonomy_burn_in_observe_requires_explicit_tools_dir(self) -> None:
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            cli_main([
                "autonomy", "burn-in", "observe",
                "--workspace-root", str(self.tmp),
                "--workspace-base", str(self.tmp / "workspaces"),
                "--target-ref", "HEAD",
                "--output-dir", str(self.base / "burn-in" / "test-run"),
            ])

    def test_autonomy_burn_in_observe_dispatches_runner(self) -> None:
        captured: dict[str, object] = {}

        def fake_burn_in(**kwargs):  # type: ignore[no-untyped-def]
            captured.update(kwargs)
            return {
                "schema_version": "aria/autonomy-burn-in-report/v1",
                "acceptance_verdict": "passed",
                "valid_cycles": kwargs["min_valid_cycles"],
            }

        with patch("aria_kernel.cli.run_observe_burn_in", fake_burn_in), redirect_stdout(io.StringIO()) as buf:
            rc = cli_main([
                "--tools-dir", str(self.base),
                "autonomy", "burn-in", "observe",
                "--workspace-root", str(self.tmp),
                "--workspace-base", str(self.tmp / "workspaces"),
                "--target-ref", "HEAD",
                "--cycles", "30",
                "--min-valid-cycles", "20",
                "--output-dir", str(self.base / "burn-in" / "test-run"),
            ])

        self.assertEqual(rc, 0)
        self.assertEqual(captured["workspace_root"], str(self.tmp))
        self.assertEqual(captured["workspace_base"], str(self.tmp / "workspaces"))
        self.assertEqual(captured["base_dir"], str(self.base.resolve()))
        self.assertEqual(captured["target_ref"], "HEAD")
        self.assertEqual(captured["cycles"], 30)
        self.assertEqual(captured["min_valid_cycles"], 20)
        self.assertEqual(captured["output_dir"], str(self.base / "burn-in" / "test-run"))
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["acceptance_verdict"], "passed")


if __name__ == "__main__":
    unittest.main()
