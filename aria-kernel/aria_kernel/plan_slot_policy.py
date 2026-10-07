"""ARIA-HIGH-369 — which candidate the one planning slot is offered to first.

WHY. The provider (``cycle_phases.plan_source.V9PressureSourceProvider``)
converts the first candidate of ``plan_synthesizer.rank_candidate_sources``
that yields a plan, and the cycle holds ONE plan in flight
(``plan_convergence.resume_candidate_plan_id`` adopts it until it ends). The
rank is a fixed source order — operator feedback, failing CI, orphan, F
finding — so whenever any main workflow was red, failing CI took the slot.
Measured on the aria/state store 2026-10-07: 32 candidate selections, 21 of
them failing CI and every one of the last 12 automated ones; 20 plans
started, 0 converged; the F source won only while no workflow was red; the
2026-10-05 plan was ARIA's own ``aria-auto-cycle`` workflow, whose surface
(``.github/workflows/aria-*``) is ARIA's own code
(``self_improvement.SELF_CHANGE_ALLOWED_PREFIXES``) and is parked for a human
anyway; and the F source offered 18 files, youngest first (the ``age_seconds``
key sorts ascending): F-101/F-102, which the finding fold never emitted, and 16
OPEN findings of which F-003/F-005/F-007/F-008/F-015 are one subject and
F-001/F-004/F-006 another (ARIA-HIGH-363's key) — 10 distinct candidates.

WHAT. :func:`order_for_slot` re-orders the ranked candidates for the slot:

* an operator request always comes first (ADR-0018: the operator's act
  outranks every automated brake) — F-015's live run keeps the slot;
* a failing-CI candidate on ARIA's own workflow is dropped
  (:data:`FAILING_CI_SELF_LANE`), and one whose workflow's last plan failed
  (``plan_abandoned``, ``implementation_rejected``, ``HUMAN_REQUIRED``) less
  than :data:`FAILING_CI_COOL_OFF` ago is dropped (:data:`FAILING_CI_COOL_OFF_REASON`);
* F candidates the fold does not hold, or holds in another status than OPEN,
  are dropped with admission's own reasons; the rest are GROUPED by subject
  (``finding_subject.finding_subject_key``, ARIA-HIGH-363; a finding without
  a subject is its own group). Groups are offered best first and every member
  of a group is offered, best first — highest severity, then oldest
  ``created_at``, then lowest id. Review M3: dropping the siblings up front
  starved a subject whose first member was refused for a reason of its own;
  the representative is now whichever member admission and the seed accept
  (the provider falls through the group), and the loop guards judge the
  SUBJECT's plans (``finding_grounding._loop_refusal``), so a sibling cannot
  re-plan a subject another sibling's failed plan cooled off;
* the slot alternates: when the newest automated plan (a plan no operator
  request bound) came from the F source, the other automated sources go first
  and F follows; otherwise F goes first and the others follow. With one slot
  this IS the reserved F slot, without idling it: a lane with nothing
  convertible this cycle hands the slot to the next.

Dropped candidates are disclosed in ONE governance event per synthesis
(:data:`SLOT_POLICY_EVENT`), never silently.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from .finding import SEVERITY_RANK
from .finding_grounding import FINDING_NOT_OPEN, FINDING_UNKNOWN, LoopHistory, PlanRecord
from .finding_subject import finding_subject_key
from .plan_candidate_source import PlanCandidateSource

SLOT_POLICY_EVENT = "plan_slot_policy_applied"
FAILING_CI_SELF_LANE = "failing_ci_self_lane"
FAILING_CI_COOL_OFF_REASON = "failing_ci_subject_cool_off"
# The 5 failing-CI plans on the store (2026-08-16 .. 10-05) reached their
# terminal state 0.25 to 2.39 days after they started: three days is one full
# plan lifetime for the slot to serve another lane before the same red
# workflow, planned from the same evidence, may retry.
FAILING_CI_COOL_OFF = timedelta(days=3)
_FAILING = PlanCandidateSource.FAILING_CI.value
_F = PlanCandidateSource.F_FINDING.value
_OPERATOR = PlanCandidateSource.OPERATOR_FEEDBACK.value


@dataclass(frozen=True)
class SlotOrder:
    """The candidates in the order the slot is offered, and every candidate dropped with why."""

    ordered: tuple[Mapping[str, Any], ...]
    dropped: tuple[dict[str, Any], ...]
    f_first: bool
    last_automated_plan: str | None
    subjects: Mapping[str, tuple[str, ...]] = field(default_factory=dict)

    def disclosure(self) -> dict[str, Any]:
        return {"f_first": self.f_first, "last_automated_plan": self.last_automated_plan,
                "offered": [c.get("candidate_id") for c in self.ordered], "dropped": list(self.dropped),
                "subjects": {key: list(ids) for key, ids in self.subjects.items()}}


def _drop(candidate: Mapping[str, Any], reason: str, **detail: Any) -> dict[str, Any]:
    return {"candidate_id": candidate.get("candidate_id"), "source_type": candidate.get("source_type"),
            "reason": reason, **detail}


def _self_lane(candidate: Mapping[str, Any]) -> bool:
    """A red workflow whose file is ARIA's own code, by the self-change SSoT."""
    from .self_improvement import SELF_CHANGE_ALLOWED_PREFIXES

    path = candidate.get("workflow_path")
    return isinstance(path, str) and path.startswith(SELF_CHANGE_ALLOWED_PREFIXES)


