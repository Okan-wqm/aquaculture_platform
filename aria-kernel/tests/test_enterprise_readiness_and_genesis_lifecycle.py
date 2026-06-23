from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from aria_kernel.enterprise_readiness import (
    READINESS_SCHEMA,
    assert_enterprise_readiness_claim,
    consume_waiver,
    evaluate_enterprise_readiness_claim,
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
    verify_enterprise_readiness,
)
from aria_kernel.genesis_lifecycle import current_lifecycle_state, record_transition
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.ledger_refs import ledger_ref_for_row
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
        self._source_ref_cache: dict[str, dict] = {}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _ready_claim(self, *, readiness_claim_id: str = "ready-42") -> dict:
        (self.tools / "evidence-bundle.json").write_text('{"ok":true}\n', encoding="utf-8")
        (self.tools / "rollback-source.json").write_text('{"source":true}\n', encoding="utf-8")
        (self.tools / "rollback-archive.json").write_text('{"archive":true}\n', encoding="utf-8")
        (self.tools / "retention-source.json").write_text('{"source":true}\n', encoding="utf-8")
        (self.tools / "retention-archive.json").write_text('{"archive":true}\n', encoding="utf-8")
        digest = self._sha(self.tools / "evidence-bundle.json")
        rollback_source = self._sha(self.tools / "rollback-source.json")
        rollback_archive = self._sha(self.tools / "rollback-archive.json")
        retention_source = self._sha(self.tools / "retention-source.json")
        retention_archive = self._sha(self.tools / "retention-archive.json")
        pr_number = 42
        repo = "example/aqua"
        target_ref = "refs/heads/main"
        head_ref = "aria/readiness"
        head_sha = "a" * 40
        required_checks = ["sens-enterprise-summary", "merge-gate", "aria-merge-authority"]
        artifact_ref = {
            "schema_version": 2,
            "artifact_id": "artifact-1",
            "uri": "evidence-bundle.json",
            "sha256": digest,
            "content_type": "application/json",
            "produced_by_workflow_run_id": "123",
            "source_surface": "github_actions_artifact",
        }
        common = {
            "repo": repo,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_ref": head_ref,
            "head_sha": head_sha,
            "readiness_claim_id": readiness_claim_id,
        }
        cas = {
            **common,
            "state": "fresh",
            "lease_id": "lease-1",
            "epoch": 1,
            "expires_at": "2999-06-02T00:00:00Z",
            "source_ledger_ref": self._source_ref("cas"),
        }
        branch = {
            **common,
            "$schema": "aria/branch-protection-proof/v3",
            "valid": True,
            "snapshot_hash": digest,
            "required_checks": required_checks,
            "exact_required_checks": required_checks,
            "signed_commits_required": True,
            "reviews_required": True,
            "conversation_resolution_required": True,
            "ruleset_ids": [1],
            "bypass_actors": [],
            "force_push_disabled": True,
            "delete_branch_disabled": True,
            "source_ledger_ref": self._source_ref("branch"),
        }
        rollback = {
            **common,
            "validated": True,
            "rollback_proof_id": "rollback-1",
            "source_uri": "rollback-source.json",
            "archive_uri": "rollback-archive.json",
            "source_sha256": rollback_source,
            "archive_sha256": rollback_archive,
            "source_ledger_ref": self._source_ref("rollback"),
        }
        retention = {
            **common,
            "validated": True,
            "retention_proof_id": "retention-1",
            "source_uri": "retention-source.json",
            "archive_uri": "retention-archive.json",
            "source_sha256": retention_source,
            "archive_sha256": retention_archive,
            "retention_days": 365,
            "source_ledger_ref": self._source_ref("retention"),
        }
        dlp = {
            **common,
            "valid": True,
            "dlp_proof_id": "dlp-1",
            "workflow_run_id": 123,
            "artifact_id": artifact_ref["artifact_id"],
            "artifact_sha256": artifact_ref["sha256"],
            "workflow_hash": digest,
            "contract_hash": digest,
            "network_policy": "egress-denied",
            "runtime_write_paths": ["aria-tools/tmp"],
            "scanner_results": {
                "status": "passed",
                "scanned_surfaces": ["diff", "prompt", "transcript", "logs", "artifacts"],
                "scanner_output_sha256": digest,
            },
            "source_ledger_ref": self._source_ref("dlp"),
        }
        token = {
            **common,
            "valid": True,
            "token_proof_id": "token-1",
            "workflow_run_id": 123,
            "artifact_id": artifact_ref["artifact_id"],
            "artifact_sha256": artifact_ref["sha256"],
            "workflow_hash": digest,
            "contract_hash": digest,
            "network_policy": "egress-denied",
            "runtime_write_paths": ["aria-tools/tmp"],
            "token_type": "github_app_installation_token",
            "mutation_token": "github_app_installation_token",
            "gh_token_fallback": False,
            "github_token_fallback": False,
            "pat_fallback": False,
            "source_ledger_ref": self._source_ref("token"),
        }
        return {
            "$schema": READINESS_SCHEMA,
            "schema_version": 2,
            "claim_row_id": f"claim-row-{readiness_claim_id}",
            "readiness_claim_id": readiness_claim_id,
            "repo": repo,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_ref": head_ref,
            "head_sha": head_sha,
            "evidence_bundle": {"path": "evidence-bundle.json"},
            "workflow_run_ids": ["123"],
            "artifact_refs": [artifact_ref],
            "remote_cas_proof": cas,
            "rollback_proof": rollback,
            "retention_proof": retention,
            "waiver_ledger": {"open_expired_waivers": [], "source_ledger_ref": self._source_ref("waiver")},
            "branch_protection_proof": branch,
            "dlp_proof": dlp,
            "token_proof": token,
        }

    def _sha(self, path: Path) -> str:
        return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()

    def _source_ref(self, label: str) -> dict:
        if label not in self._source_ref_cache:
            row_id = f"source-{label}"
            row = append_declared_jsonl(
                self.tools / "ci" / "source.jsonl",
                {
                    "schema_version": 1,
                    "row_id": row_id,
                    "row_type": "ci_source",
                    "label": label,
                    "content_hash": "sha256:" + hashlib.sha256(label.encode("utf-8")).hexdigest(),
                },
                expected_surface="ci_source",
                bypass_profile_gate=True,
            )
            self._source_ref_cache[label] = ledger_ref_for_row(
                surface="ci_source",
                ledger_path="ci/source.jsonl",
                row_id=row_id,
                row_type="ci_source",
                row=row,
            )
        return dict(self._source_ref_cache[label])

    def _record_ready_proofs(self, claim: dict) -> None:
        artifact_ref = claim["artifact_refs"][0]
        digest = artifact_ref["sha256"]
        record_remote_cas_proof(claim["remote_cas_proof"], base_dir=self.tools)
        record_branch_protection_proof(claim["branch_protection_proof"], base_dir=self.tools)
        record_rollback_proof(claim["rollback_proof"], base_dir=self.tools)
        record_retention_proof(claim["retention_proof"], base_dir=self.tools)
        record_workflow_run_proof(
            {
                "readiness_claim_id": claim["readiness_claim_id"],
                "repo": claim["repo"],
                "pr_number": claim["pr_number"],
                "target_ref": claim["target_ref"],
                "head_ref": claim["head_ref"],
                "head_sha": claim["head_sha"],
                "workflow_run_id": 123,
                "conclusion": "success",
                "source_ledger_ref": self._source_ref("workflow"),
            },
            base_dir=self.tools,
        )
        record_artifact_proof(
            {
                "readiness_claim_id": claim["readiness_claim_id"],
                "repo": claim["repo"],
                "pr_number": claim["pr_number"],
                "target_ref": claim["target_ref"],
                "head_ref": claim["head_ref"],
                "head_sha": claim["head_sha"],
                "artifact_id": artifact_ref["artifact_id"],
                "uri": artifact_ref["uri"],
                "sha256": artifact_ref["sha256"],
                "schema_version": artifact_ref["schema_version"],
                "content_type": artifact_ref["content_type"],
                "source_surface": artifact_ref["source_surface"],
                "produced_by_workflow_run_id": artifact_ref["produced_by_workflow_run_id"],
                "source_ledger_ref": self._source_ref("artifact"),
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
                    "repository": claim["repo"],
                    "head_sha": claim["head_sha"],
                    "base_branch": claim["target_ref"],
                    "head_ref": claim["head_ref"],
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
                    "repository": claim["repo"],
                    "head_sha": claim["head_sha"],
                    "base_branch": claim["target_ref"],
                    "head_ref": claim["head_ref"],
                }

        verdict = verify_enterprise_readiness(
            pr_number=42,
            adapter=Adapter(),
            readiness_claim_id=claim["readiness_claim_id"],
            base_dir=self.tools,
        )
        self.assertFalse(verdict.valid)
        self.assertIn("remote_cas_proof_required", verdict.failure_classes)
        self.assertIn("artifact_refs_untrusted", verdict.failure_classes)

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

    def test_verify_requires_readiness_claim_id(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "readiness_claim_id_required"):
            verify_enterprise_readiness(
                pr_number=42,
                adapter=object(),
                readiness_claim_id="",
                base_dir=self.tools,
            )

    def test_duplicate_readiness_claim_id_rejected(self) -> None:
        claim = self._ready_claim()
        record_enterprise_readiness_claim(claim, base_dir=self.tools)
        with self.assertRaisesRegex(GovernanceError, "duplicate_readiness_claim_id"):
            record_enterprise_readiness_claim(claim, base_dir=self.tools)

    def test_remote_cas_proof_requires_source_ledger_ref(self) -> None:
        claim = self._ready_claim()
        proof = dict(claim["remote_cas_proof"])
        proof.pop("source_ledger_ref")
        with self.assertRaisesRegex(GovernanceError, "requires_source_ledger_ref"):
            record_remote_cas_proof(proof, base_dir=self.tools)

    def test_source_ledger_ref_must_resolve_to_declared_row(self) -> None:
        claim = self._ready_claim()
        proof = dict(claim["remote_cas_proof"])
        proof["source_ledger_ref"] = {
            "surface": "ci_source",
            "ledger_path": "ci/source.jsonl",
            "row_id": "source-missing",
            "row_type": "ci_source",
            "row_hash": "sha256:" + "0" * 64,
            "schema_version": 1,
        }
        with self.assertRaisesRegex(GovernanceError, "source_ledger_ref_exact_match_required"):
            record_remote_cas_proof(proof, base_dir=self.tools)

    def test_artifact_canonical_content_type_mismatch_rejected(self) -> None:
        claim = self._ready_claim()
        self._record_ready_proofs(claim)
        claim["artifact_refs"][0] = {**claim["artifact_refs"][0], "content_type": "text/plain"}
        record_enterprise_readiness_claim(claim, base_dir=self.tools)

        class Adapter:
            def get_pr(self, number):
                return {
                    "number": number,
                    "repository": claim["repo"],
                    "head_sha": claim["head_sha"],
                    "base_branch": claim["target_ref"],
                    "head_ref": claim["head_ref"],
                }

        verdict = verify_enterprise_readiness(
            pr_number=42,
            adapter=Adapter(),
            readiness_claim_id=claim["readiness_claim_id"],
            base_dir=self.tools,
        )
        self.assertFalse(verdict.valid)
        self.assertIn("artifact_refs_untrusted", verdict.failure_classes)

    def test_artifact_workflow_run_must_be_in_claim_workflow_runs(self) -> None:
        claim = self._ready_claim()
        claim["artifact_refs"][0] = {**claim["artifact_refs"][0], "produced_by_workflow_run_id": "999"}
        verdict = evaluate_enterprise_readiness_claim(claim)
        self.assertFalse(verdict.valid)
        self.assertIn("artifact_refs_untrusted", verdict.failure_classes)

    def test_dlp_and_token_proof_ids_are_required(self) -> None:
        claim = self._ready_claim()
        claim["dlp_proof"] = dict(claim["dlp_proof"])
        claim["dlp_proof"].pop("dlp_proof_id")
        verdict = evaluate_enterprise_readiness_claim(claim)
        self.assertFalse(verdict.valid)
        self.assertIn("dlp_proof_required", verdict.failure_classes)

    def test_dlp_binding_mismatch_rejected(self) -> None:
        claim = self._ready_claim()
        claim["dlp_proof"] = {**claim["dlp_proof"], "repo": "other/repo"}
        verdict = evaluate_enterprise_readiness_claim(claim)
        self.assertFalse(verdict.valid)
        self.assertIn("dlp_proof_binding_required", verdict.failure_classes)

    def test_dlp_workflow_run_must_be_claim_bound(self) -> None:
        claim = self._ready_claim()
        claim["dlp_proof"] = {**claim["dlp_proof"], "workflow_run_id": 999}
        verdict = evaluate_enterprise_readiness_claim(claim)
        self.assertFalse(verdict.valid)
        self.assertIn("dlp_proof_required", verdict.failure_classes)
        self.assertIn("dlp_proof_workflow_run_id_unbound", verdict.reasons)

    def test_token_artifact_ref_must_be_claim_bound(self) -> None:
        claim = self._ready_claim()
        claim["token_proof"] = {
            **claim["token_proof"],
            "artifact_id": "other-artifact",
        }
        verdict = evaluate_enterprise_readiness_claim(claim)
        self.assertFalse(verdict.valid)
        self.assertIn("token_proof_required", verdict.failure_classes)
        self.assertIn("token_proof_artifact_ref_unbound", verdict.reasons)

    def test_rollback_byte_mismatch_rejected(self) -> None:
        claim = self._ready_claim()
        self._record_ready_proofs(claim)
        (self.tools / "rollback-source.json").write_text('{"mutated":true}\n', encoding="utf-8")
        record_enterprise_readiness_claim(claim, base_dir=self.tools)

        class Adapter:
            def get_pr(self, number):
                return {
                    "number": number,
                    "repository": claim["repo"],
                    "head_sha": claim["head_sha"],
                    "base_branch": claim["target_ref"],
                    "head_ref": claim["head_ref"],
                }

        verdict = verify_enterprise_readiness(
            pr_number=42,
            adapter=Adapter(),
            readiness_claim_id=claim["readiness_claim_id"],
            base_dir=self.tools,
        )
        self.assertFalse(verdict.valid)
        self.assertIn("rollback_proof_required", verdict.failure_classes)
        self.assertTrue(any("byte_mismatch" in reason for reason in verdict.reasons))

    def _open_waiver(self, claim: dict, *, expires_at: str = "2999-06-02T00:00:00Z") -> dict:
        return record_waiver(
            {
                "waiver_id": "waiver-1",
                "repo": claim["repo"],
                "pr_number": claim["pr_number"],
                "target_ref": claim["target_ref"],
                "head_ref": claim["head_ref"],
                "head_sha": claim["head_sha"],
                "readiness_claim_id": claim["readiness_claim_id"],
                "expires_at": expires_at,
                "source_ledger_ref": self._source_ref("waiver-open"),
            },
            base_dir=self.tools,
        )

    def test_waiver_consume_rejects_cross_pr(self) -> None:
        claim = self._ready_claim()
        open_row = self._open_waiver(claim)
        with self.assertRaisesRegex(GovernanceError, "exact_open_waiver_row"):
            consume_waiver(
                "waiver-1",
                readiness_claim_id=claim["readiness_claim_id"],
                repo=claim["repo"],
                pr_number=claim["pr_number"] + 1,
                target_ref=claim["target_ref"],
                head_ref=claim["head_ref"],
                head_sha=claim["head_sha"],
                previous_open_waiver_ledger_hash=open_row["ledger_hash"],
                base_dir=self.tools,
            )

    def test_waiver_consume_rejects_duplicate_consume(self) -> None:
        claim = self._ready_claim()
        open_row = self._open_waiver(claim)
        kwargs = {
            "readiness_claim_id": claim["readiness_claim_id"],
            "repo": claim["repo"],
            "pr_number": claim["pr_number"],
            "target_ref": claim["target_ref"],
            "head_ref": claim["head_ref"],
            "head_sha": claim["head_sha"],
            "previous_open_waiver_ledger_hash": open_row["ledger_hash"],
            "base_dir": self.tools,
        }
        consume_waiver("waiver-1", **kwargs)
        with self.assertRaisesRegex(GovernanceError, "duplicate_consume"):
            consume_waiver("waiver-1", **kwargs)

    def test_waiver_consume_rejects_expired_open_waiver(self) -> None:
        claim = self._ready_claim()
        open_row = self._open_waiver(claim, expires_at="2000-01-01T00:00:00Z")
        with self.assertRaisesRegex(GovernanceError, "consume_after_expiry"):
            consume_waiver(
                "waiver-1",
                readiness_claim_id=claim["readiness_claim_id"],
                repo=claim["repo"],
                pr_number=claim["pr_number"],
                target_ref=claim["target_ref"],
                head_ref=claim["head_ref"],
                head_sha=claim["head_sha"],
                previous_open_waiver_ledger_hash=open_row["ledger_hash"],
                base_dir=self.tools,
            )

    def test_waiver_consume_rejects_missing_expiry(self) -> None:
        claim = self._ready_claim()
        open_row = record_waiver(
            {
                "waiver_id": "waiver-1",
                "repo": claim["repo"],
                "pr_number": claim["pr_number"],
                "target_ref": claim["target_ref"],
                "head_ref": claim["head_ref"],
                "head_sha": claim["head_sha"],
                "readiness_claim_id": claim["readiness_claim_id"],
                "source_ledger_ref": self._source_ref("waiver-open-no-expiry"),
            },
            base_dir=self.tools,
        )
        with self.assertRaisesRegex(GovernanceError, "requires_open_waiver_expiry"):
            consume_waiver(
                "waiver-1",
                readiness_claim_id=claim["readiness_claim_id"],
                repo=claim["repo"],
                pr_number=claim["pr_number"],
                target_ref=claim["target_ref"],
                head_ref=claim["head_ref"],
                head_sha=claim["head_sha"],
                previous_open_waiver_ledger_hash=open_row["ledger_hash"],
                base_dir=self.tools,
            )

    def test_waiver_consume_rejects_wrong_open_row_type(self) -> None:
        claim = self._ready_claim()
        open_row = append_declared_jsonl(
            self.tools / "enterprise" / "waivers.jsonl",
            {
                "schema_version": 1,
                "state": "open",
                "row_id": "waiver-1",
                "row_type": "wrong_row_type",
                "waiver_id": "waiver-1",
                "repo": claim["repo"],
                "pr_number": claim["pr_number"],
                "target_ref": claim["target_ref"],
                "head_ref": claim["head_ref"],
                "head_sha": claim["head_sha"],
                "readiness_claim_id": claim["readiness_claim_id"],
                "expires_at": "2999-06-02T00:00:00Z",
                "source_ledger_ref": self._source_ref("waiver-open-wrong-type"),
            },
            expected_surface="enterprise_waivers",
            bypass_profile_gate=True,
        )
        with self.assertRaisesRegex(GovernanceError, "open_waiver_row_type"):
            consume_waiver(
                "waiver-1",
                readiness_claim_id=claim["readiness_claim_id"],
                repo=claim["repo"],
                pr_number=claim["pr_number"],
                target_ref=claim["target_ref"],
                head_ref=claim["head_ref"],
                head_sha=claim["head_sha"],
                previous_open_waiver_ledger_hash=open_row["ledger_hash"],
                base_dir=self.tools,
            )

    def test_waiver_ledger_source_ref_is_verified_without_waiver_ids(self) -> None:
        claim = self._ready_claim()
        self._record_ready_proofs(claim)
        claim["waiver_ledger"] = {
            **claim["waiver_ledger"],
            "source_ledger_ref": {
                "surface": "ci_source",
                "ledger_path": "ci/source.jsonl",
                "row_id": "missing-waiver-source",
                "row_type": "ci_source",
                "row_hash": "sha256:" + "0" * 64,
                "schema_version": 1,
            },
        }
        append_declared_jsonl(
            self.tools / "enterprise" / "readiness-claims.jsonl",
            {
                "recorded_at": "2026-06-06T00:00:00Z",
                "row_id": claim["claim_row_id"],
                "row_type": "readiness_claim",
                **claim,
            },
            expected_surface="enterprise_readiness_claims",
            bypass_profile_gate=True,
        )

        class Adapter:
            def get_pr(self, number):
                return {
                    "number": number,
                    "repository": claim["repo"],
                    "head_sha": claim["head_sha"],
                    "base_branch": claim["target_ref"],
                    "head_ref": claim["head_ref"],
                }

        verdict = verify_enterprise_readiness(
            pr_number=42,
            adapter=Adapter(),
            readiness_claim_id=claim["readiness_claim_id"],
            base_dir=self.tools,
        )
        self.assertFalse(verdict.valid)
        self.assertIn("waiver_ledger_not_green", verdict.failure_classes)
        self.assertIn("waiver_ledger_source_ledger_ref_not_bound", verdict.reasons)

    def test_shallow_branch_protection_object_rejected(self) -> None:
        claim = self._ready_claim()
        claim["branch_protection_proof"] = {"valid": True}
        verdict = evaluate_enterprise_readiness_claim(claim)
        self.assertFalse(verdict.valid)
        self.assertIn("branch_protection_required", verdict.failure_classes)


if __name__ == "__main__":
    unittest.main()
