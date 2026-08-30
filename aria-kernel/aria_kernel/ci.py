from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any

from .agent_priors import related_agents_for_paths
from .auto_merge import evaluate_auto_merge
from .ledger import (
    append_declared_jsonl,
    append_jsonl as _append_jsonl,
    load_declared_jsonl,
    load_jsonl as _load_jsonl,
)
from .proposal import record_proposal
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


FAILURE_CLASSES = (
    "code_regression",
    "test_contract_regression",
    "workflow_infra_failure",
    "dependency_or_env_failure",
    "protected_environment_gate",
    "unknown_requires_review",
)

WORKFLOW_CLASSES = ("pr_required", "dispatch_safe", "protected_side_effect")
SUPPRESSION_PATTERNS = (
    "skip test",
    "skip the test",
    "delete the test",
    "remove the test",
    "disable workflow",
    "disable the workflow",
    "workflow_dispatch only",
    "lower threshold",
    "reduce threshold",
    "mark false positive",
    "mark fp",
    "ignore failure",
    "allow failure",
    "continue-on-error",
)


_CI_SURFACE_BY_FILENAME: dict[str, str] = {
    "workflow-inventory.jsonl": "ci_workflow_inventory",
    "workflow-runs.jsonl": "ci_workflow_runs",
    "failures.jsonl": "ci_failures",
    "ci-reports.jsonl": "ci_reports",
    "pr-ci-gates.jsonl": "ci_pr_gates",
    "agent-review-tasks.jsonl": "ci_agent_review_tasks",
    "agent-reviews.jsonl": "ci_agent_reviews",
    "remediation-proposals.jsonl": "ci_remediation_proposals",
}


def _ci_surface_name(path: str | Path) -> str | None:
    concrete = Path(path)
    if concrete.parent.name != "ci":
        return None
    return _CI_SURFACE_BY_FILENAME.get(concrete.name)


