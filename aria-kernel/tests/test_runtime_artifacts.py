from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import raw_findings_path
from aria_kernel.integrity import verify_integrity
from aria_kernel.ledger import append_jsonl, load_jsonl
from aria_kernel.runtime_artifacts import (
    approve_runtime_v2_promotion,
    resolve_artifact_payload,
    resolve_finding_from_artifact,
    restore_artifact,
    retention_apply,
    retention_dry_run,
    verify_artifacts,
)
from aria_kernel.tool_health import record_run, runs_path
from aria_kernel.tool_registry import ensure_tools_binding, register_tool

FAKE_RUNNER = Path(__file__).resolve().parent / "_helpers" / "fake_tool_runner.py"


def _tool() -> dict:
    return {
        "tool_id": "runtime-adapter",
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": ["apps/farm-service/src/**/*.ts"],
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": "fixtures/runtime-adapter",
        "health_thresholds": {"max_cost_units": 50},
        "allowed_read_globs": ["apps/farm-service/src/**/*.ts"],
        "forbidden_read_globs": ["dist/**"],
        "claim_types": ["schema_drift"],
        "owner": "platform",
        "runner": {
            "type": "subprocess",
            "argv": ["python3", FAKE_RUNNER.as_posix()],
            "cwd": ".",
            "timeout_ms": 1000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }


def _run(**overrides) -> dict:
    finding = {
        "id": "finding-1",
        "rule": "runtime-test",
        "severity": "high",
        "path": "apps/farm-service/src/app.module.ts",
        "message": "runtime artifact test",
        "evidence": [{"path": "apps/farm-service/src/app.module.ts"}],
    }
    run = {
        "run_id": "run-1",
        "tool_id": "runtime-adapter",
        "cycle_id": "cycle-1",
        "status": "ok",
        "input_hash": "sha256:input",
        "output_hash": "sha256:output",
        "read_paths": ["apps/farm-service/src/app.module.ts"],
        "emitted_observations": [],
        "emitted_findings": [],
        "raw_findings": [finding],
        "evidence_validation": {"evidence_sources": ["apps/farm-service/src/app.module.ts"]},
        "operator_feedback_refs": [],
        "duration_ms": 25,
        "cost_units": 1,
        "schema_version": 1,
        "runner": {"raw_findings_count": 1, "raw_findings_sample": [finding]},
        "_runtime_artifact_payload": {
            "stdout": "{\"findings\":[]}",
            "stderr": "",
            "parsed_output": {},
            "raw_findings": [finding],
            "raw_observations": [],
        },
    }
    run.update(overrides)
    return run


class RuntimeArtifactTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-runtime-artifacts-"))
        self.tools = self.tmp / "aria-tools"
        self.old_format = os.environ.get("ARIA_RUN_LEDGER_FORMAT")
        os.environ["ARIA_RUN_LEDGER_FORMAT"] = "v2"
        self.repo_root = Path(__file__).resolve().parents[2]
        ensure_tools_binding(self.tools, workspace_root=self.repo_root)
        register_tool(_tool(), base_dir=self.tools)
        target_sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=self.repo_root,
            text=True,
        ).strip()
        evidence_bundle = self.tools / "runtime" / "v2-promotion-evidence.json"
        evidence_bundle.parent.mkdir(parents=True, exist_ok=True)
        evidence_bundle.write_text(
            json.dumps({"operator_approval_ref": "test", "target_sha": target_sha}),
            encoding="utf-8",
        )
        approve_runtime_v2_promotion(
            evidence_bundle=evidence_bundle,
            base_dir=self.tools,
            workspace_root=self.repo_root,
            operator_approval_ref="test",
        )

    def tearDown(self) -> None:
        import shutil
        if self.old_format is None:
            os.environ.pop("ARIA_RUN_LEDGER_FORMAT", None)
        else:
            os.environ["ARIA_RUN_LEDGER_FORMAT"] = self.old_format
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_record_run_writes_artifact_backed_v2_rows(self) -> None:
        record_run(_run(), base_dir=self.tools)

        run_row = load_jsonl(runs_path(self.tools))[-1]
        self.assertEqual(run_row["schema_version"], 2)
        self.assertEqual(run_row["artifact_status"], "present")
        self.assertIsInstance(run_row["artifact_ref"], dict)
        self.assertEqual(verify_artifacts(base_dir=self.tools)["status"], "ok")

        raw_row = load_jsonl(raw_findings_path(self.tools))[-1]
        self.assertEqual(raw_row["schema_version"], 2)
        self.assertNotIn("finding", raw_row)
        self.assertEqual(raw_row["json_pointer"], "/payload/raw_findings/0")
        resolved = resolve_finding_from_artifact(raw_row, base_dir=self.tools)
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved["id"], "finding-1")

    def test_missing_artifact_fails_integrity(self) -> None:
        record_run(_run(), base_dir=self.tools)
        run_row = load_jsonl(runs_path(self.tools))[-1]
        artifact_path = self.tools / run_row["artifact_ref"]["uri"]
        artifact_path.unlink()

        artifact_result = verify_artifacts(base_dir=self.tools)
        self.assertEqual(artifact_result["status"], "drift")
        self.assertEqual(artifact_result["issues"][0]["code"], "run_artifact_missing")
        integrity = verify_integrity(tools_dir=self.tools)
        self.assertEqual(integrity["status"], "drift")

    def test_resolve_artifact_payload_requires_strict_v2_ref(self) -> None:
        record_run(_run(), base_dir=self.tools)
        run_row = load_jsonl(runs_path(self.tools))[-1]
        artifact_ref = dict(run_row["artifact_ref"])

        self.assertIsNotNone(resolve_artifact_payload(artifact_ref, base_dir=self.tools))
        self.assertIsNone(resolve_artifact_payload({**artifact_ref, "hash": artifact_ref["sha256"]}, base_dir=self.tools))
        self.assertIsNone(resolve_artifact_payload({**artifact_ref, "source_surface": ["runtime_artifact"]}, base_dir=self.tools))

    def test_retention_requires_acknowledge_and_restores_archive(self) -> None:
        record_run(_run(cycle_id="cycle-old"), base_dir=self.tools)
        plan = retention_dry_run(base_dir=self.tools, retain_hot_cycles=0)
        self.assertEqual(plan["candidate_count"], 1)
        with self.assertRaises(Exception):
            retention_apply(base_dir=self.tools, retain_hot_cycles=0)
        applied = retention_apply(
            base_dir=self.tools,
            retain_hot_cycles=0,
            acknowledge=True,
            workspace_root=self.repo_root,
            reason="unit-test-retention",
            operator_approval_ref="test-approval",
        )
        self.assertEqual(applied["archived_count"], 1)
        artifact_id = applied["archived"][0]["artifact_id"]
        restored = restore_artifact(
            base_dir=self.tools,
            artifact_ref=artifact_id,
            workspace_root=self.repo_root,
            reason="unit-test-restore",
            operator_approval_ref="test-approval",
        )
        self.assertEqual(restored["status"], "restored")


