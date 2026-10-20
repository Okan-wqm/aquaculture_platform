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
the held work. ``cost_budget.assert_within_budget`` raises
``GovernanceError`` and trips the breaker; it is therefore banned from
every mint path this module owns.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .tool_registry import append_tools_governance, ensure_tools_dir

# The funnel's durable routing rows: one per sampled finding per cycle,
# recording the tier decision, the seats planned and (from slice C-2) the
# cache verdict. The tier-2 completion pass re-reads them: a group left at
# one seat whose verdict needs the second seat is re-offered, and the
# (judgment_group_id, target_agent) idempotency in the fan-out mints only
# the missing seat.
ROUTING_SURFACE: str = "judgment_funnel_routing"
ROUTING_RELPATH: tuple[str, ...] = ("judgment-funnel", "routing.jsonl")

BUDGET_HELD_KIND: str = "judgment_funnel_budget_held"


def routing_path(base_dir: str | Path) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*ROUTING_RELPATH)


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
    * ``active=True``: the legs carry filtered per-tier samples and the
      seats each tier mints; ``roles=None`` means the fan-out's default
      pair. Every hold is expressed by leaving items OUT of a leg (they
      stay sampleable) plus one governance row naming the held work.
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
    # Slice C-1: the funnel takes ownership of routing; its first routing
    # decision is the legacy depth for everything, on the record. Slices
    # C-2..C-4 land the real ladder (envelope budget hold, tier-0 early
    # stop, severity tiers, one-seat tier 2, the verdict cache) here.
    _append_routing_rows(root, sample, items, tier=3, seats="pair", target_sha=target_sha)
    return {
        "active": True,
        "plan": [{"tier": None, "sample": sample, "roles": None}],
        "routed": items,
        "held": [],
        "summary": {"funnel": "on", "items_in": len(items), "items_routed": len(items)},
    }


def _append_routing_rows(
    root: Path,
    sample: dict[str, Any],
    items: list[dict[str, Any]],
    *,
    tier: int,
    seats: str,
    target_sha: str | None,
) -> None:
    from .judge_fanout import _group_id
    from .ledger import append_declared_jsonl

    for item in items:
        append_declared_jsonl(
            routing_path(root),
            {
                "schema_version": 1,
                "row_type": "routing",
                "cycle_id": sample.get("cycle_id"),
                "sample_id": sample.get("sample_id"),
                "tool_id": str(item.get("tool_id") or ""),
                "rule": str(item.get("rule") or ""),
                "finding_id": str(item.get("finding_id") or ""),
                "finding_fingerprint": str(item.get("finding_fingerprint") or ""),
                # The group id is judge_fanout's law (one derivation), read
                # from the owner — never a second spelling here.
                "judgment_group_id": _group_id(item),
                "tier": tier,
                "seats": seats,
                "target_sha": target_sha,
                "held": None,
            },
            expected_surface=ROUTING_SURFACE,
        )


__all__ = [
    "BUDGET_HELD_KIND",
    "ROUTING_RELPATH",
    "ROUTING_SURFACE",
    "route_judgment_sample",
    "routing_path",
]
