from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class WorkflowJobContract:
    job_id: str
    preflight_step: str
    first_governed_mutation_step: str
    allowed_write_path_patterns: tuple[str, ...]
    preflight_artifact_path_pattern: str
    upload_artifact_name_pattern: str
    upload_artifact_path_patterns: tuple[str, ...]
    retention_days: int
    required_permissions: tuple[tuple[str, str], ...]
    token_source: str
    network_policy: tuple[str, ...]
    dlp_artifact: str
    clean_worktree_policy: str
    external_root_allowlist: tuple[str, ...] = ()


@dataclass(frozen=True)
class WorkflowContract:
    workflow_id: str
    workflow_file: str
    job_contracts: tuple[WorkflowJobContract, ...]


@dataclass(frozen=True)
class AuditedWorkflowExclusion:
    workflow_id: str
    reason: str
    owner: str
    expires_at: str


_SHA = r"sha256:[0-9a-f]{64}"
_RUNNER_TEMP = r"runner-temp"
_RUN_ID_ATTEMPT = r"\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}"
_REQUEST_ID = r"\$\{\{\s*steps\.pending\.outputs\.request_id\s*\}\}"
_REPORT_DATE = r"[0-9]{4}-[0-9]{2}-[0-9]{2}"


WORKFLOW_CONTRACTS: dict[str, WorkflowContract] = {
    "aria-agent-executor": WorkflowContract(
        workflow_id="aria-agent-executor",
        workflow_file=".github/workflows/aria-agent-executor.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="executor",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Handoff snapshot — session_start",
                allowed_write_path_patterns=(
                    r"^aria-tools/governance\.jsonl$",
                    r"^aria-tools/handoffs\.jsonl$",
                    r"^aria-tools/agent-invocations/claims\.jsonl$",
                    r"^aria-tools/agent-invocations/results\.jsonl$",
                    r"^aria-tools/agent-invocations/outputs/[A-Za-z0-9_-]{1,64}\.json$",
                    r"^aria-tools/agent-invocations/prompts/[A-Za-z0-9_-]{1,64}\.md$",
                ),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/aria-agent-executor-preflight\.json$",
                upload_artifact_name_pattern=rf"^aria-response-{_REQUEST_ID}$",
                upload_artifact_path_patterns=(
                    rf"^{_RUNNER_TEMP}/aria-agent-executor-preflight\.json$",
                    rf"^aria-tools/agent-invocations/outputs/{_REQUEST_ID}\.json$",
                ),
                retention_days=7,
                required_permissions=(("contents", "read"),),
                token_source="github_actions_artifact_token",
                network_policy=("actions_runtime", "codex_cloud", "github_artifact", "github_git"),
                dlp_artifact="aria-agent-executor-preflight.json",
                clean_worktree_policy="preflight_only_foundation",
                external_root_allowlist=("RUNNER_TEMP",),
            ),
        ),
    ),
    "aria-agent-eval": WorkflowContract(
        workflow_id="aria-agent-eval",
        workflow_file=".github/workflows/aria-agent-eval.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="eval",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Run all eval fixtures (mock mode)",
                allowed_write_path_patterns=(
                    r"^aria-tools/agent-evals/runs\.jsonl$",
                    r"^aria-tools/governance\.jsonl$",
                ),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/aria-agent-eval-preflight\.json$",
                upload_artifact_name_pattern=rf"^aria-agent-eval-proof-{_RUN_ID_ATTEMPT}$",
                upload_artifact_path_patterns=(rf"^{_RUNNER_TEMP}/aria-agent-eval-preflight\.json$",),
                retention_days=7,
                required_permissions=(("contents", "read"),),
                token_source="github_actions_artifact_token",
                network_policy=("actions_runtime", "github_artifact", "github_git"),
                dlp_artifact="aria-agent-eval-preflight.json",
                clean_worktree_policy="preflight_only_foundation",
                external_root_allowlist=("RUNNER_TEMP",),
            ),
        ),
    ),
    "aria-daily-report": WorkflowContract(
        workflow_id="aria-daily-report",
        workflow_file=".github/workflows/aria-daily-report.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="generate-report",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Generate daily chain-tip anchor (Plan ARIA-V2 §3.9)",
                allowed_write_path_patterns=(rf"^aria-tools/reports/daily/{_REPORT_DATE}\.md$",),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/aria-daily-report-generate-preflight\.json$",
                upload_artifact_name_pattern=rf"^aria-daily-report-\$\{{\{{\s*steps\.target\.outputs\.date\s*\}}\}}$",
                upload_artifact_path_patterns=(
                    rf"^aria-tools/reports/daily/\$\{{\{{\s*steps\.target\.outputs\.date\s*\}}\}}\.md$",
                    rf"^{_RUNNER_TEMP}/aria-daily-report-generate-preflight\.json$",
                ),
                retention_days=365,
                required_permissions=(("contents", "read"),),
                token_source="github_actions_artifact_token",
                network_policy=("actions_runtime", "github_artifact", "github_git", "pypi"),
                dlp_artifact="aria-daily-report-generate-preflight.json",
                clean_worktree_policy="preflight_only_foundation",
                external_root_allowlist=("RUNNER_TEMP",),
            ),
            WorkflowJobContract(
                job_id="commit-report",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Open or update daily report PR",
                allowed_write_path_patterns=(rf"^aria-tools/reports/daily/{_REPORT_DATE}\.md$",),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/aria-daily-report-preflight\.json$",
                upload_artifact_name_pattern=rf"^aria-daily-report-commit-preflight-{_RUN_ID_ATTEMPT}$",
                upload_artifact_path_patterns=(rf"^{_RUNNER_TEMP}/aria-daily-report-preflight\.json$",),
                retention_days=365,
                required_permissions=(("contents", "read"),),
                token_source="github_app:installation",
                network_policy=("actions_runtime", "github_api", "github_artifact", "github_git"),
                dlp_artifact="aria-daily-report-preflight.json",
                clean_worktree_policy="preflight_only_foundation",
                external_root_allowlist=("RUNNER_TEMP",),
            ),
        ),
    ),
    "finding-state-sweep": WorkflowContract(
        workflow_id="finding-state-sweep",
        workflow_file=".github/workflows/finding-state-sweep.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="sweep",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Apply sweep",
                allowed_write_path_patterns=(r"^docs/reviews/_registry/findings\.jsonl$",),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/finding-state-sweep-preflight\.json$",
                upload_artifact_name_pattern=rf"^finding-state-sweep-proof-{_RUN_ID_ATTEMPT}$",
                upload_artifact_path_patterns=(rf"^{_RUNNER_TEMP}/finding-state-sweep-preflight\.json$",),
                retention_days=365,
                required_permissions=(("contents", "read"), ("pull-requests", "read")),
                token_source="github_app:installation",
                network_policy=("actions_runtime", "github_api", "github_artifact", "github_git", "npm_registry"),
                dlp_artifact="finding-state-sweep-preflight.json",
                clean_worktree_policy="preflight_only_foundation",
                external_root_allowlist=("RUNNER_TEMP",),
            ),
        ),
    ),
    "rule-health-report": WorkflowContract(
        workflow_id="rule-health-report",
        workflow_file=".github/workflows/rule-health-report.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="generate",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Generate report",
                allowed_write_path_patterns=(
                    r"^docs/reviews/rule-health/[0-9]{4}-[0-9]{2}-[0-9]{2}-rule-health-[0-9]{4}-[0-9]{2}\.md$",
                ),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/rule-health-report-preflight\.json$",
                upload_artifact_name_pattern=rf"^rule-health-report-proof-{_RUN_ID_ATTEMPT}$",
                upload_artifact_path_patterns=(rf"^{_RUNNER_TEMP}/rule-health-report-preflight\.json$",),
                retention_days=365,
                required_permissions=(("contents", "read"), ("pull-requests", "read")),
                token_source="github_app:installation",
                network_policy=("actions_runtime", "github_api", "github_artifact", "github_git", "npm_registry"),
                dlp_artifact="rule-health-report-preflight.json",
                clean_worktree_policy="preflight_only_foundation",
                external_root_allowlist=("RUNNER_TEMP",),
            ),
        ),
    ),
}


