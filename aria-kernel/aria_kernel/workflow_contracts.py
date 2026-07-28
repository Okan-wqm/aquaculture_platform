"""ADR-036 — per-job workflow contract verifiers (additive on main's model).

This module is the verifier surface. It re-sources the canonical contract dict
from ``workflow_contract_registry`` (the single SSoT — there is no second
``WORKFLOW_CONTRACTS`` definition) and layers the per-job verifiers on top:

* ``verify_workflow_registry`` — whole-inventory verdict (every contract == its
  live YAML, every discovered workflow covered, every audited exclusion valid).
* ``verify_workflow_contract`` — per-workflow YAML conformance, iterating each
  ``WorkflowJobContract`` through ``_verify_job_contract``.
* ``_verify_job_contract`` / ``_verify_permissions`` /
  ``_verify_upload_artifact_step`` / ``_verify_preflight_call_shape`` —
  per-job permission, SHA-pinned upload, preflight-call-shape checks (the
  per-job governance ADR-036 adds over main's flat model).
* ``_verify_audited_exclusions`` — owner/reason/expiry/discovery checks for the
  audited-exclusion set.
* ``_verify_preflight_artifact`` — main's structured DLP-proof check, preserved
  and tightened to per-job granularity (schema_version, job_id, contract_hash,
  runtime_write_paths in addition to main's workflow_id/valid/dlp/token/network/
  workflow_hash checks).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]

from .workflow_contract_registry import (
    AUDITED_WORKFLOW_EXCLUSIONS,
    WORKFLOW_CONTRACTS,
    AuditedWorkflowExclusion,
    WorkflowAbortGate,
    WorkflowContract,
    WorkflowJobContract,
    workflow_contract_hash,
    workflow_contract_registry,
    workflow_hash,
    workflow_job_contract_hash,
)


# D4 (ADR-036) — main's live YAMLs pin actions/upload-artifact at v7.0.1
# (043fb46d…), verified via `gh api`. The canonical 13b94c505 blob carried the
# stale ea165f8d… pin which would reject every live workflow; we unify on the
# real v7.0.1 SHA. The trailing "# v7.0.1" comment in the YAML `uses:` scalar is
# part of the parsed value under yaml.safe_load, so the comparison normalizes
# the inline comment before matching (see ``_uses_action_id``).
UPLOAD_ARTIFACT_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"


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


def verify_workflow_registry(
    *,
    workspace_root: str | Path,
    contract_registry: dict[str, WorkflowContract] | None = None,
    audited_exclusions: dict[str, AuditedWorkflowExclusion] | None = None,
) -> WorkflowRegistryVerdict:
    """Validate the governed workflow inventory as a single SSoT verdict.

    valid=True iff every registered contract matches its live YAML, every
    discovered ARIA workflow is either contracted or audit-excluded, and every
    audited exclusion is well-formed + unexpired.
    """

    registry = contract_registry if contract_registry is not None else WORKFLOW_CONTRACTS
    exclusions = audited_exclusions if audited_exclusions is not None else AUDITED_WORKFLOW_EXCLUSIONS
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
    registry = contract_registry if contract_registry is not None else WORKFLOW_CONTRACTS
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
        _verify_job_contract(
            workflow_id=workflow_id,
            job=job,
            job_contract=job_contract,
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
            if proof_name in {"", "none"}:
                continue
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
    top_permissions: dict[str, Any],
    reasons: list[str],
    failure_classes: list[str],
) -> None:
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
    # Timeout sizing is independent of the preflight step's presence — run it
    # before the missing-preflight early return so one failure cannot mask
    # the other.
    _verify_burn_in_timeout(
        job_id=job_contract.job_id,
        job=job,
        steps=steps,
        floor_minutes=job_contract.burn_in_timeout_floor_minutes,
        reasons=reasons,
        failure_classes=failure_classes,
    )
    # Same reasoning: step presence / ordering / abort-gate coverage are
    # independent of the preflight step, so they run before the early return.
    _verify_declared_steps(
        job_contract=job_contract,
        steps=steps,
        named_steps=named_steps,
        reasons=reasons,
        failure_classes=failure_classes,
    )
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
    # ADR-036 — the structural verifier (verify_workflow_contract) is a
    # build/test-time tool; a workflow run-block calling it would import the
    # structural surface into the runtime, which is a layering inversion.
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
    _verify_upload_artifact_step(
        job_id=job_contract.job_id,
        steps=steps,
        job_contract=job_contract,
        reasons=reasons,
        failure_classes=failure_classes,
    )


def _collapse(text: str) -> str:
    """Whitespace-insensitive form of a GHA expression.

    ``if: always() && steps.x.outputs.y != 'true'`` and a re-wrapped or
    differently spaced spelling of the same condition must compare equal, or
    the gate would reject correctly-guarded steps and get deleted for being
    noisy.
    """
    return "".join(text.split())


def _step_label(step: Any, index: int) -> str:
    if isinstance(step, dict):
        for key in ("name", "uses", "id"):
            value = step.get(key)
            if isinstance(value, str) and value:
                return value
    return f"step[{index}]"


def _verify_declared_steps(
    *,
    job_contract: WorkflowJobContract,
    steps: list[Any],
    named_steps: list[tuple[int, dict[str, Any]]],
    reasons: list[str],
    failure_classes: list[str],
) -> None:
    """Enforce declared step presence, ordering and abort-gate coverage.

    ORPHAN-CRITICAL-469 was reintroducible with the whole suite green:
    ``first_governed_mutation_step`` pins one step name and its position
    relative to the preflight, so moving the restore step to AFTER "Find next
    pending request" — which is the bug, the queue read before the queue
    exists — passed, and deleting the publish and quarantine steps passed too.

    The contract is expressed over step NAMES and their relative positions,
    never indices: an index survives no unrelated insertion, and a check that
    fails for unrelated reasons is edited until it stops failing.
    """
    job_id = job_contract.job_id
    # First occurrence wins; a duplicated step name is a workflow-authoring
    # problem the ordering contract must not silently pick a side on.
    first_index: dict[str, int] = {}
    for idx, step in named_steps:
        first_index.setdefault(str(step.get("name")), idx)

    for required in job_contract.required_steps:
        if required not in first_index:
            reasons.append(f"workflow_required_step_missing:{job_id}:{required}")
            failure_classes.append("workflow_contract_steps")

    for earlier, later in job_contract.step_order:
        absent = [name for name in (earlier, later) if name not in first_index]
        if absent:
            reasons.append(f"workflow_ordered_step_missing:{job_id}:{absent}")
            failure_classes.append("workflow_contract_ordering")
            continue
        if first_index[earlier] >= first_index[later]:
            reasons.append(
                f"workflow_step_out_of_order:{job_id}:{earlier!r}_must_precede_{later!r}"
            )
            failure_classes.append("workflow_contract_ordering")

    _verify_abort_gate(
        job_id=job_id,
        gate=job_contract.abort_gate,
        steps=steps,
        first_index=first_index,
        reasons=reasons,
        failure_classes=failure_classes,
    )


def _verify_abort_gate(
    *,
    job_id: str,
    gate: WorkflowAbortGate | None,
    steps: list[Any],
    first_index: dict[str, int],
    reasons: list[str],
    failure_classes: list[str],
) -> None:
    """Every step after the gate must carry the gate's guard.

    ``exit 0`` in the announce step ends that STEP; GitHub Actions has no
    job-level abort. An unguarded step after the gate therefore runs during a
    blocked cycle — in aria-agent-executor that meant claiming a request and
    invoking an agent while another host held the autonomous-loop lease.
    """
    if gate is None:
        return
    if gate.gate_step not in first_index:
        reasons.append(f"workflow_abort_gate_step_missing:{job_id}:{gate.gate_step}")
        failure_classes.append("workflow_contract_abort_gate")
        return
    gate_index = first_index[gate.gate_step]
    guard = _collapse(gate.guard_expression)
    announce = _collapse(gate.skip_expression)
    # Every step, not only named ones: an unnamed `uses:` step after the gate
    # does real work too, and would otherwise be an unguarded blind spot.
    for index, step in enumerate(steps):
        if index <= gate_index or not isinstance(step, dict):
            continue
        condition = _collapse(str(step.get("if") or ""))
        if guard in condition or announce in condition:
            continue
        reasons.append(
            f"workflow_abort_gate_unguarded_step:{job_id}:{_step_label(step, index)}"
        )
        failure_classes.append("workflow_contract_abort_gate")


_BURN_IN_STEP_MARKER = "autonomy burn-in observe"
# The burn-in branch of a mode-aware timeout expression, e.g.
# ``${{ github.event.inputs.mode == 'burn-in-observe' && 150 || 50 }}`` —
# the captured integer is the timeout that applies when burn-in actually runs.
_BURN_IN_TIMEOUT_EXPR = re.compile(r"burn-in-observe'\s*&&\s*(\d+)")


def _verify_burn_in_timeout(
    *,
    job_id: str,
    job: dict[str, Any],
    steps: list[Any],
    floor_minutes: int | None,
    reasons: list[str],
    failure_classes: list[str],
) -> None:
    """Enforce the workload>timeout defect class for observe burn-ins.

    A burn-in is all-or-nothing (the kernel pins 30 cycle attempts; the
    acceptance verdict of a truncated run is ``failed`` and yields ZERO
    ladder evidence), so a job timeout sized below the measured burn-in
    wall time silently destroys the entire run — run 28577469404 died this
    way under a flat 50-minute limit. Both directions are enforced: a
    burn-in step requires a declared contract floor, and a declared floor
    requires the burn-in step it was sized for.
    """
    has_burn_in_step = any(
        isinstance(step, dict) and _BURN_IN_STEP_MARKER in str(step.get("run") or "")
        for step in steps
    )
    if floor_minutes is None:
        if has_burn_in_step:
            reasons.append(f"burn_in_step_without_contract_timeout_floor:{job_id}")
            failure_classes.append("workflow_contract_burn_in_timeout")
        return
    if not has_burn_in_step:
        reasons.append(f"burn_in_timeout_floor_without_burn_in_step:{job_id}")
        failure_classes.append("workflow_contract_burn_in_timeout")
        return
    raw_timeout = job.get("timeout-minutes")
    effective: int | None = None
    if isinstance(raw_timeout, int):
        effective = raw_timeout
    elif isinstance(raw_timeout, str):
        match = _BURN_IN_TIMEOUT_EXPR.search(raw_timeout)
        if match:
            effective = int(match.group(1))
    if effective is None:
        # Absent is NOT acceptable even though the GitHub default (360 min)
        # exceeds any current floor: explicit sizing is the contract — the
        # original defect was an unexamined inherited timeout.
        reasons.append(f"burn_in_timeout_missing_or_unparseable:{job_id}")
        failure_classes.append("workflow_contract_burn_in_timeout")
    elif effective < floor_minutes:
        reasons.append(f"burn_in_timeout_below_floor:{job_id}:{effective}<{floor_minutes}")
        failure_classes.append("workflow_contract_burn_in_timeout")


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


def _uses_action_id(value: Any) -> str:
    """The ``uses:`` scalar with any inline ``# comment`` and surrounding
    whitespace stripped, so ``actions/upload-artifact@SHA # v7.0.1`` compares
    equal to the bare ``actions/upload-artifact@SHA`` const."""
    text = str(value or "")
    if "#" in text:
        text = text.split("#", 1)[0]
    return text.strip()


def _verify_upload_artifact_step(
    *,
    job_id: str,
    steps: list[Any],
    job_contract: WorkflowJobContract,
    reasons: list[str],
    failure_classes: list[str],
) -> None:
    if not job_contract.upload_artifact_path_patterns:
        return
    upload_steps = [
        step for step in steps
        if isinstance(step, dict) and _uses_action_id(step.get("uses")).startswith("actions/upload-artifact@")
    ]
    if not upload_steps:
        reasons.append(f"workflow_upload_artifact_step_missing:{job_id}")
        failure_classes.append("workflow_artifact_upload")
        return
    matching_step = None
    for step in upload_steps:
        uses = _uses_action_id(step.get("uses"))
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
            matching_step = step
    if matching_step is None:
        reasons.append(f"workflow_upload_artifact_contract_mismatch:{job_id}")
        failure_classes.append("workflow_artifact_upload")
        return
    with_block = matching_step.get("with") if isinstance(matching_step.get("with"), dict) else {}
    if str(with_block.get("if-no-files-found") or "") != "error":
        reasons.append(f"workflow_upload_artifact_if_no_files_not_error:{job_id}")
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
    exclusions = audited_exclusions if audited_exclusions is not None else AUDITED_WORKFLOW_EXCLUSIONS
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
    if payload.get("dlp_scan_clean") is not True:
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


__all__ = [
    "AUDITED_WORKFLOW_EXCLUSIONS",
    "UPLOAD_ARTIFACT_ACTION",
    "WORKFLOW_CONTRACTS",
    "AuditedWorkflowExclusion",
    "WorkflowContract",
    "WorkflowContractVerdict",
    "WorkflowJobContract",
    "WorkflowRegistryVerdict",
    "discover_aria_workflows",
    "generated_workflow_inventory",
    "verify_workflow_contract",
    "verify_workflow_registry",
    "workflow_contract_hash",
    "workflow_contract_registry",
    "workflow_hash",
    "workflow_job_contract_hash",
]
