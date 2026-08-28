"""E21-a — one surface, one writer, one schema.

Every test here fails if the corresponding guard is removed:

* the second writer cannot come back — ``validation`` refuses the runs
  path outright, and no longer exposes a duplicate reader;
* ``status`` and ``duration_ms`` are stamped by the writer, so the
  observability dashboard stops reporting ledger rows as failures;
* the dashboard REFUSES a row missing either field instead of silently
  counting it as failed (the pre-E21-a lie) or as ok (the opposite lie);
* a run cannot be recorded against a change or a commit that does not
  exist, so the merge gate's read cannot be satisfied by a placeholder.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel import validation
from aria_kernel.change_ledger import emit_change_committed, emit_change_planned
from aria_kernel.observability import (
    generate_observability_dashboard,
    record_cycle_metrics,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.validation import run_validation_commands
from aria_kernel.validation_runs_ledger import (
    VALIDATION_RUN_SCHEMA,
    classify_validation_run_status,
    derive_validation_run_status,
    list_validation_runs,
    list_validation_runs_for_change,
    record_validation_run,
    validation_run_duration_ms,
    validation_runs_path,
    verify_validation_run,
)
from tests._helpers.declared_fixtures import append_declared_fixture


def _git(root: Path, args: list[str]) -> str:
    return subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, text=True,
    ).stdout.strip()


class UnifiedValidationRunSurfaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        (self.root / "seed.txt").write_text("seed\n", encoding="utf-8")
        _git(self.root, ["init", "-q"])
        _git(self.root, ["config", "user.email", "aria@example.invalid"])
        _git(self.root, ["config", "user.name", "ARIA"])
        _git(self.root, ["add", "."])
        _git(self.root, ["commit", "-q", "-m", "init"])
        self.commit_sha = _git(self.root, ["rev-parse", "HEAD"])
        self.base = Path(self.tmp.name) / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        planned = emit_change_planned(
            plan_id="plan-e21a",
            finding_id="F-e21a",
            intended_affected_files=["seed.txt"],
            intended_validation_refs=["python3 -m unittest --help"],
            architectural_tier=1,
            base_dir=self.base,
        )
        self.change_id = planned["change_id"]
        emit_change_committed(
            change_id=self.change_id,
            commit_sha=self.commit_sha,
            actual_affected_files=["seed.txt"],
            base_dir=self.base,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _run(self, command: str = "python3 -m unittest --help") -> dict:
        return run_validation_commands(
            commands=[command],
            workspace_root=self.root,
            change_id=self.change_id,
            commit_sha=self.commit_sha,
            runner_identity="ci-executor:e21a",
            change_author_identity="agent:planner-e21a",
            base_dir=self.base,
            cycle_id="cycle-e21a",
        )

    # ---- one writer -------------------------------------------------

    def test_lane_a_rows_are_readable_by_the_merge_gate(self) -> None:
        """The defect: Lane-A rows carried no change_id, so the gate's
        ``list_validation_runs_for_change`` never saw them."""
        plan = self._run()
        self.assertEqual(plan["status"], "ok")
        rows = list_validation_runs_for_change(self.change_id, base_dir=self.base)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["commit_sha"], self.commit_sha)
        self.assertEqual(rows[0]["runner_identity"], "ci-executor:e21a")
        self.assertEqual(rows[0]["$schema"], VALIDATION_RUN_SCHEMA)
        # The log the ledger hash-bound is verifiable, not an opaque path.
        verify_validation_run(rows[0]["validation_run_id"], base_dir=self.base)

    def test_validation_module_refuses_to_write_the_runs_surface(self) -> None:
        """Deliberate break: delete the refusal and a second writer with a
        second schema can re-open the surface."""
        runs_file = validation_runs_path(self.base)
        with self.assertRaises(GovernanceError) as ctx:
            validation.append_jsonl(runs_file, {"schema_version": 1})
        self.assertIn("validation_surface_owned_elsewhere", str(ctx.exception))
        with self.assertRaises(GovernanceError):
            validation.load_jsonl(runs_file)

    def test_validation_module_no_longer_exposes_a_duplicate_reader(self) -> None:
        self.assertFalse(hasattr(validation, "list_validation_runs"))

    # ---- status + duration are stamped, never guessed ----------------

    def test_status_is_derived_from_exit_code_and_timeout(self) -> None:
        self.assertEqual(
            derive_validation_run_status(exit_code=0, timed_out=False), "ok",
        )
        self.assertEqual(
            derive_validation_run_status(exit_code=1, timed_out=False), "failed",
        )
        self.assertEqual(
            derive_validation_run_status(exit_code=None, timed_out=True), "timeout",
        )

    def test_failing_command_records_a_failed_row(self) -> None:
        plan = self._run("python3 -m unittest aria_missing_module_e21a")
        self.assertEqual(plan["status"], "failed")
        row = list_validation_runs(base_dir=self.base)[-1]
        self.assertEqual(classify_validation_run_status(row), "failed")
        self.assertNotEqual(row["exit_code"], 0)

    def test_timeout_row_carries_no_exit_code(self) -> None:
        log = Path(self.tmp.name) / "timeout.log"
        log.write_text("killed\n", encoding="utf-8")
        row = record_validation_run(
            change_id=self.change_id,
            cmd="python3 -m unittest --help",
            exit_code=None,
            timed_out=True,
            duration_ms=120_000,
            log_path=str(log),
            commit_sha=self.commit_sha,
            runner_identity="ci-executor:e21a",
            started_at="2026-08-01T00:00:00+00:00",
            completed_at="2026-08-01T00:02:00+00:00",
            base_dir=self.base,
        )
        self.assertEqual(row["status"], "timeout")
        with self.assertRaises(GovernanceError) as ctx:
            record_validation_run(
                change_id=self.change_id,
                cmd="x",
                exit_code=0,
                timed_out=True,
                duration_ms=1,
                log_path=str(log),
                commit_sha=self.commit_sha,
                runner_identity="ci-executor:e21a",
                started_at="2026-08-01T00:00:00+00:00",
                completed_at="2026-08-01T00:02:00+00:00",
                base_dir=self.base,
            )
        self.assertIn("timeout_exit_code_must_be_absent", str(ctx.exception))

    def test_duration_ms_is_required(self) -> None:
        log = Path(self.tmp.name) / "d.log"
        log.write_text("x\n", encoding="utf-8")
        with self.assertRaises(GovernanceError) as ctx:
            record_validation_run(
                change_id=self.change_id,
                cmd="x",
                exit_code=0,
                duration_ms=-1,
                log_path=str(log),
                commit_sha=self.commit_sha,
                runner_identity="ci-executor:e21a",
                started_at="2026-08-01T00:00:00+00:00",
                completed_at="2026-08-01T00:00:01+00:00",
                base_dir=self.base,
            )
        self.assertIn("duration_ms_required", str(ctx.exception))

    def test_commit_sha_must_be_hex(self) -> None:
        log = Path(self.tmp.name) / "h.log"
        log.write_text("x\n", encoding="utf-8")
        with self.assertRaises(GovernanceError) as ctx:
            record_validation_run(
                change_id=self.change_id,
                cmd="x",
                exit_code=0,
                duration_ms=1,
                log_path=str(log),
                commit_sha="PLACEHOLDER",
                runner_identity="ci-executor:e21a",
                started_at="2026-08-01T00:00:00+00:00",
                completed_at="2026-08-01T00:00:01+00:00",
                base_dir=self.base,
            )
        self.assertIn("commit_sha_not_hex", str(ctx.exception))

    # ---- the dashboard stops lying -----------------------------------

    def test_dashboard_counts_ledger_rows_as_passing(self) -> None:
        """The live miscount: every ledger-written row was reported as
        failed because it carried no ``status`` key."""
        self._run()
        self._run()
        record_cycle_metrics(
            cycle_id="cycle-e21a",
            phase_durations_ms={"validate": 10},
            artifact_count=1,
            status="ok",
            base_dir=self.base,
        )
        dashboard = generate_observability_dashboard(
            cycle_id="cycle-e21a", base_dir=self.base,
        )
        self.assertEqual(dashboard["validation"]["run_count"], 2)
        self.assertEqual(dashboard["validation"]["failed_count"], 0)
        self.assertEqual(dashboard["validation"]["status_counts"], {"ok": 2})
        self.assertGreater(dashboard["validation"]["total_duration_ms"], 0)

    def test_ledger_written_passing_run_is_not_reported_as_failed(self) -> None:
        """The lead's red-repro, run green.

        Before E21-a: call ``record_validation_run`` with ``exit_code=0``
        (a PASSING run), then ``generate_observability_dashboard``, and
        the dashboard returned ``{'run_count': 1, 'failed_count': 1,
        'total_duration_ms': 0}`` — the row genuinely carried neither
        ``status`` nor ``duration_ms``, so the reader guessed and guessed
        wrong. Same row, same function, asserted the other way round.
        """
        log = Path(self.tmp.name) / "repro.log"
        log.write_text("passing run output\n", encoding="utf-8")
        record_validation_run(
            change_id=self.change_id,
            cmd="python3 -m unittest --help",
            exit_code=0,
            duration_ms=1_234,
            log_path=str(log),
            commit_sha=self.commit_sha,
            runner_identity="ci-executor:e21a",
            started_at="2026-08-01T00:00:00+00:00",
            completed_at="2026-08-01T00:00:01+00:00",
            base_dir=self.base,
        )
        record_cycle_metrics(
            cycle_id="cycle-e21a",
            phase_durations_ms={"validate": 10},
            artifact_count=1,
            status="ok",
            base_dir=self.base,
        )
        dashboard = generate_observability_dashboard(
            cycle_id="cycle-e21a", base_dir=self.base,
        )
        self.assertEqual(
            {
                "run_count": dashboard["validation"]["run_count"],
                "failed_count": dashboard["validation"]["failed_count"],
                "total_duration_ms": dashboard["validation"]["total_duration_ms"],
            },
            {"run_count": 1, "failed_count": 0, "total_duration_ms": 1_234},
        )

    def test_dashboard_refuses_a_row_without_status(self) -> None:
        """Deliberate break: restore the ``status not in ("ok",)``
        expression and this row is silently counted as a failure."""
        self._run()
        append_declared_fixture(
            validation_runs_path(self.base),
            {
                "schema_version": 1,
                "validation_run_id": "vrun-legacy",
                "change_id": self.change_id,
                "cmd": "legacy",
                "exit_code": 0,
                "duration_ms": 5,
                "log_path": "/nowhere.log",
                "log_hash": "sha256:" + "0" * 64,
                "commit_sha": self.commit_sha,
                "runner_identity": "legacy",
            },
            expected_surface="validation_runs",
        )
        record_cycle_metrics(
            cycle_id="cycle-e21a",
            phase_durations_ms={"validate": 10},
            artifact_count=1,
            status="ok",
            base_dir=self.base,
        )
        with self.assertRaises(GovernanceError) as ctx:
            generate_observability_dashboard(
                cycle_id="cycle-e21a", base_dir=self.base,
            )
        self.assertIn("validation_run_status_missing", str(ctx.exception))

    def test_duration_reader_refuses_a_row_without_duration(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            validation_run_duration_ms({"validation_run_id": "vrun-x"})
        self.assertIn("validation_run_duration_missing", str(ctx.exception))

    # ---- provenance cannot be fabricated -----------------------------

    def test_unknown_change_id_is_refused(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            run_validation_commands(
                commands=["python3 -m unittest --help"],
                workspace_root=self.root,
                change_id="chg_does_not_exist",
                commit_sha=self.commit_sha,
                runner_identity="ci-executor:e21a",
                base_dir=self.base,
            )
        self.assertIn("validation_change_id_unknown", str(ctx.exception))
        self.assertEqual(list_validation_runs(base_dir=self.base), [])

    def test_unresolvable_commit_sha_is_refused(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            run_validation_commands(
                commands=["python3 -m unittest --help"],
                workspace_root=self.root,
                change_id=self.change_id,
                commit_sha="0" * 40,
                runner_identity="ci-executor:e21a",
                base_dir=self.base,
            )
        self.assertIn("validation_commit_sha_unresolvable", str(ctx.exception))
        self.assertEqual(list_validation_runs(base_dir=self.base), [])

    def test_a_resolvable_commit_that_is_not_head_is_refused(self) -> None:
        """ORPHAN-CRITICAL-728 — resolving is not provenance.

        The runs execute in `workspace_root` at HEAD. A sha that merely EXISTS
        in the repository names a tree nothing measured, and the merge gate
        joins on these rows: `apply_engine.run_apply_gate` passed the tip of
        the implementation branch while HEAD sat on the base branch, so the
        suite measured the base, passed, and the ledger claimed the branch.
        """
        (self.root / "seed.txt").write_text("second\n", encoding="utf-8")
        _git(self.root, ["add", "."])
        _git(self.root, ["commit", "-q", "-m", "second"])
        new_head = _git(self.root, ["rev-parse", "HEAD"])
        self.assertNotEqual(new_head, self.commit_sha)

        with self.assertRaises(GovernanceError) as ctx:
            run_validation_commands(
                commands=["python3 -m unittest --help"],
                workspace_root=self.root,
                change_id=self.change_id,
                # A real commit in this repository — just not the one the
                # commands are about to run at.
                commit_sha=self.commit_sha,
                runner_identity="ci-executor:e21a",
                base_dir=self.base,
            )
        self.assertIn("validation_commit_sha_is_not_head", str(ctx.exception))
        self.assertEqual(list_validation_runs(base_dir=self.base), [])

    def test_self_attestation_is_refused_on_the_lane_a_path(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            run_validation_commands(
                commands=["python3 -m unittest --help"],
                workspace_root=self.root,
                change_id=self.change_id,
                commit_sha=self.commit_sha,
                runner_identity="agent:planner-e21a",
                change_author_identity="agent:planner-e21a",
                base_dir=self.base,
            )
        self.assertIn("self_attestation", str(ctx.exception))

    def test_run_logs_land_on_the_declared_surface(self) -> None:
        self._run()
        row = list_validation_runs(base_dir=self.base)[-1]
        log_path = Path(row["log_path"])
        expected_dir = ensure_tools_dir(self.base) / "validation" / "logs"
        self.assertEqual(log_path.parent, expected_dir)
        self.assertTrue(log_path.exists())


if __name__ == "__main__":
    unittest.main()
