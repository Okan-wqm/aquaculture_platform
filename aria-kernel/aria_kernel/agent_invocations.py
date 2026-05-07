from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now


ROLES = {
    "primary_plan",
    "challenger_plan",
    "cross_review",
    "gap_finding",
    "implementation",
    "verification",
    "gap_closure",
    "maintenance_utility",
    # Plan 016 adds two roles routed through the strict v1 envelope.
    "implementation_review",
    # Plan 016 Faz C4 judge roles (envelope wraps existing
    # feedback_store.generate_ai_consensus + plan_convergence logic).
    "evidence_judgment",
    "adversarial_judgment",
    "consensus_arbitration",
    "change_intelligence",
    "goldset_curation",
}
STATUSES = {"completed", "rejected", "partial"}

# Plan 016 lease defaults (30 minute lease, 30 minute heartbeat extension,
# 2 requeues then HUMAN_REQUIRED).
DEFAULT_LEASE_SECONDS = 1800
DEFAULT_HEARTBEAT_EXTEND_SECONDS = 1800
DEFAULT_MAX_REQUEUES = 2
LEASE_TOKEN_BYTES = 24

# Derived states for a request when the queue layer is queried via
# derive_request_state(). The legacy `state` field on requests.jsonl rows
# stays "pending" / "completed" / etc; this enumeration is the Plan 016
# 10-state lifecycle as observed from the claims + results ledgers.
DERIVED_STATES = (
    "PENDING",
    "CLAIMED",
    "RUNNING",
    "SUBMITTED",
    "ACCEPTED",
    "REJECTED",
    "STALE",
    "REQUEUED",
    "HUMAN_REQUIRED",
    "CANCELLED",
)


