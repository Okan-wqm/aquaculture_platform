from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from aria_kernel.runtime_artifacts import (
    ARTIFACT_BEARING,
    INTEGRITY_FAILED,
    LIFECYCLE_ONLY,
    classify_cycle_evidence,
    verify_runtime_artifacts,
    write_run_artifact,
)
from aria_kernel.runtime_profile import set_profile
from tests._helpers.declared_fixtures import append_declared_fixture


class RuntimeArtifactGraphVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-artifacts-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        (self.base / "registry.json").write_text('{"tools": []}', encoding="utf-8")

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_completed_no_tool_artifacts_is_lifecycle_only(self) -> None:
        append_declared_fixture(self.base / "cycles.jsonl", {"cycle_id": "cyc-a", "event": "started", "status": "started"}, expected_surface="cycles")
        append_declared_fixture(self.base / "cycles.jsonl", {"cycle_id": "cyc-a", "event": "completed", "status": "completed"}, expected_surface="cycles")

        result = classify_cycle_evidence(base_dir=self.base, cycle_id="cyc-a")

        self.assertEqual(result["cycle_evidence_class"], LIFECYCLE_ONLY)
        self.assertFalse(result["promotion_eligible"])

    def test_ok_run_with_existing_artifact_is_artifact_bearing(self) -> None:
        (self.base / "registry.json").write_text(
            '{"tools": [{"tool_id": "tool-a", "status": "ACTIVE"}]}',
            encoding="utf-8",
        )
        artifact = write_run_artifact(
            base_dir=self.base,
            run_id="run-b",
            cycle_uid="cyc-b",
            tool_id="tool-a",
            kind="tool_run",
            payload={"raw_findings": []},
            run_status="ok",
        )
        append_declared_fixture(self.base / "cycles.jsonl", {"cycle_id": "cyc-b", "event": "started", "status": "started"}, expected_surface="cycles")
        append_declared_fixture(self.base / "cycles.jsonl", {"cycle_id": "cyc-b", "event": "completed", "status": "completed"}, expected_surface="cycles")
        append_declared_fixture(
            self.base / "runs.jsonl",
            {
                "schema_version": 2,
                "run_id": "run-b",
                "tool_id": "tool-a",
                "cycle_id": "cyc-b",
                "status": "ok",
                "artifact_ref": artifact["artifact_ref"],
                "artifact_refs": [artifact["artifact_ref"]],
                "artifact_hash": artifact["artifact_hash"],
                "artifact_status": artifact["artifact_status"],
                "runner": {"raw_findings_count": 0},
            },
            expected_surface="runs",
        )

        result = classify_cycle_evidence(base_dir=self.base, cycle_id="cyc-b")

        self.assertEqual(result["cycle_evidence_class"], ARTIFACT_BEARING)
        self.assertTrue(result["promotion_eligible"])

    def test_hashless_legacy_artifact_ref_fails_integrity(self) -> None:
        artifact = self.base / "legacy.json"
        artifact.write_text("{}", encoding="utf-8")
        append_declared_fixture(self.base / "cycles.jsonl", {"cycle_id": "cyc-legacy", "event": "started", "status": "started"}, expected_surface="cycles")
        append_declared_fixture(self.base / "cycles.jsonl", {"cycle_id": "cyc-legacy", "event": "completed", "status": "completed"}, expected_surface="cycles")
        append_declared_fixture(
            self.base / "runs.jsonl",
            {
                "schema_version": 1,
                "run_id": "run-legacy",
                "tool_id": "tool-a",
                "cycle_id": "cyc-legacy",
                "status": "ok",
                "artifact_refs": ["legacy.json"],
                "runner": {"raw_findings_count": 0},
            },
            expected_surface="runs",
        )

        verify = verify_runtime_artifacts(base_dir=self.base, cycle_id="cyc-legacy")

        self.assertIn("artifact_ref_hashless_legacy", {issue["code"] for issue in verify["issues"]})

    def test_missing_artifact_ref_fails_integrity(self) -> None:
        append_declared_fixture(self.base / "cycles.jsonl", {"cycle_id": "cyc-c", "event": "started", "status": "started"}, expected_surface="cycles")
        append_declared_fixture(self.base / "cycles.jsonl", {"cycle_id": "cyc-c", "event": "completed", "status": "completed"}, expected_surface="cycles")
        append_declared_fixture(
            self.base / "runs.jsonl",
            {
                "schema_version": 1,
                "run_id": "run-c",
                "tool_id": "tool-a",
                "cycle_id": "cyc-c",
                "status": "ok",
                "artifact_refs": [
                    {
                        "schema_version": 2,
                        "artifact_id": "missing-artifact",
                        "uri": "missing.json",
                        "sha256": "sha256:" + "0" * 64,
                        "content_type": "application/json",
                        "produced_by_workflow_run_id": "run-1",
                        "source_surface": "runtime_artifact",
                    }
                ],
                "runner": {"raw_findings_count": 0},
            },
            expected_surface="runs",
        )

        result = classify_cycle_evidence(base_dir=self.base, cycle_id="cyc-c")
        verify = verify_runtime_artifacts(base_dir=self.base, cycle_id="cyc-c")

        self.assertEqual(result["cycle_evidence_class"], INTEGRITY_FAILED)
        self.assertIn("artifact_ref_missing", {issue["code"] for issue in verify["issues"]})

    def test_artifact_ref_v2_rejects_legacy_aliases_and_list_surface(self) -> None:
        artifact = self.base / "artifact.json"
        artifact.write_text("{}", encoding="utf-8")
        sha = "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest()
        append_declared_fixture(self.base / "cycles.jsonl", {"cycle_id": "cyc-v2", "event": "completed", "status": "completed"}, expected_surface="cycles")
        append_declared_fixture(
            self.base / "runs.jsonl",
            {
                "schema_version": 2,
                "run_id": "run-v2",
                "tool_id": "tool-a",
                "cycle_id": "cyc-v2",
                "status": "ok",
                "artifact_refs": [
                    {
                        "schema_version": 2,
                        "artifact_id": "bad-alias",
                        "uri": "artifact.json",
                        "sha256": sha,
                        "content_type": "application/json",
                        "produced_by_workflow_run_id": "run-1",
                        "source_surface": "runtime_artifact",
                        "hash": sha,
                    },
                    {
                        "schema_version": 2,
                        "artifact_id": "bad-list-surface",
                        "uri": "artifact.json",
                        "sha256": sha,
                        "content_type": "application/json",
                        "produced_by_workflow_run_id": "run-1",
                        "source_surface": ["runtime_artifact"],
                    },
                    {
                        "schema_version": 2,
                        "artifact_id": "bad-content-hash",
                        "uri": "artifact.json",
                        "sha256": sha,
                        "content_type": "application/json",
                        "produced_by_workflow_run_id": "run-1",
                        "source_surface": "runtime_artifact",
                        "content_hash": sha,
                    },
                    {
                        "schema_version": 2,
                        "artifact_id": "bad-artifact-path",
                        "uri": "artifact.json",
                        "sha256": sha,
                        "content_type": "application/json",
                        "produced_by_workflow_run_id": "run-1",
                        "source_surface": "runtime_artifact",
                        "artifact_path": "artifact.json",
                    },
                    {
                        "schema_version": 2,
                        "artifact_id": "bad-source-surfaces",
                        "uri": "artifact.json",
                        "sha256": sha,
                        "content_type": "application/json",
                        "produced_by_workflow_run_id": "run-1",
                        "source_surface": "runtime_artifact",
                        "source_surfaces": ["runtime_artifact"],
                    },
                    {
                        "schema_version": 2,
                        "artifact_id": "bad-extra",
                        "uri": "artifact.json",
                        "sha256": sha,
                        "content_type": "application/json",
                        "produced_by_workflow_run_id": "run-1",
                        "source_surface": "runtime_artifact",
                        "size_bytes": 2,
                    },
                ],
                "runner": {"raw_findings_count": 0},
            },
            expected_surface="runs",
        )

        verify = verify_runtime_artifacts(base_dir=self.base, cycle_id="cyc-v2")

        codes = {issue["code"] for issue in verify["issues"]}
        self.assertIn("artifact_ref_v2_invalid", codes)

    def test_artifact_ref_v2_rejects_absolute_and_self_output_uris(self) -> None:
        artifact = self.base / "artifact.json"
        artifact.write_text("{}", encoding="utf-8")
        tmp_artifact = self.base / "tmp" / "artifact.json"
        tmp_artifact.parent.mkdir(parents=True)
        tmp_artifact.write_text("{}", encoding="utf-8")
        sha = "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest()
        tmp_sha = "sha256:" + hashlib.sha256(tmp_artifact.read_bytes()).hexdigest()
        append_declared_fixture(self.base / "cycles.jsonl", {"cycle_id": "cyc-uri", "event": "completed", "status": "completed"}, expected_surface="cycles")
        append_declared_fixture(
            self.base / "runs.jsonl",
            {
                "schema_version": 2,
                "run_id": "run-uri",
                "tool_id": "tool-a",
                "cycle_id": "cyc-uri",
                "status": "ok",
                "artifact_refs": [
                    {
                        "schema_version": 2,
                        "artifact_id": "absolute",
                        "uri": artifact.resolve().as_posix(),
                        "sha256": sha,
                        "content_type": "application/json",
                        "produced_by_workflow_run_id": "run-1",
                        "source_surface": "runtime_artifact",
                    },
                    {
                        "schema_version": 2,
                        "artifact_id": "self-output",
                        "uri": "aria-tools/tmp/artifact.json",
                        "sha256": tmp_sha,
                        "content_type": "application/json",
                        "produced_by_workflow_run_id": "run-1",
                        "source_surface": "runtime_artifact",
                    },
                    {
                        "schema_version": 2,
                        "artifact_id": "tmp-prefix",
                        "uri": "tmp/artifact.json",
                        "sha256": tmp_sha,
                        "content_type": "application/json",
                        "produced_by_workflow_run_id": "run-1",
                        "source_surface": "runtime_artifact",
                    },
                ],
                "runner": {"raw_findings_count": 0},
            },
            expected_surface="runs",
        )

        verify = verify_runtime_artifacts(base_dir=self.base, cycle_id="cyc-uri")

        codes = {issue["code"] for issue in verify["issues"]}
        self.assertIn("artifact_ref_absolute_uri_forbidden", codes)
        self.assertIn("artifact_ref_aria_tools_alias_forbidden", codes)
        self.assertIn("artifact_ref_self_output_uri_forbidden", codes)

    def test_artifact_ref_v2_rejects_resolved_workspace_self_output_uri(self) -> None:
        workspace_self_output = self.tmp / "agent-workspace" / "proof.json"
        workspace_self_output.parent.mkdir(parents=True)
        workspace_self_output.write_text("{}", encoding="utf-8")
        sha = "sha256:" + hashlib.sha256(workspace_self_output.read_bytes()).hexdigest()
        append_declared_fixture(self.base / "cycles.jsonl", {"cycle_id": "cyc-traverse", "event": "completed", "status": "completed"}, expected_surface="cycles")
        append_declared_fixture(
            self.base / "runs.jsonl",
            {
                "schema_version": 2,
                "run_id": "run-traverse",
                "tool_id": "tool-a",
                "cycle_id": "cyc-traverse",
                "status": "ok",
                "artifact_refs": [
                    {
                        "schema_version": 2,
                        "artifact_id": "traversal",
                        "uri": "../agent-workspace/proof.json",
                        "sha256": sha,
                        "content_type": "application/json",
                        "produced_by_workflow_run_id": "run-1",
                        "source_surface": "runtime_artifact",
                    },
                ],
                "runner": {"raw_findings_count": 0},
            },
            expected_surface="runs",
        )

        verify = verify_runtime_artifacts(base_dir=self.base, workspace_root=self.tmp, cycle_id="cyc-traverse")

        self.assertIn("artifact_ref_self_output_uri_forbidden", {issue["code"] for issue in verify["issues"]})

    def test_retention_event_recomputes_archive_bytes(self) -> None:
        source = self.base / "artifact.json"
        archive = self.base / ".archive" / "runtime" / "artifact" / "artifact.json"
        archive.parent.mkdir(parents=True)
        source.write_text('{"ok":true}\n', encoding="utf-8")
        archive.write_text('{"ok":true}\n', encoding="utf-8")
        sha = "sha256:" + hashlib.sha256(source.read_bytes()).hexdigest()
        append_declared_fixture(
            self.base / "retention" / "events.jsonl",
            {
                "schema_version": 1,
                "event": "artifact_archived",
                "original_path": "artifact.json",
                "new_path": ".archive/runtime/artifact/artifact.json",
                "sha256": sha,
            },
            expected_surface="retention_events",
        )
        archive.write_text('{"tampered":true}\n', encoding="utf-8")

        verify = verify_runtime_artifacts(base_dir=self.base)

        self.assertIn("retention_archive_hash_mismatch", {issue["code"] for issue in verify["issues"]})


if __name__ == "__main__":
    unittest.main()
