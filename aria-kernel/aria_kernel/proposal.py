from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


PROPOSAL_KINDS = ("test_gap", "architecture", "security_hardening", "performance", "self_change")

# ORPHAN-CRITICAL-728 — who granted the approval, as a first-class column.
#
# `approve_proposal` took a free string and wrote it into
# `operator_approval_ref`, and the convergence lane put a machine-minted
# `aria:plan-converged:<plan_id>:<hash>` value into that same field. Every
# reader that asked "is this approved" then saw one population: the CLI's PR
# lifecycle, the worktree lane, `prepare_branch` and `commit_prepared_branch`
# could not tell an operator's decision from the kernel's own. Splitting the
# WRITER (approve_proposal vs record_machine_approval) and recording the
# source is what makes "a human agreed" a question the ledger can answer.
APPROVAL_SOURCES = ("operator", "machine")

# The reserved prefix a MACHINE approval ref carries. Defined here, beside
# the column it is written into, so `approve_proposal` can refuse an operator
# ref that impersonates one; `apply_engine` re-exports the same object rather
# than keeping a second copy.
PLAN_CONVERGED_APPROVAL_PREFIX = "aria:plan-converged:"


def plan_converged_approval_ref(*, plan_id: str, converged_content_hash: str) -> str:
    """Render the machine approval ref for a CONVERGED plan.

    The ONE renderer. ``record_machine_approval`` writes through it and
    ``apply_engine`` re-exports it, so the grammar the audit pin parses is
    the grammar the writer produced.
    """
    return f"{PLAN_CONVERGED_APPROVAL_PREFIX}{plan_id}:{converged_content_hash}"


