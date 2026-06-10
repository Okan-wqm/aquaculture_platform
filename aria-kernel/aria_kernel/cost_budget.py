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
_DAILY_FILE = "daily.json"
_MONTHLY_FILE = "monthly.json"
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
    daily = _read_json(_budget_dir(root) / _DAILY_FILE, {"date": _today_key(), "usd": 0.0})
    monthly = _read_json(_budget_dir(root) / _MONTHLY_FILE, {"month": _month_key(), "usd": 0.0})

    # Roll forward on calendar boundary.
    if daily.get("date") != _today_key():
        daily = {"date": _today_key(), "usd": 0.0}
    if monthly.get("month") != _month_key():
        monthly = {"month": _month_key(), "usd": 0.0}

    if estimated_run_usd > caps["per_run"]:
        _trip_breaker(root, cap_name="per_run", amount=estimated_run_usd, cap=caps["per_run"])
        raise GovernanceError(
            f"cost_budget_per_run_cap_exceeded: estimate={estimated_run_usd} cap={caps['per_run']}"
        )
    projected_daily = float(daily.get("usd", 0.0)) + estimated_run_usd
    if projected_daily > caps["daily"]:
        _trip_breaker(root, cap_name="daily", amount=projected_daily, cap=caps["daily"])
        raise GovernanceError(
            f"cost_budget_daily_cap_exceeded: projected={projected_daily} cap={caps['daily']}"
        )
    projected_monthly = float(monthly.get("usd", 0.0)) + estimated_run_usd
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


def record_actual_usage(
    base_dir: str | Path,
    *,
    actual_usd: float,
) -> dict[str, Any]:
    """Plan ARIA-V3 §B0 — append actual cost to the daily +
    monthly ledgers after a successful ``claude`` invocation.
    """
    if actual_usd < 0:
        raise GovernanceError(
            f"cost_budget_negative_usage: {actual_usd}"
        )
    root = ensure_tools_dir(base_dir)
    daily_path = _budget_dir(root) / _DAILY_FILE
    monthly_path = _budget_dir(root) / _MONTHLY_FILE
    daily = _read_json(daily_path, {"date": _today_key(), "usd": 0.0})
    monthly = _read_json(monthly_path, {"month": _month_key(), "usd": 0.0})
    if daily.get("date") != _today_key():
        daily = {"date": _today_key(), "usd": 0.0}
    if monthly.get("month") != _month_key():
        monthly = {"month": _month_key(), "usd": 0.0}
    daily["usd"] = float(daily.get("usd", 0.0)) + actual_usd
    monthly["usd"] = float(monthly.get("usd", 0.0)) + actual_usd
    _atomic_write_json(daily_path, daily)
    _atomic_write_json(monthly_path, monthly)
    return {
        "status": "ok",
        "daily_usd": daily["usd"],
        "monthly_usd": monthly["usd"],
    }


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
    "record_actual_usage",
    "reset_breaker",
]
