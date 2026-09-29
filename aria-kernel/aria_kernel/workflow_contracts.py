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

from .secure_artifact_io import load_json_object_bytes
from .tool_registry import GovernanceError
from .workflow_contract_registry import (
    AUDITED_WORKFLOW_EXCLUSIONS,
    UPLOAD_ARTIFACT_ACTION,
    WORKFLOW_CONTRACTS,
    AuditedWorkflowExclusion,
    WorkflowActionRequirement,
    WorkflowAbortGate,
    WorkflowContract,
    WorkflowJobContract,
    WorkflowPermissionRequirement,
    WorkflowStepRequirement,
    WorkflowUploadRequirement,
    workflow_contract_hash,
    workflow_contract_registry,
    workflow_hash,
    workflow_job_contract_hash,
)


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

    _verify_job_timeout_minutes(
        job_id=job_contract.job_id,
        job=job,
        declared_minutes=job_contract.job_timeout_minutes,
        reasons=reasons,
        failure_classes=failure_classes,
    )
    _verify_permissions(
        job_id=job_contract.job_id,
        actual=job.get("permissions") if isinstance(job.get("permissions"), dict) else top_permissions,
        requirement=job_contract.permissions,
        reasons=reasons,
        failure_classes=failure_classes,
    )
    _verify_required_actions(
        job_id=job_contract.job_id,
        steps=steps,
        requirements=job_contract.actions,
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


def _strip_expression_wrapper(text: str) -> str:
    """Drop a single enclosing ``${{ ... }}`` so the body can be parsed.

    GitHub accepts ``if: ${{ a && b }}`` and bare ``if: a && b`` as the same
    condition, so the wrapper must not change how the guard is matched.
    """
    if text.startswith("${{") and text.endswith("}}"):
        return text[3:-2]
    return text


def _normalize_condition(text: str) -> str:
    """Normalize equivalent GitHub ``if`` spellings for exact contracts."""
    return _collapse(_strip_expression_wrapper(text.strip()).strip())


def _executable_run_block(run_block: str) -> str:
    """Return executable lines only; comments cannot satisfy marker gates."""
    return "\n".join(
        line for line in run_block.splitlines() if not line.lstrip().startswith("#")
    )


def _top_level_disjuncts(condition: str) -> list[str]:
    """Split a collapsed GHA condition on its TOP-LEVEL ``||`` only.

    Depth-aware on purpose: ``(a||b)&&guard`` is ONE branch that is gated by
    ``guard``, while ``guard||always()`` is two branches of which only the
    first is gated. Splitting naively would confuse the two and either accept
    an inert guard or reject a correct one.
    """
    body = _strip_expression_wrapper(condition)
    parts: list[str] = []
    depth = 0
    start = 0
    index = 0
    while index < len(body):
        char = body[index]
        if char == "(":
            depth += 1
        elif char == ")":
            depth = max(0, depth - 1)
        elif char == "|" and depth == 0 and body[index : index + 2] == "||":
            parts.append(body[start:index])
            index += 2
            start = index
            continue
        index += 1
    parts.append(body[start:])
    return [part for part in parts if part]


def _step_is_gated(condition: str, *, guard: str, announce: str | None) -> bool:
    """True only when EVERY top-level branch of ``condition`` carries a guard.

    ORPHAN-MEDIUM-491 — this used to be ``guard in condition``, raw substring
    containment. ``${{ <guard> || always() }}`` contains the guard verbatim and
    is unconditionally true, so an unguarded step passed as guarded and ran
    during a blocked cycle. Requiring every disjunct to carry the guard rejects
    that shape while still accepting ``(guard && x) || (guard && y)``, which
    matters because an over-strict gate gets deleted for being noisy (see
    ``_collapse``).
    """
    if not condition:
        return False
    disjuncts = _top_level_disjuncts(condition)
    if not disjuncts:
        return False
    return all(
        guard in part or (announce is not None and announce in part)
        for part in disjuncts
    )


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

    for requirement in job_contract.steps:
        matches = [
            step
            for _, step in named_steps
            if step.get("name") == requirement.name
        ]
        if len(matches) != requirement.occurrences:
            reasons.append(
                f"workflow_step_occurrences_mismatch:{job_id}:{requirement.name}:"
                f"{len(matches)}!={requirement.occurrences}"
            )
            failure_classes.append("workflow_step_requirement")
            continue
        for step in matches:
            if (
                requirement.step_id is not None
                and str(step.get("id") or "") != requirement.step_id
            ):
                reasons.append(
                    f"workflow_step_id_mismatch:{job_id}:{requirement.name}"
                )
                failure_classes.append("workflow_step_requirement")
            if requirement.condition is not None and _normalize_condition(
                str(step.get("if") or "")
            ) != _normalize_condition(requirement.condition):
                reasons.append(
                    f"workflow_step_condition_mismatch:{job_id}:{requirement.name}"
                )
                failure_classes.append("workflow_step_requirement")
            run_block = _executable_run_block(str(step.get("run") or ""))
            for marker in requirement.required_run_markers:
                if marker not in run_block:
                    reasons.append(
                        f"workflow_step_run_marker_missing:{job_id}:{requirement.name}:{marker}"
                    )
                    failure_classes.append("workflow_step_requirement")
            for marker in requirement.forbidden_run_markers:
                if marker in run_block:
                    reasons.append(
                        f"workflow_step_run_marker_forbidden:{job_id}:{requirement.name}:{marker}"
                    )
                    failure_classes.append("workflow_step_requirement")

    if job_contract.exact_step_set:
        declared_names = {
            requirement.name for requirement in job_contract.steps
        } | {
            requirement.step_name for requirement in job_contract.actions
        }
        if job_contract.upload is not None:
            declared_names.add(job_contract.upload.step_name)
        actual_names = [
            str(step.get("name"))
            for step in steps
            if isinstance(step, dict) and isinstance(step.get("name"), str)
        ]
        if len(actual_names) != len(steps) or set(actual_names) != declared_names:
            reasons.append(f"workflow_exact_step_set_mismatch:{job_id}")
            failure_classes.append("workflow_exact_step_set")

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

    for earlier, later in job_contract.step_adjacency:
        absent = [name for name in (earlier, later) if name not in first_index]
        if absent:
            reasons.append(f"workflow_adjacent_step_missing:{job_id}:{absent}")
            failure_classes.append("workflow_step_adjacency")
            continue
        if first_index[later] != first_index[earlier] + 1:
            reasons.append(
                f"workflow_steps_not_adjacent:{job_id}:{earlier!r}:{later!r}"
            )
            failure_classes.append("workflow_step_adjacency")

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
        # The announce spelling is the INVERSE guard: it runs only while
        # blocked. Accepting it on any step meant a one-character edit
        # (`!=` to `==`) turned a real worker step into one that runs ONLY
        # when another host holds the lease — claiming requests and
        # dispatching agents against a tree being mutated elsewhere, i.e.
        # ORPHAN-CRITICAL-469 restored, with the contract gate still green.
        # It is now allowed on the declared announce step alone.
        is_announce_step = _step_label(step, index) == gate.announce_step
        if _step_is_gated(
            condition,
            guard=guard,
            announce=announce if is_announce_step else None,
        ):
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


# The ordinary branch of the same mode-aware expression — the ``|| 50`` tail,
# i.e. the timeout that applies when burn-in is NOT running.
_ORDINARY_TIMEOUT_EXPR = re.compile(r"\|\|\s*(\d+)\s*\}\}")


def _verify_job_timeout_minutes(
    *,
    job_id: str,
    job: dict[str, Any],
    declared_minutes: int | None,
    reasons: list[str],
    failure_classes: list[str],
) -> None:
    """The pinned ``job_timeout_minutes`` must equal the YAML's own timeout.

    ORPHAN-HIGH-472. The kernel derives its self-imposed wall-clock ceiling
    from the contract (``cycle_wall_clock_cap_seconds``), so if the contract
    and the YAML disagree, ARIA budgets against a limit the runner does not
    enforce — it would either stop early for no reason or, worse, keep going
    past the point where GitHub kills it, which is the failure the ceiling
    exists to prevent. Binding them here is what stops the second constant
    drifting away from the first.
    """
    if declared_minutes is None:
        return
    raw_timeout = job.get("timeout-minutes")
    effective: int | None = None
    if isinstance(raw_timeout, int):
        effective = raw_timeout
    elif isinstance(raw_timeout, str):
        match = _ORDINARY_TIMEOUT_EXPR.search(raw_timeout)
        if match:
            effective = int(match.group(1))
    if effective is None:
        reasons.append(f"job_timeout_minutes_unreadable:{job_id}")
        failure_classes.append("workflow_contract_job_timeout")
        return
    if effective != declared_minutes:
        reasons.append(
            f"job_timeout_minutes_mismatch:{job_id}:"
            f"yaml={effective}:contract={declared_minutes}"
        )
        failure_classes.append("workflow_contract_job_timeout")


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
    requirement: WorkflowPermissionRequirement,
    reasons: list[str],
    failure_classes: list[str],
) -> None:
    if not isinstance(actual, dict):
        reasons.append(f"workflow_permissions_missing:{job_id}")
        failure_classes.append("workflow_permissions")
        return
    required = dict(requirement.values)
    for key, value in required.items():
        if actual.get(key) != value:
            reasons.append(f"workflow_permission_mismatch:{job_id}:{key}:{actual.get(key)!r}!={value!r}")
            failure_classes.append("workflow_permissions")
    if requirement.exact:
        for key in sorted(set(actual) - set(required)):
            reasons.append(f"workflow_undeclared_permission:{job_id}:{key}")
            failure_classes.append("workflow_permissions")
    else:
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