class AutonomySummaryDerivedCountersTests(unittest.TestCase):
    """ORPHAN-HIGH-424 — the operator-facing counters must be derived.

    ``incomplete_lifecycle_count`` was pinned to 0 in ``cycle.py`` and then
    summed here, and ``warning_count``/``suppressed_count``/
    ``truncated_count`` were locals initialised to 0 that nothing ever
    incremented. Four fields reached the operator incapable of being
    non-zero, which is how a run could report ``overall_status: ok`` with
    ``warning_count: 0`` on top of an abandoned cycle. No test covered
    this function before, which is how the pinned zeros survived.
    """

    @staticmethod
    def _result(**cycle_overrides: object) -> dict:
        cycle: dict = {
            "cycle_id": "cyc-1",
            "runtime_status": "ok",
            "incomplete_lifecycle_count": 0,
            "cycle_lifecycle": {"valid": True, "incomplete_count": 0},
            "tool_run_summary": [{"tool_id": "t", "status": "ok"}],
        }
        cycle.update(cycle_overrides)
        return {"per_cycle": [{"cycle": cycle}]}

    def test_clean_cycle_reports_no_warnings(self) -> None:
        from aria_kernel.runtime_artifacts import autonomy_output_summary

        summary = autonomy_output_summary(self._result())
        self.assertEqual(summary["overall_status"], "ok")
        self.assertEqual(summary["warning_count"], 0)
        self.assertEqual(summary["warnings"], [])
        self.assertEqual(summary["incomplete_lifecycle_count"], 0)

    def test_abandoned_cycle_surfaces_in_count_and_warnings(self) -> None:
        from aria_kernel.runtime_artifacts import autonomy_output_summary

        summary = autonomy_output_summary(self._result(
            incomplete_lifecycle_count=2,
            cycle_lifecycle={"valid": False, "incomplete_count": 2},
        ))
        self.assertEqual(summary["incomplete_lifecycle_count"], 2)
        self.assertGreaterEqual(summary["warning_count"], 1)
        self.assertIn(
            "incomplete_cycle_lifecycle",
            [w["code"] for w in summary["warnings"]],
        )

    def test_unreadable_cycle_ledger_is_its_own_warning(self) -> None:
        """A 0 count with valid=False must not read as "no incomplete cycles"."""
        from aria_kernel.runtime_artifacts import autonomy_output_summary

        summary = autonomy_output_summary(self._result(
            cycle_lifecycle={
                "valid": False,
                "incomplete_count": 0,
                "ledger_integrity_error": "Invalid JSONL at cycles.jsonl:7",
            },
        ))
        self.assertEqual(summary["incomplete_lifecycle_count"], 0)
        codes = [w["code"] for w in summary["warnings"]]
        self.assertIn("cycle_lifecycle_unreadable", codes)

    def test_artifact_hash_drift_warns_but_absent_refs_do_not(self) -> None:
        from aria_kernel.runtime_artifacts import autonomy_output_summary

        drift = autonomy_output_summary(self._result(
            artifact_refs=[{"verification_status": "mismatch"}],
        ))
        self.assertIn(
            "artifact_hash_drift", [w["code"] for w in drift["warnings"]],
        )
        # "none" (no refs to verify) is not an anomaly.
        self.assertEqual(autonomy_output_summary(self._result())["warning_count"], 0)

    def test_suppressed_and_truncated_markers_are_summed(self) -> None:
        from aria_kernel.runtime_artifacts import autonomy_output_summary

        summary = autonomy_output_summary(self._result(
            findings_suppressed=4,
            tool_run_summary=[
                {"tool_id": "t", "status": "ok", "prompt_truncated": True},
                {"tool_id": "u", "status": "ok", "truncated_count": 3},
            ],
        ))
        self.assertEqual(summary["suppressed_count"], 4)
        # True counts as one truncation, plus the reported 3.
        self.assertEqual(summary["truncated_count"], 4)


