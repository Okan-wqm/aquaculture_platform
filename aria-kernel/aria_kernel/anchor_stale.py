"""The kernel decides what happens to a request that expired unclaimed (ARIA-HIGH-360).

WHY (measured 2026-10-06 on a copy of the runner store, 1,866 requests). A
request nobody claims inside its anchor window derives ANCHOR_STALE. Y7
(ORPHAN-708) recorded a HUMAN_REQUIRED record for each one and admitted the
kind to the adjudication panel. Each record opened a three-judge panel:
three new requests on the queue that had just failed to reach the first one.
693 of the 1,866 requests were these panels; all 3,023 panel folds were
``still_escalated``; none of the 213 open records was ever resolved. Expiry
is a fact about the queue, not a question for a panel.

THE RULE is one function, ``decide_expiry_disposition``, of the request, its
expiry cause (``anchor_expiry_cause``) and its owner (``expiry_ownership``):

1. A request with a ``remint_of`` successor was recovered by its lane.
2. A role nobody recovers, or a request whose claimed producer cannot be
   verified (an operator's own request), goes to the operator: the record
   stays OPEN and the sweep notifies. Nothing is dropped unseen.
3. A role whose verified producer recovers its own dead requests is left to
   it (no record for a fresh expiry).
4. A projected maintenance request has its queue item re-offered, so the
   orchestrator re-mints it under its own budget.
5. A fan-out judge request: wait while the judge backlog is full; drop by
   name when the finding no longer needs that judge (``subject_closed:``);
   hand to the operator when the lineage is spent
   (``MAX_EXPIRY_LINEAGE_REMINTS``, or ``ANCHOR_STALE_REMINT_BUDGET``
   request-class expiries; an outage expiry spends no budget); otherwise
   re-mint at HEAD the way the fan-out mints today (``judge_remint``).

THE BACKLOG. ``dispose_anchor_stale_requests`` runs inside the lease sweep
every kernel cycle. Open records an earlier sweep opened for the panel (170
on 2026-10-07) go through the same rule first; then the expiries with no
record, newest first; at most ``ANCHOR_STALE_DISPOSITIONS_PER_SWEEP``
decisions per sweep. A judge request waiting on a full backlog is decided
before any ledger is read and costs one dict lookup. When nothing is due the
sweep reads no ledger beyond the ones its caller already holds. Idempotent:
a resolved record is never read again, an open record already carries the
kernel's decision, and a crash mid-batch leaves a started row whose
unfinished items the next sweep decides again.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from .anchor_expiry_cause import ANCHOR_STALE_REMINT_BUDGET, MAX_EXPIRY_LINEAGE_REMINTS, ExpiryCause
from .anchor_stale_effects import (
    DISPOSITION_DROPPED,
    DISPOSITION_OPERATOR,
    DISPOSITION_PRODUCER_OWNED,
    DISPOSITION_REMINTED,
    DISPOSITION_STATUS,
    RemintGate,
    operator_required,
    reoffer_queue_item,
    remint_judge,
)
from .expiry_ownership import OWNER_KERNEL_REMINT, OWNER_OPERATOR, OWNER_PRODUCER, OWNER_REOFFER, owner_of
from .human_required import DEFAULT_SEVERITY, list_human_required, write_kernel_disposition
from .human_required_adjudication import _adjudications_path
from .judge_subject_liveness import JudgeSubjectLiveness
from .ledger import load_declared_jsonl
from .request_admission import RequestAdmissionThrottled
from .tool_registry import append_tools_governance

ANCHOR_STALE_KIND = "anchor_stale"

# Decisions per sweep. The 2026-10-07 backlog (170 open records and about
# 440 expiries with no decision) clears in about twelve sweeps, newest first.
ANCHOR_STALE_DISPOSITIONS_PER_SWEEP = 50

ACTION_RECOVERED = "recovered"
ACTION_OPERATOR = "operator"
ACTION_PRODUCER_OWNED = "producer_owned"
ACTION_REOFFER = "reoffer"
ACTION_DROP = "drop"
ACTION_REMINT = "remint"
ACTION_WAIT = "wait"

STARTED_GOVERNANCE_KIND = "anchor_stale_disposition_started"
DISPOSED_GOVERNANCE_KIND = "human_required_kernel_disposed"


@dataclass(frozen=True)
class ExpiryDecision:
    """What the kernel does with one expired request: ``action`` and its named ``reason``."""

    action: str
    reason: str
    successor_request_id: str | None = None


@dataclass(frozen=True)
class Lineage:
    """A request's ``remint_of`` ancestry: every ancestor, and those whose expiry spent budget."""

    depth: int
    budget_spent: int


