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
    # E14 — REMOVED, and deliberately not replaced: `implementation_review`,
    # `architectural_arbitration`, `auth_security_review`,
    # `access_boundary_review`, `tenant_isolation_review`. Plan 019 Phase 2.5
    # added them as a contract extension for lanes that were then built
    # differently: the auth lane became the security-boundary ADAPTER plus the
    # architecture spine gate, and domain review became `specialist_domain_review`
    # (specialist_review_runner's touch-map) plus expert_review_gate. Five roles
    # a request could name, that no kernel path ever minted and no bridge ever
    # consumed — a surface that admits a role nothing can fulfil is how a caller
    # ends up waiting forever for an answer that was never dispatched. Removal is
    # pinned by tests/test_role_hygiene_e14.py; ORPHAN-MEDIUM-280 closed the same
    # defect from the agent-prompt side (a prompt claiming `implementation_review`
    # the kernel never routes).
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
    # E14 — the three roles that gained a producer. A minted envelope whose
    # role the executor refuses to claim (`ci_executor.claim_and_dispatch_one`
    # validates against this set) is a request that waits forever: the mint
    # would look alive in the ledger and be dead on the lane. Minting and
    # draining are one contract, so a role joins both sides together.
    "consensus_arbitration",
    "change_intelligence",
    "goldset_curation",
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
    # Kept because the kernel really does dispatch these two: the specialist
    # touch-map routes auth-service / gateway-api / guards changes to
    # `auth-security-expert`, and expert_review_gate + ci.produce_ci_review
    # reach for `architectural-arbiter`. E14 dropped `access-boundary-auditor`
    # and `tenant-isolation-auditor` with the roles that were their only
    # kernel-side dispatch path; they remain Lane-B product-audit agents,
    # reachable the moment the touch-map names them.
    "architectural-arbiter",
    "auth-security-expert",
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
    # ORPHAN-MEDIUM-492 — the request's target_sha no longer describes the
    # repo it would be executed against. Distinct from STALE, which is a
    # lease-expiry and is retryable: a lease can be re-claimed, but a plan
    # grounded at an obsolete tree cannot be made current by retrying it.
    "ANCHOR_STALE",
)

TERMINAL_REQUEST_STATES: FrozenSet[str] = frozenset({
    "ACCEPTED",
    "REJECTED",
    "STALE",
    "CANCELLED",
    "HUMAN_REQUIRED",
    "ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL",
    "ANCHOR_STALE",
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
