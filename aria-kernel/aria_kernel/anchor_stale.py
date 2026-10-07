"""The kernel decides what happens to a request that expired unclaimed (ARIA-HIGH-360).

WHY (measured 2026-10-06 on a copy of the runner store, 1,866 requests). A
request nobody claims inside its anchor window derives ANCHOR_STALE. Y7
(ORPHAN-708) recorded a HUMAN_REQUIRED record for each one, so the work was
not lost without a trace, and admitted the record kind to the adjudication
panel. Each record opened a three-judge panel: three new requests on the
queue that had just failed to reach the first one, and they expired the same
way. 693 of the 1,866 requests were these panels. All 3,023 panel folds were
``still_escalated`` and none of the 213 open records was ever resolved. On
2026-09-29 one sweep opened 99 panels (297 requests). Expiry is a fact about
the queue. It is not a question for a panel.

THE RULE is one function, ``decide_expiry_disposition``, which takes the
request, its expiry cause and the facts it needs, and returns one decision:

1. A role whose producer already handles its own dead requests is left to
   it, with no record: the planning-round roles (the convergence drainer's
   step rule, ``step_request``) and the adjudication panel (its re-open
   budget in ``human_required_adjudication``).
2. A request that already has a ``remint_of`` successor was recovered by the
   lane that minted the successor.
3. A judge request (the fan-out's two roles) whose finding still needs that
   judge (``judge_subject_liveness``) is re-minted once against the current
   HEAD, with ``remint_of`` lineage, while that judge role's backlog is under
   the fan-out's own ceiling. Over the ceiling it waits for a later sweep: a
   mint the queue cannot absorb only expires again.
4. Everything else is dropped with its reason: ``role_not_remintable``,
   ``remint_budget_spent``, ``subject_closed:<rule>``,
   ``obligations_unmintable`` or ``remint_refused``.

THE EXPIRY CAUSE (``ExpiryCause``) is the ``reason`` on the request's
``anchor_stale`` claim row, classified by the one release-reason table
(``agent_invocations.classify_release_reason``). A harness-class expiry (the
host or a provider could not serve the queue) says nothing about the
request, so it does not spend the re-mint budget, the same rule the claim
requeue counter applies to a harness-class release. This module owns no
clock and no fault table: when the expiry clock or the harness-class expiry
reasons change (ARIA-HIGH-365), the decision follows without an edit here.

THE BACKLOG. ``dispose_anchor_stale_requests`` runs inside the lease sweep
every kernel cycle. Records an earlier sweep opened for the panel (170 open
on 2026-10-07) go through the same rule first and are closed in place; then
the expiries with no record, newest first. Both share the per-sweep bound.
A resolved record, a producer-owned role and a request with a successor are
skipped, so the migration is idempotent and needs no operator step. Every
decision is a resolved record in the human-required directory
(``human_required.record_kernel_dispositions``), where an operator looks for
work that did not happen.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from .agent_invocations import _claims_path, classify_release_reason, create_agent_invocation_request
from .human_required import DEFAULT_SEVERITY, list_human_required, record_kernel_dispositions
from .human_required_adjudication import ADJUDICATION_ROLE, _adjudications_path
from .judge_fanout import JUDGE_FANOUT, pending_judge_counts
from .judge_subject_liveness import JudgeSubjectLiveness
from .ledger import load_declared_jsonl
from .must_satisfy import upcast_sealed_items
from .plan_round_scope import PLANNING_ROUND_ROLES
from .tool_registry import GovernanceError, bound_workspace_root

# The context kind of a record about an expired request. Records of this kind
# written before ARIA-HIGH-360 were open panel questions; they stay readable,
# and the disposition below closes them.
ANCHOR_STALE_KIND = "anchor_stale"

# Request-class expiries one lineage may re-mint after. A successor that
# expires as well, for a reason of its own, has shown the queue cannot reach
# it; asking a third time only adds to the backlog that made it expire.
ANCHOR_STALE_REMINT_BUDGET = 1

# Decisions per sweep. A drop costs a file write; a re-mint is also bounded
# by the judge backlog ceiling. The 2026-10-07 backlog (170 open records and
# about 440 expiries with no decision) clears in about twelve sweeps, and the
# newest expiries, the only ones whose subject can still be live, go first.
ANCHOR_STALE_DISPOSITIONS_PER_SWEEP = 50

DISPOSITION_REMINTED = "expired_reminted"
DISPOSITION_DROPPED = "expired_dropped"
DISPOSITION_PRODUCER_OWNED = "expired_producer_owned"

# The decision's action vocabulary.
ACTION_PRODUCER_OWNED = "producer_owned"
ACTION_RECOVERED = "recovered"
ACTION_REMINT = "remint"
ACTION_DROP = "drop"
ACTION_WAIT = "wait"

REMINTABLE_ROLES: frozenset[str] = frozenset(role for role, _agent in JUDGE_FANOUT)

# The roles whose producer disposes of its own dead requests, and that
# producer. The convergence drainer re-mints or escalates a planning step
# (`step_request`); an adjudication envelope belongs to its panel's re-open
# budget. The sweep writes nothing for them.
PRODUCER_OWNED_ROLES: Mapping[str, str] = {
    **{role: "convergence_drainer" for role in PLANNING_ROUND_ROLES},
    ADJUDICATION_ROLE: "adjudication_panel",
}

HARNESS_FAULT_CLASS = "harness"


@dataclass(frozen=True)
class ExpiryCause:
    """Why a request derived ANCHOR_STALE: its claim row's reason and that reason's fault class."""

    reason: str
    fault_class: str

    @classmethod
    def from_reason(cls, reason: str) -> "ExpiryCause":
        return cls(reason=reason, fault_class=classify_release_reason(reason))

    @property
    def spends_remint_budget(self) -> bool:
        """A harness-class expiry says nothing about the request (module docstring)."""
        return self.fault_class != HARNESS_FAULT_CLASS


@dataclass(frozen=True)
class ExpiryDecision:
    """What the kernel does with one expired request: ``action`` and its named ``reason``."""

    action: str
    reason: str
    successor_request_id: str | None = None


def decide_expiry_disposition(
    request: Mapping[str, Any],
    cause: ExpiryCause,
    *,
    successor_request_id: str | None,
    budget_spent: int,
    subjects: JudgeSubjectLiveness,
    backlog_full: Callable[[str], bool],
) -> ExpiryDecision:
    """THE rule (module docstring), for one ANCHOR_STALE request.

    ``budget_spent`` is the number of request-class expiries in the request's
    ``remint_of`` ancestry (``_budget_spent``). ``cause`` is this request's
    own expiry: a harness-class one re-mints a live subject whatever the
    ancestry spent, because the expiry was not the request's.
    """
    role = str(request.get("role") or "")
    owner = PRODUCER_OWNED_ROLES.get(role)
    if owner is not None:
        return ExpiryDecision(ACTION_PRODUCER_OWNED, f"producer_owned:{owner}")
    if successor_request_id is not None:
        return ExpiryDecision(ACTION_RECOVERED, "successor_exists", successor_request_id)
    if role not in REMINTABLE_ROLES:
        return ExpiryDecision(ACTION_DROP, "role_not_remintable")
    if cause.spends_remint_budget and budget_spent >= ANCHOR_STALE_REMINT_BUDGET:
        return ExpiryDecision(ACTION_DROP, "remint_budget_spent")
    closed = subjects.closure_reason(request)
    if closed is not None:
        return ExpiryDecision(ACTION_DROP, f"subject_closed:{closed}")
    if backlog_full(role):
        return ExpiryDecision(ACTION_WAIT, "judge_backlog_full")
    return ExpiryDecision(ACTION_REMINT, "subject_live")


def mint_successor(
    root: Path,
    dead: Mapping[str, Any],
    *,
    must_satisfy: list[dict[str, Any]],
    target_sha: str | None,
    context_repo_root: Path | None = None,
    extra_evidence_refs: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Mint the successor of a dead request, ``remint_of`` naming it (the Y3 shape).

    The ONE copy of what a successor carries, shared with the panel's
    ``re_mint`` disposition. The dead row is never resurrected. Its task
    (prompt, scopes, subject ids) is copied; the anchor is the caller's.
    ``must_satisfy`` is the caller's upcast of the sealed obligations
    (``must_satisfy.upcast_sealed_items``), because each caller names its own
    refusal when they cannot be minted.
    """
    return create_agent_invocation_request(
        target_agent=str(dead.get("target_agent") or ""),
        role=str(dead.get("role") or ""),
        suggested_prompt=str(dead.get("suggested_prompt") or ""),
        must_satisfy=must_satisfy,
        allowed_scope=list(dead.get("allowed_scope") or []),
        # A judge's forbidden_scope bounds what a true_positive may stand on.
        forbidden_scope=list(dead.get("forbidden_scope") or []),
        evidence_refs=list(dead.get("evidence_refs") or []) + list(extra_evidence_refs),
        convergence_id=dead.get("convergence_id"),
        round_number=dead.get("round_number"),
        pressure_event_id=dead.get("pressure_event_id"),
        finding_id=dead.get("finding_id"),
        finding_fingerprint=dead.get("finding_fingerprint"),
        tool_id=dead.get("tool_id"),
        run_id=dead.get("run_id"),
        judgment_group_id=dead.get("judgment_group_id"),
        target_sha=target_sha,
        remint_of=str(dead.get("request_id") or ""),
        context_repo_root=context_repo_root,
        base_dir=root,
    )


