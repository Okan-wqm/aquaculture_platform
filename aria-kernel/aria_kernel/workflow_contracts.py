from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError


@dataclass(frozen=True)
class WorkflowContract:
    workflow_id: str
    workflow_file: str
    governed_jobs: tuple[str, ...]
    first_mutating_step: str
    exact_write_paths: tuple[str, ...]
    artifact_paths: tuple[str, ...]
    required_retention_days: int
    token_source: str
    network_policy: tuple[str, ...]
    dlp_artifact: str
    clean_worktree_policy: str
    external_root_allowlist: tuple[str, ...] = ()
    audited_exclusion: bool = False
    exclusion_reason: str | None = None


@dataclass(frozen=True)
class WorkflowContractVerdict:
    workflow_id: str
    valid: bool
    workflow_file: str | None = None
    workflow_hash: str | None = None
    failure_classes: tuple[str, ...] = field(default_factory=tuple)
    reasons: tuple[str, ...] = field(default_factory=tuple)


WORKFLOW_CONTRACTS: dict[str, WorkflowContract] = {
    "aria-operational-proof": WorkflowContract(
        workflow_id="aria-operational-proof",
        workflow_file=".github/workflows/aria-operational-proof.yml",
        governed_jobs=("proof",),
        first_mutating_step="Run observe burn-in proof",
        exact_write_paths=(
            "runner-temp/aria-operational-proof",
            "runner-temp/aria-tools.*",
            "runner-temp/aria-workspaces.*",
        ),
        artifact_paths=("runner-temp/aria-operational-proof",),
        required_retention_days=365,
        token_source="github_actions_artifact_token",
        network_policy=("github_artifact",),
        dlp_artifact="workflow-preflight.json",
        clean_worktree_policy="pre_and_post",
        external_root_allowlist=("RUNNER_TEMP",),
    ),
    "aria-agent-executor": WorkflowContract(
        workflow_id="aria-agent-executor",
        workflow_file=".github/workflows/aria-agent-executor.yml",
        governed_jobs=("executor",),
        first_mutating_step="Handoff snapshot — session_start",
        exact_write_paths=("runner-temp/aria-agent-executor",),
        artifact_paths=("runner-temp/aria-agent-executor",),
        required_retention_days=7,
        token_source="github_app:installation",
        network_policy=("github_api", "github_artifact"),
        dlp_artifact="workflow-preflight.json",
        clean_worktree_policy="pre_and_post",
        external_root_allowlist=("RUNNER_TEMP",),
    ),
    "aria-agent-eval": WorkflowContract(
        workflow_id="aria-agent-eval",
        workflow_file=".github/workflows/aria-agent-eval.yml",
        governed_jobs=("eval",),
        first_mutating_step="Run all eval fixtures (mock mode)",
        exact_write_paths=("runner-temp/aria-agent-eval",),
        artifact_paths=("runner-temp/aria-agent-eval",),
        required_retention_days=7,
        token_source="github_app:installation",
        network_policy=("github_api", "github_artifact"),
        dlp_artifact="workflow-preflight.json",
        clean_worktree_policy="pre_and_post",
        external_root_allowlist=("RUNNER_TEMP",),
    ),
    "aria-daily-report": WorkflowContract(
        workflow_id="aria-daily-report",
        workflow_file=".github/workflows/aria-daily-report.yml",
        governed_jobs=("generate-report", "commit-report"),
        first_mutating_step="Generate daily chain-tip anchor (Plan ARIA-V2 §3.9)",
        exact_write_paths=("aria-tools/reports/daily", "docs/aria/reports"),
        artifact_paths=("aria-daily-report",),
        required_retention_days=365,
        token_source="github_app:installation",
        network_policy=("github_api", "github_artifact"),
        dlp_artifact="workflow-preflight.json",
        clean_worktree_policy="pre_and_post",
    ),
    "finding-state-sweep": WorkflowContract(
        workflow_id="finding-state-sweep",
        workflow_file=".github/workflows/finding-state-sweep.yml",
        governed_jobs=("sweep",),
        first_mutating_step="Apply sweep",
        exact_write_paths=("aria-findings", "aria-debts"),
        artifact_paths=("finding-state-sweep",),
        required_retention_days=365,
        token_source="github_app:installation",
        network_policy=("github_api", "github_artifact"),
        dlp_artifact="workflow-preflight.json",
        clean_worktree_policy="pre_and_post",
    ),
    "rule-health-report": WorkflowContract(
        workflow_id="rule-health-report",
        workflow_file=".github/workflows/rule-health-report.yml",
        governed_jobs=("generate",),
        first_mutating_step="Generate report",
        exact_write_paths=("docs/aria/reports",),
        artifact_paths=("rule-health-report",),
        required_retention_days=365,
        token_source="github_app:installation",
        network_policy=("github_api", "github_artifact"),
        dlp_artifact="workflow-preflight.json",
        clean_worktree_policy="pre_and_post",
    ),
}


