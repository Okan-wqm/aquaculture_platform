"""Which agent contract a mission's `next_action` pointer mints — the table the queue drain reads.

WHY: a mission's forward pointer (`next_action`, ORPHAN-MEDIUM-730) was
forwarded by the orchestrator's mission branch as FREE PROMPT TEXT
(`recommended_action`) under one generic contract, whatever it said. Two
kernel-owned pointers existed and neither was read by anyone:
`SELF_CHANGE_NEXT_ACTION` (a self-change must reach `propose_self_change`
with structured fields) and `ISSUE_MISSION_NEXT_ACTION` (a labelled GitHub
issue). Confirmed live 2026-09-12.

WHAT: two tables that PARTITION the kernel-minted pointers, the same shape
as `gateway.default_schedules` (`DEFAULT_SCHEDULES` / `OPERATOR_ONLY_ACTIONS`):
* `NEXT_ACTION_CONTRACTS` — pointers whose answer has a KERNEL consumer.
  The builder returns the prompt, must_satisfy and allowed_scope the drain
  mints; the accepted answer is bridged to that consumer.
* `GENERIC_PROJECTION_POINTERS` — pointers for which the generic queue
  projection IS the dispatch, each with the mandatory reason and the NAMED
  consumer that reads the mission by its `source_kind`. A bare ``None`` in
  the contract table used to say the same thing with no reason and no
  consumer — an enumeration escape hatch a new pointer could hide in.
A pointer in neither table, or in both, fails
`tests/test_self_change_bridge.py::EveryNextActionHasADispatcher`, so a new
`*_NEXT_ACTION` constant cannot ship minted-but-unread.

A contract is asked ONCE PER MISSION while a request is in flight
(`in_flight_mission_request`): the scheduler never moves a DISCOVERED
mission and the queue de-duplicates per pending item, so without this rule
every cycle re-queued the same mission and the drain minted a second
request for a question the first had not yet answered.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .gateway.router import ISSUE_MISSION_NEXT_ACTION, ISSUE_MISSION_SOURCE_KIND
from .self_change_bridge import build_self_change_prompt, self_change_allowed_scope, self_change_must_satisfy
from .self_improvement import SELF_CHANGE_NEXT_ACTION, is_self_change_mission
from .tool_registry import GovernanceError


@dataclass(frozen=True)
class MissionContract:
    prompt: dict[str, Any]
    must_satisfy: list[dict[str, Any]]
    allowed_scope: list[str]

    @property
    def contract_ids(self) -> frozenset[str]:
        """The contract's identity: what `is_self_change_request` and the in-flight lookup compare."""
        return frozenset(str(item.get("id")) for item in self.must_satisfy if isinstance(item, dict))


@dataclass(frozen=True)
class GenericProjection:
    """A pointer the generic queue projection dispatches — with the proof that someone reads the mission.

    ``consumer`` is ``"<module>:<function>"``: a scanner that takes
    ``workspace_root`` and returns candidate rows whose ``candidate_id`` is
    the mission id, for missions of ``source_kind``. The invariant test
    resolves it and runs it against a minted mission, so the entry cannot
    name a consumer that does not exist or does not read this source kind.
    """
    source_kind: str
    consumer: str
    reason: str


ContractBuilder = Callable[..., MissionContract]


def _self_change_contract(*, queue_item_id: str, source_cycle_id: str | None, mission_row: dict[str, Any]) -> MissionContract:
    if not is_self_change_mission(mission_row):
        # The pointer alone is not the discriminator: a foreign source kind
        # carrying it is a producer defect, disclosed at the mint rather
        # than silently handed the generic contract.
        raise GovernanceError(
            f"self_change_pointer_on_foreign_mission:{mission_row.get('mission_id')}:{mission_row.get('source_kind')}"
        )
    return MissionContract(
        prompt=build_self_change_prompt(queue_item_id=queue_item_id, source_cycle_id=source_cycle_id, mission_row=mission_row),
        must_satisfy=self_change_must_satisfy(),
        allowed_scope=self_change_allowed_scope(),
    )


NEXT_ACTION_CONTRACTS: dict[str, ContractBuilder] = {
    SELF_CHANGE_NEXT_ACTION: _self_change_contract,
}

GENERIC_PROJECTION_POINTERS: dict[str, GenericProjection] = {
    ISSUE_MISSION_NEXT_ACTION: GenericProjection(
        source_kind=ISSUE_MISSION_SOURCE_KIND,
        consumer="aria_kernel.plan_synthesizer:scan_github_issue_missions",
        reason=(
            "triage of an `aria`-labelled issue IS planner work: the planner reads the mission under the "
            "generic projection, and plan_synthesizer.scan_github_issue_missions reads the same mission as a "
            "ranked plan-candidate source (PlanCandidateSource.GITHUB_ISSUE); a structured contract would be a "
            "second copy of the planner's own question"
        ),
    ),
}


def contract_for_mission(*, mission_row: dict[str, Any], queue_item_id: str, source_cycle_id: str | None) -> MissionContract | None:
    """The contract this mission's pointer mints, or ``None`` for the generic queue projection."""
    builder = NEXT_ACTION_CONTRACTS.get(str(mission_row.get("next_action") or ""))
    if builder is None:
        return None
    return builder(queue_item_id=queue_item_id, source_cycle_id=source_cycle_id, mission_row=mission_row)


def in_flight_mission_request(*, mission_id: str, contract: MissionContract, base_dir: str | Path | None) -> dict[str, Any] | None:
    """The request already asking this mission THIS contract, if one is still in flight.

    In flight = its derived state is not in `TERMINAL_REQUEST_STATES`.
    ACCEPTED and REJECTED are verdicts about the work and do NOT hold the
    mission: an accepted answer the kernel refused (an authority surface)
    leaves the mission DISCOVERED and re-selectable, which is the intended
    re-ask; an accepted answer the kernel honoured parks the mission in
    HUMAN_REQUIRED, which the scheduler skips. The result carries
    ``request_state`` so the drain's disclosure names what is holding it.
    """
    from .agent_invocations import derive_request_state, list_agent_invocation_requests
    from .agent_surface import TERMINAL_REQUEST_STATES

    marker = f"mission:{mission_id}"
    for request in reversed(list_agent_invocation_requests(base_dir=base_dir)):
        if str(request.get("pressure_event_id") or "") != marker:
            continue
        asked = frozenset(str(item.get("id")) for item in (request.get("must_satisfy") or []) if isinstance(item, dict))
        if asked != contract.contract_ids:
            continue
        state = derive_request_state(request_id=str(request.get("request_id")), base_dir=base_dir)
        if state in TERMINAL_REQUEST_STATES:
            continue
        return {**request, "request_state": state}
    return None


__all__ = ["GENERIC_PROJECTION_POINTERS", "GenericProjection", "NEXT_ACTION_CONTRACTS", "MissionContract", "contract_for_mission",
           "in_flight_mission_request"]