class _RemintGate:
    """The judge backlog ceiling and the current HEAD, each read at most once per sweep."""

    def __init__(self, root: Path, states: Mapping[str, str]) -> None:
        self._root = root
        self._states = states
        self._pending: dict[str, int] | None = None
        self._ceiling = 0
        self._head: str | None = None
        self._head_read = False
        self.workspace = bound_workspace_root(root)

    def full(self, role: str) -> bool:
        """The fan-out's own ceiling (`judgment_pipeline.max_pending_per_role`)."""
        if self._pending is None:
            from .genesis_policy import judgment_pipeline_policy

            self._pending = pending_judge_counts(base_dir=self._root, states=self._states)
            self._ceiling = int(judgment_pipeline_policy(self.workspace)["max_pending_per_role"])
        return self._pending.get(role, 0) >= self._ceiling

    def head(self) -> str | None:
        """The workspace HEAD a successor is anchored at (the fan-out's `target_sha`)."""
        if not self._head_read:
            from .convergence_drainer import _resolve_workspace_head_sha

            self._head = _resolve_workspace_head_sha(self.workspace)
            self._head_read = True
        return self._head

    def minted(self, role: str) -> None:
        if self._pending is not None:
            self._pending[role] = self._pending.get(role, 0) + 1


def _expiry_causes(root: Path) -> dict[str, ExpiryCause]:
    """Each ANCHOR_STALE request's cause, from its ``anchor_stale`` claim row (terminal, so one per request)."""
    causes: dict[str, ExpiryCause] = {}
    for row in load_declared_jsonl(_claims_path(root), expected_surface="agent_invocation_claims"):
        if row.get("event") == "anchor_stale" and row.get("request_id"):
            causes[str(row["request_id"])] = ExpiryCause.from_reason(str(row.get("reason") or ""))
    return causes


