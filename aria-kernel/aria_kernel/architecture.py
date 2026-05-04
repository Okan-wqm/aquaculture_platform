from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


ARCHITECTURE_ACTIONS = (
    "fix_in_place",
    "harden_boundary",
    "introduce_abstraction",
    "incremental_refactor",
    "replace_with_adr",
    "emergency_patch",
)

REPLACEMENT_GROUNDS = (
    "eol_or_unsupported",
    "unpatched_critical_cve",
    "license_or_compliance_blocker",
    "accepted_adr_conflict",
    "recurring_production_failure",
    "target_architecture_conflict",
)

PATCH_ACTIONS = ("fix_in_place", "emergency_patch")


def review_architecture_decision(
    *,
    technology: str,
    proposed_action: str,
    evidence_refs: list[str],
    root_cause: str,
    authoritative_refs: list[str] | None = None,
    repo_prior_refs: list[str] | None = None,
    replacement_grounds: list[str] | None = None,
    migration_plan: str = "",
    rollback_plan: str = "",
    abstraction_boundary: str = "",
    validation_commands: list[str] | None = None,
    cleanup_task: str = "",
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    normalized = _normalize_input(
        technology=technology,
        proposed_action=proposed_action,
        evidence_refs=evidence_refs,
        root_cause=root_cause,
        authoritative_refs=authoritative_refs or [],
        repo_prior_refs=repo_prior_refs or [],
        replacement_grounds=replacement_grounds or [],
        validation_commands=validation_commands or [],
    )
    adoption = _adoption_gravity(normalized["evidence_refs"])
    recommended = _recommended_action(
        proposed_action=normalized["proposed_action"],
        adoption=adoption,
        replacement_grounds=normalized["replacement_grounds"],
        evidence_refs=normalized["evidence_refs"],
    )
    blockers = _blockers(
        proposed_action=normalized["proposed_action"],
        recommended_action=recommended,
        adoption=adoption,
        evidence_refs=normalized["evidence_refs"],
        authoritative_refs=normalized["authoritative_refs"],
        repo_prior_refs=normalized["repo_prior_refs"],
        replacement_grounds=normalized["replacement_grounds"],
        migration_plan=migration_plan,
        rollback_plan=rollback_plan,
        abstraction_boundary=abstraction_boundary,
        cleanup_task=cleanup_task,
    )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "review_id": _review_id(normalized["technology"], normalized["proposed_action"], normalized["evidence_refs"]),
        "technology": normalized["technology"],
        "proposed_action": normalized["proposed_action"],
        "recommended_action": recommended,
        "status": "blocked" if blockers else "ready_for_architecture_review",
        "blocked_by": blockers,
        "root_cause": normalized["root_cause"],
        "adoption": adoption,
        "evidence_refs": normalized["evidence_refs"],
        "authoritative_refs": normalized["authoritative_refs"],
        "repo_prior_refs": normalized["repo_prior_refs"],
        "replacement_grounds": normalized["replacement_grounds"],
        "migration_plan": migration_plan,
        "rollback_plan": rollback_plan,
        "abstraction_boundary": abstraction_boundary,
        "validation_commands": normalized["validation_commands"],
        "decision_principles": [
            "repo adoption is load-bearing evidence",
            "best-practice hardening precedes replacement",
            "symptom-only patching is blocked outside emergency cleanup",
        ],
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "architecture" / "reviews.jsonl", row)


def generate_architecture_options(
    *,
    technology: str,
    evidence_refs: list[str],
    root_cause: str,
    authoritative_refs: list[str] | None = None,
    repo_prior_refs: list[str] | None = None,
    replacement_grounds: list[str] | None = None,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    normalized = _normalize_input(
        technology=technology,
        proposed_action="harden_boundary",
        evidence_refs=evidence_refs,
        root_cause=root_cause,
        authoritative_refs=authoritative_refs or [],
        repo_prior_refs=repo_prior_refs or [],
        replacement_grounds=replacement_grounds or [],
        validation_commands=[],
    )
    adoption = _adoption_gravity(normalized["evidence_refs"])
    options = [
        _option("harden_boundary", "Keep the technology and correct ownership, fail-mode, timeout, metrics, and policy boundaries.", adoption),
        _option("introduce_abstraction", "Move repeated calls behind a shared contract so callers depend on repo-owned semantics.", adoption),
        _option("incremental_refactor", "Migrate callers in batches after the boundary contract is proven by tests.", adoption),
    ]
    if normalized["replacement_grounds"]:
        options.append(
            _option("replace_with_adr", "Evaluate replacement through ADR, dual-run, rollback, and migration evidence.", adoption),
        )
    recommended = _recommended_action(
        proposed_action="harden_boundary",
        adoption=adoption,
        replacement_grounds=normalized["replacement_grounds"],
        evidence_refs=normalized["evidence_refs"],
    )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "option_set_id": _review_id(normalized["technology"], "option_set", normalized["evidence_refs"]),
        "technology": normalized["technology"],
        "root_cause": normalized["root_cause"],
        "adoption": adoption,
        "recommended_action": recommended,
        "options": options,
        "evidence_refs": normalized["evidence_refs"],
        "authoritative_refs": normalized["authoritative_refs"],
        "repo_prior_refs": normalized["repo_prior_refs"],
        "replacement_grounds": normalized["replacement_grounds"],
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "architecture" / "option-sets.jsonl", row)


