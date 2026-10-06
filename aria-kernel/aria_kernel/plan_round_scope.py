"""One plan's round contract: the scope and obligations of every round envelope of THAT plan.

WHY this module exists (ARIA-HIGH-345, measured 2026-10-04). A cycle adopts
the newest mid-convergence plan (``plan_convergence.resume_candidate_plan_id``)
and, in the same cycle, synthesizes a fresh candidate from workspace pressure.
The orchestrator derived ``must_satisfy`` / ``allowed_scope`` /
``evidence_refs`` from the FRESH candidate and passed them to the convergence
drainer, which minted every round envelope of the ADOPTED plan with them. The
round-1 cross_review of the operator plan for F-007 (hr-module / hr-service)
went out with ``allowed_scope: ['.github/workflows/ci-affected.yml']`` and the
failing_ci candidate's ``key-change-0``. The reviewer correctly refused both
plans for violating an obligation that forbade every file they touch. The
drainer's own "adopted plans use what the plan STARTED with" branch read
``plan_started.must_satisfy``, a key ``start_plan`` never records, so it fell
through to the caller's value on every adopted plan.

WHAT it exposes:

* :func:`plan_round_contract` derives the scope, the key-change obligations and
  the evidence refs from the plan's own ``plan_started`` record and its
  admission bound (``plan_origin.admission_scope_for_plan``, ADR-0021). The
  drainer has no parameter through which a cycle-level value could enter, so
  the leak is impossible on that path by construction.
* :func:`require_plan_round_envelope` is the mint-time check
  ``agent_invocations.create_agent_invocation_request`` runs for every
  planning-round role. A producer that still names a scope (the CLI, a test,
  a future caller) is refused with a named reason when a scope entry or a
  key-change obligation does not reach the plan the envelope names.

Scope semantics. For a plan with an admission bound, the scope is that bound:
the admitted surfaces, ``<root>/**`` for every closure root, and the policy
pins. Every revision of the plan is already held to exactly that bound
(``plan_origin.require_within_admission_scope``), so a planner or reviewer may
cite evidence anywhere a revision may write. For a plan with no finding
origin, the scope is the started body's own surfaces and key-change paths.
The implementation envelope is not derived here. Its write scope is the
CONVERGED body's surfaces minus the readonly set, inside the same bound
(``cross_review_bridge.issue_implementation_envelope``).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from .tool_registry import GovernanceError

# Roles whose envelope belongs to one convergence round of one plan. The
# implementation envelope is post-convergence (round 0) and derives its own
# scope from the CONVERGED body, so it is not held to the started body here.
PLANNING_ROUND_ROLES = frozenset({"primary_plan", "challenger_plan", "cross_review", "completeness_critique"})

PLAN_ROUND_PLAN_NOT_STARTED = "plan_round_plan_not_started"
PLAN_ROUND_SCOPE_FOREIGN = "plan_round_scope_foreign"
PLAN_ROUND_OBLIGATION_FOREIGN = "plan_round_obligation_foreign"


@dataclass(frozen=True)
class PlanRoundContract:
    """What every planning-round envelope of one plan carries, derived from that plan."""

    plan_id: str
    allowed_scope: tuple[str, ...]
    must_satisfy: tuple[dict[str, Any], ...]
    evidence_refs: tuple[str, ...]
    # The paths and directories a scope entry or obligation path must reach:
    # the admission bound's entries, or the unbound plan's own paths.
    reach: tuple[str, ...]
    key_change_ids: frozenset[str]
    # ADR-0021 D9 (ARIA-HIGH-357) — where a planning-round agent may also
    # cite evidence and no body may write: the roots of the projects the
    # admitted surfaces import. Empty for a plan whose record predates it.
    evidence_scope: tuple[str, ...] = ()


def _dedupe(values: list[str]) -> list[str]:
    seen: list[str] = []
    for value in values:
        if value not in seen:
            seen.append(value)
    return seen


def _started_body(state: Mapping[str, Any], plan_id: str) -> dict[str, Any]:
    started = state.get("plan_started") if isinstance(state, Mapping) else None
    content = started.get("plan_content") if isinstance(started, Mapping) else None
    if not isinstance(content, dict):
        raise GovernanceError(
            f"{PLAN_ROUND_PLAN_NOT_STARTED}: plan {plan_id!r} has no plan_started record; a round "
            f"envelope derives its scope and obligations from the plan it names"
        )
    return content


def plan_round_contract(state: Mapping[str, Any]) -> PlanRoundContract:
    """The scope, obligations and evidence of ``state``'s plan, from its own start record."""
    from .must_satisfy import key_change_obligation
    from .plan_convergence import key_change_description, key_change_id, key_change_paths
    from .plan_origin import admission_scope_for_plan, body_paths, require_within_admission_scope

    plan_id = str(state.get("plan_id") or "")
    body = _started_body(state, plan_id)
    own_paths = _dedupe(body_paths(body))
    bound = admission_scope_for_plan(state)
    evidence_scope: list[str] = []
    if bound is None:
        reach = own_paths
        allowed_scope = own_paths
    else:
        evidence_scope = [f"{root}/**" for root in bound.get("dependency_roots") or []]
        # A started body inside its own bound is what `start_plan` recorded;
        # a body outside it is refused here exactly as a revision would be.
        require_within_admission_scope(bound, own_paths)
        reach = _dedupe([*bound["admitted_surfaces"], *bound["closure_roots"], *bound["policy_pins"]])
        allowed_scope = _dedupe([*bound["admitted_surfaces"],
                                 *(f"{root}/**" for root in bound["closure_roots"]),
                                 *bound["policy_pins"]])
    changes = body["key_changes"]
    must_satisfy = tuple(
        key_change_obligation(
            id=f"key-change-{index}",
            index=index,
            plan_description=key_change_description(change) or str(change),
            paths=key_change_paths(change),
            key_change_id=key_change_id(change),
        )
        for index, change in enumerate(changes)
    )
    refs = body.get("evidence_refs")
    evidence_refs = tuple(ref for ref in refs if isinstance(ref, str) and ref.strip()) if isinstance(refs, list) else ()
    return PlanRoundContract(
        plan_id=plan_id,
        allowed_scope=tuple(allowed_scope),
        must_satisfy=must_satisfy,
        evidence_refs=evidence_refs,
        reach=tuple(reach),
        key_change_ids=frozenset(filter(None, (key_change_id(change) for change in changes))),
        evidence_scope=tuple(evidence_scope),
    )


