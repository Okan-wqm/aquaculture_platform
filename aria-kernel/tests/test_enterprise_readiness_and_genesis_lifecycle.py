from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

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
    readiness_proof_path,
)
from aria_kernel.ledger import append_jsonl
from aria_kernel.state_manifest import surface_for_path
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


HEAD_SHA = "a" * 40
OTHER_HEAD_SHA = "b" * 40
TARGET_REF = "refs/heads/main"
REPOSITORY = "acme/aqua"
ARTIFACT_HASH = "sha256:" + "1" * 64
LEDGER_HASH = "sha256:" + "2" * 64
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

    def _claim(self, **overrides) -> dict:
        claim = {
            **self._common(),
            "workflow_run_ids": [123],
            "artifact_hashes": {"evidence/readiness.json": ARTIFACT_HASH},
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
                "source_ledger_hash": LEDGER_HASH,
            })
        elif proof_type == "workflow_run":
            row.update({
                "workflow_run_id": 123,
                "status": "completed",
                "conclusion": "success",
                "source_ledger_hash": LEDGER_HASH,
            })
        elif proof_type == "artifact":
            row.update({
                "workflow_run_id": 123,
                "artifact_path": "evidence/readiness.json",
                "artifact_hash": ARTIFACT_HASH,
                "source_ledger_hash": LEDGER_HASH,
            })
        elif proof_type == "rollback":
            row.update({
                "rollback_plan_ref": "runbooks/rollback.md#pr-42",
                "status": "verified",
                "artifact_hash": ARTIFACT_HASH,
                "source_ledger_hash": LEDGER_HASH,
            })
        elif proof_type == "retention":
            row.update({
                "status": "active",
                "retention_days": 365,
                "retained_until": FUTURE,
                "artifact_hash": ARTIFACT_HASH,
                "source_ledger_hash": LEDGER_HASH,
            })
        elif proof_type == "dlp":
            row.update({
                "scanner": "dlp-ci",
                "findings_count": 0,
                "artifact_hash": ARTIFACT_HASH,
                "source_ledger_hash": LEDGER_HASH,
            })
        elif proof_type == "token":
            row.update({
                "token_subject": "github-app:installation:42",
                "scopes": ["contents:read", "pull_requests:read", "actions:read"],
                "expires_at": FUTURE,
                "token_hash": TOKEN_HASH,
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
            artifact_hashes=claim["artifact_hashes"],
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
                "pr_number": 42,
                "expires_at": PAST,
            },
            base_dir=self.tools,
        )
        verdict = self._verify(waiver_ids=["wv-1"])
        self.assertFalse(verdict.valid)
        self.assertIn("waiver_ledger_not_green", verdict.failure_classes)
        self.assertIn("waiver_ledger_has_open_expired_rows", verdict.reasons)

    def test_weak_artifact_hash_blocks_readiness_even_if_row_exists(self) -> None:
        weak_hash = "sha256:abc"
        self._record_all(skip={"artifact"})
        raw = {
            "$schema": "aria/enterprise-readiness/artifact/v1",
            "schema_version": 1,
            "proof_type": "artifact",
            "proof_row_id": "manual-weak",
            "recorded_at": FUTURE,
            **self._proof("artifact", artifact_hash=weak_hash),
        }
        append_jsonl(readiness_proof_path("artifact", base_dir=self.tools), raw)
        verdict = self._verify(artifact_hashes={"evidence/readiness.json": weak_hash})
        self.assertFalse(verdict.valid)
        self.assertIn("artifact_hashes_untrusted", verdict.failure_classes)
        self.assertIn("artifact_artifact_hash_must_be_sha256", verdict.reasons)

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
                    self.assertIn(f"{missing}_proof_missing", verdict.reasons)
                finally:
                    self.tools = previous_tools
                    shutil.rmtree(fresh, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
