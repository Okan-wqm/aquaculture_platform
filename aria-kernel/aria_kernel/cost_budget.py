"""Plan ARIA-V3 §B0 + INFRA-CRITICAL-001 — cost circuit breaker.

GAP: after B1 flips ``CLAUDE_CLI_MOCK=false``, every daily
``aria-agent-executor.yml`` cron run hits the real Claude API. The
existing failure breaker (``circuit_breaker.py``, Phase B2) trips
on validator rejections / sandbox-red / CI-red etc. — but NOT on
$cost. A pricing surprise or runaway request could exhaust an
operator's budget silently between daily reviews.

V3 §B0 lands a co-equal **cost** circuit breaker:

  * No persisted cost aggregates of its own: the former
    ``budget/daily.json`` + ``budget/monthly.json`` were removed
    (ORPHAN-HIGH-466, see the note beside ``_BUDGET_DIR_RELATIVE``).
    Daily and monthly USD totals are DERIVED from the cost-attribution
    rows by ``derived_usage()``.
  * ``assert_within_budget`` runs before every live ``claude`` spawn,
    called from ``tools/aria-poc/claude_runtime._assert_budget_before_spawn``
    when ``ARIA_TOOLS_DIR`` names the durable store. Under
    ``monetary_admission == "managed_subscription"`` it returns
    ``status: telemetry_only`` and never raises; only under metered
    admission does an exceeded per-run / daily / monthly cap raise
    ``GovernanceError``.
  * A metered cap breach trips the breaker and emits a
    ``cost_budget_breaker_tripped`` governance event with the exceeded
    cap name + amounts. The runtime profile is NOT changed here
    (``set_profile`` requires an ``operator_approval_ref``); the
    tripped breaker refuses further autonomous cycles until reset.
  * State survives kernel restart: cold-start reads
    ``budget/breaker_state.json``, and usage is re-derived from the
    cost-attribution rows (I-V3-B0e invariant locks this).

Caps live in ``genesis_policy_default.json`` under
``cost_caps_usd: {daily, monthly, per_run}`` (defaults: 5 / 100 /
0.50). Operators can override via the policy template at the
project root (Plan ARIA-V2 §genesis-policy override chain).

I-V3-B0a..e invariants lock the contract; the gate consumes
``current_state(base_dir)`` so the materialize path refuses when
the breaker is tripped (already wired in ``auto_action_gate``
via the ``cost_state`` field — Phase A4 stub).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .hmac_keyring import utc_now_stamp
from .ledger import atomic_write_json
from .operator_approval import recorded_instance, require_operator_act
from .tool_registry import GovernanceError, ensure_tools_dir, tools_dir

# ARIA-HIGH-238 — the breaker's name in an operator approval line, and the
# governance kind recording an operator clearing it (an authority-raising
# write, pinned by tests/test_operator_approval_callers.py).
COST_BREAKER = "cost"
COST_BREAKER_RESET_EVENT = "cost_budget_breaker_reset"

_BUDGET_DIR_RELATIVE = ("budget",)
# ORPHAN-HIGH-466 — budget/daily.json + budget/monthly.json are GONE.
# They were a second cost ledger only record_actual_usage wrote, and
# nothing called it. Usage is now derived from the cost-attribution
# rows in derived_usage(); re-introducing an aggregate here would
# recreate the divergence this finding closed.
_STATE_FILE = "breaker_state.json"

_DEFAULT_CAPS_USD: dict[str, float] = {
    "daily": 5.0,
    "monthly": 100.0,
    "per_run": 0.50,
}


def _budget_dir(base_dir: str | Path) -> Path:
    return Path(base_dir).joinpath(*_BUDGET_DIR_RELATIVE)


def _today_key() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _month_key() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


def _read_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return dict(default)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return dict(default)


def _load_caps(base_dir: str | Path) -> dict[str, float]:
    from .genesis_policy import load_policy
    from .tool_registry import bound_workspace_root

    # Plan ARIA-V3 §B0 — operator override lives at
    # ``<workspace_root>/aria-config/genesis_policy.json``; the workspace is
    # the one the store is BOUND to (a legacy store's parent). Defaults
    # shipped in ``aria_kernel/data/genesis_policy_default.json`` include
    # the ``cost_caps_usd`` block.
    policy = load_policy(bound_workspace_root(base_dir))
    raw = policy.get("cost_caps_usd") or {}
    if not isinstance(raw, dict):
        raw = {}
    return {
        "daily": float(raw.get("daily", _DEFAULT_CAPS_USD["daily"])),
        "monthly": float(raw.get("monthly", _DEFAULT_CAPS_USD["monthly"])),
        "per_run": float(raw.get("per_run", _DEFAULT_CAPS_USD["per_run"])),
    }


def _state_path(base_dir: str | Path) -> Path:
    return _budget_dir(base_dir) / _STATE_FILE


def current_state(base_dir: str | Path) -> str:
    """Plan ARIA-V3 §B0 — return ``ok`` or ``tripped``. Consumed
    by :mod:`auto_action_gate` to gate the autonomous path.
    """
    state = _read_json(_state_path(base_dir), {"state": "ok"}).get("state", "ok")
    return "tripped" if state == "tripped" else "ok"


def monetary_admission_in_force(base_dir: str | Path) -> str:
    """``managed_subscription`` or ``metered``: the admission the spawn gate acts under.

    Read from the workspace the store is BOUND to, the one place the gate reads
    operator policy; no ``adaptive_runtime`` block means metered.
    """
    from .genesis_policy import _adaptive_runtime_policy
    from .tool_registry import bound_workspace_root

    adaptive = _adaptive_runtime_policy(bound_workspace_root(base_dir))
    return adaptive.monetary_admission if adaptive is not None else "metered"


def attribution(base_dir: str | Path) -> dict[str, Any]:
    """What a report names about cost: the admission in force, the USD derived so far, the caps.

    WP-D4 — the room's report of a change review carries this block. It is
    ``derived_usage`` and ``_load_caps`` (the numbers ``assert_within_budget``
    gates on) beside ``monetary_admission_in_force`` (the mode that decides
    whether those numbers admit or only inform): no figure is re-derived.
    """
    root = ensure_tools_dir(base_dir)
    daily_usd, monthly_usd = derived_usage(root)
    return {
        "monetary_admission": monetary_admission_in_force(root),
        "daily_usd": daily_usd,
        "monthly_usd": monthly_usd,
        "caps": _load_caps(root),
    }


def assert_within_budget(
    base_dir: str | Path,
    *,
    estimated_run_usd: float,
) -> dict[str, Any]:
    """Plan ARIA-V3 §B0 — call BEFORE spawning ``claude``. Raises
    GovernanceError when any cap is exceeded; otherwise returns the
    current usage snapshot.
    """
    if estimated_run_usd < 0:
        raise GovernanceError(
            f"cost_budget_negative_estimate: {estimated_run_usd}"
        )
    root = ensure_tools_dir(base_dir)
    caps = _load_caps(root)
    spent_daily, spent_monthly = derived_usage(root)
    projected_daily = spent_daily + estimated_run_usd
    projected_monthly = spent_monthly + estimated_run_usd

    # Under the managed-subscription policy the notional dollars this
    # ledger accumulates are telemetry, never admission (ORPHAN-HIGH-472
    # retired them for the dispatch budget, ARIA-HIGH-074 for the spawn
    # reservation): the wall-clock caps bound a night. This gate refused
    # trial eight's cross-review with the shipped $5 daily cap after one
    # accepted challenger (ARIA-HIGH-079). The projection is still returned.
    monetary_admission = monetary_admission_in_force(root)
    if monetary_admission == "managed_subscription":
        return {
            "status": "telemetry_only",
            "monetary_admission": monetary_admission,
            "estimated_run_usd": estimated_run_usd,
            "projected_daily_usd": projected_daily,
            "projected_monthly_usd": projected_monthly,
            "caps": caps,
        }

    if estimated_run_usd > caps["per_run"]:
        _trip_breaker(root, cap_name="per_run", amount=estimated_run_usd, cap=caps["per_run"])
        raise GovernanceError(
            f"cost_budget_per_run_cap_exceeded: estimate={estimated_run_usd} cap={caps['per_run']}"
        )
    if projected_daily > caps["daily"]:
        _trip_breaker(root, cap_name="daily", amount=projected_daily, cap=caps["daily"])
        raise GovernanceError(
            f"cost_budget_daily_cap_exceeded: projected={projected_daily} cap={caps['daily']}"
        )
    if projected_monthly > caps["monthly"]:
        _trip_breaker(root, cap_name="monthly", amount=projected_monthly, cap=caps["monthly"])
        raise GovernanceError(
            f"cost_budget_monthly_cap_exceeded: projected={projected_monthly} cap={caps['monthly']}"
        )
    return {
        "status": "ok",
        "estimated_run_usd": estimated_run_usd,
        "projected_daily_usd": projected_daily,
        "projected_monthly_usd": projected_monthly,
        "caps": caps,
    }


def derived_usage(base_dir: str | Path) -> tuple[float, float]:
    """ORPHAN-HIGH-466 — (daily_usd, monthly_usd) derived from the
    cost-attribution ledger the system actually writes.

    Pre-fix this module kept its OWN aggregates, ``budget/daily.json`` and
    ``budget/monthly.json``, incremented by ``record_actual_usage`` — a
    function whose only occurrences repo-wide were its ``def`` and its
    ``__all__`` entry. Meanwhile every real invocation recorded through
    ``budget.record_cost_attribution``, which ``CostTelemetryHookImpl``
    wires for standard/strict/autonomous. Two parallel cost systems, and
    the enforcing gate read the one nothing fed: the caps could not be
    reached no matter what was spent.

    Deriving instead of dual-writing is deliberate. A second producer
    alongside the attribution row would make the two ledgers capable of
    disagreeing, and the telemetry hook deliberately swallows its own write
    failures so the cycle's LLM call cannot be blocked by a cost-row error —
    meaning the aggregate would drift silently and the gate would enforce
    against a number nobody could reconcile. With one ledger, divergence is
    not handled, it is impossible.

    The calendar-boundary roll-forward the old aggregates needed is gone for
    the same reason: the window is expressed in the query
    (``since_iso``), so a stale date field cannot carry yesterday's total
    into today.
    """
    from .budget import aggregate_cost_attribution

    root = ensure_tools_dir(base_dir)
    day_start = f"{_today_key()}T00:00:00Z"
    month_start = f"{_month_key()}-01T00:00:00Z"
    daily = aggregate_cost_attribution(since_iso=day_start, base_dir=root)
    monthly = aggregate_cost_attribution(since_iso=month_start, base_dir=root)
    return (
        float(daily.get("total_usd", 0.0) or 0.0),
        float(monthly.get("total_usd", 0.0) or 0.0),
    )


def _trip_breaker(
    base_dir: str | Path,
    *,
    cap_name: str,
    amount: float,
    cap: float,
) -> None:
    """Plan ARIA-V3 §B0 — flip state to ``tripped`` + emit
    governance event. Auto-downgrade of the runtime profile to
    ``strict`` is the operator's recovery path; we DO NOT
    auto-change profile inside this primitive because profile
    transitions require ``operator_approval_ref`` per
    ``runtime_profile.set_profile`` contract. The breaker simply
    refuses further autonomous spawns until reset.
    """
    root = Path(base_dir)
    atomic_write_json(
        _state_path(root),
        {
            "state": "tripped",
            "tripped_at": utc_now_stamp(),
            "cap_name": cap_name,
            "amount": amount,
            "cap": cap,
        },
    )
    from .tool_registry import append_tools_governance
    append_tools_governance(
        ensure_tools_dir(root),
        "cost_budget_breaker_tripped",
        {
            "cap_name": cap_name,
            "amount_usd": amount,
            "cap_usd": cap,
        },
    )
    # Plan 032 Faz 032e — a tripped cost breaker is an operator event.
    from .notify import notify_best_effort

    # ARIA-MEDIUM-556 — the amounts reach private channels only; the public
    # issue names the breaker state record.
    notify_best_effort(
        kind="breaker_tripped", key=f"cost:{cap_name}", base_dir=root,
        title=f"ARIA cost breaker tripped ({cap_name})",
        body=f"amount_usd: {amount} cap_usd: {cap}",
        record=_state_path(root).relative_to(root).as_posix(),
    )


def trip_scope(base_dir: str | Path | None) -> dict[str, str]:
    """ARIA-HIGH-238 — the trip an operator act clearing this breaker binds to:
    the state's ``tripped_at`` (``NO_RECORDED_INSTANCE`` when the tripped state
    records none), so an act posted for one trip cannot clear the next."""
    return {
        "breaker": COST_BREAKER,
        "tripped_at": recorded_instance(_read_json(_state_path(tools_dir(base_dir)), {}).get("tripped_at")),
    }


def reset_breaker(
    *,
    base_dir: str | Path,
    reason: str,
    operator_approval_ref: str,
) -> dict[str, Any]:
    """Plan ARIA-V3 §B0 — operator clears the tripped flag after
    investigating + adjusting caps if needed. Audit event records
    the reset.

    ARIA-HIGH-238 — clearing a cost stop is proven by an operator's GitHub
    act approving ``surface=breaker_reset breaker=cost`` for THIS trip
    (:func:`trip_scope`; ``aria-kernel cost-breaker reset
    --print-approval-line`` prints the line). It accepted any string,
    including an empty one, before. A breaker that is not tripped has
    nothing to clear: no act is asked for and nothing is written.
    """
    if not (reason or "").strip():
        raise GovernanceError("cost_budget_reset_requires_reason")
    root = ensure_tools_dir(base_dir)
    if current_state(root) != "tripped":
        return {"status": "ok", "already_ok": True}
    # The audit row below is refused under a frozen profile; refusing first
    # keeps the act unspent and the stop in place.
    from .runtime_profile import enforce_profile_for_write

    enforce_profile_for_write("tool_governance", base_dir=root)
    approval = require_operator_act(
        operator_approval_ref, surface="breaker_reset", scope=trip_scope(root), base_dir=root,
    )
    atomic_write_json(_state_path(root), {"state": "ok"})
    from .tool_registry import append_tools_governance
    append_tools_governance(
        root,
        COST_BREAKER_RESET_EVENT,
        {
            "operator_approval_ref": operator_approval_ref,
            "operator_approval": approval,
            "reason": reason,
        },
    )
    return {"status": "ok"}


__all__ = [
    "COST_BREAKER",
    "COST_BREAKER_RESET_EVENT",
    "assert_within_budget",
    "attribution",
    "current_state",
    "derived_usage",
    "monetary_admission_in_force",
    "reset_breaker",
    "trip_scope",
]