def append_jsonl(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    surface = _ci_surface_name(path)
    if surface is not None:
        return append_declared_jsonl(path, record, expected_surface=surface)
    return _append_jsonl(path, record)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    surface = _ci_surface_name(path)
    if surface is not None:
        return load_declared_jsonl(path, expected_surface=surface)
    return _load_jsonl(path)


def inventory_workflows(
    *,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    workflow_dir = root / ".github" / "workflows"
    workflows = []
    if workflow_dir.exists():
        for path in sorted([*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")]):
            workflows.append(_classify_workflow(path, root))
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "workflow_count": len(workflows),
        "workflows": workflows,
        "summary": {kind: sum(1 for item in workflows if item["class"] == kind) for kind in WORKFLOW_CLASSES},
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "ci" / "workflow-inventory.jsonl", row)


def latest_workflow_inventory(*, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    rows = load_jsonl(ensure_tools_dir(base_dir) / "ci" / "workflow-inventory.jsonl")
    return rows[-1] if rows else None


def record_ci_report(
    *,
    pr: dict[str, Any],
    github: dict[str, Any],
    changed_files: list[str] | None = None,
    workflow_inventory: dict[str, Any] | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    inventory = workflow_inventory or latest_workflow_inventory(base_dir=base_dir) or {"workflows": []}
    changed = _string_list(changed_files if changed_files is not None else pr.get("changed_files", pr.get("files", [])))
    workflow_runs = _workflow_runs(github)
    recorded_runs = [
        append_jsonl(root / "ci" / "workflow-runs.jsonl", _workflow_run_row(run, pr, cycle_id))
        for run in workflow_runs
    ]
    failures = []
    for run in workflow_runs:
        workflow_class = _workflow_class_for_run(run, inventory)
        for failure in _failures_for_run(run, changed, workflow_class, cycle_id, pr.get("number")):
            failures.append(append_jsonl(root / "ci" / "failures.jsonl", failure))
    gate = evaluate_pr_ci_gate(
        pr=pr,
        github=github,
        workflow_inventory=inventory,
        base_dir=base_dir,
        cycle_id=cycle_id,
    )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "pr_number": pr.get("number"),
        "head_sha": _first_string(pr, "head_sha", "headRefOid", "head"),
        "changed_files": changed,
        "workflow_run_refs": [run["ledger_hash"] for run in recorded_runs],
        "failure_refs": [failure["ledger_hash"] for failure in failures],
        "failure_count": len(failures),
        "ready_state": gate["status"],
        "gate_ref": gate["ledger_hash"],
    }
    return append_jsonl(root / "ci" / "ci-reports.jsonl", row)


def evaluate_pr_ci_gate(
    *,
    pr: dict[str, Any],
    github: dict[str, Any],
    policy: dict[str, Any] | None = None,
    workflow_inventory: dict[str, Any] | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    inventory = workflow_inventory or latest_workflow_inventory(base_dir=base_dir) or {"workflows": []}
    auto = evaluate_auto_merge(
        pr=pr,
        github=github,
        policy=policy or {"enabled": True, "base_branch": "main", "merge_method": "squash"},
        base_dir=base_dir,
        cycle_id=cycle_id,
        dry_run=True,
    )
    blockers = list(auto.get("reasons", []))
    protected_gates = _protected_workflow_gates(inventory, github)
    blockers.extend(gate["reason"] for gate in protected_gates if gate.get("blocking"))
    unknown_failures = [
        run.get("name") or run.get("workflow_name") or run.get("workflow")
        for run in _workflow_runs(github)
        if _run_failed(run) and not _run_success(run)
    ]
    blockers.extend(f"failed workflow requires review: {name}" for name in unknown_failures if name)
    status = "ready_for_human_merge" if not blockers else "blocked"
    pr_number = pr.get("number")
    head_sha = _first_string(pr, "head_sha", "headRefOid", "head")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "pr_number": pr_number,
        "head_sha": head_sha,
        "status": status,
        "ready_for_human_merge": status == "ready_for_human_merge",
        "blocked_by": sorted(set(blockers)),
        "required_checks": auto.get("required_checks"),
        "check_result": auto.get("check_result"),
        "protected_workflow_gates": protected_gates,
    }
    # F5-a — WHY: gate rows become source_ledger_ref targets for the
    # readiness-claim chain, which needs row_id + row_type on the source
    # row. WHAT: identity is (pr, head-sha prefix); stamped only when both
    # halves exist so a snapshot lacking either cannot mint a fake or
    # colliding identity. Readers tolerate absence (legacy rows).
    if pr_number is not None and head_sha:
        row["row_id"] = f"ci-pr-gate:{pr_number}:{head_sha[:12]}"
        row["row_type"] = "ci_pr_gate"
    return append_jsonl(ensure_tools_dir(base_dir) / "ci" / "pr-ci-gates.jsonl", row)


def wait_pr_checks(
    *,
    pr_number: int | None = None,
    snapshot: dict[str, Any] | None = None,
    workspace_root: str | Path = ".",
    policy: dict[str, Any] | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    if snapshot is not None:
        return evaluate_pr_ci_gate(
            pr=snapshot["pr"],
            github=snapshot.get("github", {}),
            policy=snapshot.get("policy", policy),
            workflow_inventory=snapshot.get("workflow_inventory"),
            base_dir=base_dir,
            cycle_id=cycle_id,
        )
    if pr_number is None:
        raise GovernanceError("pr_number is required when no snapshot is provided")
    payload = _gh_pr_snapshot(pr_number=pr_number, workspace_root=workspace_root)
    return evaluate_pr_ci_gate(
        pr=payload["pr"],
        github=payload.get("github", {}),
        policy=policy,
        workflow_inventory=latest_workflow_inventory(base_dir=base_dir),
        base_dir=base_dir,
        cycle_id=cycle_id,
    )


def produce_ci_review(
    *,
    ci_failure_id: str,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    failure = _failure_by_id(ci_failure_id, base_dir)
    paths = sorted(set(_string_list(failure.get("affected_files")) + _string_list(failure.get("changed_file_overlap"))))
    agents = related_agents_for_paths(paths=paths, base_dir=base_dir)
    agents = sorted(set(agents + _fallback_agents(failure)))
    if not agents:
        agents = ["architectural-arbiter"]
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "ci_failure_id": ci_failure_id,
        "status": "review_requested",
        "read_only": True,
        "target_agents": agents,
        "task_packet": {
            "lane": "ci_failure_root_cause_review",
            "instructions": [
                "Use ARIA read-only tools and repo evidence only.",
                "Return root cause classification, architectural options, risk/tradeoff, and validation commands.",
                "Do not include a patch, diff, skip, suppression, threshold lowering, or workflow disabling proposal.",
            ],
            "required_fields": [
                "repo_evidence_refs",
                "workflow_evidence_refs",
                "root_cause_classification",
                "architectural_options",
                "risk_tradeoff",
                "validation_commands",
                "compliance_statement",
            ],
            "failure": failure,
        },
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "ci" / "agent-review-tasks.jsonl", row)


def record_agent_review_result(
    *,
    review: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    _validate_agent_review(review)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "ci_failure_id": str(review.get("ci_failure_id")),
        "reviewer_agent": str(review.get("reviewer_agent")),
        "root_cause_classification": str(review.get("root_cause_classification")),
        "repo_evidence_refs": _string_list(review.get("repo_evidence_refs")),
        "workflow_evidence_refs": _string_list(review.get("workflow_evidence_refs")),
        "architectural_options": review.get("architectural_options"),
        "risk_tradeoff": str(review.get("risk_tradeoff")),
        "validation_commands": _string_list(review.get("validation_commands")),
        "compliance_statement": str(review.get("compliance_statement")),
        "status": "accepted_read_only_review",
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "ci" / "agent-reviews.jsonl", row)


def record_remediation_proposal(
    *,
    ci_failure_id: str,
    title: str,
    problem: str,
    architectural_solution: str,
    evidence_refs: list[str],
    validation_commands: list[str],
    agent_review_refs: list[str],
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    if not validation_commands:
        raise GovernanceError("remediation proposal requires validation_commands")
    if not evidence_refs:
        raise GovernanceError("remediation proposal requires evidence_refs")
    if _suppression_violation(" ".join([title, problem, architectural_solution, *validation_commands])):
        raise GovernanceError("suppression_policy_violation")
    proposal = record_proposal(
        kind="architecture",
        title=title,
        problem=problem,
        evidence=evidence_refs,
        validation_command=validation_commands[0],
        validation_commands=validation_commands,
        source_authority="ci_agent_review",
        proposed_change=architectural_solution,
        status="ready_for_operator",
        base_dir=base_dir,
    )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "ci_failure_id": ci_failure_id,
        "proposal_id": proposal["proposal_id"],
        "title": title,
        "problem": problem,
        "architectural_solution": architectural_solution,
        "evidence_refs": evidence_refs,
        "validation_commands": validation_commands,
        "agent_review_refs": agent_review_refs,
        "status": "ready_for_operator",
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "ci" / "remediation-proposals.jsonl", row)


def list_ci_failures(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "ci" / "failures.jsonl")


def list_agent_reviews(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "ci" / "agent-reviews.jsonl")


def _classify_workflow(path: Path, root: Path) -> dict[str, Any]:
    content = path.read_text(encoding="utf-8", errors="ignore")
    lower = content.lower()
    name = _workflow_name(content) or path.stem
    workflow_class = "pr_required"
    reasons = []
    if _side_effect_workflow(path.name, lower):
        workflow_class = "protected_side_effect"
        reasons.append("side_effect_or_protected_environment")
    elif "workflow_dispatch" in lower and "pull_request" not in lower:
        workflow_class = "dispatch_safe"
        reasons.append("manual_dispatch_without_side_effect_markers")
    elif "pull_request" in lower:
        reasons.append("pull_request_check")
    else:
        workflow_class = "dispatch_safe"
        reasons.append("not_required_on_pull_request")
    return {
        "path": path.relative_to(root).as_posix(),
        "name": name,
        "class": workflow_class,
        "triggers": _workflow_triggers(lower),
        "reasons": reasons,
    }


def _workflow_name(content: str) -> str | None:
    match = re.search(r"(?m)^\s*name\s*:\s*(.+?)\s*$", content)
    return match.group(1).strip("'\"") if match else None


def _workflow_triggers(lower: str) -> list[str]:
    triggers = []
    for trigger in ("pull_request", "push", "workflow_dispatch", "schedule", "workflow_run"):
        if trigger in lower:
            triggers.append(trigger)
    return triggers


def _side_effect_workflow(filename: str, lower: str) -> bool:
    text = f"{filename.lower()}\n{lower}"
    tokens = (
        "deploy",
        "release",
        "backup",
        "secret",
        "rotate",
        "production",
        "staging",
        "kubectl",
        "terraform apply",
        "helm upgrade",
        "docker push",
        "environment:",
    )
    return any(token in text for token in tokens)


def _workflow_runs(github: dict[str, Any]) -> list[dict[str, Any]]:
    runs = github.get("workflow_runs", github.get("workflows", []))
    if isinstance(runs, dict):
        runs = runs.get("runs", runs.get("workflow_runs", []))
    return [run for run in runs if isinstance(run, dict)] if isinstance(runs, list) else []


def _workflow_run_row(run: dict[str, Any], pr: dict[str, Any], cycle_id: str | None) -> dict[str, Any]:
    workflow_run_id = run.get("id") or run.get("databaseId")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "pr_number": pr.get("number"),
        "head_sha": run.get("head_sha") or _first_string(pr, "head_sha", "headRefOid", "head"),
        "workflow_run_id": workflow_run_id,
        "name": run.get("name") or run.get("workflow_name") or run.get("workflow"),
        "status": run.get("status"),
        "conclusion": run.get("conclusion"),
        "url": run.get("url") or run.get("html_url"),
    }
    # F5-a — WHY: enterprise readiness proofs must target this row through
    # ledger_refs.find_row_by_source_ledger_ref, which requires a stable
    # row_id + row_type on the SOURCE row. WHAT: stamp the identity pair
    # only when the run actually carries an id — a row without a run id has
    # no stable identity, and stamping "ci-workflow-run:None" would mint
    # colliding fake identities. Readers tolerate absence (legacy rows).
    if workflow_run_id is not None:
        row["row_id"] = f"ci-workflow-run:{workflow_run_id}"
        row["row_type"] = "ci_workflow_run"
    return row


def _failures_for_run(
    run: dict[str, Any],
    changed_files: list[str],
    workflow_class: str,
    cycle_id: str | None,
    pr_number: Any = None,
) -> list[dict[str, Any]]:
    if workflow_class == "protected_side_effect":
        if _protected_run_success(run):
            return []
    elif not _run_failed(run):
        return []
    jobs = run.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        jobs = [run]
    failures = []
    for job in jobs:
        if not isinstance(job, dict):
            continue
        if workflow_class == "protected_side_effect":
            if _protected_run_success(job):
                continue
        elif not _run_failed(job):
            continue
        steps = job.get("steps") if isinstance(job.get("steps"), list) else []
        failing_steps = [step for step in steps if isinstance(step, dict) and _run_failed(step)] or [{}]
        for step in failing_steps:
            affected_files = _affected_files(job, step)
            overlap = sorted(set(affected_files) & set(changed_files))
            log_text = _log_text(run, job, step)
            classification = _classify_failure(log_text, workflow_class, bool(overlap), job, step)
            test_names = _test_names(job, step, log_text)
            failure_fingerprint = _failure_fingerprint(run, job, step, log_text, test_names)
            normalized = {
                "workflow": run.get("name") or run.get("workflow_name") or run.get("workflow"),
                "workflow_run_id": run.get("id") or run.get("databaseId"),
                "job": job.get("name") or job.get("job_name"),
                "step": step.get("name") or step.get("step_name"),
                "classification": classification,
                "log_hash": _hash_text(log_text),
                "failure_fingerprint": failure_fingerprint,
            }
            failures.append(
                {
                    "schema_version": 1,
                    "recorded_at": utc_now(),
                    "cycle_id": cycle_id,
                    "pr_number": pr_number,
                    "ci_failure_id": "ci-failure-" + _hash_json(normalized)[:12],
                    "failure_fingerprint": failure_fingerprint,
                    "workflow": normalized["workflow"],
                    "workflow_run_id": normalized["workflow_run_id"],
                    "workflow_class": workflow_class,
                    "job": normalized["job"],
                    "step": normalized["step"],
                    "status": job.get("status") or run.get("status"),
                    "conclusion": job.get("conclusion") or run.get("conclusion"),
                    "root_cause_classification": classification,
                    "log_hash": normalized["log_hash"],
                    "log_excerpt": log_text[:1200],
                    "affected_files": affected_files,
                    "changed_files": changed_files,
                    "changed_file_overlap": overlap,
                    "test_names": test_names,
                    "exit_code": step.get("exit_code", job.get("exit_code")),
                    "review_status": "requires_agent_review",
                },
            )
    return failures


def _workflow_class_for_run(run: dict[str, Any], inventory: dict[str, Any]) -> str:
    run_name = str(run.get("name") or run.get("workflow_name") or run.get("workflow") or "").lower()
    run_path = str(run.get("path") or "").lower()
    for workflow in inventory.get("workflows", []):
        if not isinstance(workflow, dict):
            continue
        if str(workflow.get("name") or "").lower() == run_name or str(workflow.get("path") or "").lower() == run_path:
            return str(workflow.get("class") or "pr_required")
    return "pr_required"


def _affected_files(job: dict[str, Any], step: dict[str, Any]) -> list[str]:
    candidates = []
    for payload in (step, job):
        candidates.extend(_string_list(payload.get("affected_files")))
        annotations = payload.get("annotations")
        if isinstance(annotations, list):
            candidates.extend(str(item.get("path")) for item in annotations if isinstance(item, dict) and item.get("path"))
    return sorted(set(path.replace("\\", "/") for path in candidates if path))


def _test_names(job: dict[str, Any], step: dict[str, Any], log_text: str) -> list[str]:
    names = _string_list(step.get("test_names")) + _string_list(job.get("test_names"))
    for match in re.finditer(r"(?:FAIL|FAILED|Error:)\s+([A-Za-z0-9_./:-]+)", log_text):
        names.append(match.group(1))
    return sorted(set(names))


def _failure_fingerprint(
    run: dict[str, Any],
    job: dict[str, Any],
    step: dict[str, Any],
    log_text: str,
    test_names: list[str],
) -> str:
    assertion = _normalize_log_assertion(log_text)
    file_line = _first_file_line(log_text)
    payload = {
        "workflow": run.get("name") or run.get("workflow_name") or run.get("workflow"),
        "job": job.get("name") or job.get("job_name"),
        "test_names": test_names,
        "assertion": assertion,
        "file_line": file_line,
        "step": step.get("name") or step.get("step_name"),
    }
    return "failure:" + _hash_json(payload)[:16]


def _normalize_log_assertion(log_text: str) -> str:
    for line in log_text.splitlines():
        lower = line.lower()
        if any(token in lower for token in ("expected", "received", "assert", "error:", "failed")):
            return " ".join(line.strip().split())[:240]
    return " ".join(log_text.strip().split())[:240]


def _first_file_line(log_text: str) -> str:
    match = re.search(r"([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|py|rs|go))[:(](\d+)", log_text)
    if not match:
        return ""
    return f"{match.group(1)}:{match.group(2)}"


def _log_text(*payloads: dict[str, Any]) -> str:
    parts = []
    for payload in payloads:
        for key in ("log", "logs", "log_excerpt", "message", "stderr", "stdout"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                parts.append(value)
    return "\n".join(parts)


def _classify_failure(
    log_text: str,
    workflow_class: str,
    has_overlap: bool,
    job: dict[str, Any],
    step: dict[str, Any],
) -> str:
    lower = log_text.lower()
    if workflow_class == "protected_side_effect":
        return "protected_environment_gate"
    if any(token in lower for token in ("runner", "rate limit", "network", "econnreset", "timed out", "no space left")):
        return "workflow_infra_failure"
    if any(token in lower for token in ("npm ci", "npm install", "pip install", "lockfile", "enotfound", "dependency")):
        return "dependency_or_env_failure"
    if _test_names(job, step, log_text) or any(token in lower for token in ("assert", "expected", "received", "snapshot")):
        return "test_contract_regression"
    if has_overlap:
        return "code_regression"
    return "unknown_requires_review"


def _protected_workflow_gates(inventory: dict[str, Any], github: dict[str, Any]) -> list[dict[str, Any]]:
    runs = _workflow_runs(github)
    by_name = {str(run.get("name") or run.get("workflow_name") or run.get("workflow") or ""): run for run in runs}
    gates = []
    for workflow in inventory.get("workflows", []):
        if not isinstance(workflow, dict) or workflow.get("class") != "protected_side_effect":
            continue
        run = by_name.get(str(workflow.get("name") or ""))
        blocking = run is not None and not _protected_run_success(run)
        gates.append(
            {
                "workflow": workflow.get("name"),
                "path": workflow.get("path"),
                "class": "protected_side_effect",
                "blocking": blocking,
                "reason": f"protected workflow requires human gate: {workflow.get('name')}",
                "run_status": run.get("status") if run else "not_dispatched_by_aria",
                "run_conclusion": run.get("conclusion") if run else None,
            },
        )
    return gates


def _validate_agent_review(review: dict[str, Any]) -> None:
    if not isinstance(review, dict):
        raise GovernanceError("agent review result must be a JSON object")
    required = (
        "ci_failure_id",
        "reviewer_agent",
        "repo_evidence_refs",
        "workflow_evidence_refs",
        "root_cause_classification",
        "architectural_options",
        "risk_tradeoff",
        "validation_commands",
        "compliance_statement",
    )
    missing = [field for field in required if field not in review]
    if missing:
        raise GovernanceError("agent review missing required fields: " + ", ".join(missing))
    if str(review.get("root_cause_classification")) not in FAILURE_CLASSES:
        raise GovernanceError("unknown root_cause_classification")
    if not _string_list(review.get("repo_evidence_refs")):
        raise GovernanceError("agent review requires repo evidence refs")
    if not _string_list(review.get("workflow_evidence_refs")):
        raise GovernanceError("agent review requires workflow evidence refs")
    if not _string_list(review.get("validation_commands")):
        raise GovernanceError("agent review requires validation commands")
    options = review.get("architectural_options")
    if not isinstance(options, list) or not options:
        raise GovernanceError("agent review requires architectural_options")
    text = json.dumps(review, sort_keys=True)
    if _contains_patch(text):
        raise GovernanceError("agent review must be read-only and must not include a patch or diff")
    if _suppression_violation(text):
        raise GovernanceError("suppression_policy_violation")


def _contains_patch(text: str) -> bool:
    lower = text.lower()
    return "```diff" in lower or "\ndiff --git " in lower or "\n+++ b/" in lower or "\n--- a/" in lower


def _suppression_violation(text: str) -> bool:
    lower = text.lower()
    return any(pattern in lower for pattern in SUPPRESSION_PATTERNS)


def _failure_by_id(ci_failure_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    for failure in reversed(list_ci_failures(base_dir=base_dir)):
        if failure.get("ci_failure_id") == ci_failure_id:
            return failure
    raise GovernanceError(f"CI failure not found: {ci_failure_id}")


def _fallback_agents(failure: dict[str, Any]) -> list[str]:
    text = " ".join(str(failure.get(key) or "") for key in ("workflow", "job", "step", "root_cause_classification")).lower()
    agents = []
    if any(token in text for token in ("security", "secret", "trivy", "gitleaks", "snyk")):
        agents.append("security")
    if any(token in text for token in ("tenant", "auth")):
        agents.append("tenant")
    if any(token in text for token in ("db", "database", "migration")):
        agents.append("database")
    if any(token in text for token in ("test", "lint", "build", "contract")):
        agents.append("test")
    if any(token in text for token in ("workflow", "infra", "deploy", "backup")):
        agents.append("infra")
    return agents


def _gh_pr_snapshot(*, pr_number: int, workspace_root: str | Path) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    pr = _gh_json(root, ["pr", "view", str(pr_number), "--json", "number,baseRefName,headRefOid,files"])
    checks = _gh_json(root, ["pr", "checks", str(pr_number), "--json", "name,state,link,workflow"])
    # Map gh-cli state strings -> CompletedProcess-style (status,
    # conclusion) tuples used by the auto-merge / verification gates.
    runs = [
        {
            "name": item.get("workflow") or item.get("name"),
            "status": "completed" if item.get("state") in ("SUCCESS", "FAILURE", "SKIPPED", "CANCELLED") else "in_progress",
            "conclusion": (
                "success" if item.get("state") == "SUCCESS"
                else "failure" if item.get("state") == "FAILURE"
                else "skipped" if item.get("state") == "SKIPPED"
                else "cancelled" if item.get("state") == "CANCELLED"
                else None
            ),
            "url": item.get("link"),
        }
        for item in checks if isinstance(item, dict)
    ]
    required = [str(item.get("name")) for item in checks if isinstance(item, dict) and item.get("name")]

    # Plan 022 §C-7 — required-check runs MUST reflect real gh state.
    # Pre-fix this list was synthesized as `[{name, status:'completed',
    # conclusion:'success'} for name in required]` regardless of the
    # actual check outcome. Auto-merge gates that consumed
    # github.checks.runs (rather than workflow_runs) saw pending /
    # failing checks as success and could greenlight a merge over a
    # broken CI baseline.
    runs_by_name: dict[str, dict[str, Any]] = {}
    for item in checks:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not name:
            continue
        state = item.get("state")
        runs_by_name[str(name)] = {
            "name": str(name),
            "status": "completed" if state in ("SUCCESS", "FAILURE", "SKIPPED", "CANCELLED") else "in_progress",
            "conclusion": (
                "success" if state == "SUCCESS"
                else "failure" if state == "FAILURE"
                else "skipped" if state == "SKIPPED"
                else "cancelled" if state == "CANCELLED"
                else None
            ),
        }
    # Plan 023 v3 §P-2 — fetch real branch protection required_checks
    # instead of deriving from already-run gh-pr-checks list. The
    # checks-list approach silently accepted PRs with 0 runs against a
    # protected base.
    base_branch = pr.get("baseRefName") or "main"
    bp_contexts, bp_error = _fetch_branch_protection_contexts(
        root=root, base_branch=str(base_branch),
    )
    # Authoritative required-check list: real protection contexts when
    # available, fall back to checks-list only when the lookup itself
    # failed (operator-readable lookup_error captures the reason).
    required_authoritative = bp_contexts if bp_contexts is not None else required
    required_runs = [
        runs_by_name[name] if name in runs_by_name else {
            "name": name, "status": "in_progress", "conclusion": None,
        }
        for name in required_authoritative
    ]
    if not required_runs and required:
        # Branch protection can be readable but unconfigured for local/test
        # repos. Do not hide real gh-pr-check states from consumers; an empty
        # checks.runs list would make failures invisible to gates that inspect
        # the snapshot's concrete run state.
        required_runs = [runs_by_name[name] for name in required if name in runs_by_name]

    branch_protection_block: dict[str, Any] = {
        "readable": bp_error is None,
        "required_checks": required_authoritative,
    }
    if bp_error is not None:
        branch_protection_block["lookup_error"] = bp_error

    return {
        "pr": {
            "number": pr.get("number"),
            "base_branch": pr.get("baseRefName"),
            "head_sha": pr.get("headRefOid"),
            "changed_files": pr.get("files", []),
        },
        "github": {
            "latest_head_sha": pr.get("headRefOid"),
            "branch_protection": branch_protection_block,
            "checks": {"readable": True, "runs": required_runs},
            "workflow_runs": runs,
            "reviews": {"readable": True, "items": []},
            "conversations": {"readable": True, "unresolved_count": 0},
        },
    }


def _gh_json(root: Path, args: list[str]) -> Any:
    completed = subprocess.run(["gh", *args], cwd=root, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise GovernanceError(completed.stderr.strip() or completed.stdout.strip() or "gh command failed")
    return json.loads(completed.stdout or "{}")


def _fetch_branch_protection_contexts(
    *, root: Path, base_branch: str,
) -> tuple[list[str] | None, str | None]:
    """Plan 023 v3 §P-2 — fetch real branch-protection required contexts.

    Pre-Plan-023 _gh_pr_snapshot derived `required_checks` from
    `gh pr checks` stdout, which lists the checks that ALREADY RAN on
    the PR — not the checks branch protection requires. A PR with 0
    runs against a base branch protected by `ci-affected` returned
    required=[] and auto-merge then accepted "all required satisfied".

    Post-fix: query the real protection contexts via gh api. Returns
    a (contexts, error_code) tuple; the auto-merge consumer (P-4)
    reads both. Failure paths discriminate explicitly:
      * HTTP 200, populated → (contexts, None).
      * HTTP 200, empty contexts → ([], 'branch_protection_no_required_checks_configured').
      * HTTP 404 in stderr → (None, 'branch_protection_disabled_on_base').
      * HTTP 401/403 in stderr → (None, 'branch_protection_lookup_permission_denied').
      * Subprocess error / unrecognized failure → (None, 'branch_protection_lookup_failed').
    """
    try:
        completed = subprocess.run(
            [
                "gh", "api",
                f"repos/{{owner}}/{{repo}}/branches/{base_branch}/protection/required_status_checks",
            ],
            cwd=root, capture_output=True, text=True, check=False,
        )
    except (FileNotFoundError, OSError):
        return None, "branch_protection_lookup_failed"
    if completed.returncode != 0:
        stderr = (completed.stderr or "").lower()
        if "404" in stderr or "not protected" in stderr:
            return None, "branch_protection_disabled_on_base"
        if "401" in stderr or "403" in stderr or "forbidden" in stderr or "authentication required" in stderr:
            return None, "branch_protection_lookup_permission_denied"
        return None, "branch_protection_lookup_failed"
    try:
        body = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError:
        return None, "branch_protection_lookup_failed"
    contexts = body.get("contexts") if isinstance(body, dict) else None
    if not isinstance(contexts, list):
        return None, "branch_protection_lookup_failed"
    contexts_str = [str(c) for c in contexts if isinstance(c, str) and c.strip()]
    if not contexts_str:
        return [], "branch_protection_no_required_checks_configured"
    return contexts_str, None


def _run_success(run: dict[str, Any]) -> bool:
    status = str(run.get("status") or "").lower()
    conclusion = str(run.get("conclusion") or run.get("state") or "").lower()
    return status == "completed" and conclusion in ("success", "neutral", "skipped")


def _protected_run_success(run: dict[str, Any]) -> bool:
    status = str(run.get("status") or "").lower()
    conclusion = str(run.get("conclusion") or run.get("state") or "").lower()
    return status == "completed" and conclusion == "success"


def _run_failed(run: dict[str, Any]) -> bool:
    status = str(run.get("status") or "").lower()
    conclusion = str(run.get("conclusion") or run.get("state") or "").lower()
    return conclusion in ("failure", "failed", "timed_out", "cancelled", "action_required") or status == "failure"


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    output = []
    for item in value:
        if isinstance(item, str) and item.strip():
            output.append(item.replace("\\", "/"))
        elif isinstance(item, dict):
            path = item.get("path") or item.get("filename") or item.get("name")
            if isinstance(path, str) and path.strip():
                output.append(path.replace("\\", "/"))
    return sorted(set(output))


def _first_string(payload: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _hash_text(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _hash_json(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def record_ci_source_attestation(
    *,
    label: str,
    payload: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """F5-g (ORPHAN-694) — the ``ci_source`` surface's first production writer.

    The surface was declared and consumed (readiness bindings cite its
    rows) but only tests ever wrote it. Claim-time attestations — e.g.
    "the waiver ledger was swept at assembly and held N expired-open
    rows" — need a resolvable row; this is that writer. ``payload`` is
    hashed into the row so the attested content is tamper-evident.
    """
    import hashlib as _hashlib

    if not isinstance(label, str) or not label.strip():
        raise GovernanceError("ci_source_label_required")
    root = ensure_tools_dir(base_dir)
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_id": f"source-{label}",
        "row_type": "ci_source",
        "label": label,
        "payload": payload,
        "content_hash": "sha256:" + _hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    }
    return append_declared_jsonl(
        root / "ci" / "source.jsonl", row, expected_surface="ci_source",
    )
