"""Single source of truth for the ARIA implementation-rejection class taxonomy.

WHY: the closed set of ``rejection_class`` values an ``implementation_rejected``
row may carry used to be duplicated — an inline ``frozenset`` inside
``plan_convergence.record_implementation_outcome`` (the validator) PLUS a
hardcoded string literal inside ``auto_merge_runners`` (the V9 merge-path-disabled
decision emitter). Two independent copies of a security-relevant audit taxonomy
drift apart over time. This module is the DRY single source of truth so the
validator and every emitter agree by import, not by copy — CLAUDE.md tier-1
"make drift impossible".

WHAT: ``VALID_IMPLEMENTATION_REJECTION_CLASSES`` is the closed set that
``plan_convergence.record_implementation_outcome`` validates an
``implementation_rejected`` payload's ``rejection_class`` against.
``V9_MERGE_PATH_DISABLED_REJECTION_CLASS`` is the rejection class the V9
auto-merge runner stamps onto a ``V9MergeDecision``; it is INTENTIONALLY NOT a
member of the validation set — it is emitted only on the auto-merge decision
path and never flows through ``record_implementation_outcome`` validation.
"""

from __future__ import annotations


# ARIA-HIGH-388 — the classes an executor-side terminal outcome settles with
# (see ``DELIVERY_STAGE_SETTLEMENT`` below and ``implementation_settlement``).
IMPLEMENTER_REFUSED = "implementer_refused"
IMPLEMENTATION_UNPUBLISHED = "implementation_unpublished"
IMPLEMENTATION_RESULT_INADMISSIBLE = "implementation_result_inadmissible"
PR_PERIMETER_REFUSED = "pr_perimeter_refused"
PUSH_REFUSED = "push_refused"
PR_OPEN_REFUSED = "pr_open_refused"


# Closed set of rejection classes accepted by
# plan_convergence.record_implementation_outcome for IMPLEMENTATION_REJECTED rows.
# The inline descriptions record WHERE each class is raised (provenance relocated
# here from plan_convergence so the taxonomy + its rationale live in one place).
VALID_IMPLEMENTATION_REJECTION_CLASSES: frozenset[str] = frozenset(
    {
        "no_claim_timeout",  # poll deadline in REQUESTED state
        "in_flight_abandoned",  # poll deadline in IN_FLIGHT state
        "ci_check_timeout",  # auto-merge poll deadline
        "ci_check_red",  # any required check NOT SUCCESS
        "merge_policy_violation",  # evaluate_auto_merge ineligible
        "branch_tip_drift",  # headRefOid != recorded branch_tip_sha
        "content_hash_mismatch",  # content_hash drift between mint + outcome
        "secret_leak_detected",  # verify_no_secret_in_diff fired
        "kernel_self_modification_attempted",  # envelope-mint refusal
        "bash_command_denylist_hit",  # V9.0-D ALLOWED_BASH_COMMANDS miss
        "path_escape_outside_workspace",  # V9.0-D verify_no_path_escape fired
        "file_lock_conflict",  # V9.5 check 11 — per_file_mutual_exclusion
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
        # Plan ARIA-V3.1-B3 — orphan reaper rejection class. The orchestrator
        # startup hook transitions a plan stuck in IMPLEMENTATION_REQUESTED or
        # IMPLEMENTATION_IN_FLIGHT to IMPLEMENTATION_REJECTED with this class so
        # the audit trail distinguishes crash-recovery reaping from real
        # implementation failures (closes H-12).
        "orchestrator_restart_reaped_orphan",
        # Plan ARIA-V3.1-B-5 — commit signature verify mismatch raised by
        # plan_convergence_bridge._dispatch_implementation BEFORE
        # record_implementation_outcome would accept the row. The IMPL row never
        # lands; if the agent's claim was IMPLEMENTATION_IN_FLIGHT, the
        # orchestrator can reap with this canonical class.
        "commit_signature_unverified",
        # ARIA-HIGH-388 — the executor's own terminal outcomes of an
        # implementation request, settled onto the plan ledger
        # (`implementation_settlement`) instead of living only in governance
        # and HUMAN_REQUIRED rows that no learning consumer reads.
        IMPLEMENTER_REFUSED,
        IMPLEMENTATION_UNPUBLISHED,
        IMPLEMENTATION_RESULT_INADMISSIBLE,
        PR_PERIMETER_REFUSED,
        PUSH_REFUSED,
        PR_OPEN_REFUSED,
    }
)


# ARIA-HIGH-388 — where a delivery refusal is SETTLED: each request-class
# stage of ``implementation_delivery.DELIVERY_STAGES`` maps to the rejection
# class its plan is closed with and the fault domain that class carries
# (``release_reason.FAULT_DOMAINS``). ``request`` means the work (the agent's
# commit, its result, the gate its change failed) and may cool the finding's
# subject off; ``harness`` means the lane (GitHub refused a push or a PR,
# the kernel's commit identity) and never does
# (``outage_attribution.failure_is_lane_fault``). Whether the IMPLEMENTER is
# blamed is ``failure_attribution.APPLY_GATE_REJECTION_CLASSES``'s decision,
# not this table's. The host stages (``admission``, ``credential``) are
# absent on purpose: they are released harness-class and retried, never
# settled (`implementation_delivery.HOST_STAGES`).
DELIVERY_STAGE_SETTLEMENT: dict[str, tuple[str, str]] = {
    "branch_publication": (IMPLEMENTATION_UNPUBLISHED, "request"),
    "commit_identity": ("commit_signature_unverified", "harness"),
    # The scope verdict on the agent's commit (`change_committed_refused`);
    # a diff git cannot produce is rarer and is not told apart here.
    "change_ledger": ("forbidden_scope_violation", "request"),
    "result_admissible": (IMPLEMENTATION_RESULT_INADMISSIBLE, "request"),
    "apply_gate": ("validation_failed", "request"),
    "change_validated": ("validation_failed", "request"),
    "pre_pr_open": (PR_PERIMETER_REFUSED, "request"),
    "push": (PUSH_REFUSED, "harness"),
    "pr_open": (PR_OPEN_REFUSED, "harness"),
}


# V9 auto-merge "merge path disabled" rejection class. Stamped onto a
# V9MergeDecision by auto_merge_runners when the V9 merge path is disabled in
# favour of merge_if_green. Deliberately OUTSIDE
# VALID_IMPLEMENTATION_REJECTION_CLASSES: it is emitted only on the auto-merge
# decision path and is never validated by record_implementation_outcome.
V9_MERGE_PATH_DISABLED_REJECTION_CLASS: str = "v9_merge_path_disabled_use_merge_if_green"