def record_proposal(
    *,
    kind: str,
    title: str,
    problem: str,
    evidence: list[str],
    validation_command: str,
    validation_commands: list[str] | None = None,
    source_authority: str = "manual",
    risk_class: str = "unknown",
    task_id: str | None = None,
    proposed_change: str | None = None,
    status: str = "open",
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if kind not in PROPOSAL_KINDS:
        raise GovernanceError(f"unknown proposal kind: {kind}")
    if not title.strip() or not problem.strip() or not validation_command.strip():
        raise GovernanceError("proposal title, problem and validation command are required")
    if not evidence or not all(isinstance(item, str) and item.strip() for item in evidence):
        raise GovernanceError("proposal evidence must contain at least one repo evidence path")
    if validation_commands is not None and (
        not validation_commands or not all(isinstance(item, str) and item.strip() for item in validation_commands)
    ):
        raise GovernanceError("proposal validation_commands must be non-empty strings when provided")
    row = {
        "schema_version": 1,
        "proposal_id": f"proposal-{uuid.uuid4()}",
        "recorded_at": utc_now(),
        "kind": kind,
        "title": title,
        "problem": problem,
        "evidence": evidence,
        "validation_command": validation_command,
        "source_authority": source_authority,
        "risk_class": risk_class,
        "task_id": task_id,
        "proposed_change": proposed_change or title,
        "validation_scope": {"commands": validation_commands or [validation_command]},
        "blocked_by": _blocked_by(source_authority, status),
        "status": status,
    }
    append_declared_jsonl(
        ensure_tools_dir(base_dir) / "proposals" / "proposals.jsonl",
        row,
        expected_surface="proposals",
    )
    return row


def list_proposals(*, base_dir: str | Path | None = None, kind: str | None = None) -> list[dict[str, Any]]:
    rows = load_declared_jsonl(
        ensure_tools_dir(base_dir) / "proposals" / "proposals.jsonl",
        expected_surface="proposals",
    )
    if kind is not None:
        rows = [row for row in rows if row.get("kind") == kind]
    return rows


def get_proposal(*, proposal_id: str, base_dir: str | Path | None = None) -> dict[str, Any]:
    for row in reversed(
        load_declared_jsonl(
            ensure_tools_dir(base_dir) / "proposals" / "proposals.jsonl",
            expected_surface="proposals",
        ),
    ):
        if row.get("proposal_id") == proposal_id:
            return row
    raise GovernanceError(f"proposal not found: {proposal_id}")


def approve_proposal(
    *,
    proposal_id: str,
    operator_approval_ref: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """An OPERATOR approved this proposal. Machines use record_machine_approval.

    ORPHAN-CRITICAL-728 — refuses a ref carrying the reserved machine prefix.
    Without that the split would be advisory: any caller could keep writing a
    machine ref through the operator writer and every `approval_source ==
    "operator"` reader would believe it.
    """
    if not operator_approval_ref.strip():
        raise GovernanceError("operator approval ref is required")
    if operator_approval_ref.startswith(PLAN_CONVERGED_APPROVAL_PREFIX):
        raise GovernanceError(
            f"operator_approval_ref_uses_reserved_machine_prefix: "
            f"{PLAN_CONVERGED_APPROVAL_PREFIX!r} names a convergence-granted "
            f"approval; record it through record_machine_approval so the row "
            f"carries approval_source='machine'"
        )
    return _write_approval(
        proposal_id=proposal_id,
        approval_source="operator",
        operator_approval_ref=operator_approval_ref,
        machine_approval_ref=None,
        base_dir=base_dir,
    )


def record_machine_approval(
    *,
    proposal_id: str,
    plan_id: str,
    content_hash: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """The convergence gate — not an operator — approved this proposal.

    ORPHAN-CRITICAL-728. The ref names the plan AND the exact body that
    converged, and it lands in ``machine_approval_ref`` with
    ``approval_source="machine"``; ``operator_approval_ref`` stays None,
    because no operator did anything. ``apply_engine.
    verify_plan_converged_approval`` is what makes the ref falsifiable, and
    ``pr_manager.open_pr_for_action`` refuses a machine approval that does
    not survive it.

    Scope: PR-OPEN only. No reader treats this as merge authority, and
    ``ACTION_PERMISSIONS['pr_merge']`` is unchanged.
    """
    if not isinstance(plan_id, str) or not plan_id.strip():
        raise GovernanceError("machine approval requires a plan_id")
    if not isinstance(content_hash, str) or not content_hash.startswith("sha256:"):
        raise GovernanceError(
            "machine approval requires the sha256 content_hash of the body "
            "that converged"
        )
    return _write_approval(
        proposal_id=proposal_id,
        approval_source="machine",
        operator_approval_ref=None,
        machine_approval_ref=plan_converged_approval_ref(
            plan_id=plan_id, converged_content_hash=content_hash,
        ),
        base_dir=base_dir,
    )


def _write_approval(
    *,
    proposal_id: str,
    approval_source: str,
    operator_approval_ref: str | None,
    machine_approval_ref: str | None,
    base_dir: str | Path | None,
) -> dict[str, Any]:
    previous = get_proposal(proposal_id=proposal_id, base_dir=base_dir)
    row = dict(previous)
    row["recorded_at"] = utc_now()
    row["status"] = "approved_for_apply"
    row["approval_source"] = approval_source
    row["operator_approval_ref"] = operator_approval_ref
    row["machine_approval_ref"] = machine_approval_ref
    row["blocked_by"] = []
    append_declared_jsonl(
        ensure_tools_dir(base_dir) / "proposals" / "proposals.jsonl",
        row,
        expected_surface="proposals",
    )
    return row


def approval_source_of(proposal: dict[str, Any]) -> str | None:
    """Who granted this proposal's approval: 'operator', 'machine', or None.

    The ONE reader of that question. Rows written before the column existed
    are classified from the ref they carry, and the classification is
    deliberately asymmetric: a ref bearing the reserved machine prefix is
    MACHINE whichever column it sits in, because the failure that matters is
    a machine approval being read as a human's. Only a ref that cannot be a
    machine ref is read as an operator's.
    """
    declared = proposal.get("approval_source")
    if declared in APPROVAL_SOURCES:
        return declared
    for key in ("machine_approval_ref", "operator_approval_ref"):
        ref = proposal.get(key)
        if isinstance(ref, str) and ref.startswith(PLAN_CONVERGED_APPROVAL_PREFIX):
            return "machine"
    ref = proposal.get("operator_approval_ref")
    if isinstance(ref, str) and ref.strip():
        return "operator"
    return None


def require_operator_approval(proposal: dict[str, Any], *, action: str) -> None:
    """Refuse an action that means "a human agreed" on a machine approval."""
    source = approval_source_of(proposal)
    if source != "operator":
        raise GovernanceError(
            f"{action}_requires_operator_approval: proposal "
            f"{proposal.get('proposal_id')!r} carries approval_source="
            f"{source!r}; this lane acts on an operator's decision, and a "
            f"machine approval is not one"
        )


def proposal_packet_from_task(task: dict[str, Any]) -> dict[str, Any]:
    evidence_refs = task.get("evidence_refs", [])
    validation_commands = task.get("validation_commands", [])
    if not isinstance(evidence_refs, list) or not evidence_refs:
        raise GovernanceError("task has no evidence refs")
    if not isinstance(validation_commands, list) or not validation_commands:
        raise GovernanceError("task has no validation commands")
    task_id = str(task.get("task_id") or "")
    packet_id = "packet-" + hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:12]
    return {
        "schema_version": 1,
        "packet_id": packet_id,
        "task_id": task_id,
        "source_authority": task.get("source_authority"),
        "title": task.get("title"),
        "problem": task.get("problem"),
        "risk_class": task.get("risk_class"),
        "evidence_refs": [str(item) for item in evidence_refs],
        "validation_commands": [str(item) for item in validation_commands],
        "blocked_by": task.get("blocked_by", []),
    }


def record_proposal_from_amplification(
    *,
    task: dict[str, Any],
    amplification: dict[str, Any],
    kind: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    response = amplification.get("response", {})
    status = "draft_shadow" if task.get("source_authority") == "shadow_draft" else "ready_for_operator"
    return record_proposal(
        kind=kind,
        title=str(response.get("title")),
        problem=str(response.get("problem")),
        evidence=[str(item) for item in response.get("evidence_refs", [])],
        validation_command=str(response.get("validation_commands", [""])[0]),
        validation_commands=[str(item) for item in response.get("validation_commands", [])],
        source_authority=str(task.get("source_authority") or "unknown"),
        risk_class=str(task.get("risk_class") or "unknown"),
        task_id=str(task.get("task_id") or ""),
        proposed_change=str(response.get("proposed_change")),
        status=status,
        base_dir=base_dir,
    )


def _blocked_by(source_authority: str, status: str) -> list[str]:
    if status == "approved_for_apply":
        return []
    if source_authority == "shadow_draft":
        return ["operator_feedback_required", "active_finding_required"]
    if status in ("open", "ready_for_operator"):
        return ["operator_approval_required"]
    return []
