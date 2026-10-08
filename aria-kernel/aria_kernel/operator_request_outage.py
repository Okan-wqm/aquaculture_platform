"""An operator request that expires unconsumed during a provider outage is put back to the operator.

WHY (ARIA-HIGH-365, the operator-request expiry). A signed request is
consumed when a plan starts from it, and one convergence runs at a time; a
provider outage holds the active plan, so requests queue behind it. At its
``expires_at`` (at most the 168 h operator-act lifetime) a request is refused
as ``request_expired`` and SPENT — the operator's intent was gone and nobody
was told.

WHY NOT the provider-available clock here. ``expires_at`` is a SIGNED term
(ADR-0018 B1): it bounds how long a rolled-back store can re-admit a spent
request, and the bound is read from git objects, never from state a runner-uid
process can write (ARIA-LOW-267, ADR-0023). The outage ledger is exactly such
state; letting it stretch a signed lifetime would let one appended governance
row re-open the replay window the signature closes. So the expiry stays a
wall-clock fact and the request is NOT re-admitted; what changes is that
nothing is lost silently: the request, its finding and its text go into one
HUMAN_REQUIRED item asking for a re-signature, raised only when an outage on
the ledger overlapped the request's life (the case the operator requirement
of 2026-10-07 names).
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from .operator_request_terms import parse_utc

OUTAGE_EXPIRED_CONTEXT_KIND = "operator_request_expired_in_outage"


def surface_outage_expired_request(base_dir: str | Path, row: dict[str, Any], *, now: datetime) -> str | None:
    """Raise the re-sign item for an expired request whose life overlapped an outage; its id, or None."""
    from .human_required import record_human_required
    from .provider_clock import provider_clock

    authored, expires = parse_utc(row.get("authored_at")), parse_utc(row.get("expires_at"))
    if authored is None or expires is None:
        return None
    from .provider_clock import planning_heads

    # Review HIGH-2: the providers a request's plan would run on, never "any".
    covered = provider_clock(base_dir).covered_any(authored, min(expires, now), planning_heads())
    if covered.total_seconds() <= 0:
        return None
    signal_id = f"operator-request-expired-{row.get('id')}"
    record_human_required(
        request_id=signal_id, severity="HIGH",
        reason=(f"operator request {row.get('id')} (finding {row.get('finding_id')}) expired unconsumed "
                f"after {covered.total_seconds() / 3600:.1f}h of provider outage; nothing ran on it — "
                "re-sign it to have it planned (`aria-kernel feedback request --finding-id` the same finding)"),
        context={"kind": OUTAGE_EXPIRED_CONTEXT_KIND, "operator_request_id": row.get("id"),
                 "finding_id": row.get("finding_id"), "priority": row.get("priority"),
                 "request": str(row.get("request") or "")[:4000], "authored_at": row.get("authored_at"),
                 "expires_at": row.get("expires_at"), "outage_hours": round(covered.total_seconds() / 3600, 3)},
        base_dir=base_dir, now=now,
    )
    return signal_id


__all__ = ["OUTAGE_EXPIRED_CONTEXT_KIND", "surface_outage_expired_request"]