AUDITED_WORKFLOW_EXCLUSIONS: dict[str, AuditedWorkflowExclusion] = {
    "aria-kernel": AuditedWorkflowExclusion(
        workflow_id="aria-kernel",
        reason="test-only kernel validation workflow; no governed ARIA state write authority",
        owner="aria-kernel",
        expires_at="2026-07-05",
    ),
    "aria-kernel-fast": AuditedWorkflowExclusion(
        workflow_id="aria-kernel-fast",
        reason="test-only fast kernel validation workflow; no governed ARIA state write authority",
        owner="aria-kernel",
        expires_at="2026-07-05",
    ),
    "aria-kernel-full": AuditedWorkflowExclusion(
        workflow_id="aria-kernel-full",
        reason="test-only full kernel validation workflow; no governed ARIA state write authority",
        owner="aria-kernel",
        expires_at="2026-07-05",
    ),
}


def workflow_contract_registry() -> dict[str, WorkflowContract]:
    return dict(WORKFLOW_CONTRACTS)


def workflow_job_contract(workflow_id: str, job_id: str) -> WorkflowJobContract | None:
    contract = WORKFLOW_CONTRACTS.get(workflow_id)
    if contract is None:
        return None
    for job in contract.job_contracts:
        if job.job_id == job_id:
            return job
    return None


def workflow_hash(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def workflow_contract_hash(contract: WorkflowContract) -> str:
    payload = json.dumps(asdict(contract), sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def workflow_job_contract_hash(workflow_id: str, job_id: str) -> str | None:
    contract = WORKFLOW_CONTRACTS.get(workflow_id)
    job = workflow_job_contract(workflow_id, job_id)
    if contract is None or job is None:
        return None
    payload = {
        "workflow_id": workflow_id,
        "workflow_file": contract.workflow_file,
        "job_contract": asdict(job),
    }
    return "sha256:" + hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


__all__ = [
    "AUDITED_WORKFLOW_EXCLUSIONS",
    "WORKFLOW_CONTRACTS",
    "AuditedWorkflowExclusion",
    "WorkflowContract",
    "WorkflowJobContract",
    "workflow_contract_hash",
    "workflow_contract_registry",
    "workflow_hash",
    "workflow_job_contract",
    "workflow_job_contract_hash",
]