def _budget_spent(
    by_id: Mapping[str, Mapping[str, Any]], causes: Mapping[str, ExpiryCause], request_id: str,
) -> int:
    """Request-class expiries in the ``remint_of`` ancestry of ``request_id``.

    An ancestor that died any other way (a panel ``re_mint`` of a lease
    death) spends the budget too: only a harness-class expiry is free.
    """
    spent = 0
    seen: set[str] = {request_id}
    current = by_id.get(request_id)
    while current is not None and current.get("remint_of"):
        parent = str(current["remint_of"])
        if parent in seen:
            break
        seen.add(parent)
        cause = causes.get(parent)
        if cause is None or cause.spends_remint_budget:
            spent += 1
        current = by_id.get(parent)
    return spent


def _panel_request_ids(root: Path) -> dict[str, list[str]]:
    """Every panel envelope minted per escalation, from the adjudication ledger."""
    panels: dict[str, list[str]] = {}
    for row in load_declared_jsonl(_adjudications_path(root), expected_surface="human_required_adjudications"):
        panels.setdefault(str(row.get("escalation_request_id")), []).extend(
            str(rid) for rid in row.get("request_ids") or []
        )
    return panels


def _apply(
    decision: ExpiryDecision, request: Mapping[str, Any], *, root: Path, gate: _RemintGate,
) -> dict[str, Any]:
    """The recorded disposition of a decision; a re-mint is minted here."""
    if decision.action == ACTION_PRODUCER_OWNED:
        return {"disposition": DISPOSITION_PRODUCER_OWNED, "reason": decision.reason}
    if decision.action == ACTION_RECOVERED:
        return {"disposition": DISPOSITION_REMINTED, "reason": decision.reason,
                "successor_request_id": decision.successor_request_id}
    if decision.action == ACTION_DROP:
        return {"disposition": DISPOSITION_DROPPED, "reason": decision.reason}
    role = str(request.get("role") or "")
    try:
        must_satisfy = upcast_sealed_items(request.get("must_satisfy") or [])
    except GovernanceError as exc:
        return {"disposition": DISPOSITION_DROPPED, "reason": "obligations_unmintable", "error": str(exc)[:300]}
    try:
        successor = mint_successor(root, request, must_satisfy=must_satisfy, target_sha=gate.head(),
                                   context_repo_root=gate.workspace)
    except GovernanceError as exc:
        return {"disposition": DISPOSITION_DROPPED, "reason": "remint_refused", "error": str(exc)[:300]}
    gate.minted(role)
    return {"disposition": DISPOSITION_REMINTED, "reason": decision.reason,
            "successor_request_id": str(successor.get("request_id")), "target_sha": gate.head()}


