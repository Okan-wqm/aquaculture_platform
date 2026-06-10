"""Canonical implementation rejection classes."""
from __future__ import annotations


V9_MERGE_PATH_DISABLED = "v9_merge_path_disabled_use_merge_if_green"

IMPLEMENTATION_REJECTION_CLASSES: frozenset[str] = frozenset({
    "no_claim_timeout",
    "in_flight_abandoned",
    "ci_check_timeout",
    "ci_check_red",
    "merge_policy_violation",
    "branch_tip_drift",
    "content_hash_mismatch",
    "secret_leak_detected",
    "kernel_self_modification_attempted",
    "bash_command_denylist_hit",
    "path_escape_outside_workspace",
    "file_lock_conflict",
    "validation_failed",
    "forbidden_scope_violation",
    "plan_evidence_stale",
    "branch_collision",
    "prompt_injection_detected",
    "dependency_pinning_unsafe",
    "implementer_turn_budget_exhausted",
    "cycle_budget_exhausted",
    "gh_api_scope_violation",
    "autonomous_profile_preconditions_not_met",
    "orchestrator_restart_reaped_orphan",
    "commit_signature_unverified",
    V9_MERGE_PATH_DISABLED,
})


__all__ = [
    "IMPLEMENTATION_REJECTION_CLASSES",
    "V9_MERGE_PATH_DISABLED",
]