def _verify_required_actions(
    *,
    job_id: str,
    steps: list[Any],
    requirements: tuple[WorkflowActionRequirement, ...],
    reasons: list[str],
    failure_classes: list[str],
) -> None:
    for requirement in requirements:
        matches = [
            step
            for step in steps
            if isinstance(step, dict) and step.get("name") == requirement.step_name
        ]
        if len(matches) != requirement.occurrences:
            reasons.append(
                f"workflow_action_occurrences_mismatch:{job_id}:{requirement.step_name}:"
                f"{len(matches)}!={requirement.occurrences}"
            )
            failure_classes.append("workflow_required_action")
            continue
        for step in matches:
            uses = _uses_action_id(step.get("uses"))
            if uses != requirement.uses:
                reasons.append(
                    f"workflow_action_uses_mismatch:{job_id}:{requirement.step_name}:"
                    f"{uses}!={requirement.uses}"
                )
                failure_classes.append("workflow_required_action")
            with_block = step.get("with") if isinstance(step.get("with"), dict) else {}
            for key, value in requirement.required_inputs:
                if str(with_block.get(key) or "") != value:
                    reasons.append(
                        f"workflow_action_input_mismatch:{job_id}:{requirement.step_name}:"
                        f"{key}"
                    )
                    failure_classes.append("workflow_required_action")
            for key in requirement.forbidden_inputs:
                if key in with_block:
                    reasons.append(
                        f"workflow_action_forbidden_input:{job_id}:{requirement.step_name}:{key}"
                    )
                    failure_classes.append("workflow_required_action")


