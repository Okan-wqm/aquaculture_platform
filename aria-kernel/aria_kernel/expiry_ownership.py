"""Who recovers an expired request of each role (ARIA-HIGH-360, review of PR #1825).

WHY this module exists. The first version of the anchor-stale disposition
dropped every role outside the judge and planning roles as
``role_not_remintable`` and wrote the record already resolved, with no
notification. Review found that work lost for good: a maintenance item is
consumed when its request is minted (``autonomy_orchestrator``), a
verification question counts its dead request as asked
(``decision_questioning.already_questioned``), a change-intelligence merge
and a goldset proposal do the same (``agent_invocations.minted_subject_refs``,
``goldset.dispatch_goldset_curation``), and an operator's own request has no
producer at all. The standing rule (Okan): no work may be lost inside ARIA.

THE TABLE (``ROLE_OWNERSHIP``) is closed over ``agent_surface.INVOCATION_ROLES``
(``tests/test_anchor_stale_disposition.py`` fails on a role it does not
name). Each role has exactly one owner of its expired requests, and each
claim cites ``file.py::symbol`` definitions the same test resolves with ``ast``:

* ``producer``: a named producer notices the death and recovers the work on
  its own (re-mint, re-open, or a terminal outcome it records where the
  operator reads it). The kernel writes no record for a fresh expiry.
* ``kernel_remint``: the judge fan-out never asks a (group, judge) pair
  again (``judge_fanout._existing_judge_dispatches`` counts dead rows), so
  the kernel re-mints a live subject (``anchor_stale``).
* ``reoffer``: the producer re-mints only while its source item is pending;
  the kernel puts the item back (``next_cycle_queue.reoffer_item``).
* ``operator``: nothing recovers it. The record stays OPEN, on the
  operator's list and SLA ladder, with the kernel's reason, and the sweep
  notifies once per batch. No panel: the kind is not adjudicable.

Ownership is verified per request, never assumed from the role: each claim
names the fields only that producer stamps (``Ownership.signature``). An
operator-CLI request (``cli.py`` ``agent-invocations request``) can set
neither ``target_sha``, ``implementation_ids``, ``judgment_group_id`` nor a
panel membership, so it fails every signature and is handed to the
operator, never dropped. A request whose claimed producer cannot be
verified goes the same way: the error direction is a visible record.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from .plan_round_scope import PLANNING_ROUND_ROLES

OWNER_PRODUCER = "producer"
OWNER_KERNEL_REMINT = "kernel_remint"
OWNER_REOFFER = "reoffer"
OWNER_OPERATOR = "operator"


@dataclass(frozen=True)
class Ownership:
    """One role's owner of its expired requests, the proof, and the producer's signature."""

    owner: str
    producer: str
    proof: str
    signature: Callable[[Mapping[str, Any], frozenset[str]], bool]
    # ``file.py::symbol`` for each definition the proof rests on; a test
    # parses each file and fails when the symbol is not defined there
    # (review of PR #1825: a line number alone drifted to a blank line).
    citations: tuple[str, ...]


def _planning_step(request: Mapping[str, Any], _panel_ids: frozenset[str]) -> bool:
    # The drainer's step key is (convergence_id, role, round_number); every
    # drainer mint anchors at the workspace HEAD (`target_sha`), which the
    # operator CLI cannot set.
    return bool(request.get("convergence_id")) and request.get("round_number") is not None \
        and bool(request.get("target_sha"))


def _implementation(request: Mapping[str, Any], _panel_ids: frozenset[str]) -> bool:
    return isinstance(request.get("implementation_ids"), Mapping)


def _panel_member(request: Mapping[str, Any], panel_ids: frozenset[str]) -> bool:
    return str(request.get("request_id") or "") in panel_ids


def _fanout_judge(request: Mapping[str, Any], _panel_ids: frozenset[str]) -> bool:
    # `judge_fanout._group_id`: judge:<tool>:<fingerprint or finding id>.
    tool_id = str(request.get("tool_id") or "")
    keys = {str(request.get("finding_fingerprint") or ""), str(request.get("finding_id") or "")} - {""}
    return bool(tool_id) and str(request.get("judgment_group_id") or "") in {f"judge:{tool_id}:{k}" for k in keys}


def queue_item_id_of(request: Mapping[str, Any]) -> str | None:
    """The next-cycle queue item a projected maintenance request was minted for."""
    try:
        prompt = json.loads(str(request.get("suggested_prompt") or ""))
    except ValueError:
        return None
    if not isinstance(prompt, dict) or prompt.get("$schema") != "aria/next-cycle-queue-request/v1":
        return None
    qid = prompt.get("queue_item_id")
    return qid if isinstance(qid, str) and qid else None


def _queue_projection(request: Mapping[str, Any], _panel_ids: frozenset[str]) -> bool:
    return request.get("target_agent") == "aria-autonomy-planner" and queue_item_id_of(request) is not None


def _never(_request: Mapping[str, Any], _panel_ids: frozenset[str]) -> bool:
    return False


_DRAINER = Ownership(
    OWNER_PRODUCER, "convergence_drainer",
    "ANCHOR_STALE is successor-eligible for a planning step (MAX_STEP_REQUEST_REMINTS); exhaustion "
    "escalates the plan",
    _planning_step,
    ("convergence_drainer.py::_step_disposition", "step_request.py::step_request_disposition"),
)
_NOBODY = "no producer re-asks a dead request of this role"
_FANOUT_DEDUPE = ("judge_fanout.py::_existing_judge_dispatches",)

ROLE_OWNERSHIP: Mapping[str, Ownership] = {
    **{role: _DRAINER for role in sorted(PLANNING_ROUND_ROLES)},
    "implementation": Ownership(
        OWNER_PRODUCER, "implementation_orphan_reaper",
        "a plan left IMPLEMENTATION_REQUESTED 24 h (inside the 7-day anchor window) is moved to "
        "IMPLEMENTATION_REJECTED by the orchestrator, recorded on the plan",
        _implementation,
        ("plan_convergence.py::scan_orphan_implementation_requests",
         "plan_convergence.py::ORPHAN_IMPLEMENTATION_REAP_AFTER_HOURS"),
    ),
    "human_required_adjudication": Ownership(
        OWNER_PRODUCER, "adjudication_panel",
        "a panel whose envelopes all died is re-opened up to MAX_PANEL_REOPENS, then left open for the "
        "operator",
        _panel_member,
        ("human_required_adjudication.py::_panel_is_terminally_dead",
         "human_required_adjudication.py::MAX_PANEL_REOPENS"),
    ),
    "evidence_judgment": Ownership(
        OWNER_KERNEL_REMINT, "anchor_stale", "the fan-out counts dead rows as dispatched", _fanout_judge,
        _FANOUT_DEDUPE,
    ),
    "adversarial_judgment": Ownership(
        OWNER_KERNEL_REMINT, "anchor_stale", "the fan-out counts dead rows as dispatched", _fanout_judge,
        _FANOUT_DEDUPE,
    ),
    "maintenance_utility": Ownership(
        OWNER_REOFFER, "autonomy_orchestrator",
        "the projection re-mints a dead request with remint_of while its queue item is pending; "
        "reoffer_item makes it pending again",
        _queue_projection,
        ("autonomy_orchestrator.py::_find_projected_queue_request", "next_cycle_queue.py::reoffer_item"),
    ),
    "consensus_arbitration": Ownership(
        OWNER_OPERATOR, "", "the fan-out counts the dead arbiter as dispatched; the anchor arm never "
        "escalates", _never, _FANOUT_DEDUPE,
    ),
    "verification": Ownership(
        OWNER_OPERATOR, "", f"already_questioned counts dead requests; {_NOBODY}", _never,
        ("decision_questioning.py::already_questioned",),
    ),
    "change_intelligence": Ownership(
        OWNER_OPERATOR, "", f"minted_subject_refs counts dead rows; {_NOBODY}", _never,
        ("agent_invocations.py::minted_subject_refs",),
    ),
    "goldset_curation": Ownership(
        OWNER_OPERATOR, "", f"the curation dispatch skips a subject any request named; {_NOBODY}", _never,
        ("goldset.py::dispatch_goldset_curation",),
    ),
    "primary_authoring": Ownership(
        OWNER_OPERATOR, "", f"the drafter poll waits until timeout, never re-mints; {_NOBODY}", _never,
        ("dispatcher_factory.py::_poll_for_drafter_response",),
    ),
    "challenger_authoring": Ownership(
        OWNER_OPERATOR, "", f"the drafter poll waits until timeout, never re-mints; {_NOBODY}", _never,
        ("dispatcher_factory.py::_poll_for_drafter_response",),
    ),
    "specialist_domain_review": Ownership(
        OWNER_OPERATOR, "", f"the runner fails closed on a dead request; {_NOBODY}", _never,
        ("specialist_review_runner.py::run_specialist_review_runner",),
    ),
}

# Why an expired request of a role the table assigns elsewhere goes to the
# operator: its claimed producer's signature is absent (an operator-CLI or
# foreign mint).
UNVERIFIED_PRODUCER = "producer_unverified"


def owner_of(request: Mapping[str, Any], panel_ids: frozenset[str]) -> tuple[str, str]:
    """(owner, producer or reason) for one expired request; an unknown role is the operator's."""
    role = str(request.get("role") or "")
    ownership = ROLE_OWNERSHIP.get(role)
    if ownership is None:
        return OWNER_OPERATOR, f"role_unowned:{role}"
    if ownership.owner == OWNER_OPERATOR:
        return OWNER_OPERATOR, f"no_recovering_producer:{role}"
    if not ownership.signature(request, panel_ids):
        return OWNER_OPERATOR, f"{UNVERIFIED_PRODUCER}:{ownership.producer}"
    return ownership.owner, ownership.producer


__all__ = [
    "OWNER_KERNEL_REMINT",
    "OWNER_OPERATOR",
    "OWNER_PRODUCER",
    "OWNER_REOFFER",
    "ROLE_OWNERSHIP",
    "UNVERIFIED_PRODUCER",
    "Ownership",
    "owner_of",
    "queue_item_id_of",
]