def _literal_prefix(entry: str) -> str:
    prefix = entry
    for wildcard in ("*", "?", "["):
        prefix = prefix.split(wildcard, 1)[0]
    return prefix.strip().strip("/")


def _reaches_plan(entry: str, contract: PlanRoundContract) -> bool:
    """True when a scope entry or path lies inside the plan's reach, or covers a part of it.

    Inside: the entry's literal prefix is a reach target or under one
    (``apps/hr-service/src/x.ts`` inside the closure root ``apps/hr-service``).
    Covering: the entry, as a glob or a directory, contains a reach target
    (``apps/**`` or ``apps/hr-service`` around ``apps/hr-service/src/x.ts``).
    An entry that does neither names nothing of this plan.
    """
    from .evidence_validator import _path_matches_any_glob

    prefix = _literal_prefix(entry)
    for target in contract.reach:
        inside = bool(prefix) and (prefix == target or prefix.startswith(target + "/"))
        covering = not prefix or target.startswith(prefix + "/") or _path_matches_any_glob(target, [entry])
        if inside or covering:
            return True
    return False


def require_plan_round_envelope(
    state: Mapping[str, Any],
    *,
    role: str,
    allowed_scope: list[str],
    must_satisfy: list[dict[str, Any]],
) -> None:
    """Refuse a planning-round envelope whose scope or key-change obligations are another plan's.

    The rule compares an envelope with the plan it names, so it applies once
    that plan has a ``plan_started`` record. A row whose ``convergence_id``
    names no started plan (a queue fixture, a listing label) belongs to no
    plan round, and there is no plan scope to hold it to. Every kernel
    producer of a round envelope (the drainer, the round controller) starts
    or folds the plan before it mints.
    """
    from .must_satisfy import KEY_CHANGE_KIND

    if not isinstance(state.get("plan_started"), Mapping):
        return
    contract = plan_round_contract(state)
    foreign_scope = [entry for entry in allowed_scope if not _reaches_plan(entry, contract)]
    if foreign_scope:
        raise GovernanceError(
            f"{PLAN_ROUND_SCOPE_FOREIGN}: role {role!r} envelope for plan {contract.plan_id!r} names "
            f"scope {foreign_scope} outside the plan's surfaces and admission bound {list(contract.reach)}"
        )
    foreign_obligations = []
    for item in must_satisfy:
        if item.get("kind") != KEY_CHANGE_KIND:
            continue
        change_id = item.get("key_change_id")
        paths = item.get("paths") if isinstance(item.get("paths"), list) else []
        if (change_id is not None and change_id not in contract.key_change_ids) or any(
            not _reaches_plan(str(path), contract) for path in paths
        ):
            foreign_obligations.append({"id": item.get("id"), "key_change_id": change_id, "paths": paths})
    if foreign_obligations:
        raise GovernanceError(
            f"{PLAN_ROUND_OBLIGATION_FOREIGN}: role {role!r} envelope for plan {contract.plan_id!r} "
            f"carries key-change obligations {foreign_obligations} that are not the plan's own "
            f"key changes {sorted(contract.key_change_ids)}"
        )