def _verify_upload_artifact_step(
    *,
    job_id: str,
    steps: list[Any],
    job_contract: WorkflowJobContract,
    reasons: list[str],
    failure_classes: list[str],
) -> None:
    requirement = job_contract.upload
    if requirement is None:
        return
    upload_steps = [
        step for step in steps
        if isinstance(step, dict) and _uses_action_id(step.get("uses")).startswith("actions/upload-artifact@")
    ]
    declared_upload_names = {requirement.step_name} | {
        action.step_name
        for action in job_contract.actions
        if action.uses.startswith("actions/upload-artifact@")
    }
    for step in upload_steps:
        uses = _uses_action_id(step.get("uses"))
        if uses != UPLOAD_ARTIFACT_ACTION:
            reasons.append(f"workflow_upload_artifact_not_sha_pinned:{job_id}:{uses}")
            failure_classes.append("workflow_artifact_upload")
        if step.get("name") not in declared_upload_names:
            reasons.append(f"workflow_upload_artifact_extra:{job_id}:{step.get('name')}")
            failure_classes.append("workflow_artifact_upload")
    matching_steps = [
        step for step in upload_steps if step.get("name") == requirement.step_name
    ]
    if len(matching_steps) != requirement.occurrences:
        reasons.append(
            f"workflow_upload_artifact_occurrences_mismatch:{job_id}:"
            f"{len(matching_steps)}!={requirement.occurrences}"
        )
        failure_classes.append("workflow_artifact_upload")
        return
    matching_step = matching_steps[0]
    if _uses_action_id(matching_step.get("uses")) != requirement.uses:
        reasons.append(f"workflow_upload_artifact_uses_mismatch:{job_id}")
        failure_classes.append("workflow_artifact_upload")
    if _normalize_condition(str(matching_step.get("if") or "")) != _normalize_condition(
        requirement.condition
    ):
        reasons.append(f"workflow_upload_artifact_condition_mismatch:{job_id}")
        failure_classes.append("workflow_artifact_upload")
    with_block = matching_step.get("with") if isinstance(matching_step.get("with"), dict) else {}
    name = str(with_block.get("name") or "")
    if re.fullmatch(requirement.artifact_name_pattern, name) is None:
        reasons.append(f"workflow_upload_artifact_name_mismatch:{job_id}")
        failure_classes.append("workflow_artifact_upload")
    paths = _normalize_artifact_paths(with_block.get("path"))
    if not _paths_match_contract(paths, requirement.path_patterns):
        reasons.append(f"workflow_upload_artifact_path_mismatch:{job_id}")
        failure_classes.append("workflow_artifact_upload")
    if str(with_block.get("if-no-files-found") or "") != requirement.if_no_files_found:
        reasons.append(f"workflow_upload_artifact_if_no_files_not_error:{job_id}")
        failure_classes.append("workflow_artifact_upload")
    retention = with_block.get("retention-days")
    try:
        retention_days = int(str(retention))
    except (TypeError, ValueError):
        retention_days = 0
    if retention_days != requirement.retention_days:
        reasons.append(
            f"artifact_retention_mismatch:{job_id}:"
            f"{retention_days}!={requirement.retention_days}"
        )
        failure_classes.append("workflow_artifact_upload")


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
    try:
        data = path.read_bytes()
    except OSError:
        return ([f"dlp_artifact_unreadable:{path.name}"], ["workflow_dlp_proof_missing"])
    return verify_workflow_preflight_artifact_bytes(
        data,
        contract=contract,
        job_contract=job_contract,
        workflow_hash=workflow_hash,
        contract_hash=contract_hash,
    )


