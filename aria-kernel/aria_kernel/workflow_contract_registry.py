"""ADR-036 — per-job CI-workflow governance registry (single SSoT).

This module is the ONE definition of the governed-workflow contract set.
``workflow_contracts.py``, ``preflight.py`` and ``docs_ssot.py`` all import
``WORKFLOW_CONTRACTS`` (and the nested dataclasses) FROM here — there is no
second copy of the contract dict anywhere (CLAUDE.md root-cause SSoT rule).

Contract model (nested, per-job):

* ``WorkflowJobContract`` — the per-job governance unit. A job is the GitHub
  Actions unit that holds a ``permissions:`` scope + a ``steps:`` list, so the
  per-job granularity is what lets ADR-036 verify permissions, the
  SHA-pinned upload-artifact step, the preflight-call shape and the
  write-path allowlist independently for every job in a workflow.
* ``WorkflowContract`` — a workflow groups one-or-more ``WorkflowJobContract``.
* ``AuditedWorkflowExclusion`` — a workflow that is discovered + owned but
  deliberately NOT contract-verified, with an owner + reason + expiry so the
  exclusion is auditable rather than silent.

D1 (ADR-036) — the 3 ``aria-kernel*`` test workflows carry NO governed ARIA
write authority (they write only the ephemeral ``./.aria-ci`` scratch tree,
clean the worktree post-run, and never upload a governed artifact). They are
modelled as ``AuditedWorkflowExclusion`` so they stay in the governed
inventory (owner + reason + discovery-presence enforced) WITHOUT fabricating a
``verify_workflow_preflight`` step or a governed upload-artifact step that
would misrepresent their write surface. The canonical ``13b94c505`` blob put
them under audited-exclusion with ``expires_at=2026-07-05`` — a dated
time-bomb that would silently expire and red the registry. D1's recorded
consequence is exactly "Rejects the canonical's expires_at=2026-07-05
time-bomb": we keep the audited-exclusion shape but pin ``expires_at`` to the
non-expiring ``date.max`` sentinel (``9999-12-31``) so there is no time-bomb.
See ADR-036 §Decision Points D1 and the convergence spec for the full
rationale (this is a deliberate, documented divergence from the spec's
"FULL contract" letter in favour of its stated D1 consequence — forcing
governed-write structure into pure test workflows is not an architectural
root-cause fix, it is a misrepresentation of their write authority).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import date
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
    # Minimum effective ``timeout-minutes`` for a job whose steps run
    # ``autonomy burn-in observe``. A burn-in is all-or-nothing (the kernel
    # pins 30 cycle attempts; a partial run yields ZERO ladder evidence), so a
    # timeout sized below the measured workload silently destroys the whole
    # run — run 28577469404 died this way under a flat 50-minute limit.
    # ``None`` means the job runs no burn-in step (and the verifier rejects a
    # burn-in step appearing in such a job — both directions are enforced).
    burn_in_timeout_floor_minutes: int | None = None


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


# ``date.max`` (9999-12-31) is a valid ISO date that never satisfies the
# ``expires_at <= date.today()`` expiry check in ``_verify_audited_exclusions``.
# It is the "audited but non-expiring" sentinel (ADR-036 D1 — no time-bomb).
_NEVER_EXPIRES = date.max.isoformat()


# Regex fragments for the upload-artifact path / name patterns. These match the
# GitHub-expression interpolations EXACTLY as the live YAMLs emit them, after
# ``_normalize_workflow_path`` collapses ``${{ runner.temp }}`` -> ``runner-temp``.
_RUNNER_TEMP = r"runner-temp"
_RUN_ID_ATTEMPT = r"\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}"
_REQUEST_ID = r"\$\{\{\s*steps\.pending\.outputs\.request_id\s*\}\}"
_REPORT_DATE = r"[0-9]{4}-[0-9]{2}-[0-9]{2}"
_REPORT_DATE_EXPR = r"\$\{\{\s*steps\.target\.outputs\.date\s*\}\}"


# All contract VALUES below are re-derived from main's LIVE workflow YAMLs
# (ADR-036: structure is portable from 13b94c505, values are NOT — they target
# a divergent YAML generation). Job keys are the YAML-true keys
# (executor / generate-report / commit-report / generate / eval / sweep / proof).
WORKFLOW_CONTRACTS: dict[str, WorkflowContract] = {
    "aria-operational-proof": WorkflowContract(
        workflow_id="aria-operational-proof",
        workflow_file=".github/workflows/aria-operational-proof.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="proof",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Run observe burn-in proof",
                allowed_write_path_patterns=(
                    rf"^{_RUNNER_TEMP}/aria-operational-proof$",
                ),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/aria-operational-proof/workflow-preflight\.json$",
                upload_artifact_name_pattern=r"^aria-operational-proof-\$\{\{\s*github\.sha\s*\}\}$",
                upload_artifact_path_patterns=(rf"^{_RUNNER_TEMP}/aria-operational-proof$",),
                retention_days=365,
                required_permissions=(("contents", "read"),),
                token_source="github_actions_artifact_token",
                network_policy=("github_artifact",),
                dlp_artifact="workflow-preflight.json",
                clean_worktree_policy="pre_and_post",
                external_root_allowlist=("RUNNER_TEMP",),
                # MOCK-mode burn-in (dry-run cycles, minutes-scale); the live
                # YAML's 35-minute job timeout satisfies this floor.
                burn_in_timeout_floor_minutes=30,
            ),
        ),
    ),
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
                    r"^aria-tools/agent-invocations/outputs/[A-Za-z0-9_.-]{1,80}$",
                    r"^aria-tools/agent-invocations/prompts/[A-Za-z0-9_.-]{1,80}$",
                ),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/aria-agent-executor-preflight\.json$",
                upload_artifact_name_pattern=rf"^aria-response-{_REQUEST_ID}$",
                upload_artifact_path_patterns=(
                    rf"^aria-tools/agent-invocations/outputs/{_REQUEST_ID}\.json$",
                    rf"^aria-tools/agent-invocations/outputs/{_REQUEST_ID}\.transcript\.jsonl$",
                ),
                retention_days=7,
                required_permissions=(("contents", "read"),),
                token_source="github_actions_artifact_token",
                network_policy=("github_artifact",),
                dlp_artifact="aria-agent-executor-preflight.json",
                clean_worktree_policy="pre_and_post",
                external_root_allowlist=("RUNNER_TEMP",),
            ),
        ),
    ),
    "aria-auto-cycle": WorkflowContract(
        workflow_id="aria-auto-cycle",
        workflow_file=".github/workflows/aria-auto-cycle.yml",
        job_contracts=(
            WorkflowJobContract(
                job_id="cycle",
                preflight_step="Persist enterprise workflow preflight",
                first_governed_mutation_step="Restore aria-tools state from previous run",
                # The producer cycle owns the whole aria-tools state tree
                # (cycles, autonomy_state, pressure, budget shards,
                # cost-attribution, governance, handoffs, locks, burn-in
                # evidence, agent-invocations) — the state carries across
                # nights via the aria-tools-state artifact round-trip —
                # plus the gitignored aria-findings/ seed surface the
                # nightly fresh-scan seeder re-derives from repo truth.
                allowed_write_path_patterns=(
                    r"^aria-tools(/.*)?$",
                    r"^aria-findings(/.*)?$",
                    # mode=autonomous-cycle only — the kernel's per-cycle
                    # ed25519 signing keys + scoped token files live under
                    # aria-debts/keys/ (gh_token_factory.mint_signing_key /
                    # mint_installation_token). Narrow on purpose: the
                    # tracked debt JSONs in aria-debts/ itself stay
                    # read-only for this workflow.
                    r"^aria-debts/keys(/.*)?$",
                ),
                preflight_artifact_path_pattern=rf"^{_RUNNER_TEMP}/aria-auto-cycle-preflight\.json$",
                upload_artifact_name_pattern=r"^aria-tools-state$",
                upload_artifact_path_patterns=(r"^aria-tools$",),
                retention_days=30,
                required_permissions=(("contents", "read"), ("actions", "read")),
                token_source="github_actions_artifact_token",
                network_policy=("github_artifact",),
                dlp_artifact="aria-auto-cycle-preflight.json",
                clean_worktree_policy="pre_and_post",
                external_root_allowlist=("RUNNER_TEMP",),
                # Measured REAL burn-in wall time ≈ 80-90 min (30 cycles ×
                # ~2.5 min); the live YAML sets 150 for burn-in mode.
                burn_in_timeout_floor_minutes=120,
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
                token_source="none",
                network_policy=("none",),
                dlp_artifact="aria-agent-eval-preflight.json",
                clean_worktree_policy="pre_and_post",
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
                upload_artifact_name_pattern=rf"^aria-daily-report-{_REPORT_DATE_EXPR}$",
                upload_artifact_path_patterns=(
                    rf"^aria-tools/reports/daily/{_REPORT_DATE_EXPR}\.md$",
                ),
                retention_days=365,
                required_permissions=(("contents", "read"),),
                token_source="github_actions_artifact_token",
                network_policy=("github_artifact",),
                dlp_artifact="aria-daily-report-generate-preflight.json",
                clean_worktree_policy="pre_and_post",
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
                required_permissions=(("contents", "write"),),
                token_source="github_app:installation",
                network_policy=("github_api",),
                dlp_artifact="aria-daily-report-preflight.json",
                clean_worktree_policy="pre_and_post",
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
                required_permissions=(("contents", "write"), ("pull-requests", "write")),
                token_source="github_app:installation",
                network_policy=("github_api",),
                dlp_artifact="finding-state-sweep-preflight.json",
                clean_worktree_policy="pre_and_post",
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
                required_permissions=(("contents", "write"), ("pull-requests", "write")),
                token_source="github_app:installation",
                network_policy=("github_api",),
                dlp_artifact="rule-health-report-preflight.json",
                clean_worktree_policy="pre_and_post",
                external_root_allowlist=("RUNNER_TEMP",),
            ),
        ),
    ),
}


# ADR-036 D1 — the 3 test-only kernel workflows carry no governed ARIA write
# authority; audited-excluded with a non-expiring sentinel (no time-bomb).
AUDITED_WORKFLOW_EXCLUSIONS: dict[str, AuditedWorkflowExclusion] = {
    "aria-kernel": AuditedWorkflowExclusion(
        workflow_id="aria-kernel",
        reason="test-only kernel validation workflow; writes only ephemeral ./.aria-ci, "
        "verifies a clean worktree post-run, and uploads no governed ARIA artifact",
        owner="aria-kernel",
        expires_at=_NEVER_EXPIRES,
    ),
    "aria-kernel-fast": AuditedWorkflowExclusion(
        workflow_id="aria-kernel-fast",
        reason="test-only fast kernel validation workflow; writes only ephemeral ./.aria-ci "
        "and uploads no governed ARIA artifact",
        owner="aria-kernel",
        expires_at=_NEVER_EXPIRES,
    ),
    "aria-kernel-full": AuditedWorkflowExclusion(
        workflow_id="aria-kernel-full",
        reason="test-only full kernel validation workflow; writes only ephemeral ./.aria-ci, "
        "verifies a clean worktree post-run, and uploads no governed ARIA artifact",
        owner="aria-kernel",
        expires_at=_NEVER_EXPIRES,
    ),
    "aria-merge-authority": AuditedWorkflowExclusion(
        workflow_id="aria-merge-authority",
        reason="required merge-gate check workflow; asserts ARIA merge authority via "
        "`npm run gates:required-status-checks` and uploads no governed ARIA artifact",
        owner="aria-kernel",
        expires_at=_NEVER_EXPIRES,
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
