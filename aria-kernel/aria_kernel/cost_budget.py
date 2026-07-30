"""Plan ARIA-V3 §B0 + INFRA-CRITICAL-001 — cost circuit breaker.

GAP: after B1 flips ``CLAUDE_CODE_MOCK=false``, every daily
``aria-agent-executor.yml`` cron run hits the real Claude API. The
existing failure breaker (``circuit_breaker.py``, Phase B2) trips
on validator rejections / sandbox-red / CI-red etc. — but NOT on
$cost. A pricing surprise or runaway request could exhaust an
operator's budget silently between daily reviews.

V3 §B0 lands a co-equal **cost** circuit breaker:

  * Persisted daily + monthly USD ledgers at
    ``aria-tools/budget/daily.json`` + ``aria-tools/budget/monthly.json``
    (gitignored per Phase A2 + A5 .gitignore sweep).
  * Per-run cap enforced AT THE EXECUTOR BOUNDARY
    (``tools/aria-poc/{ci,worker}_executor.py``) before spawning
    ``claude``. The kernel-side ``assert_within_budget`` raises
    ``GovernanceError`` when any cap is exceeded.
  * Tripped state ⇒ runtime profile auto-downgrades to ``strict``
    (no more autonomous loops) and emits
    ``cost_budget_breaker_tripped`` governance event with the
    exceeded cap name + amounts.
  * State survives kernel restart (cold-start reads the on-disk
    JSON files; I-V3-B0e invariant locks this).

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

from .tool_registry import GovernanceError, ensure_tools_dir

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


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{id(payload)}")
    tmp.write_text(
        json.dumps(payload, sort_keys=True, indent=2),
        encoding="utf-8",
    )
    tmp.replace(path)


def _load_caps(base_dir: str | Path) -> dict[str, float]:
    from .genesis_policy import load_policy

    # Plan ARIA-V3 §B0 — operator override lives at
    # ``<workspace_root>/aria-config/genesis_policy.json``; the
    # kernel ``base_dir`` is ``<workspace_root>/aria-tools`` so the
    # repo_root is the parent. Defaults shipped in
    # ``aria_kernel/data/genesis_policy_default.json`` include the
    # ``cost_caps_usd`` block.
    repo_root = Path(base_dir).parent
    policy = load_policy(repo_root)
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

    if estimated_run_usd > caps["per_run"]:
        _trip_breaker(root, cap_name="per_run", amount=estimated_run_usd, cap=caps["per_run"])
        raise GovernanceError(
            f"cost_budget_per_run_cap_exceeded: estimate={estimated_run_usd} cap={caps['per_run']}"
        )
    projected_daily = spent_daily + estimated_run_usd
    if projected_daily > caps["daily"]:
        _trip_breaker(root, cap_name="daily", amount=projected_daily, cap=caps["daily"])
        raise GovernanceError(
            f"cost_budget_daily_cap_exceeded: projected={projected_daily} cap={caps['daily']}"
        )
    projected_monthly = spent_monthly + estimated_run_usd
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
    _atomic_write_json(
        _state_path(root),
        {
            "state": "tripped",
            "tripped_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
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


def reset_breaker(
    *,
    base_dir: str | Path,
    reason: str,
    operator_approval_ref: str,
) -> dict[str, Any]:
    """Plan ARIA-V3 §B0 — operator clears the tripped flag after
    investigating + adjusting caps if needed. Audit event records
    the reset.
    """
    root = ensure_tools_dir(base_dir)
    _atomic_write_json(_state_path(root), {"state": "ok"})
    from .tool_registry import append_tools_governance
    append_tools_governance(
        root,
        "cost_budget_breaker_reset",
        {
            "operator_approval_ref": operator_approval_ref,
            "reason": reason,
        },
    )
    return {"status": "ok"}


__all__ = [
    "assert_within_budget",
    "current_state",
    "derived_usage",
    "reset_breaker",
]
