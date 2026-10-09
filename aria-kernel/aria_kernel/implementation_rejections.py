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

from dataclasses import dataclass
from typing import Any


# ARIA-HIGH-388 — the classes an executor-side terminal outcome settles with
# (``settlement_for_*`` below, written by ``implementation_settlement``).
IMPLEMENTER_REFUSED = "implementer_refused"
IMPLEMENTATION_RESULT_INADMISSIBLE = "implementation_result_inadmissible"
IMPLEMENTATION_DELIVERY_UNCLASSIFIED = "implementation_delivery_unclassified"
IMPLEMENTATION_REQUEST_INVALID = "implementation_request_invalid"
PUSH_REFUSED = "push_refused"
PR_OPEN_REFUSED = "pr_open_refused"
# ARIA-HIGH-389 — a result refused AFTER its delivery opened the PR.
IMPLEMENTATION_RESULT_REFUSED_AFTER_DELIVERY = "implementation_result_refused_after_delivery"


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
        IMPLEMENTATION_RESULT_INADMISSIBLE,
        IMPLEMENTATION_DELIVERY_UNCLASSIFIED,
        IMPLEMENTATION_REQUEST_INVALID,
        PUSH_REFUSED,
        PR_OPEN_REFUSED,
        # ARIA-HIGH-389 — the submit refused a result whose PR is already open.
        IMPLEMENTATION_RESULT_REFUSED_AFTER_DELIVERY,
    }
)


# V9 auto-merge "merge path disabled" rejection class. Stamped onto a
# V9MergeDecision by auto_merge_runners when the V9 merge path is disabled in
# favour of merge_if_green. Deliberately OUTSIDE
# VALID_IMPLEMENTATION_REJECTION_CLASSES: it is emitted only on the auto-merge
# decision path and is never validated by record_implementation_outcome.
V9_MERGE_PATH_DISABLED_REJECTION_CLASS: str = "v9_merge_path_disabled_use_merge_if_green"


# ===========================================================================
# ARIA-HIGH-388 — how an implementation request's terminal outcome is SETTLED
# ===========================================================================
#
# A settlement says what ended the plan and WHOSE fault it was, and the fault
# domain decides two things downstream: whether the finding's subject cools
# off (`outage_attribution.failure_is_lane_fault`: only a `request` fault does)
# and, through the class, whether the implementer is blamed
# (`failure_attribution.APPLY_GATE_REJECTION_CLASSES`).
#
# The domain is `request` ONLY where the kernel can VERIFY the cause is the
# work's: a reason the kernel itself produced from the agent's output. A
# delivery stage is not enough (adversarial review of cd2166bb4): the same
# `branch_publication` stage refuses an agent that committed nothing AND a
# host with no git identity, and `apply_gate` refuses a red suite AND a
# kernel GovernanceError. Everything the kernel cannot verify is
# `unclassified`: it ends the plan, cools nothing off and blames no one. An
# agent's own refusal is never verifiable (it is the agent's word; on
# 2026-10-08 `agent_refused:safety` was the host's missing commit identity).

FAULT_REQUEST = "request"
FAULT_HARNESS = "harness"
FAULT_UNCLASSIFIED = "unclassified"
AGENT_REFUSAL_STAGE = "agent_refusal"
PRE_SPAWN_STAGE = "pre_spawn"
ORPHAN_REAP_STAGE = "orphan_reap"
ORPHAN_REAPED = "orchestrator_restart_reaped_orphan"
POST_DELIVERY_STAGE = "post_delivery"
# Gate blockers that PROVE the agent's change is at fault: a regression
# against the baseline the same suite measured (`validation.
# compare_validation_groups`), and a suppression pattern in the agent's own
# diff (`apply_engine`). `candidate_validation_not_green` alone proves
# nothing (re-review N1): it is set whenever the candidate run is not ok,
# including when the baseline was red too (a red main, a missing toolchain).
# It may accompany a proving blocker; on its own the gate is unclassified.
# `validation_room_unobserved` is the host's.
AGENT_PROVING_GATE_BLOCKERS: frozenset[str] = frozenset({"validation_regression", "suppression_pattern"})
AGENT_GATE_BLOCKERS: frozenset[str] = AGENT_PROVING_GATE_BLOCKERS | frozenset({"candidate_validation_not_green"})


@dataclass(frozen=True)
class ImplementationSettlement:
    """The typed facts a settled ``implementation_rejected`` event carries."""

    rejection_class: str
    fault_domain: str
    stage: str
    cause: str
    request_id: str = ""
    # ARIA-HIGH-389 — the PR the kernel's delivery opened before the result
    # was refused; absent (and absent from the payload, so every earlier
    # settlement keeps its shape and idempotency key) when nothing was opened.
    pr_number: int | None = None

    def payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"stage": self.stage, "fault_domain": self.fault_domain, "cause": self.cause,
                                   "request_id": self.request_id}
        if self.pr_number is not None:
            payload["pr_number"] = self.pr_number
        return payload


def _cause(reason: str) -> str:
    return reason.split(":", 1)[0].strip()[:64]


def _gate_blockers_are_the_agents(reason: str) -> bool:
    items = {item for item in reason.split(":", 1)[1].split(",") if item}
    return items <= AGENT_GATE_BLOCKERS and bool(items & AGENT_PROVING_GATE_BLOCKERS)


def _result_codes_are_the_agents(reason: str) -> bool:
    from .failure_attribution import attributable_rejection_code

    codes = [code for code in reason.split(":", 2)[1].split(",") if code]
    return bool(codes) and all(attributable_rejection_code(code) for code in codes)