def _open_anchor_stale_records(root: Path) -> list[dict[str, Any]]:
    """The records an earlier sweep opened as panel questions about an expiry."""
    return [
        record for record in list_human_required(base_dir=root)
        if (record.get("context") or {}).get("kind") == ANCHOR_STALE_KIND and record.get("request_id")
    ]


def _record_ids(root: Path) -> set[str]:
    """Every request id with a human-required record, open or resolved: one directory listing."""
    directory = root / "human-required"
    return {path.stem for path in directory.glob("*.json")} if directory.exists() else set()


def dispose_anchor_stale_requests(
    *,
    root: Path,
    requests: list[dict[str, Any]],
    states: Mapping[str, str],
    now: datetime | None = None,
) -> dict[str, Any]:
    """Apply ``decide_expiry_disposition`` to the ANCHOR_STALE requests in ``states``.

    ``requests`` and ``states`` are the caller's one ledger load
    (ARIA-HIGH-358). Open ``anchor_stale`` records go first, newest request
    first: until they close, their panel envelopes are a question the panel
    sweep no longer reads. A record whose request row is not in the ledger
    names nothing to re-mint and is dropped as ``request_not_in_ledger``.
    Then the expiries with no record, newest first, because only a recent one
    can still have a live subject. Idempotent: a resolved record is never
    read again, and a producer-owned role or a request with a successor gets
    no record unless an earlier sweep opened one.
    """
    reference = now or datetime.now(timezone.utc)
    by_id = {str(r["request_id"]): r for r in requests if r.get("request_id")}
    order = {rid: position for position, rid in enumerate(by_id)}
    successor_of = {str(r["remint_of"]): str(r["request_id"]) for r in requests
                    if r.get("remint_of") and r.get("request_id")}
    open_records = sorted(
        _open_anchor_stale_records(root),
        key=lambda record: -order.get(str(record["request_id"]), len(order)),
    )
    recorded = _record_ids(root)
    fresh = [
        request for request in reversed(requests)
        if request.get("request_id") and states.get(str(request["request_id"])) == "ANCHOR_STALE"
        and str(request["request_id"]) not in recorded
        and str(request.get("role") or "") not in PRODUCER_OWNED_ROLES
        and str(request["request_id"]) not in successor_of
    ]
    if not open_records and not fresh:
        return {"disposed": [], "waiting_judge_backlog_full": 0, "waiting_sample": [],
                "bound": ANCHOR_STALE_DISPOSITIONS_PER_SWEEP}
    causes = _expiry_causes(root)
    subjects = JudgeSubjectLiveness(base_dir=root, now=reference)
    gate = _RemintGate(root, states)
    panels = _panel_request_ids(root) if open_records else {}
    work: list[tuple[str, dict[str, Any] | None, dict[str, Any] | None]] = [
        (str(record["request_id"]), by_id.get(str(record["request_id"])), record) for record in open_records
    ] + [(str(request["request_id"]), request, None) for request in fresh]
    decided: list[dict[str, Any]] = []
    waiting: list[str] = []
    for rid, request, record in work:
        if len(decided) >= ANCHOR_STALE_DISPOSITIONS_PER_SWEEP:
            break
        cause = causes.get(rid, ExpiryCause.from_reason(""))
        if request is None:
            # Only an open record can name a request the ledger lacks.
            disposition = {"disposition": DISPOSITION_DROPPED, "reason": "request_not_in_ledger"}
            request = dict((record or {}).get("context") or {}, request_id=rid)
        else:
            decision = decide_expiry_disposition(
                request, cause, successor_request_id=successor_of.get(rid),
                budget_spent=_budget_spent(by_id, causes, rid), subjects=subjects, backlog_full=gate.full,
            )
            if decision.action == ACTION_WAIT:
                waiting.append(rid)
                continue
            disposition = _apply(decision, request, root=root, gate=gate)
        disposition = {"role": request.get("role"), "expiry_reason": cause.reason,
                       "expiry_fault_class": cause.fault_class, **disposition}
        if record is not None:
            # The record leaves the open list, so no sweep folds or re-opens
            # its panel, and the panel's unclaimed envelopes become moot.
            disposition["closed_panel_request_ids"] = panels.get(rid, [])
        decided.append({
            "request_id": rid,
            "severity": str(request.get("severity") or DEFAULT_SEVERITY),
            "reason": f"request {rid!r} expired ANCHOR_STALE unclaimed",
            "context": {"kind": ANCHOR_STALE_KIND, "request_id": rid,
                        "role": request.get("role"), "target_agent": request.get("target_agent")},
            "disposition": disposition,
            "migrated": record is not None,
        })
    record_kernel_dispositions(dispositions=decided, base_dir=root, now=reference)
    return {
        "disposed": [{"request_id": d["request_id"], "migrated": d["migrated"], **d["disposition"]} for d in decided],
        "waiting_judge_backlog_full": len(waiting),
        "waiting_sample": waiting[:20],
        "bound": ANCHOR_STALE_DISPOSITIONS_PER_SWEEP,
    }


__all__ = [
    "ACTION_DROP",
    "ACTION_PRODUCER_OWNED",
    "ACTION_RECOVERED",
    "ACTION_REMINT",
    "ACTION_WAIT",
    "ANCHOR_STALE_DISPOSITIONS_PER_SWEEP",
    "ANCHOR_STALE_KIND",
    "ANCHOR_STALE_REMINT_BUDGET",
    "DISPOSITION_DROPPED",
    "DISPOSITION_PRODUCER_OWNED",
    "DISPOSITION_REMINTED",
    "ExpiryCause",
    "ExpiryDecision",
    "PRODUCER_OWNED_ROLES",
    "REMINTABLE_ROLES",
    "decide_expiry_disposition",
    "dispose_anchor_stale_requests",
    "mint_successor",
]
