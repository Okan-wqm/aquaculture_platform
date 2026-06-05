from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.evidence_trust import (
    is_self_output_path,
    recompute_artifact_hash,
    verify_hash_bound_artifact_ref,
    verify_retention_event_structure,
    verify_workflow_dlp_token_evidence,
)


class EvidenceTrustTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-evidence-trust-"))
        self.tools = self.tmp / "aria-tools"
        self.tools.mkdir()

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_hash_bound_artifact_ref_recomputes_hash_from_bytes(self) -> None:
        artifact = self.tools / "proof.json"
        artifact.write_text('{"ok":true}\n', encoding="utf-8")
        ref = {
            "artifact_id": "proof-1",
            "source_surface": "runtime_artifact",
            "uri": "proof.json",
            "sha256": recompute_artifact_hash(artifact),
        }

        self.assertEqual(verify_hash_bound_artifact_ref(ref, root=self.tools), [])

        artifact.write_text('{"ok":false}\n', encoding="utf-8")
        issues = verify_hash_bound_artifact_ref(ref, root=self.tools)

        self.assertIn("proof_artifact_hash_mismatch", {issue["code"] for issue in issues})

    def test_caller_proof_string_is_not_authority(self) -> None:
        issues = verify_hash_bound_artifact_ref("proof passed: sha256:abc", root=self.tools)

        self.assertEqual([issue["code"] for issue in issues], ["proof_ref_not_structured"])

    def test_missing_source_surface_is_not_trusted_proof(self) -> None:
        artifact = self.tools / "proof.json"
        artifact.write_text("proof\n", encoding="utf-8")
        ref = {
            "artifact_id": "proof-2",
            "uri": "proof.json",
            "sha256": recompute_artifact_hash(artifact),
        }

        issues = verify_hash_bound_artifact_ref(ref, root=self.tools)

        self.assertIn("proof_source_surface_missing", {issue["code"] for issue in issues})

    def test_worktree_and_self_output_surfaces_are_not_enterprise_trusted(self) -> None:
        artifact = self.tools / "proof.json"
        artifact.write_text("proof\n", encoding="utf-8")
        base_ref = {
            "artifact_id": "proof-3",
            "uri": "proof.json",
            "sha256": recompute_artifact_hash(artifact),
        }

        for surface in ("worktree", "self_output"):
            issues = verify_hash_bound_artifact_ref(
                {**base_ref, "source_surface": surface},
                root=self.tools,
            )
            self.assertIn("proof_source_surface_untrusted", {issue["code"] for issue in issues})

        self.assertTrue(is_self_output_path("src/../aria-tools/proof.json"))

    def test_workspace_file_path_cannot_satisfy_trusted_artifact_ref_by_default(self) -> None:
        workspace = self.tmp / "workspace"
        workspace.mkdir()
        proof = workspace / "proof.json"
        proof.write_text("proof\n", encoding="utf-8")
        ref = {
            "artifact_id": "proof-4",
            "source_surface": "runtime_artifact",
            "uri": proof.as_posix(),
            "sha256": recompute_artifact_hash(proof),
        }

        issues = verify_hash_bound_artifact_ref(ref, root=self.tools, workspace_root=workspace)

        self.assertIn("proof_artifact_path_escape", {issue["code"] for issue in issues})

    def test_retention_event_structure_rejects_unreviewed_unapproved_event(self) -> None:
        issues = verify_retention_event_structure(
            {
                "schema_version": 1,
                "event": "artifact_archived",
                "artifact_id": "artifact-1",
                "original_path": "run-artifacts/hot/a.json",
                "new_path": ".archive/runtime/a.json",
                "sha256": "caller-said-ok",
                "reason": "retention",
            }
        )

        self.assertIn("retention_event_hash_invalid", {issue["code"] for issue in issues})
        self.assertIn("retention_event_operator_approval_missing", {issue["code"] for issue in issues})
        self.assertIn("retention_event_review_missing", {issue["code"] for issue in issues})

    def test_workflow_dlp_token_evidence_is_structural(self) -> None:
        issues = verify_workflow_dlp_token_evidence(
            {
                "schema_version": 1,
                "valid": True,
                "dlp_scan_clean": False,
                "token_provenance": "github_actions_default_token",
                "workflow_hash": "caller-said-ok",
                "contract_hash": "sha256:" + "0" * 64,
                "network_policy": ["github_artifact"],
                "runtime_write_paths": ["runner-temp/aria-operational-proof"],
            },
            expected_token_source="github_actions_artifact_token",
            expected_network_policy=("github_artifact",),
            expected_runtime_write_paths=("runner-temp/aria-operational-proof",),
        )

        codes = {issue["code"] for issue in issues}
        self.assertIn("workflow_proof_dlp_not_clean", codes)
        self.assertIn("workflow_proof_token_provenance_mismatch", codes)
        self.assertIn("workflow_proof_workflow_hash_invalid", codes)


if __name__ == "__main__":
    unittest.main()
