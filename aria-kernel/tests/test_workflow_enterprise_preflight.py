from __future__ import annotations

import os
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.preflight import verify_workflow_preflight
from aria_kernel.workflow_contracts import verify_workflow_contract, workflow_hash


class WorkflowEnterprisePreflightTests(unittest.TestCase):
    def test_global_kill_switch_is_hard_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"ARIA_GLOBAL_KILL_SWITCH": "true"}):
            verdict = verify_workflow_preflight(
                workflow_id="aria-agent-executor",
                profile="autonomous",
                workspace_root=tmp,
                allowed_write_roots=[str(Path(tmp).parent / "tools")],
                path_allowlist=["aria-tools/reports/daily/2026-06-02.md"],
                network_policy=["none"],
                network_enforcement_evidence="network disabled by job policy",
                token_provenance="github_app:installation",
                audit_reason="unit test",
            )
            self.assertFalse(verdict.valid)
            self.assertIn("global_kill_switch", verdict.failure_classes)

    def test_production_requires_github_app_provenance_and_fail_closed_dlp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            verdict = verify_workflow_preflight(
                workflow_id="aria-agent-executor",
                profile="autonomous",
                workspace_root=tmp,
                allowed_write_roots=[str(Path(tmp).parent / "tools")],
                path_allowlist=["dispatch/requests.jsonl"],
                network_policy=["github_api"],
                network_enforcement_evidence="gh api only",
                token_provenance="github_actions_default_token",
                dlp_mode="best_effort",
                audit_reason="unit test",
            )
            self.assertFalse(verdict.valid)
            self.assertIn("token_provenance_required", verdict.failure_classes)
            self.assertIn("dlp_fail_closed_required", verdict.failure_classes)

    def test_exact_repo_path_allowlist_can_pass_with_audit_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            audit = workspace / "preflight.json"
            verdict = verify_workflow_preflight(
                workflow_id="aria-daily-report",
                profile="standard",
                workspace_root=workspace,
                allowed_write_roots=["aria-tools/reports/daily/2026-06-02.md"],
                path_allowlist=["aria-tools/reports/daily/2026-06-02.md"],
                network_policy=["github_api"],
                network_enforcement_evidence="GitHub App PR API only",
                token_provenance="github_app:installation",
                audit_reason="unit test",
                audit_artifact_path=audit,
            )
            self.assertTrue(verdict.valid)
            self.assertTrue(audit.exists())

    def test_workflow_contract_missing_rejects(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            verdict = verify_workflow_contract(
                workflow_id="missing-workflow",
                workspace_root=tmp,
            )
            self.assertFalse(verdict.valid)
            self.assertIn("workflow_contract_missing", verdict.failure_classes)

    def test_operational_proof_workflow_matches_registry_contract(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        verdict = verify_workflow_contract(
            workflow_id="aria-operational-proof",
            workspace_root=repo,
            event_context={"token_source": "github_actions_artifact_token"},
        )
        self.assertTrue(verdict.valid, verdict.reasons)
        self.assertTrue((verdict.workflow_hash or "").startswith("sha256:"))

    def test_workflow_contract_rejects_token_source_mismatch(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        verdict = verify_workflow_contract(
            workflow_id="aria-operational-proof",
            workspace_root=repo,
            event_context={"token_source": "github_app:installation"},
        )
        self.assertFalse(verdict.valid)
        self.assertIn("workflow_token_source", verdict.failure_classes)

    def test_workflow_contract_uses_run_block_structure_not_comments(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow = root / ".github" / "workflows" / "aria-operational-proof.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text(
                """
name: ARIA Operational Proof
jobs:
  proof:
    steps:
      # verify_workflow_contract in a YAML comment is not proof
      - name: Checkout
        run: echo checkout
      - name: Run observe burn-in proof
        run: echo "${{ github.event.inputs.unsafe }}"
      - name: Upload
        uses: actions/upload-artifact@v4
        with:
          retention-days: 365
""",
                encoding="utf-8",
            )
            verdict = verify_workflow_contract(
                workflow_id="aria-operational-proof",
                workspace_root=root,
                event_context={"token_source": "github_actions_artifact_token"},
            )
        self.assertFalse(verdict.valid)
        self.assertIn("workflow_contract_preflight_missing", verdict.failure_classes)
        self.assertIn("workflow_input_injection", verdict.failure_classes)

    def test_workflow_contract_validates_structured_preflight_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow = root / ".github" / "workflows" / "aria-operational-proof.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text(
                """
name: ARIA Operational Proof
jobs:
  proof:
    steps:
      - name: Persist enterprise workflow preflight
        run: |
          python3 - <<'PY'
          from aria_kernel.workflow_contracts import verify_workflow_contract
          from aria_kernel.preflight import verify_workflow_preflight
          PY
      - name: Run observe burn-in proof
        run: npm run aria:test:unit
      - name: Upload ARIA operational proof
        uses: actions/upload-artifact@v4
        with:
          path: ${{ runner.temp }}/aria-operational-proof/
          retention-days: 365
""",
                encoding="utf-8",
            )
            artifact_dir = root / "artifacts"
            artifact_dir.mkdir()
            (artifact_dir / "workflow-preflight.json").write_text(
                json.dumps(
                    {
                        "workflow_id": "aria-operational-proof",
                        "valid": True,
                        "dlp_scan_clean": True,
                        "token_provenance": "github_actions_artifact_token",
                        "network_policy": ["github_artifact"],
                        "workflow_hash": workflow_hash(workflow),
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            verdict = verify_workflow_contract(
                workflow_id="aria-operational-proof",
                workspace_root=root,
                artifact_dir=artifact_dir,
                event_context={"token_source": "github_actions_artifact_token"},
            )
        self.assertTrue(verdict.valid, verdict.reasons)

    def test_workflow_contract_rejects_preflight_artifact_without_workflow_hash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow = root / ".github" / "workflows" / "aria-operational-proof.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text(
                """
name: ARIA Operational Proof
jobs:
  proof:
    steps:
      - name: Persist enterprise workflow preflight
        run: |
          python3 - <<'PY'
          from aria_kernel.workflow_contracts import verify_workflow_contract
          from aria_kernel.preflight import verify_workflow_preflight
          PY
      - name: Run observe burn-in proof
        run: npm run aria:test:unit
      - name: Upload ARIA operational proof
        uses: actions/upload-artifact@v4
        with:
          path: ${{ runner.temp }}/aria-operational-proof/
          retention-days: 365
""",
                encoding="utf-8",
            )
            artifact_dir = root / "artifacts"
            artifact_dir.mkdir()
            (artifact_dir / "workflow-preflight.json").write_text(
                json.dumps(
                    {
                        "workflow_id": "aria-operational-proof",
                        "valid": True,
                        "dlp_scan_clean": True,
                        "token_provenance": "github_actions_artifact_token",
                        "network_policy": ["github_artifact"],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            verdict = verify_workflow_contract(
                workflow_id="aria-operational-proof",
                workspace_root=root,
                artifact_dir=artifact_dir,
                event_context={"token_source": "github_actions_artifact_token"},
            )
        self.assertFalse(verdict.valid)
        self.assertIn("workflow_dlp_proof_missing", verdict.failure_classes)
        self.assertIn("workflow_preflight_artifact_workflow_hash_missing", verdict.reasons)


if __name__ == "__main__":
    unittest.main()
