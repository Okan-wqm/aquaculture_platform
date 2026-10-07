"""The effects of an anchor-stale decision: re-mint, re-offer, or hand to the operator (ARIA-HIGH-360).

``anchor_stale.decide_expiry_disposition`` decides; this module carries the
decision out and returns what the record says. A decided effect that cannot
be carried out (a mint the queue refuses, an item the queue cannot take
back) is handed to the operator by name, never dropped: no work may be lost
inside ARIA (review of PR #1825).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from .expiry_ownership import queue_item_id_of
from .judge_fanout import pending_judge_counts
from .judge_remint import remint_judge_request
from .judge_subject_liveness import JudgeSubjectLiveness
from .request_admission import RequestAdmissionThrottled, admit_request, inherits_critical_path
from .tool_registry import GovernanceError, bound_workspace_root

DISPOSITION_REMINTED = "expired_reminted"
DISPOSITION_REOFFERED = "expired_reoffered"
DISPOSITION_DROPPED = "expired_dropped"
DISPOSITION_PRODUCER_OWNED = "expired_producer_owned"
DISPOSITION_OPERATOR = "expired_operator_required"

# The record status each disposition leaves (`human_required.KERNEL_DISPOSITION_STATUSES`).
DISPOSITION_STATUS: Mapping[str, str] = {
    DISPOSITION_REMINTED: "resolved",
    DISPOSITION_REOFFERED: "resolved",
    DISPOSITION_DROPPED: "resolved",
    DISPOSITION_PRODUCER_OWNED: "resolved",
    DISPOSITION_OPERATOR: "open",
}


class RemintGate:
    """The judge backlog ceiling and the current HEAD, each read at most once per sweep."""

    def __init__(self, root: Path, requests: list[dict[str, Any]], states: Mapping[str, str],
                 cycle_id: str | None = None) -> None:
        self._root = root
        # ARIA-HIGH-364 — the cycle a re-mint's admission is budgeted under.
        self.cycle_id = cycle_id
        self._requests = requests
        self._states = states
        self._pending: dict[str, int] | None = None
        self._ceiling = 0
        self._head: str | None = None
        self._head_read = False
        self.workspace = bound_workspace_root(root)

    def full(self, role: str) -> bool:
        """The fan-out's own ceiling (`judgment_pipeline.max_pending_per_role`), from rows in hand."""
        if self._pending is None:
            from .genesis_policy import judgment_pipeline_policy

            self._pending = pending_judge_counts(base_dir=self._root, states=self._states, requests=self._requests)
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
        """Reserve a planned re-mint against the ceiling before it is minted."""
        if self._pending is not None:
            self._pending[role] = self._pending.get(role, 0) + 1


def operator_required(reason: str, **extra: Any) -> dict[str, Any]:
    return {"disposition": DISPOSITION_OPERATOR, "reason": reason, **extra}


def _anchor_remint_producer(request: Mapping[str, Any]) -> str:
    """The class a re-asked judge inherits from its expired predecessor (ARIA-HIGH-364)."""
    return "anchor_stale.remint_critical" if inherits_critical_path(request) else "anchor_stale.remint"


def remint_judge(
    request: Mapping[str, Any], reason: str, *, subjects: JudgeSubjectLiveness, gate: RemintGate,
) -> dict[str, Any]:
    """Re-mint as the fan-out mints; its contract refusal closes the subject, a refused mint is the operator's.

    ARIA-HIGH-364 (review of #1833, MEDIUM-5) — a re-mint the request-admission
    door refuses is neither: it raises ``RequestAdmissionThrottled`` past the
    operator arm, and the sweep records nothing for the request, so the next
    sweep decides it again. Routed to the operator, a throttle would open an
    escalation and feed the panels (the amplifier ARIA-HIGH-360 removes).
    """
    admission = admit_request(
        _anchor_remint_producer(request), str(request.get("role") or ""),
        base_dir=subjects.root, cycle_id=gate.cycle_id,
    )
    if not admission.admitted:
        raise RequestAdmissionThrottled(admission.refusal)
    try:
        successor = remint_judge_request(request, subjects=subjects, target_sha=gate.head(),
                                         workspace=gate.workspace, admission=admission)
    except RequestAdmissionThrottled:
        raise
    except GovernanceError as exc:
        return operator_required("remint_refused", error=str(exc)[:300])
    if isinstance(successor, str):
        return {"disposition": DISPOSITION_DROPPED, "reason": f"subject_closed:{successor}"}
    return {"disposition": DISPOSITION_REMINTED, "reason": reason,
            "successor_request_id": str(successor.get("request_id")), "target_sha": gate.head()}


def reoffer_queue_item(root: Path, request: Mapping[str, Any], requests: list[dict[str, Any]]) -> dict[str, Any]:
    """Put a projected maintenance request's queue item back, inside the producer's own remint budget."""
    from .autonomy_orchestrator import _MAX_QUEUE_ITEM_REMINTS
    from .next_cycle_queue import REOFFER_ALREADY_PENDING, REOFFERED, reoffer_item

    qid = str(queue_item_id_of(request) or "")
    # The orchestrator's own lineage count (autonomy_orchestrator
    # `_drain_next_cycle_queue` remint_exhausted arm):
    # past it the projection discloses the item exhausted and consumes it.
    lineage = sum(1 for row in requests if row.get("remint_of") and qid in str(row.get("suggested_prompt") or ""))
    if lineage >= _MAX_QUEUE_ITEM_REMINTS:
        return operator_required("queue_remint_budget_spent", queue_item_id=qid)
    outcome = reoffer_item(root, queue_item_id=qid, reason=f"anchor_stale:{request.get('request_id')}")
    if outcome not in (REOFFERED, REOFFER_ALREADY_PENDING):
        return operator_required(f"queue_item_not_reofferable:{outcome}", queue_item_id=qid)
    return {"disposition": DISPOSITION_REOFFERED, "reason": f"queue_item_{outcome}", "queue_item_id": qid}


__all__ = [
    "DISPOSITION_DROPPED",
    "DISPOSITION_OPERATOR",
    "DISPOSITION_PRODUCER_OWNED",
    "DISPOSITION_REMINTED",
    "DISPOSITION_REOFFERED",
    "DISPOSITION_STATUS",
    "RemintGate",
    "operator_required",
    "reoffer_queue_item",
    "remint_judge",
]
