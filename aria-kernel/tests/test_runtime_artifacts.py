from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import raw_findings_path
from aria_kernel.integrity import verify_integrity
from aria_kernel.ledger import append_jsonl, load_jsonl
from aria_kernel.runtime_artifacts import (
    approve_runtime_v2_promotion,
    resolve_finding_from_artifact,
    restore_artifact,
    retention_apply,
    retention_dry_run,
    verify_artifacts,
)
from aria_kernel.tool_health import record_run, runs_path
from aria_kernel.tool_registry import register_tool


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
            "argv": ["python3", "-c", "print('{}')"],
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
        register_tool(_tool(), base_dir=self.tools)
        evidence_bundle = self.tools / "runtime" / "v2-promotion-evidence.json"
        evidence_bundle.parent.mkdir(parents=True, exist_ok=True)
        evidence_bundle.write_text(
            '{"operator_approval_ref":"test","target_sha":"test-sha"}',
            encoding="utf-8",
        )
        approve_runtime_v2_promotion(
            evidence_bundle=evidence_bundle,
            base_dir=self.tools,
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

    def test_retention_requires_acknowledge_and_restores_archive(self) -> None:
        record_run(_run(cycle_id="cycle-old"), base_dir=self.tools)
        plan = retention_dry_run(base_dir=self.tools, retain_hot_cycles=0)
        self.assertEqual(plan["candidate_count"], 1)
        with self.assertRaises(Exception):
            retention_apply(base_dir=self.tools, retain_hot_cycles=0)
        applied = retention_apply(base_dir=self.tools, retain_hot_cycles=0, acknowledge=True)
        self.assertEqual(applied["archived_count"], 1)
        artifact_id = applied["archived"][0]["artifact_id"]
        restored = restore_artifact(base_dir=self.tools, artifact_ref=artifact_id)
        self.assertEqual(restored["status"], "restored")


if __name__ == "__main__":
    unittest.main()
