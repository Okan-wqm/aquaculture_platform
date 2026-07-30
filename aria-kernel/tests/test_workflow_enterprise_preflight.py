from __future__ import annotations

import os
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.preflight import verify_workflow_preflight
from aria_kernel.workflow_contracts import (
    AUDITED_WORKFLOW_EXCLUSIONS,
    UPLOAD_ARTIFACT_ACTION,
    WORKFLOW_CONTRACTS,
    AuditedWorkflowExclusion,
    discover_aria_workflows,
    verify_workflow_contract,
    verify_workflow_registry,
    workflow_hash,
    workflow_job_contract_hash,
)


def _write_runtime_workflow(root: Path, workflow_id: str) -> None:
    contract = WORKFLOW_CONTRACTS[workflow_id]
    workflow = root / contract.workflow_file
    workflow.parent.mkdir(parents=True, exist_ok=True)
    workflow.write_text("name: unit\njobs: {}\n", encoding="utf-8")


class WorkflowEnterprisePreflightTests(unittest.TestCase):
    def test_upload_artifact_action_pins_live_v7_0_1_sha(self) -> None:
        # D4 (ADR-036) — the registry verifier must enforce the REAL live pin
        # (043fb46d… v7.0.1), not the canonical's stale ea165f8d… pin.
        self.assertEqual(
            UPLOAD_ARTIFACT_ACTION,
            "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
        )

    def test_global_kill_switch_is_hard_failure(self) -> None:
        # Security assertion #1 (preserved from main's 9) — kill switch is a
        # hard fail regardless of an otherwise-valid contracted call.
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
        # Security assertion #2 (preserved from main's 9) — fail-closed DLP +
        # token-provenance enforcement. finding-state-sweep contracts the
        # combined OIDC + verified App publication identity, so a default-token
        # + best-effort DLP call must hard-fail.
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

    def test_standalone_caller_keeps_github_app_token_value_allowlist(self) -> None:
        # Security assertion #2b (preserved from main) — for a NON-registered
        # (workflow_id, job_id) the no-contract path must STILL apply main's
        # github-app token-VALUE allowlist (the canonical dropped this).
        with tempfile.TemporaryDirectory() as tmp:
            verdict = verify_workflow_preflight(
                workflow_id="standalone-caller",
                job_id="job",
                profile="standard",
                workspace_root=tmp,
                allowed_write_roots=["some/path.jsonl"],
                path_allowlist=["some/path.jsonl"],
                network_policy=["github_api"],
                network_enforcement_evidence="gh api only",
                token_provenance="github_actions_default_token",
                audit_reason="unit test",
            )
            self.assertFalse(verdict.valid)
            self.assertIn("token_provenance_required", verdict.failure_classes)
            self.assertIn("github_app_token_required", verdict.reasons)

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
                network_policy=["github_api", "github_artifact"],
                network_enforcement_evidence="exact Actions run read and GitHub artifact upload",
                token_provenance="github_actions:actions_read+artifact",
                audit_reason="unit test",
                audit_artifact_path=runner_temp / "aria-daily-report-generate-preflight.json",
                external_root_allowlist=[str(runner_temp)],
            )
            self.assertTrue(verdict.valid, verdict.reasons)
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
        # CONVERGENCE GATE — every registered contract == its live YAML, every
        # discovered workflow covered, every audited exclusion valid.
        repo = Path(__file__).resolve().parents[2]
        verdict = verify_workflow_registry(workspace_root=repo)
        self.assertTrue(verdict.valid, verdict.reasons)
        self.assertEqual(verdict.failed_contracts, {})
        self.assertEqual(verdict.uncovered_workflows, ())

    def test_discovered_aria_workflows_are_contracted_or_audited_exclusions(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        discovered = set(discover_aria_workflows(repo))
        covered = set(WORKFLOW_CONTRACTS) | set(AUDITED_WORKFLOW_EXCLUSIONS)
        self.assertEqual(sorted(discovered - covered), [])
        for workflow_id, exclusion in AUDITED_WORKFLOW_EXCLUSIONS.items():
            self.assertIn(workflow_id, discovered)
            self.assertRegex(exclusion.expires_at, r"^\d{4}-\d{2}-\d{2}$")
            self.assertTrue(exclusion.owner)
        verdict = verify_workflow_registry(workspace_root=repo)
        self.assertTrue(verdict.valid, verdict.reasons)

    def test_audited_kernel_workflows_have_no_expiry_time_bomb(self) -> None:
        # D1 (ADR-036) — the 3 kernel workflows are audited-excluded with a
        # NON-expiring sentinel; the canonical's dated expires_at=2026-07-05
        # time-bomb is rejected.
        for workflow_id in ("aria-kernel", "aria-kernel-fast", "aria-kernel-full"):
            self.assertIn(workflow_id, AUDITED_WORKFLOW_EXCLUSIONS)
            self.assertEqual(AUDITED_WORKFLOW_EXCLUSIONS[workflow_id].expires_at, "9999-12-31")

    def test_workflow_registry_rejects_expired_audited_exclusion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow = root / ".github" / "workflows" / "aria-kernel.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text("name: aria-kernel\njobs: {}\n", encoding="utf-8")
            verdict = verify_workflow_registry(
                workspace_root=root,
                contract_registry={},
                audited_exclusions={
                    "aria-kernel": AuditedWorkflowExclusion(
                        workflow_id="aria-kernel",
                        reason="unit expired exclusion",
                        owner="aria-kernel",
                        expires_at="2000-01-01",
                    )
                },
            )
        self.assertFalse(verdict.valid)
        self.assertIn("workflow_audited_exclusion", verdict.failure_classes)
        self.assertIn("audited_exclusion_expired:aria-kernel:2000-01-01", verdict.reasons)

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
        # Security assertion #3 (preserved from main's 9) — the structured DLP
        # proof artifact is validated (workflow_id/job_id/valid/dlp/token/network/
        # workflow_hash/contract_hash/runtime_write_paths).
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
    timeout-minutes: 35
    steps:
      - name: Persist enterprise workflow preflight
        run: |
          python3 - <<'PY'
          import os
          from pathlib import Path
          from aria_kernel.preflight import verify_workflow_preflight
          verify_workflow_preflight(
              workflow_id="aria-operational-proof",
              job_id="proof",
              profile="standard",
              workspace_root=os.environ["GITHUB_WORKSPACE"],
              allowed_write_roots=[str(Path(os.environ["RUNNER_TEMP"]) / "aria-operational-proof")],
              path_allowlist=[str(Path(os.environ["RUNNER_TEMP"]) / "aria-operational-proof")],
              network_policy=["github_artifact"],
              network_enforcement_evidence="GitHub artifact upload only",
              token_provenance="github_actions_artifact_token",
              require_github_app=False,
              dlp_mode="fail_closed",
              dlp_scan_clean=True,
              audit_reason="unit test operational proof",
              audit_artifact_path=Path(os.environ["RUNNER_TEMP"]) / "aria-operational-proof" / "workflow-preflight.json",
              external_root_allowlist=[str(Path(os.environ["RUNNER_TEMP"]).resolve())],
          )
          PY
      - name: Run observe burn-in proof
        run: python3 -m aria_kernel autonomy burn-in observe --cycles 30
      - name: Upload ARIA operational proof
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
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

    def test_workflow_contract_rejects_runner_temp_audit_without_external_root_allowlist(self) -> None:
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
          import os
          from pathlib import Path
          from aria_kernel.preflight import verify_workflow_preflight
          verify_workflow_preflight(
              workflow_id="aria-operational-proof",
              job_id="proof",
              profile="standard",
              workspace_root=os.environ["GITHUB_WORKSPACE"],
              allowed_write_roots=[str(Path(os.environ["RUNNER_TEMP"]) / "aria-operational-proof")],
              path_allowlist=[str(Path(os.environ["RUNNER_TEMP"]) / "aria-operational-proof")],
              network_policy=["github_artifact"],
              network_enforcement_evidence="GitHub artifact upload only",
              token_provenance="github_actions_artifact_token",
              require_github_app=False,
              dlp_mode="fail_closed",
              dlp_scan_clean=True,
              audit_reason="unit test operational proof",
              audit_artifact_path=Path(os.environ["RUNNER_TEMP"]) / "aria-operational-proof" / "workflow-preflight.json",
          )
          PY
      - name: Run observe burn-in proof
        run: npm run aria:test:unit
      - name: Upload ARIA operational proof
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: aria-operational-proof-${{ github.sha }}
          path: ${{ runner.temp }}/aria-operational-proof/
          if-no-files-found: error
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
        self.assertIn("workflow_preflight_call_shape", verdict.failure_classes)
        self.assertIn("workflow_preflight_external_root_allowlist_missing:proof", verdict.reasons)

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
          import os
          from pathlib import Path
          from aria_kernel.preflight import verify_workflow_preflight
          verify_workflow_preflight(
              workflow_id="aria-operational-proof",
              job_id="proof",
              profile="standard",
              workspace_root=os.environ["GITHUB_WORKSPACE"],
              allowed_write_roots=[str(Path(os.environ["RUNNER_TEMP"]) / "aria-operational-proof")],
              path_allowlist=[str(Path(os.environ["RUNNER_TEMP"]) / "aria-operational-proof")],
              network_policy=["github_artifact"],
              network_enforcement_evidence="GitHub artifact upload only",
              token_provenance="github_actions_artifact_token",
              audit_artifact_path=Path(os.environ["RUNNER_TEMP"]) / "aria-operational-proof" / "workflow-preflight.json",
              external_root_allowlist=[str(Path(os.environ["RUNNER_TEMP"]).resolve())],
          )
          PY
      - name: Run observe burn-in proof
        run: npm run aria:test:unit
      - name: Upload ARIA operational proof
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
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


class BurnInTimeoutFloorTests(unittest.TestCase):
    """ORPHAN finding: run 28577469404 — a flat 50-minute job timeout killed a
    REAL 30-cycle observe burn-in (~80-90 min) mid-flight; the all-or-nothing
    acceptance verdict turned the truncation into ZERO ladder evidence. The
    contract floor makes the workload>timeout class structurally detectable.
    """

    def _verdict_for(self, workflow_id: str, timeout_line: str, burn_in_step: bool):
        run_line = (
            "PYTHONPATH=aria-kernel python3 -m aria_kernel autonomy burn-in observe --cycles 30"
            if burn_in_step
            else "echo no-burn-in"
        )
        job_id = WORKFLOW_CONTRACTS[workflow_id].job_contracts[0].job_id
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow = root / WORKFLOW_CONTRACTS[workflow_id].workflow_file
            workflow.parent.mkdir(parents=True)
            workflow.write_text(
                f"""
name: unit
permissions:
  contents: read
jobs:
  {job_id}:
    {timeout_line}
    permissions:
      contents: read
    steps:
      - name: Step
        run: {run_line}
""",
                encoding="utf-8",
            )
            return verify_workflow_contract(
                workflow_id=workflow_id,
                workspace_root=root,
                event_context={"token_source": "github_actions_artifact_token"},
            )

    def test_registry_pins_measured_floors(self) -> None:
        # Value pins: REAL burn-in floor sized from the 80-90 min measurement;
        # MOCK proof floor sized from its minutes-scale dry-run cycles.
        cycle = WORKFLOW_CONTRACTS["aria-auto-cycle"].job_contracts[0]
        proof = WORKFLOW_CONTRACTS["aria-operational-proof"].job_contracts[0]
        self.assertEqual(cycle.burn_in_timeout_floor_minutes, 120)
        self.assertEqual(proof.burn_in_timeout_floor_minutes, 30)

    def test_integer_timeout_at_or_above_floor_passes(self) -> None:
        verdict = self._verdict_for(
            "aria-operational-proof", "timeout-minutes: 35", burn_in_step=True
        )
        self.assertNotIn("workflow_contract_burn_in_timeout", verdict.failure_classes)

    def test_mode_expression_burn_in_branch_at_floor_passes(self) -> None:
        verdict = self._verdict_for(
            "aria-operational-proof",
            "timeout-minutes: ${{ github.event.inputs.mode == 'burn-in-observe' && 150 || 50 }}",
            burn_in_step=True,
        )
        self.assertNotIn("workflow_contract_burn_in_timeout", verdict.failure_classes)

    def test_mode_expression_burn_in_branch_below_floor_rejects(self) -> None:
        verdict = self._verdict_for(
            "aria-operational-proof",
            "timeout-minutes: ${{ github.event.inputs.mode == 'burn-in-observe' && 25 || 50 }}",
            burn_in_step=True,
        )
        self.assertIn("workflow_contract_burn_in_timeout", verdict.failure_classes)
        self.assertTrue(
            any(r.startswith("burn_in_timeout_below_floor:proof:25<30") for r in verdict.reasons),
            verdict.reasons,
        )

    def test_integer_timeout_below_floor_rejects(self) -> None:
        verdict = self._verdict_for(
            "aria-operational-proof", "timeout-minutes: 20", burn_in_step=True
        )
        self.assertIn("workflow_contract_burn_in_timeout", verdict.failure_classes)

    def test_missing_timeout_rejects_despite_github_default(self) -> None:
        # GitHub's implicit 360-minute default would exceed the floor, but an
        # unexamined inherited timeout is exactly the original defect —
        # explicit sizing is the contract.
        verdict = self._verdict_for(
            "aria-operational-proof", "env: {}", burn_in_step=True
        )
        self.assertIn("workflow_contract_burn_in_timeout", verdict.failure_classes)
        self.assertTrue(
            any(r.startswith("burn_in_timeout_missing_or_unparseable") for r in verdict.reasons),
            verdict.reasons,
        )

    def test_floor_without_burn_in_step_rejects(self) -> None:
        verdict = self._verdict_for(
            "aria-operational-proof", "timeout-minutes: 35", burn_in_step=False
        )
        self.assertIn("workflow_contract_burn_in_timeout", verdict.failure_classes)
        self.assertTrue(
            any(r.startswith("burn_in_timeout_floor_without_burn_in_step") for r in verdict.reasons),
            verdict.reasons,
        )

    def test_burn_in_step_without_declared_floor_rejects(self) -> None:
        # Self-enforcing direction: a NEW burn-in step cannot land in a job
        # whose contract never declared (= never sized) a floor.
        verdict = self._verdict_for(
            "aria-agent-executor", "timeout-minutes: 35", burn_in_step=True
        )
        self.assertIn("workflow_contract_burn_in_timeout", verdict.failure_classes)
        self.assertTrue(
            any(r.startswith("burn_in_step_without_contract_timeout_floor") for r in verdict.reasons),
            verdict.reasons,
        )


class StepOrderingAndAbortGateContract(unittest.TestCase):
    """ORPHAN-CRITICAL-469 was reintroducible with the suite green.

    Mutation testing against the pre-fix registry: moving "Restore aria-tools
    state from previous run" to AFTER "Find next pending request" passed both
    ``verify_workflow_contract`` and ``verify_workflow_registry``, and so did
    deleting the publish and quarantine steps outright. Only renaming or
    deleting the restore step was caught, because
    ``first_governed_mutation_step`` pins a name and its position relative to
    the preflight — nothing else. The moved-restore mutation IS the original
    bug: ``next_pending_request`` reads the queue before the queue has been
    restored and always answers None.

    Every test below runs the mutation against the LIVE YAML rather than a
    synthetic fixture, so a contract that has quietly stopped applying to the
    real workflow cannot pass here.
    """

    _EXECUTOR = "aria-agent-executor"
    _CYCLE = "aria-auto-cycle"

    def _mutated_verdict(self, workflow_id: str, mutate):
        """Apply ``mutate`` to the live job's step list and re-verify."""
        repo = Path(__file__).resolve().parents[2]
        contract = WORKFLOW_CONTRACTS[workflow_id]
        job_id = contract.job_contracts[0].job_id
        import yaml  # local import: the verifier owns the dependency

        workflow = yaml.safe_load(
            (repo / contract.workflow_file).read_text(encoding="utf-8")
        )
        workflow["jobs"][job_id]["steps"] = mutate(
            list(workflow["jobs"][job_id]["steps"])
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / contract.workflow_file
            target.parent.mkdir(parents=True)
            target.write_text(
                yaml.safe_dump(workflow, sort_keys=False), encoding="utf-8",
            )
            return verify_workflow_contract(
                workflow_id=workflow_id, workspace_root=root,
            )

    def _mutated_job_verdict(self, workflow_id: str, mutate_job):
        """Apply ``mutate_job`` to the live job dict itself and re-verify."""
        repo = Path(__file__).resolve().parents[2]
        contract = WORKFLOW_CONTRACTS[workflow_id]
        job_id = contract.job_contracts[0].job_id
        import yaml  # local import: the verifier owns the dependency

        workflow = yaml.safe_load(
            (repo / contract.workflow_file).read_text(encoding="utf-8")
        )
        workflow["jobs"][job_id] = mutate_job(dict(workflow["jobs"][job_id]))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / contract.workflow_file
            target.parent.mkdir(parents=True)
            target.write_text(
                yaml.safe_dump(workflow, sort_keys=False), encoding="utf-8",
            )
            return verify_workflow_contract(
                workflow_id=workflow_id, workspace_root=root,
            )

    def test_job_timeout_drifting_from_the_contract_is_rejected(self) -> None:
        """ORPHAN-HIGH-472 — the kernel budgets against this number.

        ``cycle_wall_clock_cap_seconds`` derives ARIA's self-imposed ceiling
        from ``job_timeout_minutes``. If the YAML moved and the contract did
        not, ARIA would budget against a limit the runner does not enforce:
        either stopping early for nothing, or running past the point where
        GitHub kills it — which is the exact failure the ceiling exists to
        prevent, since a killed job strands the claim.
        """
        for workflow_id in (self._EXECUTOR, self._CYCLE):
            with self.subTest(workflow=workflow_id):
                def mutate(job):
                    job["timeout-minutes"] = 999
                    return job

                verdict = self._mutated_job_verdict(workflow_id, mutate)
                self.assertFalse(verdict.valid)
                self.assertIn("workflow_contract_job_timeout", verdict.failure_classes)

    def test_declared_job_timeout_matches_the_live_yaml(self) -> None:
        # The acceptance direction, and a live-value assertion: if someone
        # retunes the YAML timeout deliberately, this fails and points at the
        # contract that must move with it.
        from aria_kernel.workflow_contract_registry import (
            WALL_CLOCK_RESERVE_MINUTES,
            cycle_wall_clock_cap_seconds,
        )

        self.assertEqual(
            cycle_wall_clock_cap_seconds(self._EXECUTOR),
            (45 - WALL_CLOCK_RESERVE_MINUTES) * 60,
        )
        self.assertEqual(
            cycle_wall_clock_cap_seconds(self._CYCLE),
            (50 - WALL_CLOCK_RESERVE_MINUTES) * 60,
        )
        # An unknown lane must be None ("no self-imposed ceiling"), never 0,
        # which would refuse every dispatch.
        self.assertIsNone(cycle_wall_clock_cap_seconds("no-such-workflow"))

    @staticmethod
    def _index_of(steps, name: str) -> int:
        return next(
            idx for idx, step in enumerate(steps)
            if isinstance(step, dict) and step.get("name") == name
        )

    def test_live_workflows_satisfy_their_declared_step_contracts(self) -> None:
        # The unmutated control. Without it, every rejection below could be
        # explained by the round-trip rather than by the mutation.
        repo = Path(__file__).resolve().parents[2]
        for workflow_id in (self._EXECUTOR, self._CYCLE):
            with self.subTest(workflow=workflow_id):
                verdict = verify_workflow_contract(
                    workflow_id=workflow_id, workspace_root=repo,
                )
                self.assertTrue(verdict.valid, verdict.reasons)
        for workflow_id in (self._EXECUTOR, self._CYCLE):
            with self.subTest(workflow=workflow_id, form="round-tripped"):
                verdict = self._mutated_verdict(workflow_id, lambda steps: steps)
                self.assertTrue(verdict.valid, verdict.reasons)

    def test_restore_moved_after_the_queue_read_is_rejected(self) -> None:
        """The verbatim ORPHAN-CRITICAL-469 reintroduction."""
        def mutate(steps):
            restore = steps.pop(self._index_of(steps, "Restore aria-tools state from previous run"))
            steps.insert(
                self._index_of(steps, "Find next pending request") + 1, restore,
            )
            return steps

        verdict = self._mutated_verdict(self._EXECUTOR, mutate)
        self.assertFalse(verdict.valid)
        self.assertIn("workflow_contract_ordering", verdict.failure_classes)
        self.assertTrue(
            any(
                r.startswith("workflow_step_out_of_order:executor:")
                and "Find next pending request" in r
                for r in verdict.reasons
            ),
            verdict.reasons,
        )

    def test_restore_moved_after_the_lease_preflight_is_rejected(self) -> None:
        # The other half of 469: lease_state() reads the restored tree, so a
        # bootstrap-empty one cannot observe a lease another host holds.
        def mutate(steps):
            restore = steps.pop(self._index_of(steps, "Restore aria-tools state from previous run"))
            steps.insert(
                self._index_of(steps, "Pre-flight — cross-host autonomous-loop lease check") + 1,
                restore,
            )
            return steps

        verdict = self._mutated_verdict(self._EXECUTOR, mutate)
        self.assertFalse(verdict.valid)
        self.assertIn("workflow_contract_ordering", verdict.failure_classes)

    def test_deleting_publish_or_quarantine_is_rejected(self) -> None:
        for step_name in (
            "Persist aria-tools state (verified)",
            "Quarantine unverified aria-tools state",
            "Fail when aria-tools state was not published",
        ):
            with self.subTest(step=step_name):
                verdict = self._mutated_verdict(
                    self._EXECUTOR,
                    lambda steps, name=step_name: [
                        s for s in steps
                        if not (isinstance(s, dict) and s.get("name") == name)
                    ],
                )
                self.assertFalse(verdict.valid)
                self.assertIn("workflow_contract_steps", verdict.failure_classes)
                self.assertIn(
                    f"workflow_required_step_missing:executor:{step_name}",
                    verdict.reasons,
                )

    def test_publish_moved_before_the_work_is_rejected(self) -> None:
        # Terminal accounting that runs before the work reports on a tree the
        # run never wrote.
        def mutate(steps):
            publish = steps.pop(self._index_of(steps, "Persist aria-tools state (verified)"))
            steps.insert(self._index_of(steps, "Run CI executor"), publish)
            return steps

        verdict = self._mutated_verdict(self._EXECUTOR, mutate)
        self.assertFalse(verdict.valid)
        self.assertIn("workflow_contract_ordering", verdict.failure_classes)

    def test_a_step_after_the_lease_gate_without_the_guard_is_rejected(self) -> None:
        """FIX 2's structural half: `exit 0` ends a step, not a job.

        A step after the gate with no guard runs during a blocked cycle. In
        aria-agent-executor that meant claiming a request and invoking an
        agent against a tree another host held the lease on.
        """
        for workflow_id, victim in (
            (self._EXECUTOR, "Run CI executor"),
            (self._CYCLE, "Run nightly standard-profile cycle"),
        ):
            with self.subTest(workflow=workflow_id, step=victim):
                def mutate(steps, name=victim):
                    for step in steps:
                        if isinstance(step, dict) and step.get("name") == name:
                            step.pop("if", None)
                    return steps

                verdict = self._mutated_verdict(workflow_id, mutate)
                self.assertFalse(verdict.valid)
                self.assertIn("workflow_contract_abort_gate", verdict.failure_classes)
                self.assertIn(
                    f"workflow_abort_gate_unguarded_step:"
                    f"{WORKFLOW_CONTRACTS[workflow_id].job_contracts[0].job_id}:{victim}",
                    verdict.reasons,
                )

    def test_a_guard_naming_the_wrong_output_is_rejected(self) -> None:
        # A plausible near-miss: the step carries an `if:`, just not the one
        # the gate writes. Substring matching must not accept it.
        def mutate(steps):
            for step in steps:
                if isinstance(step, dict) and step.get("name") == "Run CI executor":
                    step["if"] = "steps.preflight.outputs.effective_mock != 'true'"
            return steps

        verdict = self._mutated_verdict(self._EXECUTOR, mutate)
        self.assertFalse(verdict.valid)
        self.assertIn("workflow_contract_abort_gate", verdict.failure_classes)

    def test_reformatted_guard_is_still_accepted(self) -> None:
        # The inverse of the test above: a gate that rejects a correctly
        # guarded step for whitespace gets deleted for being noisy.
        def mutate(steps):
            for step in steps:
                if isinstance(step, dict) and step.get("name") == "Run CI executor":
                    step["if"] = (
                        "steps.pending.outputs.request_id != ''\n&&  "
                        "steps.lease_check.outputs.blocked   !=   'true'"
                    )
            return steps

        verdict = self._mutated_verdict(self._EXECUTOR, mutate)
        self.assertNotIn("workflow_contract_abort_gate", verdict.failure_classes)

    def test_a_guard_widened_by_a_top_level_or_is_rejected(self) -> None:
        """ORPHAN-MEDIUM-491 — the inert guard.

        ``<guard> || always()`` CONTAINS the guard verbatim, so the old
        substring match accepted it, while ``always()`` makes the condition
        unconditionally true. The step therefore ran during a blocked cycle —
        the exact failure the abort gate exists to prevent. This test fails
        against the pre-fix `guard in condition` implementation.
        """
        guard = WORKFLOW_CONTRACTS[self._EXECUTOR].job_contracts[0].abort_gate.guard_expression
        for widener in ("always()", "success()", "github.event_name == 'workflow_dispatch'"):
            with self.subTest(widener=widener):
                def mutate(steps, widener=widener):
                    for step in steps:
                        if isinstance(step, dict) and step.get("name") == "Run CI executor":
                            step["if"] = "${{ " + guard + " || " + widener + " }}"
                    return steps

                verdict = self._mutated_verdict(self._EXECUTOR, mutate)
                self.assertFalse(verdict.valid)
                self.assertIn("workflow_contract_abort_gate", verdict.failure_classes)

    def test_an_inverted_guard_on_a_worker_step_is_rejected(self) -> None:
        """TEST-HIGH-004 — one character, and the gate meant the opposite.

        The announce exemption used to be global, so ANY step could spell
        `blocked == 'true'` and pass. Flipping `!=` to `==` on the worker step
        makes the CI executor run ONLY while another host holds the lease —
        claiming requests and dispatching agents against a tree being mutated
        elsewhere, which is ORPHAN-CRITICAL-469 restored with the contract
        gate still green. The exemption is now scoped to the declared
        announce step alone.
        """
        gate = WORKFLOW_CONTRACTS[self._EXECUTOR].job_contracts[0].abort_gate
        inverted = gate.skip_expression

        def mutate(steps):
            for step in steps:
                if isinstance(step, dict) and step.get("name") == "Run CI executor":
                    step["if"] = inverted
            return steps

        verdict = self._mutated_verdict(self._EXECUTOR, mutate)
        self.assertFalse(verdict.valid)
        self.assertIn("workflow_contract_abort_gate", verdict.failure_classes)

    def test_the_declared_announce_step_keeps_its_exemption(self) -> None:
        # The acceptance direction: the one step that exists to announce the
        # block must still be allowed to carry the inverse guard, or the live
        # workflow stops verifying.
        gate = WORKFLOW_CONTRACTS[self._EXECUTOR].job_contracts[0].abort_gate
        self.assertTrue(gate.announce_step)
        verdict = self._mutated_verdict(self._EXECUTOR, lambda steps: steps)
        self.assertTrue(verdict.valid, verdict.reasons)

    def test_a_guard_present_in_every_disjunct_is_still_accepted(self) -> None:
        # The other direction, and the reason the fix is a top-level split
        # rather than "reject any ||": fan-out where BOTH branches are gated
        # is correct, and a gate that rejected it would get deleted for being
        # noisy (see _collapse's docstring).
        guard = WORKFLOW_CONTRACTS[self._EXECUTOR].job_contracts[0].abort_gate.guard_expression

        def mutate(steps):
            for step in steps:
                if isinstance(step, dict) and step.get("name") == "Run CI executor":
                    step["if"] = (
                        f"({guard} && github.event_name == 'schedule') || "
                        f"({guard} && github.event_name == 'workflow_dispatch')"
                    )
            return steps

        verdict = self._mutated_verdict(self._EXECUTOR, mutate)
        self.assertNotIn("workflow_contract_abort_gate", verdict.failure_classes)

    def test_a_nested_or_inside_a_guarded_conjunct_is_still_accepted(self) -> None:
        # Depth-awareness: `guard && (a || b)` is ONE gated branch. A naive
        # split on every `||` would see `guard && (a` and `b)` and reject a
        # correctly guarded step.
        guard = WORKFLOW_CONTRACTS[self._EXECUTOR].job_contracts[0].abort_gate.guard_expression

        def mutate(steps):
            for step in steps:
                if isinstance(step, dict) and step.get("name") == "Run CI executor":
                    step["if"] = (
                        f"{guard} && (github.event_name == 'schedule' || "
                        "github.event_name == 'workflow_dispatch')"
                    )
            return steps

        verdict = self._mutated_verdict(self._EXECUTOR, mutate)
        self.assertNotIn("workflow_contract_abort_gate", verdict.failure_classes)

    def test_the_announce_step_may_carry_the_inverse_guard(self) -> None:
        # "Skip autonomous loop when local lease is fresh" runs ONLY when
        # blocked; the gate must permit exactly that one shape.
        gate = WORKFLOW_CONTRACTS[self._EXECUTOR].job_contracts[0].abort_gate
        self.assertIsNotNone(gate)
        self.assertEqual(gate.skip_expression, "steps.lease_check.outputs.blocked == 'true'")
        self.assertEqual(gate.guard_expression, "steps.lease_check.outputs.blocked != 'true'")

    def test_every_lease_gated_workflow_declares_an_abort_gate(self) -> None:
        """Discovery-driven, so a THIRD lease-gated workflow cannot ship
        without declaring the gate that makes its `exit 0` real."""
        repo = Path(__file__).resolve().parents[2]
        for workflow_id, path in discover_aria_workflows(repo).items():
            if "outputs.blocked" not in path.read_text(encoding="utf-8"):
                continue
            with self.subTest(workflow=workflow_id):
                contract = WORKFLOW_CONTRACTS.get(workflow_id)
                self.assertIsNotNone(
                    contract,
                    f"{workflow_id} gates on a blocked output but is not contracted",
                )
                self.assertTrue(
                    any(job.abort_gate is not None for job in contract.job_contracts),
                    f"{workflow_id} gates on a blocked output but declares no "
                    "abort_gate, so nothing checks that its later steps carry "
                    "the guard — `exit 0` does not abort a GitHub Actions job",
                )


if __name__ == "__main__":
    unittest.main()
