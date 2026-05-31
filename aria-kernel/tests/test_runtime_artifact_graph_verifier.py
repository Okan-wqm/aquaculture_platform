from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import append_jsonl
from aria_kernel.runtime_artifacts import (
    ARTIFACT_BEARING,
    INTEGRITY_FAILED,
    LIFECYCLE_ONLY,
    classify_cycle_evidence,
    verify_runtime_artifacts,
    write_run_artifact,
)
from aria_kernel.runtime_profile import set_profile


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
        append_jsonl(self.base / "cycles.jsonl", {"cycle_id": "cyc-a", "event": "started", "status": "started"})
        append_jsonl(self.base / "cycles.jsonl", {"cycle_id": "cyc-a", "event": "completed", "status": "completed"})

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
        append_jsonl(self.base / "cycles.jsonl", {"cycle_id": "cyc-b", "event": "started", "status": "started"})
        append_jsonl(self.base / "cycles.jsonl", {"cycle_id": "cyc-b", "event": "completed", "status": "completed"})
        append_jsonl(
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
        )

        result = classify_cycle_evidence(base_dir=self.base, cycle_id="cyc-b")

        self.assertEqual(result["cycle_evidence_class"], ARTIFACT_BEARING)
        self.assertTrue(result["promotion_eligible"])

    def test_hashless_legacy_artifact_ref_fails_integrity(self) -> None:
        artifact = self.base / "legacy.json"
        artifact.write_text("{}", encoding="utf-8")
        append_jsonl(self.base / "cycles.jsonl", {"cycle_id": "cyc-legacy", "event": "started", "status": "started"})
        append_jsonl(self.base / "cycles.jsonl", {"cycle_id": "cyc-legacy", "event": "completed", "status": "completed"})
        append_jsonl(
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
        )

        verify = verify_runtime_artifacts(base_dir=self.base, cycle_id="cyc-legacy")

        self.assertIn("artifact_ref_hashless_legacy", {issue["code"] for issue in verify["issues"]})

    def test_missing_artifact_ref_fails_integrity(self) -> None:
        append_jsonl(self.base / "cycles.jsonl", {"cycle_id": "cyc-c", "event": "started", "status": "started"})
        append_jsonl(self.base / "cycles.jsonl", {"cycle_id": "cyc-c", "event": "completed", "status": "completed"})
        append_jsonl(
            self.base / "runs.jsonl",
            {
                "schema_version": 1,
                "run_id": "run-c",
                "tool_id": "tool-a",
                "cycle_id": "cyc-c",
                "status": "ok",
                "artifact_refs": [
                    {
                        "artifact_id": "missing-artifact",
                        "uri": "missing.json",
                        "sha256": "sha256:" + "0" * 64,
                    }
                ],
                "runner": {"raw_findings_count": 0},
            },
        )

        result = classify_cycle_evidence(base_dir=self.base, cycle_id="cyc-c")
        verify = verify_runtime_artifacts(base_dir=self.base, cycle_id="cyc-c")

        self.assertEqual(result["cycle_evidence_class"], INTEGRITY_FAILED)
        self.assertIn("artifact_ref_missing", {issue["code"] for issue in verify["issues"]})


if __name__ == "__main__":
    unittest.main()
