from __future__ import annotations

import os
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.preflight import verify_workflow_preflight
from aria_kernel.workflow_contracts import (
    AUDITED_WORKFLOW_EXCLUSIONS,
    WORKFLOW_CONTRACTS,
    discover_aria_workflows,
    verify_workflow_contract,
    workflow_hash,
    workflow_job_contract_hash,
)


def _write_runtime_workflow(root: Path, workflow_id: str) -> None:
    contract = WORKFLOW_CONTRACTS[workflow_id]
    workflow = root / contract.workflow_file
    workflow.parent.mkdir(parents=True, exist_ok=True)
    workflow.write_text("name: unit\njobs: {}\n", encoding="utf-8")


class WorkflowEnterprisePreflightTests(unittest.TestCase):
    def _run_open_report_pr(self, cwd: Path, **env: str) -> subprocess.CompletedProcess[str]:
        script = Path(__file__).resolve().parents[2] / "tools" / "scripts" / "automation" / "open-report-pr.sh"
        base_env = os.environ.copy()
        base_env.update(env)
        return subprocess.run(
            ["bash", str(script)],
            cwd=cwd,
            env=base_env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_global_kill_switch_is_hard_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"ARIA_GLOBAL_KILL_SWITCH": "true"}):
            _write_runtime_workflow(Path(tmp), "aria-agent-executor")
            verdict = verify_workflow_preflight(
                workflow_id="aria-agent-executor",
                job_id="executor",
                profile="autonomous",
                workspace_root=tmp,
                allowed_write_roots=["aria-tools/governance.jsonl"],
                path_allowlist=["aria-tools/governance.jsonl"],
                network_policy=["github_artifact"],
                network_enforcement_evidence="github artifact upload only",
                token_provenance="github_actions_artifact_token",
                audit_reason="unit test",
            )
            self.assertFalse(verdict.valid)
            self.assertIn("global_kill_switch", verdict.failure_classes)

    def test_production_requires_github_app_provenance_and_fail_closed_dlp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            _write_runtime_workflow(Path(tmp), "finding-state-sweep")
            verdict = verify_workflow_preflight(
                workflow_id="finding-state-sweep",
                job_id="sweep",
                profile="autonomous",
                workspace_root=tmp,
                allowed_write_roots=["docs/reviews/_registry/findings.jsonl"],
                path_allowlist=["docs/reviews/_registry/findings.jsonl"],
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
            _write_runtime_workflow(workspace, "aria-daily-report")
            runner_temp = workspace.parent / f"{workspace.name}-runner-temp"
            runner_temp.mkdir()
            verdict = verify_workflow_preflight(
                workflow_id="aria-daily-report",
                job_id="generate-report",
                profile="standard",
                workspace_root=workspace,
                allowed_write_roots=["aria-tools/reports/daily/2026-06-02.md"],
                path_allowlist=["aria-tools/reports/daily/2026-06-02.md"],
                network_policy=["github_artifact"],
                network_enforcement_evidence="GitHub artifact upload only",
                token_provenance="github_actions_artifact_token",
                audit_reason="unit test",
                audit_artifact_path=runner_temp / "aria-daily-report-generate-preflight.json",
                external_root_allowlist=[str(runner_temp)],
            )
            self.assertTrue(verdict.valid)
            self.assertTrue((runner_temp / "aria-daily-report-generate-preflight.json").exists())

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

    def test_all_registered_workflow_contracts_match_yaml(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        failures: dict[str, tuple[str, ...]] = {}
        for workflow_id in sorted(WORKFLOW_CONTRACTS):
            verdict = verify_workflow_contract(
                workflow_id=workflow_id,
                workspace_root=repo,
            )
            if not verdict.valid:
                failures[workflow_id] = verdict.reasons
        self.assertEqual(failures, {})

    def test_discovered_aria_workflows_are_contracted_or_audited_exclusions(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        discovered = set(discover_aria_workflows(repo))
        covered = set(WORKFLOW_CONTRACTS) | set(AUDITED_WORKFLOW_EXCLUSIONS)
        self.assertEqual(sorted(discovered - covered), [])
        for workflow_id, reason in AUDITED_WORKFLOW_EXCLUSIONS.items():
            self.assertIn(workflow_id, discovered)
            self.assertRegex(reason.expires_at, r"^\d{4}-\d{2}-\d{2}$")
            self.assertTrue(reason.owner)

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
permissions:
  contents: read
jobs:
  proof:
    permissions:
      contents: read
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
permissions:
  contents: read
jobs:
  proof:
    permissions:
      contents: read
    steps:
      - name: Persist enterprise workflow preflight
        run: |
          python3 - <<'PY'
          from aria_kernel.preflight import verify_workflow_preflight
          verify_workflow_preflight(job_id="proof")
          PY
      - name: Run observe burn-in proof
        run: npm run aria:test:unit
      - name: Upload ARIA operational proof
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: aria-operational-proof-${{ github.sha }}
          path: ${{ runner.temp }}/aria-operational-proof/
          if-no-files-found: error
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
                        "job_id": "proof",
                        "schema_version": 1,
                        "valid": True,
                        "dlp_scan_clean": True,
                        "token_provenance": "github_actions_artifact_token",
                        "network_policy": ["github_artifact"],
                        "workflow_hash": workflow_hash(workflow),
                        "contract_hash": workflow_job_contract_hash("aria-operational-proof", "proof"),
                        "runtime_write_paths": ["runner-temp/aria-operational-proof"],
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
permissions:
  contents: read
jobs:
  proof:
    permissions:
      contents: read
    steps:
      - name: Persist enterprise workflow preflight
        run: |
          python3 - <<'PY'
          from aria_kernel.preflight import verify_workflow_preflight
          verify_workflow_preflight(job_id="proof")
          PY
      - name: Run observe burn-in proof
        run: npm run aria:test:unit
      - name: Upload ARIA operational proof
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: aria-operational-proof-${{ github.sha }}
          path: ${{ runner.temp }}/aria-operational-proof/
          if-no-files-found: error
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
                        "job_id": "proof",
                        "schema_version": 1,
                        "valid": True,
                        "dlp_scan_clean": True,
                        "token_provenance": "github_actions_artifact_token",
                        "network_policy": ["github_artifact"],
                        "contract_hash": workflow_job_contract_hash("aria-operational-proof", "proof"),
                        "runtime_write_paths": ["runner-temp/aria-operational-proof"],
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

    def test_open_report_pr_rejects_unsafe_branch_name(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            body = cwd / "body.md"
            body.write_text("body\n", encoding="utf-8")
            result = self._run_open_report_pr(
                cwd,
                PR_BRANCH="feature/not-automation",
                PR_TITLE="title",
                PR_BODY_FILE=str(body),
                COMMIT_MESSAGE="message",
                CHANGED_PATHS="report.md",
                GH_TOKEN="token",
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PR_BRANCH must match", result.stderr)

    def test_open_report_pr_rejects_newline_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            body = cwd / "body.md"
            body.write_text("body\n", encoding="utf-8")
            result = self._run_open_report_pr(
                cwd,
                PR_BRANCH="automation/report",
                PR_TITLE="title\ninjected",
                PR_BODY_FILE=str(body),
                COMMIT_MESSAGE="message",
                CHANGED_PATHS="report.md",
                GH_TOKEN="token",
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PR_TITLE must be a single line", result.stderr)

    def test_open_report_pr_rejects_extra_dirty_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp)
            subprocess.check_call(["git", "init"], cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            body = cwd / "body.md"
            body.write_text("body\n", encoding="utf-8")
            (cwd / "report.md").write_text("report\n", encoding="utf-8")
            (cwd / "extra.md").write_text("extra\n", encoding="utf-8")
            result = self._run_open_report_pr(
                cwd,
                PR_BRANCH="automation/report",
                PR_TITLE="title",
                PR_BODY_FILE=str(body),
                COMMIT_MESSAGE="message",
                CHANGED_PATHS="report.md",
                GH_TOKEN="token",
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("extra dirty path outside CHANGED_PATHS", result.stderr)


if __name__ == "__main__":
    unittest.main()
