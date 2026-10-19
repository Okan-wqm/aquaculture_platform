"""Plan 026R §C.5 — agent-result bridge status ledger + crash recovery.

Pre-§C.5 the submit_claim_result accepted path invoked the three
bridges (judgment / supporting / plan_convergence per §C.1) and on
bridge failure ONLY emitted an ``agent_bridge_warning`` governance
event. The original result row stayed ``accepted`` but the bridge
side-effect (consensus engine + plan_convergence event ledger +
goldset/change-intel persistence) never landed; replay on the next
submit was idempotent-skip because the result row was already
present. The bridge debt was silent.

§C.5 closes this with three architectural pieces:

1. **``BRIDGE_REQUIRED_ROLES`` constant** — the roles whose
   acceptance is INCOMPLETE without a successful bridge. Acceptance
   for these roles writes ``bridge_status: "pending"`` on the
   results.jsonl row at write time. Roles NOT in this set get
   ``bridge_status: "not_required"`` immediately.

2. **NEW append-only ledger ``agent-result-bridge-status.jsonl``** —
   tracks every bridge invocation outcome per (result_row_ledger_
   hash, envelope_evidence_hash) pair. The transition enum is
   CLOSED: ``ok | pending_retry | not_required | permanent_fail``.
   Note ``pending`` is NOT a transition value — pending lives only
   on the result row's ``bridge_status`` field, never as a bridge-
   ledger transition. Each transition row records ``attempt_number``
   so retry budgets (env ``ARIA_BRIDGE_MAX_RETRIES``, default 3)
   are derivable from the ledger. ARIA-MEDIUM-172: a
   ``permanent_fail`` row also names ``terminal_reason``
   (``refused`` | ``retry_budget_exhausted``), and the retry-vs-terminal
   decision has ONE owner (``bridge_transition``), not three.

3. **Crash recovery rule** — a result row with
   ``bridge_status: "pending"`` and NO matching bridge-status
   ledger row is treated as ``"pending attempt 0"``: a crash
   between result-row write and bridge-ledger row write. Replay
   path re-invokes the bridge and writes the first bridge-ledger
   row (attempt_number=1).

4. **Result row in results.jsonl IMMUTABLE.** The ``bridge_status``
   field on the result row reflects the role at WRITE time and
   NEVER changes. Subsequent state lives in the bridge-status
   ledger — append-only, hash-chained via the §A.1 atomic primitive.

5. **``derive_request_state`` reads the bridge-status ledger** to
   resolve the new state ``ACCEPTED_PENDING_BRIDGE`` (between
   ``ACCEPTED`` and ``REJECTED`` in the operator-facing lifecycle).
   The terminal-set
   ``{ACCEPTED, REJECTED, STALE, CANCELLED, HUMAN_REQUIRED,
   ACCEPTED_PENDING_BRIDGE_PERMANENT_FAIL}`` keeps
   ``ACCEPTED_PENDING_BRIDGE`` NON-terminal so the F.1 orchestrator
   can retry.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .agent_surface import BRIDGE_REQUIRED_ROLES
from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, utc_now


# Plan 026R §C.5 — closed transition enum. ``pending`` is NOT here —
# pending lives only on the result row's ``bridge_status`` field.
BRIDGE_TRANSITIONS: frozenset[str] = frozenset({
    "ok",
    "pending_retry",
    "not_required",
    "permanent_fail",
})

# ARIA-MEDIUM-172 — why a row ended ``permanent_fail``. Closed vocabulary,
# validated at the write boundary: ``refused`` (every error deterministic —
# the same input is refused again) or ``retry_budget_exhausted`` (transient
# errors spent ARIA_BRIDGE_MAX_RETRIES). The 13 legacy terminal rows on live
# state predate the reason and carry none; readers never infer one.
BRIDGE_TERMINAL_REASONS: frozenset[str] = frozenset({
    "refused",
    "retry_budget_exhausted",
})


@dataclass(frozen=True)
class BridgeOutcome:
    """What ONE bridge invocation produced, split by kind (ARIA-MEDIUM-172).

    ``errors`` is every failure string (the pre-172 ``list[str]`` invoker
    contract); ``refused`` is the deterministic subset — refusals whose input
    is a pure function of the request/response pair, so a replay of the same
    sealed bytes is refused identically. ``refused`` is a subset of ``errors``
    by construction: the one recorder (``agent_invocations
    _invoke_bridges_for_result``) appends to both in the same except arm.
    """

    errors: tuple[str, ...] = ()
    refused: tuple[str, ...] = ()

    @classmethod
    def from_bridged(cls, bridged: dict[str, Any]) -> "BridgeOutcome":
        return cls(
            errors=tuple(str(item) for item in bridged.get("bridge_errors") or []),
            refused=tuple(str(item) for item in bridged.get("bridge_refusals") or []),
        )

    def detail(self) -> str:
        return "; ".join(self.errors)[:500]


def bridge_transition(
    outcome: BridgeOutcome, *, attempt: int, max_retries: int | None = None,
) -> tuple[str, str | None]:
    """The ONE owner of the retry-vs-terminal decision (ARIA-MEDIUM-172).

    Pre-172 three owners decided on the attempt count alone (the submit
    write, the replay write and the replay selector), so a contract refusal
    was retried until the budget ran out and a budget-spent row could be
    stranded invisible. Now: no errors -> ``ok``; every error deterministic
    -> ``permanent_fail``/``refused`` at this attempt; budget spent ->
    ``permanent_fail``/``retry_budget_exhausted``; otherwise
    ``pending_retry`` and the budget still owns the row.
    """
    if max_retries is None:
        max_retries = _default_max_retries()
    if not outcome.errors:
        return "ok", None
    if len(outcome.refused) == len(outcome.errors):
        return "permanent_fail", "refused"
    if attempt >= max_retries:
        return "permanent_fail", "retry_budget_exhausted"
    return "pending_retry", None


BRIDGE_LEDGER_FILENAME = "agent-result-bridge-status.jsonl"


def _bridge_ledger_path(root: Path) -> Path:
    return root / "agent-invocations" / BRIDGE_LEDGER_FILENAME


def _default_max_retries() -> int:
    """Plan 026R §C.5 — retry budget via env ``ARIA_BRIDGE_MAX_RETRIES``
    (default 3). Operators can tune for incident-response."""
    raw = os.environ.get("ARIA_BRIDGE_MAX_RETRIES", "3")
    try:
        value = int(raw)
    except ValueError:
        return 3
    return max(1, value)


def bridge_status_for_role(role: str | None) -> str:
    """Return the initial ``bridge_status`` field value for a result row.

    Roles in ``BRIDGE_REQUIRED_ROLES`` → ``"pending"`` (acceptance is
    incomplete until the bridge succeeds). All other roles →
    ``"not_required"`` (acceptance is terminal).
    """
    return "pending" if role in BRIDGE_REQUIRED_ROLES else "not_required"


def append_bridge_status(
    *,
    base_dir: str | Path,
    result_row_ledger_hash: str,
    envelope_evidence_hash: str,
    role: str | None,
    transition: str,
    attempt_number: int,
    error_detail: str | None = None,
    terminal_reason: str | None = None,
) -> dict[str, Any]:
    """Append an immutable bridge-status row to
    ``agent-invocations/agent-result-bridge-status.jsonl``.

    Schema (Plan 026R §C.5; ARIA-MEDIUM-172 adds the optional
    ``terminal_reason``):
        ``{recorded_at, result_row_ledger_hash, envelope_evidence_hash,
            role, transition, attempt_number, error_detail_if_any,
            terminal_reason_if_permanent_fail}``

    Transition enum is closed (``BRIDGE_TRANSITIONS``); unknown values
    raise ``GovernanceError`` at the boundary. A ``permanent_fail`` row
    MUST name why from ``BRIDGE_TERMINAL_REASONS`` — an unnamed terminal
    row is unauditable — and no other transition carries one.
    """
    if transition not in BRIDGE_TRANSITIONS:
        raise GovernanceError(
            f"bridge_transition_unknown: {transition!r} "
            f"(valid: {sorted(BRIDGE_TRANSITIONS)})"
        )
    if attempt_number < 0:
        raise GovernanceError(
            f"bridge_attempt_number_negative: {attempt_number}"
        )
    if transition == "permanent_fail":
        if terminal_reason not in BRIDGE_TERMINAL_REASONS:
            raise GovernanceError(
                f"bridge_terminal_reason_required: a permanent_fail row must "
                f"name why from {sorted(BRIDGE_TERMINAL_REASONS)}; got "
                f"{terminal_reason!r}"
            )
    elif terminal_reason is not None:
        raise GovernanceError(
            f"bridge_terminal_reason_not_allowed: only permanent_fail rows "
            f"carry a terminal_reason; {transition!r} got {terminal_reason!r}"
        )
    row = {
        "$schema": "aria/agent-result-bridge-status/v1",
        "schema_version": 1,
        "recorded_at": utc_now(),
        "result_row_ledger_hash": result_row_ledger_hash,
        "envelope_evidence_hash": envelope_evidence_hash,
        "role": role,
        "transition": transition,
        "attempt_number": attempt_number,
    }
    if error_detail is not None:
        row["error_detail"] = error_detail
    if terminal_reason is not None:
        row["terminal_reason"] = terminal_reason
    return append_declared_jsonl(
        _bridge_ledger_path(Path(base_dir)),
        row,
        expected_surface="agent_result_bridge_status",
    )


def latest_bridge_status_for(
    *,
    base_dir: str | Path,
    result_row_ledger_hash: str,
    envelope_evidence_hash: str,
) -> dict[str, Any] | None:
    """Return the latest bridge-status row for the (result_row_ledger_hash,
    envelope_evidence_hash) pair, or None when no row exists."""
    rows = load_declared_jsonl(
        _bridge_ledger_path(Path(base_dir)),
        expected_surface="agent_result_bridge_status",
    )
    latest: dict[str, Any] | None = None
    for row in rows:
        if (
            row.get("result_row_ledger_hash") == result_row_ledger_hash
            and row.get("envelope_evidence_hash") == envelope_evidence_hash
        ):
            latest = row
    return latest


def derive_bridge_state(
    *,
    base_dir: str | Path,
    result_row: dict[str, Any],
) -> dict[str, Any]:
    """Resolve the bridge state for an accepted result row.

    Returns:
        ``{"state": one of ('ok', 'pending', 'pending_retry',
            'not_required', 'permanent_fail'),
            "attempt_number": int,
            "crash_recovery_triggered": bool}``

    Crash-recovery rule (Plan 026R §C.5 round-6 fix):

        If ``result_row.bridge_status == "pending"`` AND no matching
        bridge-ledger row exists, the result row was written but the
        first bridge transition row was lost (crash between the two
        writes). Treat as "pending attempt 0" so the replay path
        re-invokes the bridge.
    """
    bridge_status_on_row = result_row.get("bridge_status")
    result_hash = result_row.get("ledger_hash")
    envelope_hash = result_row.get("envelope_evidence_hash")
    if not result_hash or not envelope_hash:
        # Legacy rows pre-§C.5 — caller decides whether legacy is OK
        # (currently treated as not_required to preserve compatibility).
        return {
            "state": "not_required",
            "attempt_number": 0,
            "crash_recovery_triggered": False,
        }
    latest = latest_bridge_status_for(
        base_dir=base_dir,
        result_row_ledger_hash=str(result_hash),
        envelope_evidence_hash=str(envelope_hash),
    )
    if latest is None:
        if bridge_status_on_row == "pending":
            return {
                "state": "pending",
                "attempt_number": 0,
                "crash_recovery_triggered": True,
            }
        # not_required role + no bridge ledger row → still
        # not_required (the bridge never needed to run).
        return {
            "state": "not_required",
            "attempt_number": 0,
            "crash_recovery_triggered": False,
        }
    return {
        "state": str(latest.get("transition")),
        "attempt_number": int(latest.get("attempt_number") or 0),
        "crash_recovery_triggered": False,
    }


def _results_path(root: Path) -> Path:
    return root / "agent-invocations" / "results.jsonl"


def _replayable_state(state: dict[str, Any]) -> bool:
    """A bridge state the replay loop acts on: crash-recovery ``pending``
    (attempt 0) or any ``pending_retry`` row.

    ARIA-MEDIUM-172 (A1) — the budget filter that used to live here was a
    THIRD owner of the retry-vs-terminal decision, and it stranded rows:
    a ``pending_retry`` attempt already meeting a lowered
    ``ARIA_BRIDGE_MAX_RETRIES`` knob was skipped silently (no terminal row,
    invisible in ``pending_after``). The loop now reaches every replayable
    row and terminalizes a budget-spent one by name without invoking."""
    return state["state"] in {"pending", "pending_retry"}


def _default_bridge_invoker(result_row: dict[str, Any], root: Path) -> BridgeOutcome:
    """Re-invoke the three §C.1 bridges for an accepted result row.

    Reuses ``agent_invocations._invoke_bridges_for_result`` — the SAME
    code the accepted submit path runs — so a replayed bridge cannot
    drift from the original invocation.

    ARIA-MEDIUM-172 — the envelope is read through the sealed-artifact
    verifier (``_verify_prepared_artifact``) against the row's
    ``output_hash``: the replay folds the exact sealed bytes the submit
    path accepted, never whatever later replaced the file at
    ``output_path`` (A2). Reader failures (missing, unreadable, hash
    mismatch) stay TRANSIENT; bytes that hash-verified but cannot be a
    response envelope (undecodable, non-object) are REFUSED — the same
    bytes are refused on every replay. A deterministic bridge failure
    raised through (``DETERMINISTIC_BRIDGE_FAILURES``) is refused: a
    Violation means an envelope minted against a plan state it no longer
    belongs to, so re-invoking after the state moved would fold a stale
    answer — retrying is unsafe, not just useless.
    """
    import json

    # Function-level imports: agent_invocations imports this module inside
    # its own functions; a module-level import here would be a cycle.
    from .agent_invocations import (
        _find_request_by_id,
        _invoke_bridges_for_result,
        _verify_prepared_artifact,
    )
    from .bridge_exceptions import DETERMINISTIC_BRIDGE_FAILURES, BridgeContractViolation
    from .tool_registry import append_tools_governance

    request_id = str(result_row.get("request_id") or "")
    claim_id = str(result_row.get("claim_id") or "")
    request = _find_request_by_id(root, request_id)
    if request is None:
        return BridgeOutcome(errors=(f"replay_request_missing: {request_id}",))
    try:
        content = _verify_prepared_artifact(
            root=root.resolve(),
            artifact_ref=result_row.get("output_path"),
            expected_hash=result_row.get("output_hash"),
            artifact_kind="response",
        )
    except GovernanceError as exc:
        return BridgeOutcome(errors=(f"replay_output_envelope_unreadable: {exc}",))
    try:
        envelope = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        detail = f"replay_output_envelope_undecodable: {exc}"
        return BridgeOutcome(errors=(detail,), refused=(detail,))
    if not isinstance(envelope, dict):
        detail = "replay_output_envelope_not_object: " + str(result_row.get("output_path") or "")
        return BridgeOutcome(errors=(detail,), refused=(detail,))
    try:
        bridged = _invoke_bridges_for_result(
            request=request,
            envelope=envelope,
            base_dir=root,
            root=root,
            claim_id=claim_id,
            request_id=request_id,
        )
    except DETERMINISTIC_BRIDGE_FAILURES as exc:
        if isinstance(exc, BridgeContractViolation):
            # Divergence from the submit path, on purpose: the caller there
            # is the live consumer and must see the breach in real time;
            # here propagation would wedge the whole drain on one poisoned
            # row. The breach stays operator-visible through this governance
            # event and the permanent_fail/refused transition below.
            append_tools_governance(
                root,
                "bridge_replay_contract_violation",
                {"claim_id": claim_id, "request_id": request_id, "error": str(exc)},
            )
        detail = f"bridge_contract_violation: {exc}"
        return BridgeOutcome(errors=(detail,), refused=(detail,))
    return BridgeOutcome.from_bridged(bridged)


def replay_pending_bridges(
    *,
    base_dir: str | Path,
    max_iterations: int = 10,
    bridge_invoker: Any = None,
) -> dict[str, Any]:
    """Drain pending bridge work — the §C.5 retry primitive the F.1
    orchestrator's ``_default_bridge_drainer`` resolves by name.

    Walks accepted result rows whose role requires a bridge, derives each
    row's bridge state, and re-invokes the bridges for every replayable
    row (crash-recovery ``pending`` at attempt 0, or ``pending_retry``
    with budget left under ``ARIA_BRIDGE_MAX_RETRIES``). Each outcome
    lands as an immutable transition row: ``ok`` on success,
    ``pending_retry`` while budget remains, ``permanent_fail`` when the
    budget is spent.

    Return shape is the orchestrator's consumer contract
    (autonomy_orchestrator.py bridge_drained / bridge_replay_required):

        ``{"status": "ok"|"failed", "iterations": int,
           "replayed_ok": int, "retry_scheduled": int,
           "permanent_fail": int, "pending_after": int}``

    ``status`` reports whether the DRAIN ran, not whether every bridge
    succeeded — unresolved rows surface through ``pending_after``, which
    the orchestrator turns into ``bridge_replay_required`` under the
    strict/autonomous profiles. A structural failure (unreadable results
    ledger) returns ``status="failed"`` instead of raising so the
    orchestrator loop stays in control.
    """
    root = Path(base_dir)
    invoker = bridge_invoker or _default_bridge_invoker
    max_retries = _default_max_retries()
    try:
        results = load_declared_jsonl(
            _results_path(root),
            expected_surface="agent_invocation_results",
        )
    except GovernanceError as exc:
        return {
            "status": "failed",
            "reason": f"results_ledger_unreadable: {exc}",
            "iterations": 0,
            "replayed_ok": 0,
            "retry_scheduled": 0,
            "permanent_fail": 0,
            "pending_after": 0,
        }

    def _bridge_rows() -> list[dict[str, Any]]:
        return [
            row
            for row in results
            if row.get("status") == "accepted" and row.get("role") in BRIDGE_REQUIRED_ROLES
        ]

    iterations = 0
    replayed_ok = 0
    retry_scheduled = 0
    permanent_fail = 0
    for row in _bridge_rows():
        state = derive_bridge_state(base_dir=root, result_row=row)
        if not _replayable_state(state):
            continue
        result_hash = str(row.get("ledger_hash") or "")
        envelope_hash = str(row.get("envelope_evidence_hash") or "")
        role = row.get("role")
        attempt = int(state["attempt_number"])
        if state["state"] == "pending_retry" and attempt >= max_retries:
            # A1 — the budget is already spent (a lowered knob, or a row an
            # older loop's selector stranded): terminalize by name at the
            # stored attempt WITHOUT spending an invocation.
            latest = latest_bridge_status_for(
                base_dir=root,
                result_row_ledger_hash=result_hash,
                envelope_evidence_hash=envelope_hash,
            )
            detail = str((latest or {}).get("error_detail") or "bridge_retry_budget_spent")
            _transition, reason = bridge_transition(
                BridgeOutcome(errors=(detail,)), attempt=attempt, max_retries=max_retries,
            )
            append_bridge_status(
                base_dir=root,
                result_row_ledger_hash=result_hash,
                envelope_evidence_hash=envelope_hash,
                role=role,
                transition=_transition,
                attempt_number=attempt,
                error_detail=detail[:500],
                terminal_reason=reason,
            )
            permanent_fail += 1
            continue
        if iterations >= max_iterations:
            # The iteration budget bounds INVOCATIONS only; a later row can
            # still be terminalized without invoking.
            continue
        outcome = invoker(row, root)
        iterations += 1
        attempt += 1
        transition, reason = bridge_transition(outcome, attempt=attempt, max_retries=max_retries)
        append_bridge_status(
            base_dir=root,
            result_row_ledger_hash=result_hash,
            envelope_evidence_hash=envelope_hash,
            role=role,
            transition=transition,
            attempt_number=attempt,
            error_detail=outcome.detail() or None,
            terminal_reason=reason,
        )
        if transition == "ok":
            replayed_ok += 1
        elif transition == "pending_retry":
            retry_scheduled += 1
        else:
            permanent_fail += 1

    pending_after = 0
    for row in _bridge_rows():
        state = derive_bridge_state(base_dir=root, result_row=row)
        if _replayable_state(state):
            pending_after += 1

    return {
        "status": "ok",
        "iterations": iterations,
        "replayed_ok": replayed_ok,
        "retry_scheduled": retry_scheduled,
        "permanent_fail": permanent_fail,
        "pending_after": pending_after,
    }


__all__ = [
    "BRIDGE_LEDGER_FILENAME",
    "BRIDGE_REQUIRED_ROLES",
    "BRIDGE_TERMINAL_REASONS",
    "BRIDGE_TRANSITIONS",
    "BridgeOutcome",
    "append_bridge_status",
    "bridge_status_for_role",
    "bridge_transition",
    "derive_bridge_state",
    "latest_bridge_status_for",
    "replay_pending_bridges",
]
