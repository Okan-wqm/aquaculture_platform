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

import json
import os
from pathlib import Path
from typing import Any, Callable

from .agent_surface import BRIDGE_REQUIRED_ROLES
from .artifact_safety import read_safe_artifact
from .bridge_exceptions import BridgeContractViolation
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


def _results_ledger_path(root: Path) -> Path:
    return root / "agent-invocations" / "results.jsonl"


def _requests_ledger_path(root: Path) -> Path:
    return root / "agent-invocations" / "requests.jsonl"


def _result_bundles_ledger_path(root: Path) -> Path:
    return root / "agent-invocations" / "agent-result-bundles.jsonl"


def _load_bridge_rows(root: Path) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        _bridge_ledger_path(root),
        expected_surface="agent_result_bridge_status",
        verify=True,
    )


def _load_result_rows(root: Path) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        _results_ledger_path(root),
        expected_surface="agent_invocation_results",
        verify=True,
    )


def _load_request_rows(root: Path) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        _requests_ledger_path(root),
        expected_surface="agent_invocation_requests",
        verify=True,
    )


def _matching_result_bundle(
    *,
    root: Path,
    result_row: dict[str, Any],
    result_row_ledger_hash: str,
    envelope_evidence_hash: str,
) -> dict[str, Any] | None:
    for bundle in reversed(
        load_declared_jsonl(
            _result_bundles_ledger_path(root),
            expected_surface="agent_result_bundles",
            verify=True,
        )
    ):
        if bundle.get("bundle_marker") != "result_transcript_output_committed":
            continue
        if bundle.get("result_ledger_hash") != result_row_ledger_hash:
            continue
        if bundle.get("envelope_evidence_hash") != envelope_evidence_hash:
            continue
        if bundle.get("claim_id") != result_row.get("claim_id"):
            continue
        if bundle.get("request_id") != result_row.get("request_id"):
            continue
        if bundle.get("output_path") != result_row.get("output_path"):
            continue
        if bundle.get("output_hash") != result_row.get("output_hash"):
            continue
        if bundle.get("transcript_artifact_ref") != result_row.get("transcript_artifact_ref"):
            continue
        if bundle.get("transcript_hash") != result_row.get("transcript_hash"):
            continue
        return bundle
    return None