def decide_expiry_disposition(
    request: Mapping[str, Any],
    cause: ExpiryCause,
    *,
    owner: tuple[str, str],
    successor_request_id: str | None,
    lineage: Lineage,
    subjects: Any,
    backlog_full: Callable[[str], bool],
) -> ExpiryDecision:
    """THE rule (module docstring) for one ANCHOR_STALE request.

    ``owner`` is ``expiry_ownership.owner_of(request, ...)``; ``subjects``
    answers ``closure_reason(request)`` (``JudgeSubjectLiveness``) and is
    read only for a judge whose backlog has room.
    """
    if successor_request_id is not None:
        return ExpiryDecision(ACTION_RECOVERED, "successor_exists", successor_request_id)
    kind, detail = owner
    if kind == OWNER_OPERATOR:
        return ExpiryDecision(ACTION_OPERATOR, detail)
    if kind == OWNER_PRODUCER:
        return ExpiryDecision(ACTION_PRODUCER_OWNED, f"producer_owned:{detail}")
    if kind == OWNER_REOFFER:
        return ExpiryDecision(ACTION_REOFFER, f"reoffer:{detail}")
    role = str(request.get("role") or "")
    if backlog_full(role):
        return ExpiryDecision(ACTION_WAIT, "judge_backlog_full")
    closed = subjects.closure_reason(request)
    if closed is not None:
        return ExpiryDecision(ACTION_DROP, f"subject_closed:{closed}")
    if lineage.depth >= MAX_EXPIRY_LINEAGE_REMINTS:
        return ExpiryDecision(ACTION_OPERATOR, "lineage_remint_cap_reached")
    if cause.spends_remint_budget and lineage.budget_spent >= ANCHOR_STALE_REMINT_BUDGET:
        return ExpiryDecision(ACTION_OPERATOR, "remint_budget_spent")
    return ExpiryDecision(ACTION_REMINT, "subject_live")


def _causes(claims: list[dict[str, Any]]) -> dict[str, ExpiryCause]:
    """Each expired request's cause, from its terminal ``anchor_stale`` claim row."""
    return {
        str(row["request_id"]): ExpiryCause.from_reason(str(row.get("reason") or ""))
        for row in claims if row.get("event") == "anchor_stale" and row.get("request_id")
    }


def _lineage(by_id: Mapping[str, Mapping[str, Any]], causes: Mapping[str, ExpiryCause], rid: str) -> Lineage:
    depth = spent = 0
    seen = {rid}
    current = by_id.get(rid)
    while current is not None and current.get("remint_of"):
        parent = str(current["remint_of"])
        if parent in seen:
            break
        seen.add(parent)
        depth += 1
        cause = causes.get(parent)
        # Only an outage expiry is free; an ancestor that died otherwise spends.
        if cause is None or cause.spends_remint_budget:
            spent += 1
        current = by_id.get(parent)
    return Lineage(depth=depth, budget_spent=spent)


def _panel_request_ids(root: Path) -> dict[str, list[str]]:
    panels: dict[str, list[str]] = {}
    for row in load_declared_jsonl(_adjudications_path(root), expected_surface="human_required_adjudications"):
        panels.setdefault(str(row.get("escalation_request_id")), []).extend(str(r) for r in row.get("request_ids") or [])
    return panels


def _record_ids(root: Path) -> set[str]:
    directory = root / "human-required"
    return {path.stem for path in directory.glob("*.json")} if directory.exists() else set()


def _undecided_open_records(root: Path) -> list[dict[str, Any]]:
    """Open anchor_stale records the kernel has not decided (the pre-ARIA-HIGH-360 panel questions)."""
    return [
        record for record in list_human_required(base_dir=root)
        if (record.get("context") or {}).get("kind") == ANCHOR_STALE_KIND
        and record.get("request_id") and "kernel_disposition" not in record
    ]


def _notify_operator(root: Path, handed: list[str], now: datetime) -> None:
    """One notification per batch for the records left open for the operator."""
    if not handed:
        return
    from .notify import notify_best_effort

    notify_best_effort(
        kind="human_required_opened", key=f"anchor-stale:{handed[0]}:{len(handed)}", base_dir=root, now=now,
        title=f"ARIA: {len(handed)} expired request(s) need an operator",
        body="No producer recovers these expired requests; each record names why.\n" + "\n".join(handed[:50]),
    )