# (stage, reason prefix, class, domain, verifier) — the delivery causes the
# kernel can attribute; the first match wins, no match is unclassified.
_VERIFIED_DELIVERY_CAUSES: tuple[tuple[str, str, str, str, object], ...] = (
    ("change_ledger", "change_committed_refused:scope_drift_requires_human",
     "forbidden_scope_violation", FAULT_REQUEST, None),
    ("result_admissible", "diff_secret_shaped:", "secret_leak_detected", FAULT_REQUEST, None),
    ("result_admissible", "result_rejected:", IMPLEMENTATION_RESULT_INADMISSIBLE, FAULT_REQUEST,
     _result_codes_are_the_agents),
    ("apply_gate", "gate_blocked:", "validation_failed", FAULT_REQUEST, _gate_blockers_are_the_agents),
    ("push", "push_failed:", PUSH_REFUSED, FAULT_HARNESS, None),
    ("pr_open", "pr_open_refused:", PR_OPEN_REFUSED, FAULT_HARNESS, None),
)


def settlement_for_delivery(*, stage: str, reason: str, request_id: str) -> ImplementationSettlement:
    """The settlement of a delivery the kernel refused at ``stage`` for ``reason``."""
    for rule_stage, prefix, rejection_class, domain, verifier in _VERIFIED_DELIVERY_CAUSES:
        if stage == rule_stage and reason.startswith(prefix) and (verifier is None or verifier(reason)):
            return ImplementationSettlement(rejection_class, domain, stage, _cause(reason), request_id)
    return ImplementationSettlement(IMPLEMENTATION_DELIVERY_UNCLASSIFIED, FAULT_UNCLASSIFIED, stage,
                                    _cause(reason), request_id)


def settlement_for_agent_refusal(*, reason_class: str, request_id: str) -> ImplementationSettlement:
    """An agent's refusal: the agent's word, never verifiable, so unclassified."""
    return ImplementationSettlement(IMPLEMENTER_REFUSED, FAULT_UNCLASSIFIED, AGENT_REFUSAL_STAGE,
                                    _cause(reason_class), request_id)


# The executor's pre-spawn refusals that end a request for good (released
# request-class, escalated): a published branch a retry would collide with
# (whose cause the kernel cannot tell), and a request row whose own
# implementation ids are unusable (the kernel's mint).
PRE_SPAWN_SETTLEMENT: dict[str, tuple[str, str]] = {
    "implementation_branch_collision": ("branch_collision", FAULT_UNCLASSIFIED),
    "implementation_request_invalid": (IMPLEMENTATION_REQUEST_INVALID, FAULT_HARNESS),
}


def settlement_for_pre_spawn(*, release_reason: str, request_id: str) -> ImplementationSettlement:
    rejection_class, domain = PRE_SPAWN_SETTLEMENT[release_reason]
    return ImplementationSettlement(rejection_class, domain, PRE_SPAWN_STAGE, release_reason, request_id)


def settlement_for_orphan(*, request_id: str, wait_cause: str, waiting: bool) -> ImplementationSettlement:
    """The orphan reaper's settlement (ARIA-HIGH-388): a plan whose implementation
    request produced no outcome inside the reap bound.

    No agent answer was judged, so it is never a `request` fault: `harness`
    when the request was still waiting for the lane (never claimed, or last
    released harness-class: an outage, a missing delivery authority, a
    window), `unclassified` otherwise (claimed and lost, or escalated by a
    writer that predates the settlement). Neither cools the finding off.
    """
    return ImplementationSettlement(ORPHAN_REAPED, FAULT_HARNESS if waiting else FAULT_UNCLASSIFIED,
                                    ORPHAN_REAP_STAGE, _cause(wait_cause), request_id)


# ARIA-HIGH-389 — the executor's refusals AFTER a successful delivery (the
# branch pushed, the PR open), by the cause the executor names. None of them
# is the work's: the delivery already ran the submit's own admissibility
# decision on this envelope (`implementation_delivery`, round 5) and the apply
# gate passed. The submit's bound, its probes, its lease or transport and the
# native reconcile are the lane's (`harness`); the kernel refusing what it
# admitted minutes earlier, or the executor's pre-submit check failing on
# facts the kernel stamped, is a disagreement it cannot attribute
# (`unclassified`). An unknown cause is `unclassified`.
POST_DELIVERY_FAULT_DOMAINS: dict[str, str] = {
    "submit_timeout": FAULT_HARNESS,
    "evidence_verification_unavailable": FAULT_HARNESS,
    "submit_rejected": FAULT_HARNESS,
    "agent_result_rejected": FAULT_UNCLASSIFIED,
    "pre_submit_invalid": FAULT_UNCLASSIFIED,
    "native_result_unreconciled": FAULT_UNCLASSIFIED,
}


def settlement_for_post_delivery(*, request_id: str, cause: str, pr_number: int) -> ImplementationSettlement:
    """A result refused after its PR was opened: the plan ends, carrying the PR
    (``human_merge_surface`` hands it to a person by that number)."""
    return ImplementationSettlement(IMPLEMENTATION_RESULT_REFUSED_AFTER_DELIVERY,
                                    POST_DELIVERY_FAULT_DOMAINS.get(cause, FAULT_UNCLASSIFIED),
                                    POST_DELIVERY_STAGE, _cause(cause), request_id, pr_number)


# ARIA-HIGH-390 — the classes that end a plan after its PR existed: a person
# may still merge that PR, and the plan ledger then records the merge
# (`merge_record`, `plan_convergence._record_implementation_merged`). Every
# other rejection ended the plan before anything was published to merge.
MERGEABLE_AFTER_REJECTION: frozenset[str] = frozenset({
    IMPLEMENTATION_RESULT_REFUSED_AFTER_DELIVERY,
    ORPHAN_REAPED,
})