def create_agent_invocation_request(
    *,
    target_agent: str,
    role: str,
    suggested_prompt: str,
    convergence_id: str | None = None,
    pressure_event_id: str | None = None,
    round_number: int | None = None,
    expected_output_path: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if role not in ROLES:
        raise GovernanceError(f"unknown invocation role: {role}")
    if not target_agent.strip():
        raise GovernanceError("target_agent is required")
    if not suggested_prompt.strip():
        raise GovernanceError("suggested_prompt is required")
    root = ensure_tools_dir(base_dir)
    request_id = _request_id(target_agent, role, suggested_prompt, convergence_id, round_number)
    expected = expected_output_path or _default_expected_output_path(root, request_id, convergence_id, round_number, role)
    row = {
        "$schema": "aria/agent-invocation-request/v1",
        "schema_version": 1,
        "request_id": request_id,
        "convergence_id": convergence_id,
        "pressure_event_id": pressure_event_id,
        "round_number": round_number,
        "role": role,
        "target_agent": target_agent,
        "suggested_prompt": suggested_prompt,
        "expected_output_path": expected,
        "state": "pending",
        "created_at": utc_now(),
    }
    return append_jsonl(root / "agent-invocations" / "requests.jsonl", row)


def submit_agent_invocation_result(
    *,
    request_id: str,
    output_path: str | Path,
    status: str = "completed",
    by: str | None = None,
    rejection_reason: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if status not in STATUSES:
        raise GovernanceError("status must be completed, rejected, or partial")
    if status != "completed" and not (rejection_reason or "").strip():
        raise GovernanceError("rejection_reason is required unless status is completed")
    root = ensure_tools_dir(base_dir)
    request = _find_request(root, request_id)
    expected = _resolve_for_compare(request.get("expected_output_path"))
    actual = _resolve_for_compare(output_path)
    if expected != actual:
        event = append_tools_governance(
            root,
            "agent_invocation_path_mismatch",
            {"request_id": request_id, "expected_output_path": str(expected), "output_path": str(actual)},
        )
        return {"schema_version": 1, "status": "rejected", "reason": "agent_invocation_path_mismatch", "governance_event_id": event.get("event_id")}
    path = Path(output_path)
    if not path.exists():
        raise GovernanceError(f"output_path does not exist: {output_path}")
    row = {
        "$schema": "aria/agent-invocation-result/v1",
        "schema_version": 1,
        "request_id": request_id,
        "convergence_id": request.get("convergence_id"),
        "pressure_event_id": request.get("pressure_event_id"),
        "round_number": request.get("round_number"),
        "role": request.get("role"),
        "target_agent": request.get("target_agent"),
        "output_path": path.resolve().as_posix(),
        "content_hash": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(),
        "status": status,
        "by": by,
        "rejection_reason": rejection_reason,
        "submitted_at": utc_now(),
    }
    return append_jsonl(root / "agent-invocations" / "results.jsonl", row)


def list_agent_invocation_requests(
    *,
    base_dir: str | Path | None = None,
    state: str | None = None,
    convergence_id: str | None = None,
    target_agent: str | None = None,
    request_id: str | None = None,
    role: str | None = None,
) -> list[dict[str, Any]]:
    rows = load_jsonl(ensure_tools_dir(base_dir) / "agent-invocations" / "requests.jsonl")
    if state is not None:
        rows = [row for row in rows if row.get("state") == state]
    if convergence_id is not None:
        rows = [row for row in rows if row.get("convergence_id") == convergence_id]
    if target_agent is not None:
        rows = [row for row in rows if row.get("target_agent") == target_agent]
    if request_id is not None:
        rows = [row for row in rows if row.get("request_id") == request_id]
    if role is not None:
        rows = [row for row in rows if row.get("role") == role]
    return rows


def _find_request(root: Path, request_id: str) -> dict[str, Any]:
    for row in reversed(load_jsonl(root / "agent-invocations" / "requests.jsonl")):
        if row.get("request_id") == request_id:
            return row
    raise GovernanceError(f"agent invocation request not found: {request_id}")


def _request_id(target_agent: str, role: str, prompt: str, convergence_id: str | None, round_number: int | None) -> str:
    slug = "".join(ch if ch.isalnum() else "-" for ch in target_agent.lower()).strip("-")[:32] or "agent"
    digest = hashlib.sha256(f"{target_agent}|{role}|{prompt}|{convergence_id}|{round_number}|{utc_now()}".encode("utf-8")).hexdigest()[:8]
    return f"AIR-{slug}-{digest}"


def _default_expected_output_path(root: Path, request_id: str, convergence_id: str | None, round_number: int | None, role: str) -> str:
    group = convergence_id or "general"
    round_part = f"round-{round_number}" if round_number is not None else "round-na"
    return (root / "agent-invocations" / "outputs" / group / f"{round_part}-{role}-{request_id}.md").resolve().as_posix()


def _resolve_for_compare(path: str | Path | None) -> Path:
    if path is None:
        raise GovernanceError("output path is required")
    return Path(path).expanduser().resolve()


# ---------------------------------------------------------------------------
# Plan 016 Faz C2 — lease / heartbeat / requeue primitives.
# ---------------------------------------------------------------------------
#
# Why these live alongside the legacy create / submit functions instead of in
# a fresh module: the request ledger (requests.jsonl) is the single source of
# truth for which requests exist. The lease primitives compose on top of that
# ledger by writing to a sibling claims.jsonl, never modifying the request
# rows in place. Keeping them in one module keeps the reader's mental model
# bounded — every concept that touches agent invocations is reachable from
# this file.


def _claims_path(root: Path) -> Path:
    return root / "agent-invocations" / "claims.jsonl"


def _utc_now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _hash_lease_token(token: str) -> str:
    return "sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest()


def _claim_id(request_id: str, agent_id: str, claimed_at: datetime) -> str:
    digest = hashlib.sha256(
        f"{request_id}|{agent_id}|{claimed_at.isoformat()}".encode("utf-8")
    ).hexdigest()[:16]
    return f"claim_{digest}"


def _request_event_count(rows: list[dict[str, Any]], request_id: str, kind: str) -> int:
    return sum(1 for row in rows if row.get("request_id") == request_id and row.get("event") == kind)


def _result_rows_for(rows: list[dict[str, Any]], request_id: str) -> list[dict[str, Any]]:
    return [row for row in rows if row.get("request_id") == request_id]


def _claim_rows_for(rows: list[dict[str, Any]], request_id: str) -> list[dict[str, Any]]:
    return [row for row in rows if row.get("request_id") == request_id]


_EVENT_TS_FIELDS = ("claimed_at", "heartbeat_at", "released_at", "stale_at", "at")


def _event_ts(row: dict[str, Any]) -> datetime:
    for key in _EVENT_TS_FIELDS:
        ts = _parse_iso(row.get(key))
        if ts is not None:
            return ts
    return datetime.fromtimestamp(0, tz=timezone.utc)


def _latest_claim_row(rows: list[dict[str, Any]], request_id: str) -> dict[str, Any] | None:
    """Return the last event row for the latest claim_id of a request.

    Multiple claims can exist for one request (after requeue cycles); we want
    the most recent activity across all claims. Append order in the ledger
    is authoritative, but we still cross-check against the recorded
    timestamp so out-of-order writes (test fixtures, manual edits) cannot
    silently flip state.
    """
    candidates = [row for row in rows if row.get("request_id") == request_id]
    if not candidates:
        return None
    # Pick the row with the largest event timestamp; ties break on append order.
    best_idx = -1
    best_ts = datetime.fromtimestamp(0, tz=timezone.utc)
    for idx, row in enumerate(candidates):
        ts = _event_ts(row)
        if ts >= best_ts:
            best_ts = ts
            best_idx = idx
    return candidates[best_idx] if best_idx >= 0 else None


def derive_request_state(
    *,
    request_id: str,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> str:
    """Derive the Plan 016 lifecycle state from request + claims + results ledgers.

    Pure function over append-only ledgers, so two callers always see the
    same state given the same files. Returns one of `DERIVED_STATES`.
    """
    root = ensure_tools_dir(base_dir)
    requests = load_jsonl(root / "agent-invocations" / "requests.jsonl")
    request = next((row for row in requests if row.get("request_id") == request_id), None)
    if request is None:
        raise GovernanceError(f"unknown request_id: {request_id}")
    if request.get("state") == "cancelled":
        return "CANCELLED"
    results = load_jsonl(root / "agent-invocations" / "results.jsonl")
    claims = load_jsonl(_claims_path(root))

    # Results dominate (terminal states first).
    request_results = _result_rows_for(results, request_id)
    if request_results:
        # Latest result wins.
        last = request_results[-1]
        status = last.get("status")
        if status == "rejected":
            return "REJECTED"
        if status == "completed":
            return "ACCEPTED"
        if status == "partial":
            return "SUBMITTED"

    # If a HUMAN_REQUIRED event was emitted, that is sticky.
    if any(row.get("event") == "human_required" and row.get("request_id") == request_id for row in claims):
        return "HUMAN_REQUIRED"

    # Otherwise inspect the latest claim's state.
    latest = _latest_claim_row(claims, request_id)
    if latest is None:
        return "PENDING"
    event = latest.get("event")
    if event == "released":
        # Released without result -> requeue counter consulted.
        requeues = _request_event_count(claims, request_id, "requeued")
        if requeues > DEFAULT_MAX_REQUEUES:
            return "HUMAN_REQUIRED"
        return "REQUEUED" if requeues > 0 else "PENDING"
    if event == "stale":
        return "STALE"
    if event == "claimed":
        # Lease expiration?
        expires = _parse_iso(latest.get("lease_expires_at"))
        ts = now or _utc_now_dt()
        if expires is not None and expires < ts:
            return "STALE"
        # Heartbeat seen?
        if any(
            row.get("event") == "heartbeat"
            and row.get("claim_id") == latest.get("claim_id")
            for row in claims
        ):
            return "RUNNING"
        return "CLAIMED"
    if event == "heartbeat":
        expires = _parse_iso(latest.get("lease_expires_at"))
        ts = now or _utc_now_dt()
        if expires is not None and expires < ts:
            return "STALE"
        return "RUNNING"
    if event == "requeued":
        requeues = _request_event_count(claims, request_id, "requeued")
        if requeues > DEFAULT_MAX_REQUEUES:
            return "HUMAN_REQUIRED"
        return "REQUEUED"
    if event == "human_required":
        return "HUMAN_REQUIRED"
    return "PENDING"


def next_pending_request(
    *,
    role: str | None = None,
    target_agent: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Return the oldest pending request matching the optional role/target.

    Pending = derived state PENDING or REQUEUED (those are eligible for a
    fresh claim). HUMAN_REQUIRED, CANCELLED, and terminal states are skipped.
    """
    root = ensure_tools_dir(base_dir)
    requests = load_jsonl(root / "agent-invocations" / "requests.jsonl")
    for request in requests:
        if role and request.get("role") != role:
            continue
        if target_agent and request.get("target_agent") != target_agent:
            continue
        state = derive_request_state(request_id=request["request_id"], base_dir=root)
        if state in {"PENDING", "REQUEUED"}:
            return request
    return None


def claim_request(
    *,
    request_id: str,
    agent_id: str,
    base_dir: str | Path | None = None,
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
) -> dict[str, Any]:
    """Issue a lease for a pending request. Returns claim metadata + RAW lease token.

    The raw token is returned to the caller exactly once (so the worker can
    present it on heartbeat / submit-result). Only its sha256 hash is
    persisted to the claims ledger — the raw token is never logged.
    """
    if lease_seconds <= 0:
        raise GovernanceError("lease_seconds must be positive")
    if not agent_id or not agent_id.strip():
        raise GovernanceError("agent_id is required")
    root = ensure_tools_dir(base_dir)
    state = derive_request_state(request_id=request_id, base_dir=root)
    if state not in {"PENDING", "REQUEUED"}:
        raise GovernanceError(
            f"cannot claim request {request_id} in state {state} (must be PENDING or REQUEUED)"
        )
    now = _utc_now_dt()
    expires = now + timedelta(seconds=lease_seconds)
    lease_token = secrets.token_hex(LEASE_TOKEN_BYTES)
    cid = _claim_id(request_id, agent_id, now)
    row = {
        "schema_version": 1,
        "event": "claimed",
        "claim_id": cid,
        "request_id": request_id,
        "agent_id": agent_id,
        "lease_token_hash": _hash_lease_token(lease_token),
        "lease_seconds": lease_seconds,
        "claimed_at": _iso(now),
        "lease_expires_at": _iso(expires),
    }
    append_jsonl(_claims_path(root), row)
    append_tools_governance(
        root,
        "agent_claim_created",
        {
            "claim_id": cid,
            "request_id": request_id,
            "agent_id": agent_id,
            "lease_expires_at": _iso(expires),
        },
    )
    return {**row, "lease_token": lease_token}


def heartbeat_claim(
    *,
    claim_id: str,
    agent_id: str,
    lease_token: str,
    base_dir: str | Path | None = None,
    extend_seconds: int = DEFAULT_HEARTBEAT_EXTEND_SECONDS,
) -> dict[str, Any]:
    """Extend a lease by `extend_seconds`. Validates lease_token + agent_id."""
    root = ensure_tools_dir(base_dir)
    claims = load_jsonl(_claims_path(root))
    claim_event = next(
        (row for row in claims if row.get("claim_id") == claim_id and row.get("event") == "claimed"),
        None,
    )
    if claim_event is None:
        raise GovernanceError(f"claim {claim_id} not found")
    if claim_event.get("agent_id") != agent_id:
        raise GovernanceError(
            f"claim {claim_id} owned by {claim_event.get('agent_id')!r}, not {agent_id!r}"
        )
    if claim_event.get("lease_token_hash") != _hash_lease_token(lease_token):
        raise GovernanceError(f"claim {claim_id} lease_token mismatch")
    # Reject heartbeat if the request was already released or marked human_required.
    later_events = [
        row for row in claims
        if row.get("claim_id") == claim_id and row.get("event") in {"released", "stale", "human_required"}
    ]
    if later_events:
        raise GovernanceError(
            f"claim {claim_id} already terminal ({later_events[-1].get('event')})"
        )
    now = _utc_now_dt()
    expires = now + timedelta(seconds=extend_seconds)
    row = {
        "schema_version": 1,
        "event": "heartbeat",
        "claim_id": claim_id,
        "request_id": claim_event["request_id"],
        "agent_id": agent_id,
        "heartbeat_at": _iso(now),
        "lease_expires_at": _iso(expires),
    }
    append_jsonl(_claims_path(root), row)
    return row


def release_claim(
    *,
    claim_id: str,
    agent_id: str,
    reason: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Operator- or worker-initiated release; the request becomes REQUEUED if not yet at the cap."""
    if not reason or not reason.strip():
        raise GovernanceError("release reason is required")
    root = ensure_tools_dir(base_dir)
    claims = load_jsonl(_claims_path(root))
    claim_event = next(
        (row for row in claims if row.get("claim_id") == claim_id and row.get("event") == "claimed"),
        None,
    )
    if claim_event is None:
        raise GovernanceError(f"claim {claim_id} not found")
    if claim_event.get("agent_id") != agent_id:
        raise GovernanceError(
            f"claim {claim_id} owned by {claim_event.get('agent_id')!r}, not {agent_id!r}"
        )
    now = _utc_now_dt()
    request_id = claim_event["request_id"]
    row = {
        "schema_version": 1,
        "event": "released",
        "claim_id": claim_id,
        "request_id": request_id,
        "agent_id": agent_id,
        "reason": reason,
        "released_at": _iso(now),
    }
    append_jsonl(_claims_path(root), row)
    requeue_count = _request_event_count(claims, request_id, "requeued") + 1
    requeue_event_kind = "requeued" if requeue_count <= DEFAULT_MAX_REQUEUES else "human_required"
    append_jsonl(
        _claims_path(root),
        {
            "schema_version": 1,
            "event": requeue_event_kind,
            "claim_id": claim_id,
            "request_id": request_id,
            "at": _iso(now),
            "requeue_count": requeue_count,
            "reason": reason,
        },
    )
    append_tools_governance(
        root,
        f"agent_{requeue_event_kind}",
        {"claim_id": claim_id, "request_id": request_id, "requeue_count": requeue_count, "reason": reason},
    )
    return row


def reap_stale_claims(
    *,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Find expired (stale) claims and emit stale + requeue/human_required events.

    Returns three lists keyed `stale`, `requeued`, `human_required`. Idempotent
    when called repeatedly: a claim already marked stale is not reprocessed.
    """
    root = ensure_tools_dir(base_dir)
    ts = now or _utc_now_dt()
    claims = load_jsonl(_claims_path(root))
    # Identify claims still in flight (claimed/heartbeat without later released/stale/human_required).
    by_claim: dict[str, list[dict[str, Any]]] = {}
    for row in claims:
        cid = row.get("claim_id")
        if not cid:
            continue
        by_claim.setdefault(cid, []).append(row)
    reaped: dict[str, list[dict[str, Any]]] = {"stale": [], "requeued": [], "human_required": []}
    for cid, events in by_claim.items():
        if any(e.get("event") in {"released", "stale", "human_required"} for e in events):
            continue
        latest = events[-1]
        expires = _parse_iso(latest.get("lease_expires_at"))
        if expires is None or expires >= ts:
            continue
        request_id = latest.get("request_id")
        agent_id = latest.get("agent_id")
        stale_row = {
            "schema_version": 1,
            "event": "stale",
            "claim_id": cid,
            "request_id": request_id,
            "agent_id": agent_id,
            "stale_at": _iso(ts),
            "lease_expires_at": latest.get("lease_expires_at"),
        }
        append_jsonl(_claims_path(root), stale_row)
        reaped["stale"].append(stale_row)
        # Reload once to keep _request_event_count accurate after each append.
        claims_after = load_jsonl(_claims_path(root))
        requeue_count = _request_event_count(claims_after, request_id, "requeued") + 1
        kind = "requeued" if requeue_count <= DEFAULT_MAX_REQUEUES else "human_required"
        followup = {
            "schema_version": 1,
            "event": kind,
            "claim_id": cid,
            "request_id": request_id,
            "at": _iso(ts),
            "requeue_count": requeue_count,
            "reason": "lease_expired",
        }
        append_jsonl(_claims_path(root), followup)
        reaped[kind].append(followup)
        append_tools_governance(
            root,
            f"agent_claim_{kind}",
            {"claim_id": cid, "request_id": request_id, "requeue_count": requeue_count, "reason": "lease_expired"},
        )
    return reaped