def dispose_anchor_stale_requests(
    *,
    root: Path,
    requests: list[dict[str, Any]],
    states: Mapping[str, str],
    claims: list[dict[str, Any]],
    now: datetime | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    """Apply ``decide_expiry_disposition`` to the expired requests (module docstring).

    ``requests``, ``states`` and ``claims`` are the caller's one load of the
    request ledgers (``agent_invocations.load_request_ledgers``).
    """
    reference = now or datetime.now(timezone.utc)
    by_id = {str(r["request_id"]): r for r in requests if r.get("request_id")}
    order = {rid: position for position, rid in enumerate(by_id)}
    successor_of = {str(r["remint_of"]): str(r["request_id"]) for r in requests if r.get("remint_of") and r.get("request_id")}
    open_records = sorted(_undecided_open_records(root), key=lambda r: -order.get(str(r["request_id"]), len(order)))
    recorded = _record_ids(root)
    stale = [r for r in reversed(requests) if r.get("request_id") and states.get(str(r["request_id"])) == "ANCHOR_STALE"
             and str(r["request_id"]) not in recorded]
    panels = _panel_request_ids(root) if open_records or any(
        r.get("role") == "human_required_adjudication" for r in stale) else {}
    panel_ids = frozenset(rid for ids in panels.values() for rid in ids)
    gate = RemintGate(root, requests, states, cycle_id=cycle_id)
    owners = {str(r["request_id"]): owner_of(r, panel_ids) for r in stale}
    for record in open_records:
        request = by_id.get(str(record["request_id"]))
        if request is not None:
            owners[str(request["request_id"])] = owner_of(request, panel_ids)
    work: list[tuple[str, dict[str, Any] | None, dict[str, Any] | None]] = [
        (str(record["request_id"]), by_id.get(str(record["request_id"])), record) for record in open_records
    ] + [
        (str(r["request_id"]), r, None) for r in stale
        if owners[str(r["request_id"])][0] != OWNER_PRODUCER and str(r["request_id"]) not in successor_of
    ]
    waiting = [rid for rid, request, _record in work if request is not None and rid not in successor_of
               and owners[rid][0] == OWNER_KERNEL_REMINT and gate.full(str(request.get("role") or ""))]
    waiting_ids = set(waiting)
    # ARIA-HIGH-364 (re-review of #1833, HIGH-A) — the bound counts decided
    # items, not examined ones. A re-mint the request-admission door refuses
    # waits like a full judge backlog: no record, retried next cycle, and it
    # does not take one of the sweep's slots. Slicing the first items of
    # `work` instead re-planned the same newest refused judges every cycle
    # while the backlog stayed over budget, and the open records and other
    # expiries behind them (operator hand-offs, re-offers, drops) were never
    # decided.
    candidates = [item for item in work if item[0] not in waiting_ids]
    summary: dict[str, Any] = {"disposed": [], "waiting_judge_backlog_full": len(waiting),
                               "waiting_sample": waiting[:20], "bound": ANCHOR_STALE_DISPOSITIONS_PER_SWEEP}
    if not candidates:
        return summary
    causes = _causes(claims)
    subjects = JudgeSubjectLiveness(base_dir=root, now=reference)
    planned: list[tuple[str, dict[str, Any], dict[str, Any] | None, ExpiryCause, ExpiryDecision]] = []
    waiting_admission: list[str] = []
    for rid, request, record in candidates:
        if len(planned) >= ANCHOR_STALE_DISPOSITIONS_PER_SWEEP:
            break
        cause = causes.get(rid, ExpiryCause.from_reason(""))
        if request is None:
            # Only an open record can name a request the ledger lacks.
            context = dict((record or {}).get("context") or {})
            planned.append((rid, dict(context, request_id=rid), record, cause,
                            ExpiryDecision(ACTION_OPERATOR, "request_not_in_ledger")))
            continue
        decision = decide_expiry_disposition(
            request, cause, owner=owners[rid], successor_request_id=successor_of.get(rid),
            lineage=_lineage(by_id, causes, rid), subjects=subjects, backlog_full=gate.full,
        )
        if decision.action == ACTION_WAIT:
            # The re-mints planned above filled the backlog.
            waiting.append(rid)
            continue
        if decision.action == ACTION_REMINT:
            if gate.refusal(request) is not None:
                waiting_admission.append(rid)
                continue
            gate.minted(str(request.get("role") or ""))
        planned.append((rid, request, record, cause, decision))
    summary["waiting_judge_backlog_full"] = len(waiting)
    summary["waiting_sample"] = waiting[:20]
    summary["waiting_request_admission"] = len(waiting_admission)
    # Written before any effect, so a crash mid-batch leaves the plan on the
    # ledger; the next sweep decides the unwritten items again.
    append_tools_governance(root, STARTED_GOVERNANCE_KIND, {
        "count": len(planned),
        "planned": [{"request_id": rid, "action": d.action, "reason": d.reason} for rid, _r, _c, _x, d in planned],
    })
    disposed: list[dict[str, Any]] = []
    throttled: list[dict[str, str]] = []
    for rid, request, record, cause, decision in planned:
        try:
            effect = _effect(decision, request, root=root, requests=requests, subjects=subjects, gate=gate)
        except RequestAdmissionThrottled as refusal:
            # ARIA-HIGH-364 (review of #1833, MEDIUM-5) — the door refused the
            # re-mint this cycle: no record, so the next sweep decides the
            # request again. Never the operator's.
            throttled.append({"request_id": rid, "reason": str(refusal)})
            continue
        except Exception as exc:  # noqa: BLE001 — one item's failure is recorded by name, never the batch's
            # Review of PR #1825: an uncaught mint error aborted the sweep on
            # the newest item, so every later cycle stopped at the same one.
            # The failed effect is the operator's, named with its error.
            effect = operator_required(f"disposition_effect_failed:{type(exc).__name__}", error=str(exc)[:300])
        disposition = {"role": request.get("role"), "expiry_reason": cause.reason,
                       "expiry_fault_class": cause.fault_class, **effect}
        if record is not None:
            disposition["closed_panel_request_ids"] = panels.get(rid, [])
        written = write_kernel_disposition(item={
            "request_id": rid, "severity": str(request.get("severity") or DEFAULT_SEVERITY),
            "reason": f"request {rid!r} expired ANCHOR_STALE unclaimed",
            "context": {"kind": ANCHOR_STALE_KIND, "request_id": rid,
                        "role": request.get("role"), "target_agent": request.get("target_agent")},
            "status": DISPOSITION_STATUS[effect["disposition"]], "disposition": disposition,
        }, base_dir=root, now=reference)
        if written is not None:
            disposed.append({"request_id": rid, "migrated": record is not None, **disposition})
    append_tools_governance(root, DISPOSED_GOVERNANCE_KIND, {"count": len(disposed), "dispositions": disposed})
    _notify_operator(root, [d["request_id"] for d in disposed if d["disposition"] == DISPOSITION_OPERATOR], reference)
    summary["disposed"] = disposed
    summary["throttled_retry"] = throttled
    return summary


def _effect(
    decision: ExpiryDecision, request: Mapping[str, Any], *, root: Path, requests: list[dict[str, Any]],
    subjects: JudgeSubjectLiveness, gate: RemintGate,
) -> dict[str, Any]:
    if decision.action == ACTION_RECOVERED:
        return {"disposition": DISPOSITION_REMINTED, "reason": decision.reason,
                "successor_request_id": decision.successor_request_id}
    if decision.action == ACTION_PRODUCER_OWNED:
        return {"disposition": DISPOSITION_PRODUCER_OWNED, "reason": decision.reason}
    if decision.action == ACTION_DROP:
        return {"disposition": DISPOSITION_DROPPED, "reason": decision.reason}
    if decision.action == ACTION_REOFFER:
        return reoffer_queue_item(root, request, requests)
    if decision.action == ACTION_REMINT:
        return remint_judge(request, decision.reason, subjects=subjects, gate=gate)
    return operator_required(decision.reason)


__all__ = [
    "ACTION_DROP",
    "ACTION_OPERATOR",
    "ACTION_PRODUCER_OWNED",
    "ACTION_RECOVERED",
    "ACTION_REMINT",
    "ACTION_REOFFER",
    "ACTION_WAIT",
    "ANCHOR_STALE_DISPOSITIONS_PER_SWEEP",
    "ANCHOR_STALE_KIND",
    "DISPOSED_GOVERNANCE_KIND",
    "ExpiryDecision",
    "Lineage",
    "STARTED_GOVERNANCE_KIND",
    "decide_expiry_disposition",
    "dispose_anchor_stale_requests",
]
