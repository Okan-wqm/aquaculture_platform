from __future__ import annotations

import shutil
import tempfile
import unittest
import json
from pathlib import Path

from aria_kernel.evidence_trust import recompute_artifact_hash
from aria_kernel.enterprise_readiness import (
    evaluate_enterprise_readiness,
    record_artifact_proof,
    record_branch_protection_proof,
    record_dlp_proof,
    record_enterprise_readiness_claim,
    record_remote_cas_proof,
    record_retention_proof,
    record_rollback_proof,
    record_token_proof,
    record_waiver,
    record_workflow_run_proof,
    readiness_source_evidence_path,
)
from aria_kernel.ledger import append_jsonl
from aria_kernel.state_manifest import surface_for_path
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


HEAD_SHA = "a" * 40
OTHER_HEAD_SHA = "b" * 40
TARGET_REF = "refs/heads/main"
REPOSITORY = "acme/aqua"
TOKEN_HASH = "sha256:" + "3" * 64
SNAPSHOT_HASH = "sha256:" + "4" * 64
FUTURE = "2999-06-05T00:00:00Z"
PAST = "2000-06-05T00:00:00Z"


class EnterpriseReadinessProofClosureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-readiness-proof-"))
        self.tools = self.tmp / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _common(self) -> dict:
        return {
            "readiness_claim_id": "ready-42",
            "repository": REPOSITORY,
            "pr_number": 42,
            "target_ref": TARGET_REF,
            "head_ref": "feature/readiness",
            "head_sha": HEAD_SHA,
        }

    def _source_ref(self, row_type: str) -> dict:
        row = append_jsonl(
            readiness_source_evidence_path(base_dir=self.tools),
            {
                "schema_version": 1,
                "row_id": f"source-{row_type}",
                "row_type": row_type,
                "repository": REPOSITORY,
                "pr_number": 42,
                "target_ref": TARGET_REF,
                "head_ref": "feature/readiness",
                "head_sha": HEAD_SHA,
            },
        )
        return {
            "surface": "enterprise_source_evidence",
            "ledger_path": "enterprise/source-evidence.jsonl",
            "row_id": row["row_id"],
            "row_type": row["row_type"],
            "row_hash": row["ledger_hash"],
            "schema_version": 1,
        }

    def _artifact_ref(self, name: str = "readiness.json", payload: dict | None = None) -> dict:
        path = self.tools / "evidence" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload or {"ok": True}, sort_keys=True) + "\n", encoding="utf-8")
        return {
            "artifact_id": f"artifact-{name}",
            "source_surface": "workflow_artifact",
            "uri": f"evidence/{name}",
            "sha256": recompute_artifact_hash(path),
            "content_type": "application/json",
            "produced_by_workflow_run_id": "123",
        }

    def _workflow_evidence_ref(self) -> dict:
        return self._artifact_ref(
            "workflow-proof.json",
            {
                "schema_version": 1,
                "valid": True,
                "dlp_scan_clean": True,
                "token_provenance": "github_actions_artifact_token",
                "workflow_hash": "sha256:" + "5" * 64,
                "contract_hash": "sha256:" + "6" * 64,
                "network_policy": ["github_artifact"],
                "runtime_write_paths": ["runner-temp/aria-operational-proof"],
            },
        ) | {"source_surface": "workflow_preflight_artifact"}

    def _claim(self, **overrides) -> dict:
        artifact_ref = self._artifact_ref()
        claim = {
            **self._common(),
            "workflow_run_ids": [123],
            "artifact_refs": [artifact_ref],
        }
        claim.update(overrides)
        return claim

    def _proof(self, proof_type: str, **overrides) -> dict:
        row = dict(self._common())
        if proof_type == "cas":
            row.update({
                "state": "fresh",
                "lease_id": "cas-lease-1",
                "epoch": 7,
                "expires_at": FUTURE,
            })
        elif proof_type == "branch_protection":
            row.update({
                "required_status_checks": ["ci/test"],
                "required_approving_review_count": 1,
                "snapshot_hash": SNAPSHOT_HASH,
                "source_ledger_ref": self._source_ref("branch_protection"),
            })
        elif proof_type == "workflow_run":
            row.update({
                "workflow_run_id": 123,
                "status": "completed",
                "conclusion": "success",
                "source_ledger_ref": self._source_ref("workflow_run"),
            })
        elif proof_type == "artifact":
            row.update({
                "workflow_run_id": 123,
                "artifact_ref": self._artifact_ref(),
                "source_ledger_ref": self._source_ref("artifact"),
            })
        elif proof_type == "rollback":
            row.update({
                "rollback_plan_ref": "runbooks/rollback.md#pr-42",
                "status": "verified",
                "artifact_ref": self._artifact_ref(),
                "source_ledger_ref": self._source_ref("rollback"),
            })
        elif proof_type == "retention":
            artifact_ref = self._artifact_ref()
            row.update({
                "status": "active",
                "retention_days": 365,
                "retained_until": FUTURE,
                "artifact_ref": artifact_ref,
                "retention_event": {
                    "schema_version": 1,
                    "event": "artifact_archived",
                    "artifact_id": artifact_ref["artifact_id"],
                    "original_path": artifact_ref["uri"],
                    "new_path": artifact_ref["uri"],
                    "sha256": artifact_ref["sha256"],
                    "reason": "retention",
                    "operator_approval_ref": "operator:retention",
                    "reviewed": True,
                },
                "source_ledger_ref": self._source_ref("retention"),
            })
        elif proof_type == "dlp":
            row.update({
                "scanner": "dlp-ci",
                "findings_count": 0,
                "artifact_ref": self._artifact_ref(),
                "workflow_evidence_ref": self._workflow_evidence_ref(),
                "token_source": "github_actions_artifact_token",
                "workflow_hash": "sha256:" + "5" * 64,
                "contract_hash": "sha256:" + "6" * 64,
                "source_ledger_ref": self._source_ref("dlp"),
            })
        elif proof_type == "token":
            row.update({
                "token_subject": "github-app:installation:42",
                "scopes": ["contents:read", "pull_requests:read", "actions:read"],
                "expires_at": FUTURE,
                "token_hash": TOKEN_HASH,
                "workflow_run_id": 123,
                "token_source": "github_actions_artifact_token",
                "workflow_hash": "sha256:" + "5" * 64,
                "contract_hash": "sha256:" + "6" * 64,
                "workflow_evidence_ref": self._workflow_evidence_ref(),
                "source_ledger_ref": self._source_ref("token"),
            })
        else:
            raise AssertionError(f"unknown proof type {proof_type}")
        row.update(overrides)
        return row

    def _record_all(self, *, skip: set[str] | None = None, overrides: dict[str, dict] | None = None) -> None:
        skip = skip or set()
        overrides = overrides or {}
        recorders = {
            "cas": record_remote_cas_proof,
            "branch_protection": record_branch_protection_proof,
            "workflow_run": record_workflow_run_proof,
            "artifact": record_artifact_proof,
            "rollback": record_rollback_proof,
            "retention": record_retention_proof,
            "dlp": record_dlp_proof,
            "token": record_token_proof,
        }
        for proof_type, recorder in recorders.items():
            if proof_type in skip:
                continue
            recorder(self._proof(proof_type, **overrides.get(proof_type, {})), base_dir=self.tools)

    def _verify(self, **claim_overrides):
        claim = self._claim(**claim_overrides)
        record_enterprise_readiness_claim(claim, base_dir=self.tools)
        return evaluate_enterprise_readiness(
            base_dir=self.tools,
            pr_number=42,
            repository=REPOSITORY,
            target_ref=TARGET_REF,
            head_ref="feature/readiness",
            head_sha=HEAD_SHA,
            readiness_claim_id="ready-42",
            workflow_run_ids=[123],
            artifact_refs=claim["artifact_refs"],
        )

    def test_manifest_declares_enterprise_readiness_surfaces(self) -> None:
        surface = surface_for_path(self.tools / "enterprise" / "remote-cas-proofs.jsonl")
        self.assertIsNotNone(surface)
        self.assertEqual(surface[0].name, "enterprise_remote_cas_proofs")
        self.assertEqual(surface[0].lock_group, "readiness")

    def test_ready_when_all_required_proofs_are_ledger_bound(self) -> None:
        self._record_all()
        verdict = self._verify()
        self.assertTrue(verdict.valid, verdict.reasons)
        self.assertEqual(
            set(verdict.proof_refs),
            {"cas", "branch_protection", "workflow_run", "artifact", "rollback", "retention", "dlp", "token"},
        )

    def test_caller_asserted_boolean_proof_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "caller_asserted_boolean_proof"):
            record_branch_protection_proof(
                self._proof("branch_protection", valid=True),
                base_dir=self.tools,
            )

    def test_missing_ledger_row_blocks_readiness(self) -> None:
        self._record_all(skip={"workflow_run"})
        verdict = self._verify()
        self.assertFalse(verdict.valid)
        self.assertIn("workflow_run_proof_required", verdict.failure_classes)
        self.assertIn("workflow_run_proof_missing:123", verdict.reasons)

    def test_stale_cas_blocks_readiness(self) -> None:
        self._record_all(overrides={"cas": {"expires_at": PAST}})
        verdict = self._verify()
        self.assertFalse(verdict.valid)
        self.assertIn("cas_proof_required", verdict.failure_classes)
        self.assertIn("cas_proof_stale", verdict.reasons)

    def test_wrong_pr_head_or_ref_blocks_readiness(self) -> None:
        self._record_all(skip={"workflow_run"})
        record_workflow_run_proof(
            self._proof("workflow_run", head_sha=OTHER_HEAD_SHA),
            base_dir=self.tools,
        )
        verdict = self._verify()
        self.assertFalse(verdict.valid)
        self.assertIn("workflow_run_proof_required", verdict.failure_classes)
        self.assertIn("workflow_run_proof_wrong_pr_head_or_ref:123", verdict.reasons)

    def test_expired_waiver_blocks_readiness(self) -> None:
        self._record_all()
        record_waiver(
            {
                "waiver_id": "wv-1",
                "state": "open",
                "repository": REPOSITORY,
                "pr_number": 42,
                "target_ref": TARGET_REF,
                "head_ref": "feature/readiness",
                "head_sha": HEAD_SHA,
                "expires_at": PAST,
            },
            base_dir=self.tools,
        )
        verdict = self._verify(waiver_ids=["wv-1"])
        self.assertFalse(verdict.valid)
        self.assertIn("waiver_ledger_not_green", verdict.failure_classes)
        self.assertIn("waiver_ledger_has_open_expired_rows", verdict.reasons)

    def test_legacy_artifact_hash_map_blocks_readiness_even_if_row_exists(self) -> None:
        self._record_all(skip={"artifact"})
        artifact_ref = self._artifact_ref()
        record_artifact_proof(self._proof("artifact", artifact_ref=artifact_ref), base_dir=self.tools)
        with self.assertRaisesRegex(GovernanceError, "readiness_claim_artifact_hashes_string_map_not_allowed"):
            self._verify(
                artifact_refs=[artifact_ref],
                artifact_hashes={"evidence/readiness.json": artifact_ref["sha256"]},
            )

    def test_missing_dlp_token_retention_and_rollback_each_block_readiness(self) -> None:
        expected = {
            "dlp": "dlp_proof_required",
            "token": "token_proof_required",
            "retention": "retention_proof_required",
            "rollback": "rollback_proof_required",
        }
        for missing, failure in expected.items():
            with self.subTest(missing=missing):
                fresh = Path(tempfile.mkdtemp(prefix=f"aria-readiness-missing-{missing}-"))
                previous_tools = self.tools
                try:
                    self.tools = fresh / "aria-tools"
                    ensure_tools_dir(self.tools)
                    self._record_all(skip={missing})
                    verdict = self._verify()
                    self.assertFalse(verdict.valid)
                    self.assertIn(failure, verdict.failure_classes)
                    self.assertTrue(
                        any(reason.startswith(f"{missing}_proof_missing") for reason in verdict.reasons),
                        verdict.reasons,
                    )
                finally:
                    self.tools = previous_tools
                    shutil.rmtree(fresh, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
