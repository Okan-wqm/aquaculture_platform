from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]

from .workflow_contract_registry import (
    AUDITED_WORKFLOW_EXCLUSIONS,
    WORKFLOW_CONTRACTS,
    AuditedWorkflowExclusion,
    WorkflowContract,
    WorkflowJobContract,
    workflow_contract_hash,
    workflow_contract_registry,
    workflow_hash,
    workflow_job_contract_hash,
)


UPLOAD_ARTIFACT_ACTION = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"
SUPPORTED_CLEAN_WORKTREE_POLICIES = frozenset({"preflight_only_foundation"})
WORKFLOW_UPLOAD_INVENTORY_PATH = Path("aria-kernel/generated/workflow-upload-inventory.json")
_GITHUB_EXPR = re.compile(r"\$\{\{\s*([^}]+?)\s*\}\}")


@dataclass(frozen=True)
class WorkflowContractVerdict:
    workflow_id: str
    valid: bool
    workflow_file: str | None = None
    workflow_hash: str | None = None
    contract_hash: str | None = None
    failure_classes: tuple[str, ...] = field(default_factory=tuple)
    reasons: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class WorkflowRegistryVerdict:
    valid: bool
    registered_count: int
    audited_exclusion_count: int
    failed_contracts: dict[str, tuple[str, ...]] = field(default_factory=dict)
    uncovered_workflows: tuple[str, ...] = field(default_factory=tuple)
    failure_classes: tuple[str, ...] = field(default_factory=tuple)
    reasons: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class WorkflowUploadInventoryVerdict:
    valid: bool
    inventory_path: str
    failure_classes: tuple[str, ...] = field(default_factory=tuple)
    reasons: tuple[str, ...] = field(default_factory=tuple)


def discover_aria_workflows(workspace_root: str | Path) -> dict[str, Path]:
    workflows = Path(workspace_root) / ".github" / "workflows"
    found: dict[str, Path] = {}
    if not workflows.is_dir():
        return found
    for path in sorted([*workflows.glob("aria-*.yml"), *workflows.glob("aria-*.yaml")]):
        found[path.stem] = path
    for name in ("finding-state-sweep", "rule-health-report"):
        for suffix in (".yml", ".yaml"):
            path = workflows / f"{name}{suffix}"
            if path.exists():
                found[name] = path
    return found


def generate_workflow_upload_inventory(workspace_root: str | Path) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    workflows_dir = root / ".github" / "workflows"
    uploads: list[dict[str, Any]] = []
    if workflows_dir.is_dir():
        for workflow_path in sorted([*workflows_dir.glob("*.yml"), *workflows_dir.glob("*.yaml")]):
            workflow_id = workflow_path.stem
            try:
                workflow = yaml.safe_load(workflow_path.read_text(encoding="utf-8")) or {}
            except yaml.YAMLError as exc:
                uploads.append({
                    "workflow_id": workflow_id,
                    "workflow_file": workflow_path.relative_to(root).as_posix(),
                    "yaml_error": str(exc),
                })
                continue
            jobs = workflow.get("jobs") if isinstance(workflow, dict) else {}
            if not isinstance(jobs, dict):
                continue
            contract = WORKFLOW_CONTRACTS.get(workflow_id)
            contract_by_job: dict[str, list[WorkflowJobContract]] = {}
            if contract:
                for job_contract in contract.job_contracts:
                    contract_by_job.setdefault(job_contract.job_id, []).append(job_contract)
            for job_id in sorted(jobs):
                job = jobs.get(job_id)
                if not isinstance(job, dict):
                    continue
                steps = job.get("steps")
                if not isinstance(steps, list):
                    continue
                for step_index, step in enumerate(steps):
                    if not isinstance(step, dict):
                        continue
                    uses = str(step.get("uses") or "")
                    if not uses.startswith("actions/upload-artifact@"):
                        continue
                    with_block = step.get("with") if isinstance(step.get("with"), dict) else {}
                    paths = _normalize_artifact_paths(with_block.get("path"))
                    job_contracts = contract_by_job.get(str(job_id), [])
                    contract_match = False
                    contract_hash = None
                    for job_contract in job_contracts:
                        candidate_match = (
                            re.fullmatch(
                                job_contract.upload_artifact_name_pattern,
                                str(with_block.get("name") or ""),
                            ) is not None
                            and _paths_match_contract(
                                paths,
                                job_contract.upload_artifact_path_patterns,
                            )
                        )
                        if candidate_match:
                            contract_match = True
                            contract_hash = workflow_job_contract_hash(
                                workflow_id,
                                str(job_id),
                                job_contract=job_contract,
                            )
                            break
                    uploads.append({
                        "workflow_id": workflow_id,
                        "workflow_file": workflow_path.relative_to(root).as_posix(),
                        "workflow_hash": workflow_hash(workflow_path),
                        "job_id": str(job_id),
                        "step_index": step_index,
                        "step_name": str(step.get("name") or ""),
                        "if": str(step.get("if") or ""),
                        "uses": uses,
                        "uses_sha_pinned": re.fullmatch(
                            r"actions/upload-artifact@[0-9a-f]{40}",
                            uses,
                        ) is not None,
                        "artifact_name": str(with_block.get("name") or ""),
                        "artifact_paths": list(paths),
                        "if_no_files_found": str(with_block.get("if-no-files-found") or ""),
                        "retention_days": str(with_block.get("retention-days") or ""),
                        "contracted": contract_match,
                        "contract_hash": contract_hash,
                    })
    uploads.sort(
        key=lambda row: (
            str(row.get("workflow_file") or ""),
            str(row.get("job_id") or ""),
            int(row.get("step_index") or 0),
            str(row.get("artifact_name") or ""),
        )
    )
    return {
        "schema_version": "aria/workflow-upload-inventory/v1",
        "generated_by": "aria_kernel.workflow_contracts.generate_workflow_upload_inventory",
        "upload_count": len(uploads),
        "uploads": uploads,
    }


