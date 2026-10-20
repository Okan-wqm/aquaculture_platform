"""WP-J slice C — the judgment funnel: ONE routing owner.

WHY. `_phase_judgment_pipeline` minted the full two-judge pair for every
sampled finding: no tier, no early stop, no cache, no drain-sized envelope.
The second sealed night measured 462 judge envelopes minted against ~9
drained per night; 296 died of anchor staleness without ever being read
(the measured history recorded beside ``JUDGMENT_PIPELINE_DEFAULTS``).
WP-J's synthesis folds WP-J-1's ``panel_router`` and WP-J-2's in-fanout gate
into this ONE module, called inside the phase between
``generate_judgment_sample`` and ``dispatch_judges_for_sample``
(cycle.py:1950→1958). Tier assignment, escalation, early stop, cache key
and batch key live HERE and nowhere else; ``dispatch_judges_for_sample``
gains no tier logic — the funnel decides WHAT is judged and HOW MANY seats
each decision gets, the fan-out mints what it is handed.

THE FIRST LAW — policy-off is bit-for-bit legacy. With the funnel block
absent (or ``funnel_enabled: false``, the shipped default),
``route_judgment_sample`` returns the sampler's own sample object as an
unfiltered leg with no roles and writes nothing: the phase's call to
``dispatch_judges_for_sample`` carries the exact legacy kwargs and no
funnel row appears anywhere. That is the mechanical proof of
wire-don't-rewrite, pinned by ``test_judgment_funnel.PolicyOffGoldenTest``.

CAPS HOLD, NEVER FAIL (the 579 discipline). The funnel expresses every cap
as a hold: the affected findings are simply not dispatched this cycle —
they stay sampleable, because the sampler draws from raw findings, not from
funnel rows — and one ``judgment_funnel_budget_held`` governance row names
the held work with its derivation. The raising, breaker-tripping gate in
``cost_budget`` is banned from every mint path this module owns (pinned by
``test_judgment_funnel.EnvelopeBudgetHoldsTest``); the envelope is
ENVELOPE-denominated — judge seats this night may mint in total across all
lanes — and is an explicit function of the measured drain:
``allowance = min(funnel_nightly_envelope, ceil(drain_per_day))`` minus the
seats the funnel already routed tonight, with the judgment lane's
pending-envelope count and USD spend for today recorded on the row as the
derivation, never as a second ledger.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .tool_registry import append_tools_governance, ensure_tools_dir

# The funnel's durable routing rows: one per sampled finding per cycle,
# recording the tier decision, the seats planned, and the hold reason when
# the item was NOT dispatched. The envelope budget counts tonight's seats
# from them, and the tier-2 completion pass re-reads them: a group left at
# one seat whose verdict needs the second seat is re-offered, and the
# (judgment_group_id, target_agent) idempotency in the fan-out mints only
# the missing seat.
ROUTING_SURFACE: str = "judgment_funnel_routing"
ROUTING_RELPATH: tuple[str, ...] = ("judgment-funnel", "routing.jsonl")

BUDGET_HELD_KIND: str = "judgment_funnel_budget_held"
TIER0_REJECTED_KIND: str = "judgment_funnel_tier0_rejected"

# The funnel's producer at the request-admission door: the tiered judge
# seats it plans to mint. Classified exactly like ``judge_fanout.sample``
# (the work starts something new; a refusal leaves the finding unjudged and
# re-offered by the next cycle's sample), so the envelope hold is expressed
# THROUGH the door, never beside it.
FUNNEL_TIERS_PRODUCER: str = "judgment_funnel.tiers"

# Seats per routed item while the severity ladder (slice C-2) has not
# landed: the legacy pair. The routing row's ``seats_planned`` is the
# number the envelope budget counts.
_LEGACY_SEATS: int = 2


def routing_path(base_dir: str | Path) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*ROUTING_RELPATH)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _tier0_verdict(
    item: dict[str, Any],
    repo_root: str | Path | None,
    target_sha: str | None,
) -> dict[str, Any]:
    """Slice A's tier-0 law, called before any mint. Never raises into the
    funnel: the gate is pure; a shape it cannot read is a pass with its
    note (tri-state), and the paid tiers still verify."""
    from .tier0 import TIER0_PASS, tier0_gate

    try:
        return tier0_gate(item, None, repo_root, target_sha)
    except Exception:  # noqa: BLE001 — tier-0 never blocks the lane it guards
        return {"status": TIER0_PASS, "reason": None, "note": "tier0_gate_unreadable"}


def _today_start(now: datetime) -> str:
    return f"{now.astimezone(timezone.utc).date():%Y-%m-%d}T00:00:00Z"


def _tonight_allowance(
    root: Path, policy: dict[str, Any], *, now: datetime,
) -> tuple[int, dict[str, Any]]:
    """(remaining seats tonight, the derivation recorded on the hold row).

    ONE per-night envelope across ALL judgment lanes, ENVELOPE-denominated
    and an explicit function of the measured drain: the cap the operator
    sized to the measured ~9-13/night, cut to ``ceil(drain_per_day)`` when
    the drain is slower, minus the seats the funnel already routed tonight.
    A dead drain (the design-time verdict: last judgment-lane mint
    2026-10-01) therefore holds the whole judgment night while every other
    lane keeps running — the demand-reduction move the 462-vs-~9 week
    demanded.
    """
    from .request_drain_capacity import measure_drain_capacity, request_admission_policy

    capacity = measure_drain_capacity(root, now=now, policy=request_admission_policy(root))
    drain_per_day = float(capacity.drain_per_day or 0.0)
    cap = int(policy.get("funnel_nightly_envelope") or 0)
    granted = max(0, min(cap, math.ceil(drain_per_day))) if cap > 0 else 0
    spent = _seats_routed_since(root, _today_start(now))
    derivation: dict[str, Any] = {
        "envelope_cap": cap,
        "drain_per_day": drain_per_day,
        "drained_in_window": capacity.drained_in_window,
        "drain_window_days": capacity.drain_window_days,
        "granted_tonight": granted,
        "seats_routed_tonight": spent,
        "pending_judge_counts": _pending_judge_counts(root),
        "judgment_lane_usd_today": _judgment_lane_usd_since(root, _today_start(now)),
    }
    return max(0, granted - spent), derivation


def _seats_routed_since(root: Path, since_iso: str) -> int:
    """Seats the funnel planned (and did not hold) since an instant."""
    from .ledger import load_declared_jsonl

    path = routing_path(root)
    if not path.exists():
        return 0
    seats = 0
    for row in load_declared_jsonl(path, expected_surface=ROUTING_SURFACE):
        if row.get("held") is not None:
            continue
        if str(row.get("routed_at") or "") < since_iso:
            continue
        planned = row.get("seats_planned")
        seats += planned if isinstance(planned, int) and not isinstance(planned, bool) else 0
    return seats


def _pending_judge_counts(root: Path) -> dict[str, int]:
    """The live per-role envelope backlog, from its one owner."""
    from .judge_fanout import pending_judge_counts

    try:
        return pending_judge_counts(base_dir=root)
    except Exception:  # noqa: BLE001 — a derivation field never breaks the hold
        return {}


def _judgment_lane_usd_since(root: Path, since_iso: str) -> float:
    """What the judgment lane spent since an instant (derivation only)."""
    from .agent_surface import JUDGE_ROLES
    from .budget import read_cost_attribution

    try:
        rows = read_cost_attribution(since_iso=since_iso, base_dir=root)
    except Exception:  # noqa: BLE001 — a derivation field never breaks the hold
        return 0.0
    return round(sum(
        float(row.get("estimated_usd") or 0.0)
        for row in rows if row.get("agent_role") in JUDGE_ROLES
    ), 6)


def route_judgment_sample(
    *,
    sample: dict[str, Any],
    base_dir: str | Path | None,
    repo_root: str | Path | None,
    target_sha: str | None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Decide what the fan-out mints for this sample — the ONE router.

    Returns a dispatch plan the phase walks:

    ``{"active": bool, "plan": [{"tier": int|None, "sample": dict,
    "roles": tuple[str, str] | None}], "routed": [...], "held": [...],
    "summary": {...}}``

    * ``active=False`` (the shipped default): one leg carrying the
      sampler's OWN sample object with ``roles=None``. The phase then calls
      ``dispatch_judges_for_sample`` with the exact legacy kwargs — no
      reordering, no filtering, no extra argument — and nothing is written.
    * ``active=True``: every hold is expressed by leaving items OUT of the
      legs (they stay sampleable) plus one governance row naming the held
      work and its derivation; the door (``request_admission``) is asked
      through this module's own producer before anything is planned.
    """
    root = ensure_tools_dir(base_dir)
    if policy is None:
        from .genesis_policy import judgment_pipeline_policy

        policy = judgment_pipeline_policy(Path(repo_root) if repo_root else None)
    if policy.get("funnel_enabled") is not True:
        return {
            "active": False,
            "plan": [{"tier": None, "sample": sample, "roles": None}],
            "routed": [],
            "held": [],
            "summary": {"funnel": "off", "items_in": len(sample.get("items") or [])},
        }
    items = [item for item in sample.get("items") or [] if isinstance(item, dict)]
    now = _now()
    remaining, derivation = _tonight_allowance(root, policy, now=now)
    held: list[dict[str, Any]] = []
    routed: list[dict[str, Any]] = []
    tier0_refused: list[dict[str, Any]] = []
    hold_reason: str | None = None
    if remaining <= 0:
        hold_reason = "envelope_allowance_exhausted"
    else:
        # The door: the funnel's tiered seats are discretionary work that
        # starts something. A refusal holds the night (the door records its
        # own rows); it never fails it.
        from .request_admission import admit_request

        for role in ("evidence_judgment", "adversarial_judgment"):
            admission = admit_request(
                FUNNEL_TIERS_PRODUCER, role, base_dir=root,
                cycle_id=str(sample.get("cycle_id") or "") or None,
                count=len(items) * _LEGACY_SEATS,
            )
            if not admission.admitted:
                hold_reason = admission.refusal
                break
    if hold_reason is None:
        for item in items:
            # TIER-0 FIRST, FREE (the operator's funnel law, step 2): the
            # mechanical gate — slice A's tier0_gate, one law — runs before
            # any envelope seat is planned. A reject is an early stop: the
            # item is refused by name, pays nothing, and stays sampleable.
            verdict = _tier0_verdict(item, repo_root, target_sha)
            if verdict.get("status") == "reject":
                reason = str(verdict.get("reason") or "tier0_rejected")
                tier0_refused.append({
                    "item": item,
                    "finding_id": str(item.get("finding_id") or ""),
                    "reason": reason,
                    "detail": verdict.get("note"),
                })
                continue
            if remaining < _LEGACY_SEATS:
                hold_reason = "envelope_allowance_exhausted"
                held.append({"item": item, "reason": hold_reason})
                continue
            routed.append(item)
            remaining -= _LEGACY_SEATS
    else:
        held.extend({"item": item, "reason": hold_reason} for item in items)
    _append_routing_rows(
        root, sample, routed,
        held + [{"item": entry["item"], "reason": f"tier0:{entry['reason']}"} for entry in tier0_refused],
        target_sha=target_sha, now=now,
    )
    if tier0_refused:
        # MEASURE mode (the WP-J falsifiability rollout): one governance row
        # per route call carrying every named refusal, before enforcement.
        append_tools_governance(root, TIER0_REJECTED_KIND, {
            "cycle_key": str(sample.get("cycle_id") or ""),
            "refused": [
                {"finding_id": entry["finding_id"], "reason": entry["reason"],
                 "detail": entry.get("detail")}
                for entry in tier0_refused
            ],
        })
    if held:
        append_tools_governance(root, BUDGET_HELD_KIND, {
            "cycle_key": str(sample.get("cycle_id") or ""),
            "held_items": len(held),
            "held_seats": len(held) * _LEGACY_SEATS,
            "reason": hold_reason,
            "derivation": derivation,
        })
    plan: list[dict[str, Any]] = []
    if routed:
        # Slice C-1: the funnel takes ownership of routing; its first
        # routing decision is the legacy depth for everything, on the
        # record. Slices C-2..C-4 land the real ladder (tier-0 early stop,
        # severity tiers, one-seat tier 2, the verdict cache) here.
        plan.append({
            "tier": None,
            "sample": {**sample, "items": routed},
            "roles": None,
        })
    return {
        "active": True,
        "plan": plan,
        "routed": routed,
        "held": held,
        "tier0_refused": tier0_refused,
        "summary": {
            "funnel": "on",
            "items_in": len(items),
            "items_routed": len(routed),
            "items_held": len(held),
            "items_tier0_refused": len(tier0_refused),
            "derivation": derivation,
        },
    }