def _resolve_result_bundle_binding(
    *,
    root: Path,
    result_row_ledger_hash: str,
    envelope_evidence_hash: str,
    role: str | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    results = load_declared_jsonl(
        _results_ledger_path(root),
        expected_surface="agent_invocation_results",
        verify=True,
    )
    result_row = next(
        (
            row for row in reversed(results)
            if row.get("ledger_hash") == result_row_ledger_hash
            and row.get("envelope_evidence_hash") == envelope_evidence_hash
        ),
        None,
    )
    if result_row is None:
        raise GovernanceError(
            "bridge_status_result_not_found:"
            f"result_row_ledger_hash={result_row_ledger_hash}"
        )
    if result_row.get("status") != "accepted":
        raise GovernanceError("bridge_status_result_not_accepted")
    if role is not None and result_row.get("role") != role:
        raise GovernanceError(
            f"bridge_status_role_mismatch: result={result_row.get('role')} bridge={role}"
        )
    bundle = _matching_result_bundle(
        root=root,
        result_row=result_row,
        result_row_ledger_hash=result_row_ledger_hash,
        envelope_evidence_hash=envelope_evidence_hash,
    )
    if bundle is None:
        raise GovernanceError(
            "bridge_status_result_bundle_missing:"
            f"result_row_ledger_hash={result_row_ledger_hash}"
        )
    return result_row, bundle


def _require_bridge_row_bound(
    *,
    root: Path,
    row: dict[str, Any],
    result_row_ledger_hash: str,
    envelope_evidence_hash: str,
) -> None:
    result_row, bundle = _resolve_result_bundle_binding(
        root=root,
        result_row_ledger_hash=result_row_ledger_hash,
        envelope_evidence_hash=envelope_evidence_hash,
        role=row.get("role"),
    )
    if row.get("result_bundle_ledger_hash") != bundle.get("ledger_hash"):
        raise GovernanceError("bridge_status_result_bundle_hash_mismatch")
    if row.get("claim_id") != result_row.get("claim_id"):
        raise GovernanceError("bridge_status_claim_binding_mismatch")
    if row.get("request_id") != result_row.get("request_id"):
        raise GovernanceError("bridge_status_request_binding_mismatch")


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
    root = Path(base_dir)
    result_row, bundle = _resolve_result_bundle_binding(
        root=root,
        result_row_ledger_hash=result_row_ledger_hash,
        envelope_evidence_hash=envelope_evidence_hash,
        role=role,
    )
    row = {
        "$schema": "aria/agent-result-bridge-status/v1",
        "schema_version": 1,
        "recorded_at": utc_now(),
        "claim_id": result_row.get("claim_id"),
        "request_id": result_row.get("request_id"),
        "result_row_ledger_hash": result_row_ledger_hash,
        "result_bundle_ledger_hash": bundle.get("ledger_hash"),
        "envelope_evidence_hash": envelope_evidence_hash,
        "role": role,
        "transition": transition,
        "attempt_number": attempt_number,
    }
    if error_detail is not None:
        row["error_detail"] = error_detail
    return append_declared_jsonl(
        _bridge_ledger_path(root),
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
    root = Path(base_dir)
    rows = _load_bridge_rows(root)
    latest: dict[str, Any] | None = None
    for row in rows:
        if (
            row.get("result_row_ledger_hash") == result_row_ledger_hash
            and row.get("envelope_evidence_hash") == envelope_evidence_hash
        ):
            _require_bridge_row_bound(
                root=root,
                row=row,
                result_row_ledger_hash=result_row_ledger_hash,
                envelope_evidence_hash=envelope_evidence_hash,
            )
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


BridgeReplayRunner = Callable[[dict[str, Any], dict[str, Any], dict[str, Any], Path], list[str]]


def _request_for_result(root: Path, result_row: dict[str, Any]) -> dict[str, Any] | None:
    request_id = result_row.get("request_id")
    for row in reversed(_load_request_rows(root)):
        if row.get("request_id") == request_id:
            return row
    return None


def _response_for_result(root: Path, result_row: dict[str, Any]) -> dict[str, Any]:
    artifact = read_safe_artifact(
        str(result_row.get("output_path") or ""),
        root=root,
        purpose="bridge_replay_output",
        max_bytes=2 * 1024 * 1024,
    )
    try:
        payload = json.loads(artifact.content.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise GovernanceError("bridge_replay_output_json_invalid") from exc
    if not isinstance(payload, dict):
        raise GovernanceError("bridge_replay_output_not_object")
    return payload


def _run_default_bridge_replay(
    result_row: dict[str, Any],
    request: dict[str, Any],
    response: dict[str, Any],
    root: Path,
) -> list[str]:
    errors: list[str] = []
    try:
        from .judgment_bridge import (
            persist_supporting_payload,
            record_judge_verdict_from_response,
        )
        try:
            record_judge_verdict_from_response(
                request=request, response=response, base_dir=root,
            )
        except GovernanceError as exc:
            errors.append(f"judge_bridge: {exc}")
        try:
            persist_supporting_payload(
                request=request, response=response, base_dir=root,
            )
        except GovernanceError as exc:
            errors.append(f"supporting_bridge: {exc}")
        try:
            from .plan_convergence_bridge import record_plan_result
            record_plan_result(
                role=result_row.get("role"),
                request=request,
                response=response,
                base_dir=root,
            )
        except BridgeContractViolation:
            raise
        except GovernanceError as exc:
            errors.append(f"plan_convergence_bridge: {exc}")
    except ImportError as exc:  # pragma: no cover
        errors.append(f"bridge_import: {exc}")
    return errors


def replay_pending_bridges(
    *,
    base_dir: str | Path,
    max_iterations: int,
    bridge_runner: BridgeReplayRunner | None = None,
) -> dict[str, Any]:
    """Replay accepted result rows whose required bridge is still pending."""
    root = Path(base_dir)
    if max_iterations <= 0:
        return {
            "status": "ok",
            "iterations": 0,
            "replayed": 0,
            "ok": 0,
            "pending_after": _count_pending_bridge_rows(root),
            "permanent_fail": 0,
            "failures": [],
        }
    runner = bridge_runner or _run_default_bridge_replay
    max_retries = _default_max_retries()
    iterations = 0
    replayed = 0
    ok_count = 0
    permanent_fail_count = 0
    failures: list[dict[str, Any]] = []
    for result_row in _load_result_rows(root):
        if iterations >= max_iterations:
            break
        if result_row.get("status") != "accepted":
            continue
        if result_row.get("role") not in BRIDGE_REQUIRED_ROLES:
            continue
        state = derive_bridge_state(base_dir=root, result_row=result_row)
        if state["state"] not in {"pending", "pending_retry"}:
            continue
        iterations += 1
        replayed += 1
        next_attempt = int(state.get("attempt_number") or 0) + 1
        result_hash = str(result_row.get("ledger_hash") or "")
        envelope_hash = str(result_row.get("envelope_evidence_hash") or "")
        try:
            request = _request_for_result(root, result_row)
            if request is None:
                raise GovernanceError("bridge_replay_request_missing")
            response = _response_for_result(root, result_row)
            errors = runner(result_row, request, response, root)
            if errors:
                transition = (
                    "permanent_fail"
                    if next_attempt >= max_retries
                    else "pending_retry"
                )
                append_bridge_status(
                    base_dir=root,
                    result_row_ledger_hash=result_hash,
                    envelope_evidence_hash=envelope_hash,
                    role=str(result_row.get("role")),
                    transition=transition,
                    attempt_number=next_attempt,
                    error_detail="; ".join(errors)[:500],
                )
                if transition == "permanent_fail":
                    permanent_fail_count += 1
                failures.append(
                    {
                        "request_id": result_row.get("request_id"),
                        "result_row_ledger_hash": result_hash,
                        "attempt_number": next_attempt,
                        "transition": transition,
                        "errors": errors,
                    }
                )
            else:
                append_bridge_status(
                    base_dir=root,
                    result_row_ledger_hash=result_hash,
                    envelope_evidence_hash=envelope_hash,
                    role=str(result_row.get("role")),
                    transition="ok",
                    attempt_number=next_attempt,
                )
                ok_count += 1
        except GovernanceError as exc:
            transition = (
                "permanent_fail"
                if next_attempt >= max_retries
                else "pending_retry"
            )
            append_bridge_status(
                base_dir=root,
                result_row_ledger_hash=result_hash,
                envelope_evidence_hash=envelope_hash,
                role=str(result_row.get("role")),
                transition=transition,
                attempt_number=next_attempt,
                error_detail=str(exc)[:500],
            )
            if transition == "permanent_fail":
                permanent_fail_count += 1
            failures.append(
                {
                    "request_id": result_row.get("request_id"),
                    "result_row_ledger_hash": result_hash,
                    "attempt_number": next_attempt,
                    "transition": transition,
                    "errors": [str(exc)],
                }
            )
    pending_after = _count_pending_bridge_rows(root)
    return {
        "status": "ok" if not failures else "degraded",
        "iterations": iterations,
        "replayed": replayed,
        "ok": ok_count,
        "pending_after": pending_after,
        "permanent_fail": permanent_fail_count,
        "failures": failures,
    }


def _count_pending_bridge_rows(root: Path) -> int:
    total = 0
    for result_row in _load_result_rows(root):
        if result_row.get("status") != "accepted":
            continue
        if result_row.get("role") not in BRIDGE_REQUIRED_ROLES:
            continue
        state = derive_bridge_state(base_dir=root, result_row=result_row)
        if state["state"] in {"pending", "pending_retry"}:
            total += 1
    return total


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