def _cooling_plan(candidate: Mapping[str, Any], plans: tuple[PlanRecord, ...], now: datetime) -> PlanRecord | None:
    """The failed automated plan on this workflow file still inside the cool-off, if any."""
    path = candidate.get("workflow_path")
    if not isinstance(path, str):
        return None
    failed = [plan for plan in plans if not plan.operator_sourced and not plan.f_sourced
              and path in plan.surfaces and plan.failed_at is not None and now - plan.failed_at < FAILING_CI_COOL_OFF]
    return max(failed, key=lambda plan: plan.failed_at or now, default=None)


def _f_rank(record: Mapping[str, Any], finding_id: str, now: datetime) -> tuple[int, datetime, str]:
    from .tool_registry import parse_utc_stamp

    stamp = record.get("created_at")
    created = parse_utc_stamp(stamp) if isinstance(stamp, str) else None
    return (-SEVERITY_RANK.get(str(record.get("severity")), -1), created or now, finding_id)


def _f_groups(
    candidates: list[Mapping[str, Any]], findings: Mapping[str, Mapping[str, Any]] | None, now: datetime,
) -> tuple[list[Mapping[str, Any]], list[dict[str, Any]], dict[str, tuple[str, ...]]]:
    """(F candidates group by group, dropped, each multi-member subject's ids in offer order)."""
    if findings is None:
        # No fold: admission refuses every F candidate as a store fault, by name.
        return candidates, [], {}
    dropped: list[dict[str, Any]] = []
    groups: dict[str, list[tuple[tuple[int, datetime, str], Mapping[str, Any]]]] = {}
    for candidate in candidates:
        finding_id = str(candidate.get("candidate_id"))
        record = findings.get(finding_id)
        if record is None or record.get("status") != "OPEN":
            dropped.append(_drop(candidate, FINDING_UNKNOWN if record is None else FINDING_NOT_OPEN))
            continue
        subject = finding_subject_key(record) or f"finding:{finding_id}"
        groups.setdefault(subject, []).append((_f_rank(record, finding_id, now), candidate))
    for members in groups.values():
        members.sort(key=lambda member: member[0])
    ordered = sorted(groups.items(), key=lambda item: item[1][0][0])
    subjects = {key: tuple(str(c.get("candidate_id")) for _rank, c in members)
                for key, members in ordered if len(members) > 1}
    return [candidate for _key, members in ordered for _rank, candidate in members], dropped, subjects


def order_for_slot(
    candidates: list[Mapping[str, Any]],
    *,
    findings: Mapping[str, Mapping[str, Any]] | None,
    history: LoopHistory | None,
) -> SlotOrder:
    """Re-order ``rank_candidate_sources`` output for the one planning slot; see the module docstring."""
    now = history.now if history is not None else datetime.now(timezone.utc)
    plans = history.plans if history is not None else ()
    operator: list[Mapping[str, Any]] = []
    f_candidates: list[Mapping[str, Any]] = []
    others: list[Mapping[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for candidate in candidates:
        source = candidate.get("source_type")
        if source == _OPERATOR:
            operator.append(candidate)
        elif source == _F:
            f_candidates.append(candidate)
        elif source == _FAILING and _self_lane(candidate):
            dropped.append(_drop(candidate, FAILING_CI_SELF_LANE, workflow_path=candidate.get("workflow_path")))
        elif source == _FAILING and (cooling := _cooling_plan(candidate, plans, now)) is not None:
            until = (cooling.failed_at or now) + FAILING_CI_COOL_OFF
            dropped.append(_drop(candidate, FAILING_CI_COOL_OFF_REASON, plan_id=cooling.plan_id,
                                 workflow_path=candidate.get("workflow_path"), until=until.isoformat()))
        else:
            others.append(candidate)
    f_kept, f_dropped, subjects = _f_groups(f_candidates, findings, now)
    dropped.extend(f_dropped)
    automated = [plan for plan in plans if not plan.operator_sourced]
    last = max(automated, key=lambda plan: plan.started_at, default=None)
    # Without the plan history the F source is refused by its loop guards
    # (LOOP_HISTORY_UNAVAILABLE), so it cannot hold the slot's first offer.
    f_first = history is not None and (last is None or not last.f_sourced)
    ordered = operator + (f_kept + others if f_first else others + f_kept)
    return SlotOrder(tuple(ordered), tuple(dropped), f_first, last.plan_id if last is not None else None,
                     subjects)


__all__ = [
    "FAILING_CI_COOL_OFF",
    "FAILING_CI_COOL_OFF_REASON",
    "FAILING_CI_SELF_LANE",
    "SLOT_POLICY_EVENT",
    "SlotOrder",
    "order_for_slot",
]
