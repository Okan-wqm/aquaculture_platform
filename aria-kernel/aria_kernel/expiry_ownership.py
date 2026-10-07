"""Who recovers an expired request of each role (ARIA-HIGH-360, review of PR #1825).

WHY this module exists. The first version of the anchor-stale disposition
dropped every role outside the judge and planning roles as
``role_not_remintable`` and wrote the record already resolved, with no
notification. Review found that work lost for good: a maintenance item is
consumed when its request is minted (``autonomy_orchestrator.py:438``), a
verification question counts its dead request as asked
(``decision_questioning.py:92``), a change-intelligence merge and a goldset
proposal do the same (``agent_invocations.minted_subject_refs``,
``goldset.py:240``), and an operator's own request has no producer at all.
The standing rule (Okan): no work may be lost inside ARIA.

THE TABLE (``ROLE_OWNERSHIP``) is closed over ``agent_surface.INVOCATION_ROLES``
(``tests/test_anchor_stale_disposition.py`` fails on a role it does not
name). Each role has exactly one owner of its expired requests:

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
    "convergence_drainer.py:623 _step_disposition -> step_request.py:92 step_request_disposition: "
    "ANCHOR_STALE is successor-eligible (MAX_STEP_REQUEST_REMINTS), exhaustion escalates the plan",
    _planning_step,
)
_NOBODY = "no producer re-asks a dead request of this role"

ROLE_OWNERSHIP: Mapping[str, Ownership] = {
    **{role: _DRAINER for role in sorted(PLANNING_ROUND_ROLES)},
    "implementation": Ownership(
        OWNER_PRODUCER, "implementation_orphan_reaper",
        "autonomy_orchestrator.py:1231 scan_orphan_implementation_requests (plan_convergence.py:1683): "
        "a plan left IMPLEMENTATION_REQUESTED 24 h (plan_convergence.py:941, inside the 7-day anchor "
        "window) is moved to IMPLEMENTATION_REJECTED, recorded on the plan",
        _implementation,
    ),
    "human_required_adjudication": Ownership(
        OWNER_PRODUCER, "adjudication_panel",
        "human_required_adjudication.py:1194 _panel_is_terminally_dead: a panel whose envelopes all "
        "died is re-opened up to MAX_PANEL_REOPENS, then left open for the operator",
        _panel_member,
    ),
    "evidence_judgment": Ownership(
        OWNER_KERNEL_REMINT, "anchor_stale", "judge_fanout.py:152 counts dead rows as dispatched", _fanout_judge,
    ),
    "adversarial_judgment": Ownership(
        OWNER_KERNEL_REMINT, "anchor_stale", "judge_fanout.py:152 counts dead rows as dispatched", _fanout_judge,
    ),
    "maintenance_utility": Ownership(
        OWNER_REOFFER, "autonomy_orchestrator",
        "autonomy_orchestrator.py:233 re-mints a dead projection with remint_of while its queue item "
        "is pending; next_cycle_queue.reoffer_item makes it pending again",
        _queue_projection,
    ),
    "consensus_arbitration": Ownership(
        OWNER_OPERATOR, "", "judge_fanout.py:152 counts the dead arbiter as dispatched; the anchor arm "
        "never escalates", _never,
    ),
    "verification": Ownership(
        OWNER_OPERATOR, "", f"decision_questioning.py:92 already_questioned counts dead requests; {_NOBODY}", _never,
    ),
    "change_intelligence": Ownership(
        OWNER_OPERATOR, "", f"agent_invocations.py:2039 minted_subject_refs counts dead rows; {_NOBODY}", _never,
    ),
    "goldset_curation": Ownership(
        OWNER_OPERATOR, "", f"goldset.py:241 minted_subject_refs counts dead rows; {_NOBODY}", _never,
    ),
    "primary_authoring": Ownership(
        OWNER_OPERATOR, "", f"dispatcher_factory.py:270 polls until timeout, never re-mints; {_NOBODY}", _never,
    ),
    "challenger_authoring": Ownership(
        OWNER_OPERATOR, "", f"dispatcher_factory.py:270 polls until timeout, never re-mints; {_NOBODY}", _never,
    ),
    "specialist_domain_review": Ownership(
        OWNER_OPERATOR, "", f"specialist_review_runner.py:602 fails closed on a dead request; {_NOBODY}", _never,
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