def list_architecture_reviews(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "architecture" / "reviews.jsonl")


def list_architecture_option_sets(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "architecture" / "option-sets.jsonl")


def _normalize_input(
    *,
    technology: str,
    proposed_action: str,
    evidence_refs: list[str],
    root_cause: str,
    authoritative_refs: list[str],
    repo_prior_refs: list[str],
    replacement_grounds: list[str],
    validation_commands: list[str],
) -> dict[str, Any]:
    if proposed_action not in ARCHITECTURE_ACTIONS:
        raise GovernanceError(f"unknown architecture action: {proposed_action}")
    if not technology.strip():
        raise GovernanceError("architecture review requires technology")
    if not root_cause.strip():
        raise GovernanceError("architecture review requires root_cause")
    if not evidence_refs or not all(isinstance(item, str) and item.strip() for item in evidence_refs):
        raise GovernanceError("architecture review requires non-empty evidence_refs")
    unknown_grounds = [ground for ground in replacement_grounds if ground not in REPLACEMENT_GROUNDS]
    if unknown_grounds:
        raise GovernanceError("unknown replacement grounds: " + ", ".join(unknown_grounds))
    return {
        "technology": technology.strip(),
        "proposed_action": proposed_action,
        "root_cause": root_cause.strip(),
        "evidence_refs": _dedupe(evidence_refs),
        "authoritative_refs": _dedupe(authoritative_refs),
        "repo_prior_refs": _dedupe(repo_prior_refs),
        "replacement_grounds": _dedupe(replacement_grounds),
        "validation_commands": _dedupe(validation_commands),
    }


def _adoption_gravity(evidence_refs: list[str]) -> dict[str, Any]:
    projects = sorted({_project_key(ref) for ref in evidence_refs if _project_key(ref)})
    usage_count = len(evidence_refs)
    if usage_count >= 5 or len(projects) >= 4:
        level = "high"
    elif usage_count >= 3 or len(projects) >= 2:
        level = "medium"
    else:
        level = "low"
    return {
        "level": level,
        "usage_ref_count": usage_count,
        "project_count": len(projects),
        "projects": projects,
    }


def _recommended_action(
    *,
    proposed_action: str,
    adoption: dict[str, Any],
    replacement_grounds: list[str],
    evidence_refs: list[str],
) -> str:
    if replacement_grounds and adoption["level"] == "low":
        return "replace_with_adr"
    if adoption["level"] == "high":
        return "introduce_abstraction"
    if len(evidence_refs) >= 3:
        return "harden_boundary"
    if proposed_action == "emergency_patch":
        return "emergency_patch"
    return "fix_in_place"


def _blockers(
    *,
    proposed_action: str,
    recommended_action: str,
    adoption: dict[str, Any],
    evidence_refs: list[str],
    authoritative_refs: list[str],
    repo_prior_refs: list[str],
    replacement_grounds: list[str],
    migration_plan: str,
    rollback_plan: str,
    abstraction_boundary: str,
    cleanup_task: str,
) -> list[str]:
    blockers: list[str] = []
    if not authoritative_refs and not repo_prior_refs:
        blockers.append("architecture_evidence_incomplete")
    if proposed_action == "replace_with_adr":
        if not replacement_grounds:
            blockers.append("replacement_requires_hard_evidence")
        if adoption["level"] in ("medium", "high"):
            if not migration_plan.strip():
                blockers.append("replacement_requires_migration_plan")
            if not rollback_plan.strip():
                blockers.append("replacement_requires_rollback_plan")
        if adoption["level"] == "high" and recommended_action != "replace_with_adr":
            blockers.append("adoption_aware_replacement_blocked")
    if proposed_action in ("harden_boundary", "introduce_abstraction", "incremental_refactor") and not abstraction_boundary.strip():
        blockers.append("architecture_boundary_required")
    if proposed_action == "fix_in_place" and (adoption["level"] != "low" or len(evidence_refs) >= 3):
        blockers.append("architecture_incomplete")
    if proposed_action == "emergency_patch" and not cleanup_task.strip():
        blockers.append("emergency_cleanup_required")
    return sorted(set(blockers))


def _option(action: str, tradeoff: str, adoption: dict[str, Any]) -> dict[str, Any]:
    return {
        "action": action,
        "tradeoff": tradeoff,
        "requires_adr": action == "replace_with_adr",
        "safe_for_high_adoption": action != "replace_with_adr" or adoption["level"] == "low",
    }


def _project_key(path: str) -> str | None:
    parts = path.replace("\\", "/").lstrip("./").split("/")
    if len(parts) >= 2 and parts[0] in ("apps", "libs", "web"):
        return "/".join(parts[:2])
    if len(parts) >= 3 and parts[0] == "platform" and parts[1] == "libs":
        return "/".join(parts[:3])
    return None


def _dedupe(items: list[str]) -> list[str]:
    return sorted({str(item).strip() for item in items if isinstance(item, str) and item.strip()})


def _review_id(technology: str, action: str, evidence_refs: list[str]) -> str:
    digest = hashlib.sha256(f"{technology}:{action}:{'|'.join(sorted(evidence_refs))}".encode("utf-8")).hexdigest()[:12]
    return f"arch-{digest}"