def _append_routing_rows(
    root: Path,
    sample: dict[str, Any],
    routed: list[dict[str, Any]],
    held: list[dict[str, Any]],
    *,
    target_sha: str | None,
    now: datetime,
) -> None:
    from .judge_fanout import _group_id
    from .ledger import append_declared_jsonl

    def _row(item: dict[str, Any], *, hold: str | None) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "row_type": "routing",
            "routed_at": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "cycle_id": sample.get("cycle_id"),
            "sample_id": sample.get("sample_id"),
            "tool_id": str(item.get("tool_id") or ""),
            "rule": str(item.get("rule") or ""),
            "finding_id": str(item.get("finding_id") or ""),
            "finding_fingerprint": str(item.get("finding_fingerprint") or ""),
            # The group id is judge_fanout's law (one derivation), read
            # from the owner — never a second spelling here.
            "judgment_group_id": _group_id(item),
            # Slice C-1: legacy depth for everything routed; the severity
            # ladder replaces this constant per item in slice C-2.
            "tier": 3,
            "seats_planned": 0 if hold is not None else _LEGACY_SEATS,
            "target_sha": target_sha,
            "held": hold,
        }

    for item in routed:
        append_declared_jsonl(routing_path(root), _row(item, hold=None),
                              expected_surface=ROUTING_SURFACE)
    for entry in held:
        append_declared_jsonl(
            routing_path(root), _row(entry["item"], hold=str(entry.get("reason") or "held")),
            expected_surface=ROUTING_SURFACE)


__all__ = [
    "BUDGET_HELD_KIND",
    "FUNNEL_TIERS_PRODUCER",
    "ROUTING_RELPATH",
    "ROUTING_SURFACE",
    "route_judgment_sample",
    "routing_path",
]