AUDITED_WORKFLOW_EXCLUSIONS: dict[str, str] = {
    "aria-kernel": "test-only kernel validation workflow; no governed ARIA state write authority; review by 2026-07-05",
    "aria-kernel-fast": "test-only fast kernel validation workflow; no governed ARIA state write authority; review by 2026-07-05",
    "aria-kernel-full": "test-only full kernel validation workflow; no governed ARIA state write authority; review by 2026-07-05",
}


def workflow_contract_registry() -> dict[str, WorkflowContract]:
    return dict(WORKFLOW_CONTRACTS)


def workflow_hash(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _workflow_structure(text: str) -> dict[str, Any]:
    """Small structural scanner for the GitHub workflow fields ARIA gates.

    This is intentionally narrower than a full YAML parser, but it observes
    indentation, step names and literal run blocks. That closes the important
    enterprise gap from raw whole-file string search: comments and env values no
    longer count as preflight calls or shell input interpolation.
    """
    lines = text.splitlines()
    job_ids: list[str] = []
    step_names: list[dict[str, Any]] = []
    run_blocks: list[dict[str, Any]] = []
    retention_days: list[int] = []
    upload_artifact_lines: list[int] = []
    in_jobs = False
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "jobs:":
            in_jobs = True
            continue
        if in_jobs and line and not line.startswith(" "):
            in_jobs = False
        if in_jobs:
            match = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
            if match:
                job_ids.append(match.group(1))
        name_match = re.match(r"^\s*-\s+name:\s*(.+?)\s*$", line)
        if name_match:
            step_names.append({"name": _yaml_scalar(name_match.group(1)), "line": idx})
        retention_match = re.match(r"^\s*retention-days:\s*['\"]?(\d+)['\"]?\s*$", line)
        if retention_match:
            retention_days.append(int(retention_match.group(1)))
        if "actions/upload-artifact" in _strip_yaml_comment(line):
            upload_artifact_lines.append(idx)
        run_match = re.match(r"^(\s*)run:\s*(.*)$", line)
        if run_match:
            indent = len(run_match.group(1))
            value = run_match.group(2)
            block_lines = [value] if value and value not in {"|", ">"} else []
            if value in {"|", ">"}:
                for later in lines[idx + 1:]:
                    if later.strip() and len(later) - len(later.lstrip(" ")) <= indent:
                        break
                    block_lines.append(later)
            run_blocks.append({"line": idx, "text": "\n".join(block_lines)})
    return {
        "job_ids": tuple(job_ids),
        "step_names": tuple(step_names),
        "run_blocks": tuple(run_blocks),
        "retention_days": tuple(retention_days),
        "upload_artifact_lines": tuple(upload_artifact_lines),
    }


def _yaml_scalar(value: str) -> str:
    value = _strip_yaml_comment(value).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _strip_yaml_comment(value: str) -> str:
    in_single = False
    in_double = False
    for index, char in enumerate(value):
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        elif char == "#" and not in_single and not in_double:
            return value[:index]
    return value


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
    structure = _workflow_structure(text)
    job_ids = set(structure["job_ids"])
    missing_jobs = sorted(set(contract.governed_jobs) - job_ids)
    if missing_jobs:
        reasons.append(f"governed_jobs_missing:{missing_jobs}")
        failure_classes.append("workflow_contract_jobs")

    preflight_lines = [
        int(block["line"])
        for block in structure["run_blocks"]
        if "verify_workflow_preflight" in str(block.get("text") or "")
        or "verify_workflow_contract" in str(block.get("text") or "")
    ]
    if not preflight_lines:
        reasons.append("workflow_contract_preflight_call_missing")
        failure_classes.append("workflow_contract_preflight_missing")
    mutating_lines = [
        int(step["line"])
        for step in structure["step_names"]
        if step.get("name") == contract.first_mutating_step
    ]
    if not mutating_lines:
        reasons.append(f"first_mutating_step_missing:{contract.first_mutating_step}")
        failure_classes.append("workflow_contract_ordering")
    elif preflight_lines:
        if min(preflight_lines) > min(mutating_lines):
            reasons.append("workflow_preflight_after_first_mutating_step")
            failure_classes.append("workflow_contract_ordering")
    if contract.required_retention_days > 0:
        observed_retention = tuple(int(item) for item in structure["retention_days"])
        if not any(item >= contract.required_retention_days for item in observed_retention):
            reasons.append(f"artifact_retention_below_contract:{contract.required_retention_days}")
            failure_classes.append("workflow_artifact_retention")
    if contract.artifact_paths and not structure["upload_artifact_lines"]:
        reasons.append("workflow_upload_artifact_step_missing")
        failure_classes.append("workflow_artifact_upload")
    run_input_lines = [
        int(block["line"])
        for block in structure["run_blocks"]
        if "${{ github.event.inputs." in str(block.get("text") or "")
    ]
    if run_input_lines:
        reasons.append("raw_github_event_inputs_interpolation_present")
        failure_classes.append("workflow_input_injection")
    if artifact_dir is not None and contract.dlp_artifact not in {"", "none"}:
        proof = Path(artifact_dir) / contract.dlp_artifact
        if not proof.exists():
            reasons.append(f"dlp_artifact_missing:{contract.dlp_artifact}")
            failure_classes.append("workflow_dlp_proof_missing")
        else:
            proof_reasons, proof_failures = _verify_preflight_artifact(
                proof,
                contract=contract,
                workflow_hash=digest,
            )
            reasons.extend(proof_reasons)
            failure_classes.extend(proof_failures)
    if event_context:
        observed_token = str(event_context.get("token_source") or "")
        if observed_token and observed_token != contract.token_source:
            reasons.append(f"workflow_token_source_mismatch:{observed_token}!={contract.token_source}")
            failure_classes.append("workflow_token_source")
    return WorkflowContractVerdict(
        workflow_id=workflow_id,
        workflow_file=contract.workflow_file,
        workflow_hash=digest,
        valid=not failure_classes,
        failure_classes=tuple(sorted(set(failure_classes))),
        reasons=tuple(reasons),
    )


def _verify_preflight_artifact(
    path: Path,
    *,
    contract: WorkflowContract,
    workflow_hash: str,
) -> tuple[list[str], list[str]]:
    reasons: list[str] = []
    failures: list[str] = []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return ([f"dlp_artifact_unparseable:{path.name}"], ["workflow_dlp_proof_missing"])
    if payload.get("workflow_id") != contract.workflow_id:
        reasons.append("workflow_preflight_artifact_workflow_id_mismatch")
        failures.append("workflow_dlp_proof_missing")
    if payload.get("valid") is not True:
        reasons.append("workflow_preflight_artifact_not_valid")
        failures.append("workflow_dlp_proof_missing")
    if payload.get("dlp_scan_clean") is not True:
        reasons.append("workflow_preflight_artifact_dlp_not_clean")
        failures.append("workflow_dlp_proof_missing")
    observed_token = str(payload.get("token_provenance") or "")
    if contract.token_source not in {"", "none"} and observed_token != contract.token_source:
        reasons.append(f"workflow_preflight_artifact_token_mismatch:{observed_token}!={contract.token_source}")
        failures.append("workflow_token_source")
    observed_network = tuple(payload.get("network_policy") or ())
    if tuple(sorted(observed_network)) != tuple(sorted(contract.network_policy)):
        reasons.append("workflow_preflight_artifact_network_policy_mismatch")
        failures.append("workflow_network_policy")
    if not payload.get("workflow_hash"):
        reasons.append("workflow_preflight_artifact_workflow_hash_missing")
        failures.append("workflow_dlp_proof_missing")
    elif payload.get("workflow_hash") != workflow_hash:
        reasons.append("workflow_preflight_artifact_workflow_hash_mismatch")
        failures.append("workflow_dlp_proof_missing")
    return reasons, failures


def generated_workflow_inventory(workspace_root: str | Path) -> str:
    discovered = discover_aria_workflows(workspace_root)
    rows = []
    for workflow_id, path in sorted(discovered.items()):
        contract = WORKFLOW_CONTRACTS.get(workflow_id)
        rows.append({
            "workflow_id": workflow_id,
            "path": path.relative_to(Path(workspace_root)).as_posix(),
            "contracted": contract is not None,
            "audited_exclusion": workflow_id in AUDITED_WORKFLOW_EXCLUSIONS,
        })
    return json.dumps(rows, indent=2, sort_keys=True) + "\n"


__all__ = [
    "AUDITED_WORKFLOW_EXCLUSIONS",
    "WORKFLOW_CONTRACTS",
    "WorkflowContract",
    "WorkflowContractVerdict",
    "discover_aria_workflows",
    "generated_workflow_inventory",
    "verify_workflow_contract",
    "workflow_contract_registry",
    "workflow_hash",
]
