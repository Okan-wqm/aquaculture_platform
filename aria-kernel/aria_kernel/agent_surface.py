"""Single source of truth for ARIA agent roles and lifecycle labels.

The runtime has several consumers that need the same closed sets:
strict request validation, invocation queue writes, bridge replay,
dispatcher polling, and lifecycle reducers.  Keeping those sets here
prevents the common failure mode where a new role is added to one
surface but remains unreachable or unbridged elsewhere.
"""
from __future__ import annotations

from typing import FrozenSet


REQUEST_ROLES: tuple[str, ...] = (
    "primary_plan",
    "challenger_plan",
    "cross_review",
    # Coverage-waiver adjudicator (plan-coverage gate PR-2). Deliberately
    # NOT in PLANNER_BRIDGE_ROLES: its result is annotation-only — the
    # drainer reads it from the invocation results ledger and folds the
    # verdict into the coverage_computed payload; no plan-state mutation
    # happens on submit.
    "completeness_critique",
    "implementation",
    "implementation_review",
    "verification",
    "gap_finding",
    "gap_closure",
    "maintenance_utility",
    "primary_authoring",
    "challenger_authoring",
    "evidence_judgment",
    "adversarial_judgment",
    "consensus_arbitration",
    "change_intelligence",
    "goldset_curation",
    "architectural_arbitration",
    "auth_security_review",
    "access_boundary_review",
    "tenant_isolation_review",
    # ORPHAN-HIGH-426 — independent adjudication of a HUMAN_REQUIRED
    # escalation. Paired with THREE distinct judge agents below so a panel
    # is composed of distinct principals by construction rather than by
    # hope; the fold still verifies disjointness against the claims ledger.
    "human_required_adjudication",
)

INVOCATION_ROLES: FrozenSet[str] = frozenset({
    *REQUEST_ROLES,
    "specialist_domain_review",
})

DISPATCHABLE_ROLES: FrozenSet[str] = frozenset({
    "specialist_domain_review",
    "primary_authoring",
    "challenger_authoring",
    "evidence_judgment",
    "adversarial_judgment",
    "primary_plan",
    "challenger_plan",
    "cross_review",
    "completeness_critique",
    "implementation",
    "human_required_adjudication",
})

DRAFTER_ROLES: FrozenSet[str] = frozenset({
    "primary_authoring",
    "challenger_authoring",
})

JUDGE_ROLES: tuple[str, ...] = (
    "evidence_judgment",
    "adversarial_judgment",
    "consensus_arbitration",
)

SUPPORTING_ROLES: tuple[str, ...] = (
    "change_intelligence",
    "goldset_curation",
)

PLANNER_BRIDGE_ROLES: FrozenSet[str] = frozenset({
    "primary_plan",
    "challenger_plan",
    "cross_review",
    "implementation",
})

BRIDGE_REQUIRED_ROLES: FrozenSet[str] = frozenset({
    *JUDGE_ROLES,
    *SUPPORTING_ROLES,
    *PLANNER_BRIDGE_ROLES,
})

DEFAULT_TARGET_AGENT_WHITELIST: tuple[str, ...] = (
    "aria-prompt-writer",
    "aria-primary-planner",
    "aria-challenger-planner",
    "aria-completeness-critic",
    "aria-primary-drafter",
    "aria-challenger-drafter",
    "aria-implementer",
    "aria-evidence-judge",
    "aria-adversarial-judge",
    "aria-consensus-arbiter",
    "aria-change-intelligence",
    "aria-goldset-curator",
    "aria-autonomy-planner",
    "aria-worker",
    "architectural-arbiter",
    "auth-security-expert",
    "access-boundary-auditor",
    "tenant-isolation-auditor",
)

ROLE_TARGET_PAIRING: dict[str, tuple[str, ...]] = {
    "primary_authoring": ("aria-primary-drafter",),
    "challenger_authoring": ("aria-challenger-drafter",),
    "completeness_critique": ("aria-completeness-critic",),
    "implementation": ("aria-implementer",),
    "evidence_judgment": ("aria-evidence-judge",),
    "adversarial_judgment": ("aria-adversarial-judge",),
    "consensus_arbitration": ("aria-consensus-arbiter",),
    # Three read-only judges. The panel mints one envelope per target, so
    # a three-member panel cannot be one agent wearing three hats.
    "human_required_adjudication": (
        "aria-evidence-judge",
        "aria-adversarial-judge",
        "aria-consensus-arbiter",
    ),
    "change_intelligence": ("aria-change-intelligence",),
    "goldset_curation": ("aria-goldset-curator",),
    "architectural_arbitration": ("architectural-arbiter",),
    "auth_security_review": ("auth-security-expert",),
    "access_boundary_review": ("access-boundary-auditor",),
    "tenant_isolation_review": ("tenant-isolation-auditor",),
}

DERIVED_REQUEST_STATES: tuple[str, ...] = (
    "PENDING",
    "CLAIMED",
    "RUNNING",
    "SUBMITTED",
    "ACCEPTED",
    "REJECTED",
    "STALE",
    "REQUEUED",
    "HUMAN_REQUIRED",
    "CANCELLED",
    "ACCEPTED_PENDING_BRIDGE",
    "ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL",
    "EXTERNAL_OUTAGE",
)

TERMINAL_REQUEST_STATES: FrozenSet[str] = frozenset({
    "ACCEPTED",
    "REJECTED",
    "STALE",
    "CANCELLED",
    "HUMAN_REQUIRED",
    "ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL",
})

GENESIS_LIFECYCLE_STATES: tuple[str, ...] = (
    "PRESSURE",
    "CANDIDATE_PROPOSED",
    "HUMAN_REQUIRED",
    "REQUEST",
    "DRAFT",
    "REAL_SANDBOX",
    "SHADOW",
    "EVAL_WINDOW",
    "ACTIVE",
)


def role_requires_bridge(role: str | None) -> bool:
    return role in BRIDGE_REQUIRED_ROLES


def allowed_targets_for_role(role: str) -> tuple[str, ...] | None:
    return ROLE_TARGET_PAIRING.get(role)


__all__ = [
    "BRIDGE_REQUIRED_ROLES",
    "DEFAULT_TARGET_AGENT_WHITELIST",
    "DERIVED_REQUEST_STATES",
    "DISPATCHABLE_ROLES",
    "DRAFTER_ROLES",
    "GENESIS_LIFECYCLE_STATES",
    "INVOCATION_ROLES",
    "JUDGE_ROLES",
    "PLANNER_BRIDGE_ROLES",
    "REQUEST_ROLES",
    "ROLE_TARGET_PAIRING",
    "SUPPORTING_ROLES",
    "TERMINAL_REQUEST_STATES",
    "allowed_targets_for_role",
    "role_requires_bridge",
]
