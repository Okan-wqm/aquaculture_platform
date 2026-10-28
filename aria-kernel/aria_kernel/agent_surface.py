"""Single source of truth for ARIA agent roles and lifecycle labels.

The runtime has several consumers that need the same closed sets:
strict request validation, invocation queue writes, bridge replay,
dispatcher polling, and lifecycle reducers.  Keeping those sets here
prevents the common failure mode where a new role is added to one
surface but remains unreachable or unbridged elsewhere.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, FrozenSet

if TYPE_CHECKING:
    from .genesis_lifecycle import ReplayedChain


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
    # `gap_finding` — REMOVED (program rev3.1): no kernel path ever minted it;
    # the acceptance-lane gap hunt it named is an operator-driven dispatch
    # outside the kernel. Blind enumeration (K42) re-adds a role only when its
    # evidence trigger fires. Pinned by tests/test_role_hygiene_e14.py.
    # `gap_closure` — REMOVED for the same reason (ORPHAN-MEDIUM-836): the
    # executor twin of `implementation`, budgeted and never minted; the
    # acceptance-lane gap closer is likewise an operator-driven dispatch.
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
    # (specialist_review_runner over the routing table) plus expert_review_gate. Five roles
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
    # WP-J B-2 — the four method-panel seats (operator protocol step 3: a
    # blind panel of experts with distinct METHODS). They join ALL FOUR E14
    # tables in this one commit: REQUEST_ROLES here, DISPATCHABLE_ROLES,
    # ROLE_TARGET_PAIRING and the request_admission producer below. The
    # reproduction seat holds Write/Edit/Bash (it writes and RUNS the red
    # test) and is the one judge-lane role in WRITE_SCOPE_ROLES.
    "bug_hunt",
    "reproduction_test",
    "impact_assessment",
    "architecture",
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
    # role the drain may not reach (`ci_executor_drain.require_dispatchable_arc`
    # checks the drain arc against this set) is a request that waits forever:
    # the mint would look alive in the ledger and be dead on the lane. Minting
    # and draining are one contract, so a role joins both sides together.
    "consensus_arbitration",
    "change_intelligence",
    "goldset_curation",
    # E9-c — adversarial re-review of a decision the pipeline already closed.
    # Added together with the minter in `decision_questioning`, never before
    # it: a role that can be dispatched but is never minted, and a role that
    # is minted but can never be claimed, are the same defect from opposite
    # ends, and this repository has now closed nineteen of them.
    "verification",
    # ARIA-HIGH-344 — the twentieth. Minted by two kernel paths (the
    # autonomy_orchestrator next-cycle queue projection and
    # self_change_bridge) and drained by the executor's quota round since
    # Y4 (ORPHAN-705), it was never named here because the drain spawns
    # `ci_executor.py <request_id>` and nothing compared the drain arc with
    # this set. The provider routing table (ARIA-HIGH-290) is validated
    # against THIS set, so the role was left unrouted and every drained
    # request died in admission
    # (`provider_routing_role_unrouted:maintenance_utility`, executor runs
    # 37192561282 and 37205463513). `ci_executor_drain` now refuses to load
    # an arc naming a role outside this set.
    "maintenance_utility",
    # WP-J B-2 — the four method-panel seats, claimable the moment they are
    # mintable (the E14 contract; the standalone ci_executor mirror joins in
    # this same commit).
    "bug_hunt",
    "reproduction_test",
    "impact_assessment",
    "architecture",
})

DRAFTER_ROLES: FrozenSet[str] = frozenset({
    "primary_authoring",
    "challenger_authoring",
})

JUDGE_ROLES: tuple[str, ...] = (
    "evidence_judgment",
    "adversarial_judgment",
    "consensus_arbitration",
    # WP-J B-2 — the panel seats fold their verdicts through the SAME judge
    # bridge as the routine pair (judgment_bridge.is_judge_role), so a paid
    # panel envelope can vote in the consensus of the group it was minted
    # for. Without this membership the seat's response would be accepted,
    # sealed and silently unfoldable - the E14 defect from the response side.
    "bug_hunt",
    "reproduction_test",
    "impact_assessment",
    "architecture",
)

# WP-J B-1 — the METHOD each judgment-lane seat practices. Operator decision
# 2026-10-18: diversity comes from PERSPECTIVE and METHOD, not from the
# provider, so the anchor's diversity question (feedback_store G-2 hybrid
# leg) and the calibrated quorum's both read the METHOD off the receipt, and
# the method a seat practiced is stamped at the MINT from THIS registry (the
# ORPHAN-HIGH-781 doctrine: identity comes from what the kernel asked, never
# from what the judged agent volunteers about itself). One registry, no
# second copy: judgment_bridge folds it onto the ai_judge row,
# generate_ai_consensus folds it onto the observers receipt, and nothing
# else may spell a role's method.
#
# The three live seats map onto the operator's method list as: the evidence
# judge is the static code tracer, the adversarial judge is the devil's
# advocate, and the arbiter weighs evidence. The panel seats (bug hunt,
# reproduction, impact, architecture) join this registry in the same commit
# they join the four E14 tables below.
EXPERT_METHODS: dict[str, str] = {
    "evidence_judgment": "static_trace",
    "adversarial_judgment": "devils_advocate",
    "consensus_arbitration": "evidence_weighing",
    # WP-J B-2 — the four panel seats. Six seats, six distinct methods: the
    # funnel routes by claim_type onto a ROLE (its table), and this registry
    # is what makes the routed seat's method answerable - never re-derived
    # per router.
    "bug_hunt": "bug_hunt",
    "reproduction_test": "reproduction_test",
    "impact_assessment": "impact_assessment",
    "architecture": "architecture_contract",
}

# The closed vocabulary of methods (the values of EXPERT_METHODS), for
# validators that check a method string without caring which seat owns it.
METHODS: tuple[str, ...] = tuple(EXPERT_METHODS.values())

# WP-J B-2 — the method ARTIFACT each method's verdict must carry: the one
# field that makes the seat's answer checkable as the product of ITS method
# (operator protocol step 4: "its own METHOD and its own required evidence
# type"). judgment_bridge refuses a response whose role's method names a
# field here and the verdict block does not carry it
# (``judge_verdict.method_evidence_missing:<field>``). Methods absent from
# this map (the static tracer's hops, the devil's advocate's
# counter-evidence) are fully governed by the existing verdict law - the
# cited evidence_refs - and name no artifact of their own, so this is a
# registry of requirements, not a second copy of the verdict contract.
METHOD_REQUIRED_EVIDENCE: dict[str, str] = {
    "bug_hunt": "failing_input",
    "reproduction_test": "reproduction",
    "impact_assessment": "visible_consequence",
    "architecture_contract": "blast_radius",
}

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
    # ARIA-MEDIUM-462 — the kernel mints this target itself
    # (`cross_review_bridge.CROSS_REVIEW_ROLE` and
    # `plan_round_controller.DEFAULT_PLANNER_AGENTS["cross_review"]`), so it
    # belongs here like every other kernel-minted target; without it the
    # surface validator never checks that its prompt file exists.
    "aria-cross-reviewer",
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
    # Kept because the kernel really does dispatch these two: the routing
    # table (SE-2) routes auth-service / gateway-api / guards changes to
    # `auth-security-expert`, and expert_review_gate + ci.produce_ci_review
    # reach for `architectural-arbiter`. E14 dropped `access-boundary-auditor`
    # and `tenant-isolation-auditor` with the roles that were their only
    # kernel-side dispatch path; they remain Lane-B product-audit agents,
    # reachable the moment the routing table names them.
    "architectural-arbiter",
    "auth-security-expert",
    # WP-J B-2 — the three new panel-seat agents (the architecture seat
    # reuses architectural-arbiter above). Whitelisted here so the surface
    # validator checks their prompt files exist like every kernel-minted
    # target's.
    "aria-bug-hunter",
    "aria-test-writer",
    "aria-impact-assessor",
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
    # E9-c — the adversarial judge, deliberately NOT the evidence judge: the
    # phase re-opens a decision two planners already agreed on, and the
    # failure mode it hunts is a shared blind spot, which is what an
    # adversary is for and what a corroborator is not.
    "verification": ("aria-adversarial-judge",),
    "change_intelligence": ("aria-change-intelligence",),
    "goldset_curation": ("aria-goldset-curator",),
    # The one agent both maintenance_utility minters address
    # (autonomy_orchestrator's queue projection and
    # self_change_bridge.SELF_CHANGE_TARGET_AGENT): read-only and
    # kernel-envelope only, so a queue item or a self-change PROPOSAL can
    # never be served by an agent that holds write tools.
    "maintenance_utility": ("aria-autonomy-planner",),
    # WP-J B-2 — the four method seats. Three new agents (one per method,
    # read-only except the test writer's sandboxed Write/Edit/Bash) plus the
    # EXISTING architectural-arbiter for the architecture seat: the expert
    # lanes already reach it (expert_review_gate, ci.produce_ci_review), so
    # a second architecture agent would be a duplicate of a paired agent.
    "bug_hunt": ("aria-bug-hunter",),
    "reproduction_test": ("aria-test-writer",),
    "impact_assessment": ("aria-impact-assessor",),
    "architecture": ("architectural-arbiter",),
}

# J2 — every agent a judge role can seat: the set whose delivered contracts
# are the judge half of the verdict-cache key (agent_contract_delivery).
JUDGE_SEAT_AGENTS: tuple[str, ...] = tuple(sorted(
    {agent for role in JUDGE_ROLES for agent in ROLE_TARGET_PAIRING[role]}
))

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
    # EXTERNAL_OUTAGE — RETIRED (ARIA-HIGH-366, 2026-10-07): it was derived
    # from an `api_backoff_exhausted` claim event that no producer ever
    # wrote, and its reaper requeued on a 30-minute wall clock and escalated
    # after four — a timer that would have killed work in any outage longer
    # than two hours. A provider outage is now the `provider_outage_ledger` fact; the
    # request stays PENDING/REQUEUED under a harness-class release.
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

# Y3 (ORPHAN-703) — the terminal states that mean "this request died of
# QUEUE MECHANICS, not of an outcome". Producers that treat any existing
# request as satisfying their idempotency check wedge forever when the match
# is one of these: the second night's measurement showed a challenger_plan
# round and consumed autonomy queue items permanently blocked by their own
# dead envelopes. ACCEPTED/REJECTED stay out — they are verdicts about the
# WORK and their consumers handle them through result folds. The one
# exception is a planning-round step, whose refused answer gets a successor
# carrying the refusal (`step_request.successor_eligible_states`,
# ARIA-HIGH-355); a planning step also treats STALE as live, the reaper's.
REMINT_ELIGIBLE_DEAD_STATES: FrozenSet[str] = frozenset({
    "HUMAN_REQUIRED",
    "ANCHOR_STALE",
    "STALE",
    "CANCELLED",
    # No EXPIRED (ARIA-MEDIUM-462): derive_request_state never returns it — a lease
    # expiry derives STALE — so naming it here matched nothing.
})


def role_requires_bridge(role: str | None) -> bool:
    return role in BRIDGE_REQUIRED_ROLES


# The roles whose seat can be held by a per-service agent instead of the generic
# one (``ROLE_TARGET_PAIRING[role][0]``). Closed: for every other role the
# answer to "which agents may serve it" is the static pairing and reads no ledger.
SERVICE_SEAT_ROLES: FrozenSet[str] = frozenset({"change_intelligence"})


@dataclass(frozen=True)
class SeatResolution:
    """The agent a seat is asked of, and why a per-service agent for it was not.

    ``declined`` is ``None`` when the agent is the one the service has (or no
    agent claims the service); otherwise it names each claimant the service
    has and the reason it did not serve, as ``<agent>:<reason>`` joined by
    commas in sorted order.
    """

    agent: str
    declined: str | None


def _grant_refusal(role: str, agent: str, chain: ReplayedChain) -> str | None:
    """Why ``agent`` (a claimant of a service seat) may not serve it in production, or ``None`` when it may.

    Closed world: only a chain that replays and ends exactly at ACTIVE grants,
    so a state added to the lifecycle later (SE-12's QUARANTINED, TOMBSTONED)
    is declined here without a rule for it. The ACTIVE row must be production
    scope: a room- or trial-scoped agent never takes production traffic. The
    role's provider routing must be able to route the agent.
    """
    # Imported where used: this module is the leaf every other surface imports.
    from .genesis_lifecycle import InvalidLifecycleChain
    from .runtime_profiles import load_provider_routing
    from .tool_registry import GovernanceError

    state = chain.state
    if isinstance(state, InvalidLifecycleChain):
        return state.reason
    if state != "ACTIVE":
        return f"state:{state}"
    scope = chain.latest_evidence.get("scope")
    if scope not in (None, "production"):
        return f"scope:{scope}"
    try:
        load_provider_routing().ladder_for(role, agent)
    except GovernanceError:
        return "provider_routing_target_unrouted"
    return None


def _seat_claims(role: str, base_dir: str | Path) -> dict[str, dict[str, str | None]]:
    """``{service: {agent: refusal}}`` for every lifecycle agent whose workspace file claims ``(role, service)``.

    An agent claims a seat when its file (found by the lifecycle entity's own
    name in the workspace the store is bound to) says ``replaces_role: <role>``
    and ``service: <name>`` in its frontmatter. ``refusal`` is
    ``_grant_refusal``'s answer: ``None`` for an agent that may serve it.
    """
    from .agent_resolver import resolve_agent_md_path
    from .agent_runtime_profile import parse_frontmatter_field
    from .genesis_lifecycle import lifecycle_chains
    from .tool_registry import bound_workspace_root

    workspace = bound_workspace_root(base_dir)
    claims: dict[str, dict[str, str | None]] = {}
    for agent, chain in lifecycle_chains(base_dir).items():
        path = resolve_agent_md_path(agent, workspace)
        if path is None:
            continue
        text = path.read_text(encoding="utf-8")
        service = parse_frontmatter_field(text, "service")
        if not service or parse_frontmatter_field(text, "replaces_role") != role:
            continue
        claims.setdefault(service, {})[agent] = _grant_refusal(role, agent, chain)
    return claims


def _eligible(agents: dict[str, str | None]) -> list[str]:
    return sorted(agent for agent, refusal in agents.items() if refusal is None)


def service_seat_agents(role: str, *, base_dir: str | Path | None) -> tuple[str, ...]:
    """The per-service agents that may serve ``role`` besides its static pairing, sorted.

    Empty for a role outside ``SERVICE_SEAT_ROLES`` and for a caller that
    holds no store (the grant is read from the store's lifecycle ledger). A
    service two agents are eligible for grants neither: which of them answers
    would be a coin toss.
    """
    if role not in SERVICE_SEAT_ROLES or base_dir is None:
        return ()
    granted: list[str] = []
    for agents in _seat_claims(role, base_dir).values():
        eligible = _eligible(agents)
        if len(eligible) == 1:
            granted.append(eligible[0])
    return tuple(sorted(granted))


def resolve_seat_agent(role: str, service: str | None, *, base_dir: str | Path) -> SeatResolution:
    """The agent ``role``'s seat for ``service`` is asked of: the service's own agent when it has one it may use.

    The generic agent (``ROLE_TARGET_PAIRING[role][0]``) answers every other
    seat (``service`` is ``None`` for a whole-change or cross-cutting seat).
    When the service has claimants and none may serve, the generic agent is
    returned with every claimant's reason in ``declined``, so a refused
    specialist is named in the result instead of dropped.
    """
    generic = ROLE_TARGET_PAIRING[role][0]
    if service is None or role not in SERVICE_SEAT_ROLES:
        return SeatResolution(generic, None)
    agents = _seat_claims(role, base_dir).get(service.lower())
    if not agents:
        return SeatResolution(generic, None)
    eligible = _eligible(agents)
    if len(eligible) == 1:
        return SeatResolution(eligible[0], None)
    declined = ",".join(f"{agent}:{agents[agent] or 'ambiguous_service'}" for agent in sorted(agents))
    return SeatResolution(generic, declined)


def allowed_targets_for_role(role: str, *, base_dir: str | Path | None = None) -> tuple[str, ...] | None:
    """The one answer to "which agents may serve ``role``": the static pairing, plus the granted per-service agents.

    ``None`` for a role with no pairing. The per-service agents are read from
    the store ``base_dir`` names; a caller without one gets the static pairing.
    """
    static = ROLE_TARGET_PAIRING.get(role)
    if static is None or base_dir is None:
        return static
    return (*static, *service_seat_agents(role, base_dir=base_dir))


__all__ = [
    "BRIDGE_REQUIRED_ROLES",
    "DEFAULT_TARGET_AGENT_WHITELIST",
    "DERIVED_REQUEST_STATES",
    "DISPATCHABLE_ROLES",
    "DRAFTER_ROLES",
    "EXPERT_METHODS",
    "INVOCATION_ROLES",
    "JUDGE_ROLES",
    "JUDGE_SEAT_AGENTS",
    "METHOD_REQUIRED_EVIDENCE",
    "METHODS",
    "PLANNER_BRIDGE_ROLES",
    "REQUEST_ROLES",
    "ROLE_TARGET_PAIRING",
    "SERVICE_SEAT_ROLES",
    "SUPPORTING_ROLES",
    "SeatResolution",
    "TERMINAL_REQUEST_STATES",
    "allowed_targets_for_role",
    "resolve_seat_agent",
    "role_requires_bridge",
    "service_seat_agents",
]
