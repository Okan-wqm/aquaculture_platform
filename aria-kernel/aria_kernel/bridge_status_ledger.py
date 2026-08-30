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
   are derivable from the ledger.

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
) -> dict[str, Any]:
    """Append an immutable bridge-status row to
    ``agent-invocations/agent-result-bridge-status.jsonl``.

    Schema (Plan 026R §C.5):
        ``{recorded_at, result_row_ledger_hash, envelope_evidence_hash,
            role, transition, attempt_number, error_detail_if_any}``

    Transition enum is closed (``BRIDGE_TRANSITIONS``); unknown values
    raise ``GovernanceError`` at the boundary.
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


def _replayable_state(state: dict[str, Any], max_retries: int) -> bool:
    """A bridge state the replay loop may act on: crash-recovery
    ``pending`` (attempt 0) or ``pending_retry`` with retry budget left."""
    if state["state"] == "pending":
        return True
    return state["state"] == "pending_retry" and int(state["attempt_number"]) < max_retries


def _default_bridge_invoker(result_row: dict[str, Any], root: Path) -> list[str]:
    """Re-invoke the three §C.1 bridges for an accepted result row.

    Reuses ``agent_invocations._invoke_bridges_for_result`` — the SAME
    code the accepted submit path runs — so a replayed bridge cannot
    drift from the original invocation. Returns the list of bridge
    errors (empty = success).

    Divergence from the submit path, on purpose: ``BridgeContractViolation``
    is CAUGHT here and returned as an error instead of propagating. On
    the submit path the caller is the live consumer and must see the
    breach in real time; on the replay path propagation would wedge the
    whole drain on one poisoned row. The breach stays operator-visible
    through the ``bridge_replay_contract_violation`` governance event and
    the ``permanent_fail`` transition the caller records once the retry
    budget is spent.
    """
    import json

    # Function-level import: agent_invocations imports this module inside
    # its own functions; a module-level import here would be a cycle.
    from .agent_invocations import _find_request_by_id, _invoke_bridges_for_result
    from .bridge_exceptions import BridgeContractViolation
    from .tool_registry import append_tools_governance

    request_id = str(result_row.get("request_id") or "")
    claim_id = str(result_row.get("claim_id") or "")
    request = _find_request_by_id(root, request_id)
    if request is None:
        return [f"replay_request_missing: {request_id}"]
    from .agent_invocations import resolve_output_artifact_path

    output_path = resolve_output_artifact_path(
        root, str(result_row.get("output_path") or ""),
    )
    try:
        envelope = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"replay_output_envelope_unreadable: {output_path} ({exc})"]
    if not isinstance(envelope, dict):
        return [f"replay_output_envelope_not_object: {output_path}"]
    try:
        bridged = _invoke_bridges_for_result(
            request=request,
            envelope=envelope,
            base_dir=root,
            root=root,
            claim_id=claim_id,
            request_id=request_id,
        )
    except BridgeContractViolation as exc:
        append_tools_governance(
            root,
            "bridge_replay_contract_violation",
            {"claim_id": claim_id, "request_id": request_id, "error": str(exc)},
        )
        return [f"bridge_contract_violation: {exc}"]
    return list(bridged.get("bridge_errors") or [])


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
        if iterations >= max_iterations:
            break
        state = derive_bridge_state(base_dir=root, result_row=row)
        if not _replayable_state(state, max_retries):
            continue
        iterations += 1
        attempt = int(state["attempt_number"]) + 1
        errors = invoker(row, root)
        result_hash = str(row.get("ledger_hash") or "")
        envelope_hash = str(row.get("envelope_evidence_hash") or "")
        role = row.get("role")
        if not errors:
            append_bridge_status(
                base_dir=root,
                result_row_ledger_hash=result_hash,
                envelope_evidence_hash=envelope_hash,
                role=role,
                transition="ok",
                attempt_number=attempt,
            )
            replayed_ok += 1
        elif attempt >= max_retries:
            append_bridge_status(
                base_dir=root,
                result_row_ledger_hash=result_hash,
                envelope_evidence_hash=envelope_hash,
                role=role,
                transition="permanent_fail",
                attempt_number=attempt,
                error_detail="; ".join(errors)[:500],
            )
            permanent_fail += 1
        else:
            append_bridge_status(
                base_dir=root,
                result_row_ledger_hash=result_hash,
                envelope_evidence_hash=envelope_hash,
                role=role,
                transition="pending_retry",
                attempt_number=attempt,
                error_detail="; ".join(errors)[:500],
            )
            retry_scheduled += 1

    pending_after = 0
    for row in _bridge_rows():
        state = derive_bridge_state(base_dir=root, result_row=row)
        if _replayable_state(state, max_retries):
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
    "BRIDGE_TRANSITIONS",
    "append_bridge_status",
    "bridge_status_for_role",
    "derive_bridge_state",
    "latest_bridge_status_for",
    "replay_pending_bridges",
]