_WORKFLOW_PREFLIGHT_ARTIFACT_KEYS = {
    "schema_version", "workflow_id", "job_id", "profile",
    "kill_switch_active", "network_policy", "allowed_write_roots",
    "path_allowlist", "external_root_allowlist", "token_provenance",
    "dlp_mode", "audit_reason", "valid", "workflow_hash", "contract_hash",
    "runtime_write_paths", "network_enforcement_evidence",
    "audit_artifact_path", "worktree_clean", "dlp_scan_clean",
    "failure_classes", "reasons",
}


def _normalized_external_artifact_path(
    value: object,
    external_roots: object,
) -> str | None:
    if not isinstance(value, str) or not isinstance(external_roots, list):
        return None
    raw = value.strip()
    if raw.startswith("runner-temp/"):
        return raw
    if len(external_roots) != 1 or not isinstance(external_roots[0], str):
        return None
    root = Path(external_roots[0])
    target = Path(raw)
    if not root.is_absolute() or not target.is_absolute():
        return None
    try:
        relative = target.relative_to(root).as_posix()
    except ValueError:
        return None
    if not relative or any(part in {"", ".", ".."} for part in relative.split("/")):
        return None
    return f"runner-temp/{relative}"


def verify_workflow_preflight_artifact_bytes(
    data: bytes,
    *,
    contract: WorkflowContract,
    job_contract: WorkflowJobContract,
    workflow_hash: str,
    contract_hash: str | None,
) -> tuple[list[str], list[str]]:
    """Validate persisted preflight bytes for both registry and proof lanes."""
    reasons: list[str] = []
    failures: list[str] = []
    try:
        payload = load_json_object_bytes(data)
    except GovernanceError:
        return (["workflow_preflight_artifact_unparseable"], ["workflow_dlp_proof_missing"])
    def reject(reason: str, failure: str = "workflow_dlp_proof_missing") -> None:
        reasons.append(reason)
        failures.append(failure)

    if set(payload) != _WORKFLOW_PREFLIGHT_ARTIFACT_KEYS:
        reject("workflow_preflight_artifact_schema_invalid")
    if (
        not isinstance(payload.get("schema_version"), int)
        or isinstance(payload.get("schema_version"), bool)
        or payload.get("schema_version") != 1
    ):
        reject("workflow_preflight_artifact_schema_version_mismatch")
    if payload.get("workflow_id") != contract.workflow_id:
        reject("workflow_preflight_artifact_workflow_id_mismatch")
    if payload.get("job_id") != job_contract.job_id:
        reject("workflow_preflight_artifact_job_id_mismatch")
    if job_contract.preflight_profile and payload.get("profile") != job_contract.preflight_profile:
        reject("workflow_preflight_artifact_profile_mismatch")
    if payload.get("kill_switch_active") is not False:
        reject("workflow_preflight_artifact_kill_switch_active")
    if payload.get("valid") is not True:
        reject("workflow_preflight_artifact_not_valid")
    if payload.get("failure_classes") != [] or payload.get("reasons") != []:
        reject("workflow_preflight_artifact_failures_present")
    if payload.get("dlp_mode") != "fail_closed" or payload.get("dlp_scan_clean") is not True:
        reject("workflow_preflight_artifact_dlp_not_clean")
    if payload.get("worktree_clean") is not True:
        reject("workflow_preflight_artifact_worktree_not_clean")
    observed_token = str(payload.get("token_provenance") or "")
    if observed_token != job_contract.token_source:
        reject(
            f"workflow_preflight_artifact_token_mismatch:{observed_token}!={job_contract.token_source}",
            "workflow_token_source",
        )
    network_value = payload.get("network_policy")
    network_typed = (
        isinstance(network_value, list)
        and all(isinstance(item, str) for item in network_value)
    )
    observed_network = tuple(network_value) if network_typed else ()
    if (
        not network_typed
        or tuple(sorted(observed_network))
        != tuple(sorted(job_contract.network_policy))
    ):
        reject("workflow_preflight_artifact_network_policy_mismatch", "workflow_network_policy")
    if not payload.get("workflow_hash"):
        reject("workflow_preflight_artifact_workflow_hash_missing")
    elif payload.get("workflow_hash") != workflow_hash:
        reject("workflow_preflight_artifact_workflow_hash_mismatch")
    if payload.get("contract_hash") != contract_hash:
        reject("workflow_preflight_artifact_contract_hash_mismatch")
    if (
        job_contract.preflight_audit_reason is not None
        and payload.get("audit_reason") != job_contract.preflight_audit_reason
    ):
        reject("workflow_preflight_artifact_audit_reason_mismatch")
    if (
        job_contract.network_enforcement_evidence is not None
        and payload.get("network_enforcement_evidence")
        != job_contract.network_enforcement_evidence
    ):
        reject("workflow_preflight_artifact_network_evidence_mismatch", "workflow_network_policy")
    runtime_value = payload.get("runtime_write_paths")
    roots_value = payload.get("allowed_write_roots")
    allowlist_value = payload.get("path_allowlist")
    runtime_paths = tuple(runtime_value) if isinstance(runtime_value, list) else ()
    roots = tuple(roots_value) if isinstance(roots_value, list) else ()
    allowlist = tuple(allowlist_value) if isinstance(allowlist_value, list) else ()
    exact_paths = job_contract.exact_runtime_write_paths
    if exact_paths:
        paths_valid = runtime_paths == roots == allowlist == exact_paths
    else:
        paths_valid = (
            bool(runtime_paths)
            and runtime_paths == roots == allowlist
            and all(
                isinstance(item, str)
                and any(re.fullmatch(pattern, item) for pattern in job_contract.allowed_write_path_patterns)
                for item in runtime_paths
            )
        )
    if not paths_valid:
        reject("workflow_preflight_artifact_runtime_paths_mismatch", "path_allowlist_violation")
    if (
        job_contract.external_root_allowlist
        and payload.get("external_root_allowlist") != ["runner-temp"]
    ):
        reject("workflow_preflight_artifact_external_roots_mismatch", "path_allowlist_violation")
    audit_label = _normalized_external_artifact_path(
        payload.get("audit_artifact_path"),
        payload.get("external_root_allowlist"),
    )
    if audit_label is None or not re.fullmatch(
        job_contract.preflight_artifact_path_pattern,
        audit_label,
    ):
        reject("workflow_preflight_artifact_audit_path_mismatch", "path_allowlist_violation")
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
    "WorkflowActionRequirement",
    "WorkflowContract",
    "WorkflowContractVerdict",
    "WorkflowJobContract",
    "WorkflowPermissionRequirement",
    "WorkflowRegistryVerdict",
    "WorkflowStepRequirement",
    "WorkflowUploadRequirement",
    "discover_aria_workflows",
    "generated_workflow_inventory",
    "verify_workflow_contract",
    "verify_workflow_preflight_artifact_bytes",
    "verify_workflow_registry",
    "workflow_contract_hash",
    "workflow_contract_registry",
    "workflow_hash",
    "workflow_job_contract_hash",
]
