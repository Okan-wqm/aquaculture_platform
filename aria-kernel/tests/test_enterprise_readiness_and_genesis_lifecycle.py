from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.enterprise_readiness import (
    assert_enterprise_readiness_claim,
    evaluate_enterprise_readiness_claim,
    record_artifact_proof,
    record_branch_protection_proof,
    record_dlp_proof,
    record_enterprise_readiness_claim,
    record_remote_cas_proof,
    record_retention_proof,
    record_rollback_proof,
    record_token_proof,
    record_workflow_run_proof,
    verify_enterprise_readiness,
)
from aria_kernel.genesis_lifecycle import current_lifecycle_state, record_transition
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class GenesisLifecycleReducerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-genesis-life-")
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_invalid_direct_request_transition_rejects(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "initial_state_must_be_PRESSURE"):
            record_transition(
                entity_id="gap-1",
                entity_kind="skill",
                to_state="REQUEST",
                evidence={"operator_feedback_ref": "op:1"},
                base_dir=self.tools,
            )

    def test_thresholds_and_linear_transition_pass(self) -> None:
        record_transition(
            entity_id="gap-1",
            entity_kind="skill",
            to_state="PRESSURE",
            evidence={"pressure_id": "p-1"},
            base_dir=self.tools,
        )
        with self.assertRaisesRegex(GovernanceError, "candidate_requires"):
            record_transition(
                entity_id="gap-1",
                entity_kind="skill",
                to_state="CANDIDATE_PROPOSED",
                evidence={"valid_cycles": 1, "source_types": ["pressure"]},
                base_dir=self.tools,
            )
        record_transition(
            entity_id="gap-1",
            entity_kind="skill",
            to_state="CANDIDATE_PROPOSED",
            evidence={"valid_cycles": 5, "source_types": ["pressure"]},
            base_dir=self.tools,
        )
        record_transition(
            entity_id="gap-1",
            entity_kind="skill",
            to_state="HUMAN_REQUIRED",
            evidence={"existing_capability_coverage": {"verdict": "positive", "coverage_score": 0.95}},
            base_dir=self.tools,
        )
        self.assertEqual(current_lifecycle_state(entity_id="gap-1", base_dir=self.tools), "HUMAN_REQUIRED")


class EnterpriseReadinessGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-readiness-")
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _ready_claim(self, *, readiness_claim_id: str = "ready-42") -> dict:
        digest = "sha256:" + "a" * 64
        pr_number = 42
        target_ref = "refs/heads/main"
        head_sha = "a" * 40
        cas = {
            "state": "fresh",
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "lease_id": "lease-1",
            "epoch": 1,
            "expires_at": "2999-06-02T00:00:00Z",
        }
        branch = {
            "valid": True,
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "snapshot_hash": digest,
            "source_ledger_hash": digest,
            "required_checks": ["ci"],
        }
        rollback = {
            "validated": True,
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "rollback_proof_id": "rollback-1",
            "source_ledger_hash": digest,
            "artifact_hash": digest,
        }
        retention = {
            "validated": True,
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "retention_proof_id": "retention-1",
            "source_ledger_hash": digest,
            "artifact_hash": digest,
            "retention_days": 365,
        }
        dlp = {
            "valid": True,
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "dlp_proof_id": "dlp-1",
            "artifact_hash": digest,
        }
        token = {
            "valid": True,
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "token_proof_id": "token-1",
            "artifact_hash": digest,
        }
        return {
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "evidence_bundle": {"path": "evidence-bundle.json"},
            "workflow_run_ids": ["123"],
            "artifact_hashes": {"evidence-bundle.json": digest},
            "remote_cas_proof": cas,
            "rollback_proof": rollback,
            "retention_proof": retention,
            "waiver_ledger": {"open_expired_waivers": [], "source_ledger_hash": digest},
            "branch_protection_proof": branch,
            "dlp_proof": dlp,
            "token_proof": token,
        }

    def _record_ready_proofs(self, claim: dict) -> None:
        digest = next(iter(claim["artifact_hashes"].values()))
        record_remote_cas_proof(claim["remote_cas_proof"], base_dir=self.tools)
        record_branch_protection_proof(claim["branch_protection_proof"], base_dir=self.tools)
        record_rollback_proof(claim["rollback_proof"], base_dir=self.tools)
        record_retention_proof(claim["retention_proof"], base_dir=self.tools)
        record_workflow_run_proof(
            {
                "readiness_claim_id": claim["readiness_claim_id"],
                "pr_number": claim["pr_number"],
                "target_ref": claim["target_ref"],
                "head_sha": claim["head_sha"],
                "workflow_run_id": 123,
                "conclusion": "success",
                "source_ledger_hash": digest,
            },
            base_dir=self.tools,
        )
        record_artifact_proof(
            {
                "readiness_claim_id": claim["readiness_claim_id"],
                "pr_number": claim["pr_number"],
                "target_ref": claim["target_ref"],
                "head_sha": claim["head_sha"],
                "artifact_path": "evidence-bundle.json",
                "artifact_hash": digest,
                "source_ledger_hash": digest,
            },
            base_dir=self.tools,
        )
        record_dlp_proof(claim["dlp_proof"], base_dir=self.tools)
        record_token_proof(claim["token_proof"], base_dir=self.tools)

    def test_incomplete_claim_rejected(self) -> None:
        verdict = evaluate_enterprise_readiness_claim({"artifact_hashes": {}})
        self.assertFalse(verdict.valid)
        self.assertIn("readiness_claim_incomplete", verdict.failure_classes)

    def test_ready_claim_requires_green_proofs(self) -> None:
        claim = self._ready_claim()
        self.assertTrue(assert_enterprise_readiness_claim(claim).valid)
        self._record_ready_proofs(claim)
        record_enterprise_readiness_claim(claim, base_dir=self.tools)

        class Adapter:
            def get_pr(self, number):
                return {
                    "number": number,
                    "head_sha": claim["head_sha"],
                    "base_branch": claim["target_ref"],
                }

        self.assertTrue(
            verify_enterprise_readiness(
                pr_number=42,
                adapter=Adapter(),
                readiness_claim_id=claim["readiness_claim_id"],
                base_dir=self.tools,
            ).valid
        )

    def test_verify_rejects_inline_only_proofs(self) -> None:
        claim = self._ready_claim()
        record_enterprise_readiness_claim(claim, base_dir=self.tools)

        class Adapter:
            def get_pr(self, number):
                return {
                    "number": number,
                    "head_sha": claim["head_sha"],
                    "base_branch": claim["target_ref"],
                }

        verdict = verify_enterprise_readiness(
            pr_number=42,
            adapter=Adapter(),
            readiness_claim_id=claim["readiness_claim_id"],
            base_dir=self.tools,
        )
        self.assertFalse(verdict.valid)
        self.assertIn("remote_cas_proof_required", verdict.failure_classes)
        self.assertIn("artifact_hashes_untrusted", verdict.failure_classes)

    def test_verify_rejects_missing_live_pr_head_and_target(self) -> None:
        claim = self._ready_claim()
        self._record_ready_proofs(claim)
        record_enterprise_readiness_claim(claim, base_dir=self.tools)

        class Adapter:
            def get_pr(self, number):
                return {"number": number}

        verdict = verify_enterprise_readiness(
            pr_number=42,
            adapter=Adapter(),
            readiness_claim_id=claim["readiness_claim_id"],
            base_dir=self.tools,
        )
        self.assertFalse(verdict.valid)
        self.assertIn("readiness_live_binding_required", verdict.failure_classes)

    def test_shallow_branch_protection_object_rejected(self) -> None:
        claim = self._ready_claim()
        claim["branch_protection_proof"] = {"valid": True}
        verdict = evaluate_enterprise_readiness_claim(claim)
        self.assertFalse(verdict.valid)
        self.assertIn("branch_protection_required", verdict.failure_classes)


if __name__ == "__main__":
    unittest.main()
