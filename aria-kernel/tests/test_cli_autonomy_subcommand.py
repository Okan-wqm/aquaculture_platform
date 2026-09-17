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

    def test_full_artifact_path_is_budgeted_without_truncating_artifact(self) -> None:
        from aria_kernel.runtime_artifacts import SUMMARY_STDOUT_MAX_BYTES, autonomy_output_summary

        result = {"cycles_completed": 1, "exits_clean": True, "exit_reason": "", "per_cycle": [{
            "cycle_id": "current", "cycle": {"status": "ok"},
            "memory_hook": {"status": "needs_signing", "convention_recorded": False},
            "memory_completion": {"status": "completed", "attempted": 0, "already_recorded": 4,
                "observations": [{"cycle_id": f"original-{i}", "status": "already_recorded",
                                  "convention_recorded": True, "chain_verified": True} for i in range(4)]},
        }], "full_only_detail": "artifact-content-" * 5000}
        before = autonomy_output_summary(result, result_detail="full", base_dir=self.base, workspace_root=self.tmp)
        before.pop("full_result")
        padding = SUMMARY_STDOUT_MAX_BYTES - len(json.dumps(before, indent=2, sort_keys=True).encode()) - 16
        result["exit_reason"] = "x" * padding
        artifact = self.tmp.joinpath(*[f"segment-{i}-" + "p" * 180 for i in range(5)], "full.json")
        before = autonomy_output_summary(result, result_detail="full", base_dir=self.base, workspace_root=self.tmp)
        before.pop("full_result")
        before["full_result_artifact"] = str(artifact)
        self.assertGreater(len(json.dumps(before, indent=2, sort_keys=True).encode()), SUMMARY_STDOUT_MAX_BYTES)

        with patch("aria_kernel.autonomy_orchestrator.run_autonomy_orchestrator", return_value=result), redirect_stdout(io.StringIO()) as output:
            rc = cli_main(["--tools-dir", str(self.base), "autonomy", "run", "--workspace-root", str(self.tmp),
                           "--max-cycles", "1", "--output", "full", "--artifact", str(artifact)])

        self.assertEqual(rc, 0)
        self.assertLessEqual(len(output.getvalue().encode("utf-8")), SUMMARY_STDOUT_MAX_BYTES)
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["full_result_artifact"], str(artifact))
        self.assertNotIn("full_result", payload)
        self.assertEqual(payload["memory_learning"]["reported_observation_counts"]["already_recorded_receipts"], 4)
        self.assertGreater(payload["memory_learning"]["omitted_observation_count"], 0)
        self.assertEqual(artifact.read_bytes(), (json.dumps(result, indent=2, sort_keys=True) + "\n").encode())

    def test_stdout_ceiling_includes_printed_newline(self) -> None:
        from aria_kernel.runtime_artifacts import SUMMARY_STDOUT_MAX_BYTES, autonomy_output_summary

        result = {"per_cycle": [], "exits_clean": True, "exit_reason": ""}
        summary = autonomy_output_summary(result, base_dir=self.base, workspace_root=self.tmp)
        result["exit_reason"] = "x" * (SUMMARY_STDOUT_MAX_BYTES - len(json.dumps(summary, indent=2, sort_keys=True).encode()))
        with patch("aria_kernel.autonomy_orchestrator.run_autonomy_orchestrator", return_value=result), redirect_stdout(io.StringIO()) as output:
            rc = cli_main(["--tools-dir", str(self.base), "autonomy", "run", "--workspace-root", str(self.tmp), "--max-cycles", "1"])
        self.assertEqual(rc, 4)
        self.assertEqual(json.loads(output.getvalue())["error"], "summary_stdout_exceeds_32kb")
        self.assertLessEqual(len(output.getvalue().encode("utf-8")), SUMMARY_STDOUT_MAX_BYTES)

    def test_essential_memory_summary_overflow_remains_explicit_contract_error(self) -> None:
        from aria_kernel.runtime_artifacts import SUMMARY_STDOUT_MAX_BYTES

        result = {"per_cycle": [{"memory_hook": {"status": "needs_signing"}}],
                  "exits_clean": True, "exit_reason": "x" * SUMMARY_STDOUT_MAX_BYTES}
        with patch("aria_kernel.autonomy_orchestrator.run_autonomy_orchestrator", return_value=result), redirect_stdout(io.StringIO()) as output:
            rc = cli_main(["--tools-dir", str(self.base), "autonomy", "run", "--workspace-root", str(self.tmp), "--max-cycles", "1"])
        self.assertEqual(rc, 4)
        self.assertEqual(json.loads(output.getvalue())["overall_status"], "contract_error")
        self.assertEqual(json.loads(output.getvalue())["error"], "summary_stdout_exceeds_32kb")
        self.assertLessEqual(len(output.getvalue().encode("utf-8")), SUMMARY_STDOUT_MAX_BYTES)

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