def write_workflow_upload_inventory(
    *,
    workspace_root: str | Path,
    inventory_path: str | Path | None = None,
) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    path = root / (Path(inventory_path) if inventory_path is not None else WORKFLOW_UPLOAD_INVENTORY_PATH)
    inventory = generate_workflow_upload_inventory(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(inventory, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return inventory


def verify_workflow_upload_inventory(
    *,
    workspace_root: str | Path,
    inventory_path: str | Path | None = None,
) -> WorkflowUploadInventoryVerdict:
    root = Path(workspace_root).resolve()
    path = root / (Path(inventory_path) if inventory_path is not None else WORKFLOW_UPLOAD_INVENTORY_PATH)
    reasons: list[str] = []
    failure_classes: list[str] = []
    expected = generate_workflow_upload_inventory(root)
    if not path.exists():
        return WorkflowUploadInventoryVerdict(
            valid=False,
            inventory_path=path.relative_to(root).as_posix(),
            failure_classes=("workflow_upload_inventory_missing",),
            reasons=(f"workflow_upload_inventory_missing:{path.relative_to(root).as_posix()}",),
        )
    try:
        observed = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return WorkflowUploadInventoryVerdict(
            valid=False,
            inventory_path=path.relative_to(root).as_posix(),
            failure_classes=("workflow_upload_inventory_invalid",),
            reasons=(f"workflow_upload_inventory_invalid:{exc}",),
        )
    if observed != expected:
        reasons.append("workflow_upload_inventory_drift")
        failure_classes.append("workflow_upload_inventory_drift")
        if observed.get("upload_count") != expected.get("upload_count"):
            reasons.append(
                f"workflow_upload_inventory_count_mismatch:"
                f"{observed.get('upload_count')}!={expected.get('upload_count')}"
            )
    for upload in expected.get("uploads") or []:
        if not upload.get("uses_sha_pinned"):
            reasons.append(
                "workflow_upload_inventory_unpinned:"
                f"{upload.get('workflow_file')}:{upload.get('job_id')}:{upload.get('step_index')}"
            )
            failure_classes.append("workflow_upload_inventory_security")
        if upload.get("if_no_files_found") != "error":
            reasons.append(
                "workflow_upload_inventory_if_no_files_not_error:"
                f"{upload.get('workflow_file')}:{upload.get('job_id')}:{upload.get('step_index')}"
            )
            failure_classes.append("workflow_upload_inventory_security")
    return WorkflowUploadInventoryVerdict(
        valid=not failure_classes,
        inventory_path=path.relative_to(root).as_posix(),
        failure_classes=tuple(sorted(set(failure_classes))),
        reasons=tuple(reasons),
    )


def verify_workflow_registry(
    *,
    workspace_root: str | Path,
    contract_registry: dict[str, WorkflowContract] | None = None,
    audited_exclusions: dict[str, AuditedWorkflowExclusion] | None = None,
) -> WorkflowRegistryVerdict:
    """Validate the governed workflow inventory as a single SSoT verdict."""

    registry = contract_registry or WORKFLOW_CONTRACTS
    exclusions = audited_exclusions or AUDITED_WORKFLOW_EXCLUSIONS
    root = Path(workspace_root).resolve()
    reasons: list[str] = []
    failure_classes: list[str] = []
    failed_contracts: dict[str, tuple[str, ...]] = {}

    for workflow_id in sorted(registry):
        verdict = verify_workflow_contract(
            workflow_id=workflow_id,
            workspace_root=root,
            contract_registry=registry,
        )
        if not verdict.valid:
            failed_contracts[workflow_id] = verdict.reasons
            reasons.extend(f"{workflow_id}:{reason}" for reason in verdict.reasons)
            failure_classes.extend(verdict.failure_classes)

    discovered = discover_aria_workflows(root)
    uncovered = tuple(sorted(set(discovered) - set(registry) - set(exclusions)))
    if uncovered:
        reasons.append(f"workflow_registry_uncovered:{uncovered}")
        failure_classes.append("workflow_registry_uncovered")

    _verify_audited_exclusions(
        reasons,
        failure_classes,
        workspace_root=root,
        audited_exclusions=exclusions,
    )

    return WorkflowRegistryVerdict(
        valid=not failure_classes,
        registered_count=len(registry),
        audited_exclusion_count=len(exclusions),
        failed_contracts=failed_contracts,
        uncovered_workflows=uncovered,
        failure_classes=tuple(sorted(set(failure_classes))),
        reasons=tuple(reasons),
    )


def verify_workflow_contract(
    *,
    workflow_id: str,
    workspace_root: str | Path,
    artifact_dir: str | Path | None = None,
    event_context: dict[str, Any] | None = None,
    contract_registry: dict[str, WorkflowContract] | None = None,
) -> WorkflowContractVerdict:
    registry = contract_registry or WORKFLOW_CONTRACTS
    contract = registry.get(workflow_id)
    reasons: list[str] = []
    failure_classes: list[str] = []
    if contract is None:
        return WorkflowContractVerdict(
            workflow_id=workflow_id,
            valid=False,
            failure_classes=("workflow_contract_missing",),
            reasons=(f"workflow_contract_missing:{workflow_id}",),
        )

    root = Path(workspace_root).resolve()
    workflow_path = root / contract.workflow_file
    if not workflow_path.exists():
        return WorkflowContractVerdict(
            workflow_id=workflow_id,
            workflow_file=contract.workflow_file,
            valid=False,
            failure_classes=("workflow_yaml_missing",),
            reasons=(f"workflow_yaml_missing:{contract.workflow_file}",),
        )

    text = workflow_path.read_text(encoding="utf-8")
    digest = workflow_hash(workflow_path)
    contract_digest = workflow_contract_hash(contract)
    try:
        workflow = yaml.safe_load(text) or {}
    except yaml.YAMLError as exc:
        return WorkflowContractVerdict(
            workflow_id=workflow_id,
            workflow_file=contract.workflow_file,
            workflow_hash=digest,
            contract_hash=contract_digest,
            valid=False,
            failure_classes=("workflow_yaml_invalid",),
            reasons=(f"workflow_yaml_invalid:{exc}",),
        )

    jobs = workflow.get("jobs")
    if not isinstance(jobs, dict):
        return WorkflowContractVerdict(
            workflow_id=workflow_id,
            workflow_file=contract.workflow_file,
            workflow_hash=digest,
            contract_hash=contract_digest,
            valid=False,
            failure_classes=("workflow_contract_jobs",),
            reasons=("workflow_jobs_missing",),
        )

    missing_jobs = sorted({job.job_id for job in contract.job_contracts} - set(jobs))
    if missing_jobs:
        reasons.append(f"governed_jobs_missing:{missing_jobs}")
        failure_classes.append("workflow_contract_jobs")

    top_permissions = workflow.get("permissions") if isinstance(workflow.get("permissions"), dict) else {}
    for job_contract in contract.job_contracts:
        job = jobs.get(job_contract.job_id)
        if not isinstance(job, dict):
            continue
        sibling_contracts = tuple(
            candidate
            for candidate in contract.job_contracts
            if candidate.job_id == job_contract.job_id
        )
        _verify_job_contract(
            workflow_id=workflow_id,
            job=job,
            job_contract=job_contract,
            sibling_contracts=sibling_contracts,
            top_permissions=top_permissions,
            reasons=reasons,
            failure_classes=failure_classes,
        )

    raw_input_jobs = _raw_event_input_interpolation(workflow)
    if raw_input_jobs:
        reasons.append(f"raw_github_event_inputs_interpolation_present:{raw_input_jobs}")
        failure_classes.append("workflow_input_injection")

    if artifact_dir is not None:
        for job_contract in contract.job_contracts:
            proof_name = Path(job_contract.dlp_artifact).name
            proof = Path(artifact_dir) / proof_name
            if not proof.exists():
                reasons.append(f"dlp_artifact_missing:{job_contract.job_id}:{proof_name}")
                failure_classes.append("workflow_dlp_proof_missing")
                continue
            proof_reasons, proof_failures = _verify_preflight_artifact(
                proof,
                contract=contract,
                job_contract=job_contract,
                workflow_hash=digest,
                contract_hash=workflow_job_contract_hash(workflow_id, job_contract.job_id),
            )
            reasons.extend(proof_reasons)
            failure_classes.extend(proof_failures)
            if job_contract.post_artifact_manifest:
                manifest = Path(artifact_dir) / job_contract.post_artifact_manifest
                if not manifest.exists():
                    reasons.append(
                        f"post_artifact_manifest_missing:{job_contract.job_id}:{job_contract.post_artifact_manifest}"
                    )
                    failure_classes.append("workflow_post_artifact_proof")
                else:
                    manifest_reasons, manifest_failures = _verify_post_artifact_manifest(manifest)
                    reasons.extend(manifest_reasons)
                    failure_classes.extend(manifest_failures)

    if event_context:
        observed_token = str(event_context.get("token_source") or "")
        observed_job = str(event_context.get("job_id") or "")
        if observed_job:
            expected = next((job.token_source for job in contract.job_contracts if job.job_id == observed_job), None)
            if expected and observed_token and observed_token != expected:
                reasons.append(f"workflow_token_source_mismatch:{observed_job}:{observed_token}!={expected}")
                failure_classes.append("workflow_token_source")
        elif len({job.token_source for job in contract.job_contracts}) == 1:
            expected = contract.job_contracts[0].token_source
            if observed_token and observed_token != expected:
                reasons.append(f"workflow_token_source_mismatch:{observed_token}!={expected}")
                failure_classes.append("workflow_token_source")
        elif observed_token:
            reasons.append("workflow_token_source_requires_job_id")
            failure_classes.append("workflow_token_source")

    return WorkflowContractVerdict(
        workflow_id=workflow_id,
        workflow_file=contract.workflow_file,
        workflow_hash=digest,
        contract_hash=contract_digest,
        valid=not failure_classes,
        failure_classes=tuple(sorted(set(failure_classes))),
        reasons=tuple(reasons),
    )


def _verify_job_contract(
    *,
    workflow_id: str,
    job: dict[str, Any],
    job_contract: WorkflowJobContract,
    sibling_contracts: tuple[WorkflowJobContract, ...],
    top_permissions: dict[str, Any],
    reasons: list[str],
    failure_classes: list[str],
) -> None:
    if job_contract.clean_worktree_policy not in SUPPORTED_CLEAN_WORKTREE_POLICIES:
        reasons.append(
            f"workflow_clean_worktree_policy_unsupported:"
            f"{job_contract.job_id}:{job_contract.clean_worktree_policy}"
        )
        failure_classes.append("workflow_clean_worktree_policy")

    steps = job.get("steps")
    if not isinstance(steps, list):
        reasons.append(f"workflow_steps_missing:{job_contract.job_id}")
        failure_classes.append("workflow_contract_jobs")
        return
    named_steps = [
        (idx, step)
        for idx, step in enumerate(steps)
        if isinstance(step, dict) and isinstance(step.get("name"), str)
    ]
    preflight_matches = [
        (idx, step)
        for idx, step in named_steps
        if step.get("name") == job_contract.preflight_step
    ]
    if not preflight_matches:
        reasons.append(f"workflow_contract_preflight_step_missing:{job_contract.job_id}:{job_contract.preflight_step}")
        failure_classes.append("workflow_contract_preflight_missing")
        return
    preflight_idx, preflight_step = preflight_matches[0]
    preflight_run = str(preflight_step.get("run") or "")
    if "verify_workflow_preflight" not in preflight_run:
        reasons.append(f"workflow_contract_preflight_call_missing:{job_contract.job_id}")
        failure_classes.append("workflow_contract_preflight_missing")
    if "verify_workflow_contract" in preflight_run:
        reasons.append(f"workflow_runtime_imports_structural_verifier:{job_contract.job_id}")
        failure_classes.append("workflow_runtime_dependency")
    _verify_preflight_call_shape(
        workflow_id=workflow_id,
        job_contract=job_contract,
        preflight_run=preflight_run,
        reasons=reasons,
        failure_classes=failure_classes,
    )

    mutating_matches = [
        (idx, step)
        for idx, step in named_steps
        if step.get("name") == job_contract.first_governed_mutation_step
    ]
    if not mutating_matches:
        reasons.append(
            f"first_governed_mutation_step_missing:{job_contract.job_id}:{job_contract.first_governed_mutation_step}"
        )
        failure_classes.append("workflow_contract_ordering")
    elif preflight_idx >= mutating_matches[0][0]:
        reasons.append(f"workflow_preflight_after_first_governed_mutation:{job_contract.job_id}")
        failure_classes.append("workflow_contract_ordering")

    _verify_permissions(
        job_id=job_contract.job_id,
        actual=job.get("permissions") if isinstance(job.get("permissions"), dict) else top_permissions,
        required=dict(job_contract.required_permissions),
        reasons=reasons,
        failure_classes=failure_classes,
    )
    if job_contract.post_artifact_step:
        post_matches = [
            (idx, step)
            for idx, step in named_steps
            if step.get("name") == job_contract.post_artifact_step
        ]
        if not post_matches:
            reasons.append(
                f"workflow_post_artifact_step_missing:{job_contract.job_id}:{job_contract.post_artifact_step}"
            )
            failure_classes.append("workflow_post_artifact_proof")
        else:
            upload_indices = [
                idx for idx, step in enumerate(steps)
                if isinstance(step, dict) and str(step.get("uses") or "").startswith("actions/upload-artifact@")
            ]
            if upload_indices and post_matches[0][0] >= upload_indices[0]:
                reasons.append(f"workflow_post_artifact_step_after_upload:{job_contract.job_id}")
                failure_classes.append("workflow_post_artifact_proof")
    _verify_upload_artifact_step(
        job_id=job_contract.job_id,
        steps=steps,
        job_contract=job_contract,
        sibling_contracts=sibling_contracts,
        reasons=reasons,
        failure_classes=failure_classes,
    )


def _contains_kwarg_literal(run_block: str, key: str, value: str) -> bool:
    return f'{key}="{value}"' in run_block or f"{key}='{value}'" in run_block


def _verify_preflight_call_shape(
    *,
    workflow_id: str,
    job_contract: WorkflowJobContract,
    preflight_run: str,
    reasons: list[str],
    failure_classes: list[str],
) -> None:
    required_kwargs = (
        "workflow_id",
        "job_id",
        "audit_artifact_path",
        "token_provenance",
        "network_policy",
        "network_enforcement_evidence",
    )
    if not _contains_kwarg_literal(preflight_run, "workflow_id", workflow_id):
        reasons.append(f"workflow_preflight_workflow_id_missing:{job_contract.job_id}")
        failure_classes.append("workflow_preflight_call_shape")
    if not _contains_kwarg_literal(preflight_run, "job_id", job_contract.job_id):
        reasons.append(f"workflow_preflight_job_id_missing:{job_contract.job_id}")
        failure_classes.append("workflow_preflight_call_shape")
    for kwarg in required_kwargs:
        if f"{kwarg}=" not in preflight_run:
            reasons.append(f"workflow_preflight_kwarg_missing:{job_contract.job_id}:{kwarg}")
            failure_classes.append("workflow_preflight_call_shape")
    if "RUNNER_TEMP" in job_contract.external_root_allowlist:
        if "external_root_allowlist=" not in preflight_run:
            reasons.append(f"workflow_preflight_external_root_allowlist_missing:{job_contract.job_id}")
            failure_classes.append("workflow_preflight_call_shape")
        if "RUNNER_TEMP" not in preflight_run or ".resolve()" not in preflight_run:
            reasons.append(f"workflow_preflight_runner_temp_not_resolved:{job_contract.job_id}")
            failure_classes.append("workflow_preflight_call_shape")


def _verify_permissions(
    *,
    job_id: str,
    actual: dict[str, Any],
    required: dict[str, str],
    reasons: list[str],
    failure_classes: list[str],
) -> None:
    if not isinstance(actual, dict):
        reasons.append(f"workflow_permissions_missing:{job_id}")
        failure_classes.append("workflow_permissions")
        return
    for key, value in required.items():
        if actual.get(key) != value:
            reasons.append(f"workflow_permission_mismatch:{job_id}:{key}:{actual.get(key)!r}!={value!r}")
            failure_classes.append("workflow_permissions")
    for key, value in actual.items():
        if value == "write" and required.get(key) != "write":
            reasons.append(f"workflow_uncontracted_write_permission:{job_id}:{key}")
            failure_classes.append("workflow_permissions")


def _verify_upload_artifact_step(
    *,
    job_id: str,
    steps: list[Any],
    job_contract: WorkflowJobContract,
    sibling_contracts: tuple[WorkflowJobContract, ...],
    reasons: list[str],
    failure_classes: list[str],
) -> None:
    upload_steps = [
        step for step in steps
        if isinstance(step, dict) and str(step.get("uses") or "").startswith("actions/upload-artifact@")
    ]
    if not upload_steps:
        reasons.append(f"workflow_upload_artifact_step_missing:{job_id}")
        failure_classes.append("workflow_artifact_upload")
        return
    matching_steps: list[dict[str, Any]] = []
    for step in upload_steps:
        uses = str(step.get("uses") or "")
        if uses != UPLOAD_ARTIFACT_ACTION:
            reasons.append(f"workflow_upload_artifact_not_sha_pinned:{job_id}:{uses}")
            failure_classes.append("workflow_artifact_upload")
        with_block = step.get("with") if isinstance(step.get("with"), dict) else {}
        name = str(with_block.get("name") or "")
        paths = _normalize_artifact_paths(with_block.get("path"))
        if re.fullmatch(job_contract.upload_artifact_name_pattern, name) and _paths_match_contract(
            paths,
            job_contract.upload_artifact_path_patterns,
        ):
            matching_steps.append(step)
    if not matching_steps:
        reasons.append(f"workflow_upload_artifact_contract_mismatch:{job_id}")
        failure_classes.append("workflow_artifact_upload")
        return
    if len(matching_steps) > 1:
        reasons.append(f"workflow_upload_artifact_contract_duplicate:{job_id}:{len(matching_steps)}")
        failure_classes.append("workflow_artifact_upload")
    covered_steps: list[dict[str, Any]] = []
    for step in upload_steps:
        with_block = step.get("with") if isinstance(step.get("with"), dict) else {}
        name = str(with_block.get("name") or "")
        paths = _normalize_artifact_paths(with_block.get("path"))
        if any(
            re.fullmatch(candidate.upload_artifact_name_pattern, name)
            and _paths_match_contract(paths, candidate.upload_artifact_path_patterns)
            for candidate in sibling_contracts
        ):
            covered_steps.append(step)
    if len(upload_steps) != len(covered_steps):
        reasons.append(
            f"workflow_upload_artifact_uncontracted_extra:{job_id}:"
            f"{len(upload_steps) - len(covered_steps)}"
        )
        failure_classes.append("workflow_artifact_upload")
    matching_step = matching_steps[0]
    with_block = matching_step.get("with") if isinstance(matching_step.get("with"), dict) else {}
    if str(with_block.get("if-no-files-found") or "") != "error":
        reasons.append(f"workflow_upload_artifact_if_no_files_not_error:{job_id}")
        failure_classes.append("workflow_artifact_upload")
    if job_contract.upload_requires_always and "always()" not in str(matching_step.get("if") or ""):
        reasons.append(f"workflow_upload_artifact_missing_always:{job_id}")
        failure_classes.append("workflow_artifact_upload")
    retention = with_block.get("retention-days")
    try:
        retention_days = int(str(retention))
    except (TypeError, ValueError):
        retention_days = 0
    if retention_days < job_contract.retention_days:
        reasons.append(f"artifact_retention_below_contract:{job_id}:{job_contract.retention_days}")
        failure_classes.append("workflow_artifact_retention")


def _normalize_artifact_paths(value: Any) -> tuple[str, ...]:
    if isinstance(value, list):
        raw_paths = [str(item) for item in value]
    else:
        raw_paths = str(value or "").splitlines()
    return tuple(
        _normalize_workflow_path(path.strip())
        for path in raw_paths
        if path.strip()
    )


def _paths_match_contract(paths: tuple[str, ...], patterns: tuple[str, ...]) -> bool:
    if len(paths) != len(patterns):
        return False
    unmatched = list(paths)
    for pattern in patterns:
        for idx, path in enumerate(unmatched):
            if re.fullmatch(pattern, path):
                unmatched.pop(idx)
                break
        else:
            return False
    return not unmatched


def _normalize_workflow_path(path: str) -> str:
    text = path.strip().strip('"').strip("'")
    text = re.sub(r"\$\{\{\s*runner\.temp\s*\}\}", "runner-temp", text)
    return text.rstrip("/") if text != "runner-temp" else text


def _raw_event_input_interpolation(workflow: dict[str, Any]) -> tuple[str, ...]:
    offenders: list[str] = []
    jobs = workflow.get("jobs") if isinstance(workflow.get("jobs"), dict) else {}
    for job_id, job in jobs.items():
        if not isinstance(job, dict):
            continue
        steps = job.get("steps")
        if not isinstance(steps, list):
            continue
        for step in steps:
            if isinstance(step, dict) and "${{ github.event.inputs." in str(step.get("run") or ""):
                offenders.append(str(job_id))
    return tuple(sorted(set(offenders)))


def _verify_audited_exclusions(
    reasons: list[str],
    failure_classes: list[str],
    *,
    workspace_root: Path,
    audited_exclusions: dict[str, AuditedWorkflowExclusion] | None = None,
) -> None:
    discovered = discover_aria_workflows(workspace_root)
    exclusions = audited_exclusions or AUDITED_WORKFLOW_EXCLUSIONS
    for workflow_id, exclusion in exclusions.items():
        if workflow_id not in discovered:
            reasons.append(f"audited_exclusion_workflow_missing:{workflow_id}")
            failure_classes.append("workflow_audited_exclusion")
        if not isinstance(exclusion, AuditedWorkflowExclusion):
            reasons.append(f"audited_exclusion_not_typed:{workflow_id}")
            failure_classes.append("workflow_audited_exclusion")
            continue
        try:
            expires_at = date.fromisoformat(exclusion.expires_at)
        except ValueError:
            reasons.append(f"audited_exclusion_expiry_invalid:{workflow_id}")
            failure_classes.append("workflow_audited_exclusion")
            continue
        if expires_at <= date.today():
            reasons.append(f"audited_exclusion_expired:{workflow_id}:{exclusion.expires_at}")
            failure_classes.append("workflow_audited_exclusion")
        if not exclusion.owner.strip() or not exclusion.reason.strip():
            reasons.append(f"audited_exclusion_incomplete:{workflow_id}")
            failure_classes.append("workflow_audited_exclusion")


def _verify_preflight_artifact(
    path: Path,
    *,
    contract: WorkflowContract,
    job_contract: WorkflowJobContract,
    workflow_hash: str,
    contract_hash: str | None,
) -> tuple[list[str], list[str]]:
    reasons: list[str] = []
    failures: list[str] = []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return ([f"dlp_artifact_unparseable:{path.name}"], ["workflow_dlp_proof_missing"])
    if payload.get("schema_version") != 1:
        reasons.append("workflow_preflight_artifact_schema_version_mismatch")
        failures.append("workflow_dlp_proof_missing")
    if payload.get("workflow_id") != contract.workflow_id:
        reasons.append("workflow_preflight_artifact_workflow_id_mismatch")
        failures.append("workflow_dlp_proof_missing")
    if payload.get("job_id") != job_contract.job_id:
        reasons.append("workflow_preflight_artifact_job_id_mismatch")
        failures.append("workflow_dlp_proof_missing")
    if payload.get("valid") is not True:
        reasons.append("workflow_preflight_artifact_not_valid")
        failures.append("workflow_dlp_proof_missing")
    if payload.get("dlp_scan_clean") is not True and payload.get("dlp_scan_phase") != "preflight":
        reasons.append("workflow_preflight_artifact_dlp_not_clean")
        failures.append("workflow_dlp_proof_missing")
    observed_token = str(payload.get("token_provenance") or "")
    if observed_token != job_contract.token_source:
        reasons.append(f"workflow_preflight_artifact_token_mismatch:{observed_token}!={job_contract.token_source}")
        failures.append("workflow_token_source")
    observed_network = tuple(payload.get("network_policy") or ())
    if tuple(sorted(observed_network)) != tuple(sorted(job_contract.network_policy)):
        reasons.append("workflow_preflight_artifact_network_policy_mismatch")
        failures.append("workflow_network_policy")
    if not payload.get("workflow_hash"):
        reasons.append("workflow_preflight_artifact_workflow_hash_missing")
        failures.append("workflow_dlp_proof_missing")
    elif payload.get("workflow_hash") != workflow_hash:
        reasons.append("workflow_preflight_artifact_workflow_hash_mismatch")
        failures.append("workflow_dlp_proof_missing")
    if payload.get("contract_hash") != contract_hash:
        reasons.append("workflow_preflight_artifact_contract_hash_mismatch")
        failures.append("workflow_dlp_proof_missing")
    runtime_paths = tuple(str(item) for item in payload.get("runtime_write_paths") or ())
    if not runtime_paths or not all(
        any(re.fullmatch(pattern, item) for pattern in job_contract.allowed_write_path_patterns)
        for item in runtime_paths
    ):
        reasons.append("workflow_preflight_artifact_runtime_paths_mismatch")
        failures.append("path_allowlist_violation")
    return reasons, failures


def _verify_post_artifact_manifest(path: Path) -> tuple[list[str], list[str]]:
    reasons: list[str] = []
    failures: list[str] = []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return ([f"post_artifact_manifest_unparseable:{path.name}"], ["workflow_post_artifact_proof"])
    if payload.get("schema_version") != "aria/ci-executor-artifacts/v1":
        reasons.append("post_artifact_manifest_schema_mismatch")
        failures.append("workflow_post_artifact_proof")
    if payload.get("dlp_scan_clean") is not True:
        reasons.append("post_artifact_manifest_dlp_not_clean")
        failures.append("workflow_post_artifact_proof")
    for key in ("request_id", "claim_id", "output_path", "transcript_path"):
        if not str(payload.get(key) or "").strip():
            reasons.append(f"post_artifact_manifest_field_missing:{key}")
            failures.append("workflow_post_artifact_proof")
    for key in ("output_hash", "transcript_hash"):
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(payload.get(key) or "")):
            reasons.append(f"post_artifact_manifest_hash_invalid:{key}")
            failures.append("workflow_post_artifact_proof")
    if payload.get("output_path") == payload.get("transcript_path"):
        reasons.append("post_artifact_manifest_output_transcript_same_path")
        failures.append("workflow_post_artifact_proof")
    return reasons, failures


def generated_workflow_inventory(workspace_root: str | Path) -> str:
    discovered = discover_aria_workflows(workspace_root)
    rows = []
    for workflow_id, path in sorted(discovered.items()):
        rows.append({
            "workflow_id": workflow_id,
            "path": path.relative_to(Path(workspace_root)).as_posix(),
            "contracted": workflow_id in WORKFLOW_CONTRACTS,
            "audited_exclusion": workflow_id in AUDITED_WORKFLOW_EXCLUSIONS,
        })
    return json.dumps(rows, indent=2, sort_keys=True) + "\n"


def _main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Manage ARIA workflow upload inventory")
    parser.add_argument("--workspace-root", default=".")
    parser.add_argument("--inventory-path", default=str(WORKFLOW_UPLOAD_INVENTORY_PATH))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    if args.write:
        inventory = write_workflow_upload_inventory(
            workspace_root=args.workspace_root,
            inventory_path=args.inventory_path,
        )
        print(json.dumps({
            "inventory_path": args.inventory_path,
            "status": "written",
            "upload_count": inventory["upload_count"],
        }, sort_keys=True))
        return 0
    verdict = verify_workflow_upload_inventory(
        workspace_root=args.workspace_root,
        inventory_path=args.inventory_path,
    )
    print(json.dumps({
        "failure_classes": verdict.failure_classes,
        "inventory_path": verdict.inventory_path,
        "reasons": verdict.reasons,
        "valid": verdict.valid,
    }, sort_keys=True))
    return 0 if verdict.valid else 1


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))


__all__ = [
    "AUDITED_WORKFLOW_EXCLUSIONS",
    "UPLOAD_ARTIFACT_ACTION",
    "WORKFLOW_CONTRACTS",
    "WORKFLOW_UPLOAD_INVENTORY_PATH",
    "AuditedWorkflowExclusion",
    "WorkflowContract",
    "WorkflowContractVerdict",
    "WorkflowJobContract",
    "WorkflowUploadInventoryVerdict",
    "WorkflowRegistryVerdict",
    "discover_aria_workflows",
    "generate_workflow_upload_inventory",
    "generated_workflow_inventory",
    "verify_workflow_upload_inventory",
    "verify_workflow_contract",
    "verify_workflow_registry",
    "write_workflow_upload_inventory",
    "workflow_contract_hash",
    "workflow_contract_registry",
    "workflow_hash",
    "workflow_job_contract_hash",
]