class CycleLifecycleStatusTests(unittest.TestCase):
    """ORPHAN-HIGH-424 — the count cycle.py reports must be real."""

    def test_started_without_terminal_is_counted(self) -> None:
        from aria_kernel.integrity import cycle_lifecycle_status

        with tempfile.TemporaryDirectory(prefix="aria-lifecycle-") as tmp:
            base = Path(tmp) / "aria-tools"
            base.mkdir(parents=True, exist_ok=True)
            cycles = base / "cycles.jsonl"
            append_jsonl(cycles, {"cycle_id": "cyc-open", "event": "started", "at": "2026-07-01T00:00:00Z"})
            append_jsonl(cycles, {"cycle_id": "cyc-done", "event": "started", "at": "2026-07-02T00:00:00Z"})
            append_jsonl(cycles, {"cycle_id": "cyc-done", "event": "completed", "at": "2026-07-02T00:05:00Z"})
            status = cycle_lifecycle_status(base)
            self.assertFalse(status["valid"])
            self.assertEqual(status["incomplete_count"], 1)
            self.assertEqual(
                [row["cycle_id"] for row in status["incomplete_cycles"]], ["cyc-open"],
            )

    def test_all_terminal_is_valid(self) -> None:
        from aria_kernel.integrity import cycle_lifecycle_status

        with tempfile.TemporaryDirectory(prefix="aria-lifecycle-ok-") as tmp:
            base = Path(tmp) / "aria-tools"
            base.mkdir(parents=True, exist_ok=True)
            cycles = base / "cycles.jsonl"
            append_jsonl(cycles, {"cycle_id": "cyc-1", "event": "started", "at": "2026-07-02T00:00:00Z"})
            append_jsonl(cycles, {"cycle_id": "cyc-1", "event": "failed", "at": "2026-07-02T00:05:00Z"})
            status = cycle_lifecycle_status(base)
            self.assertTrue(status["valid"])
            self.assertEqual(status["incomplete_count"], 0)


if __name__ == "__main__":
    unittest.main()
