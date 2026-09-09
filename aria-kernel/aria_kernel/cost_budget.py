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

# ARIA-DELIVERY-03 — the two billing channels. The notional constant is
# owned by `budget.py` (it stamps every cost-attribution row with it), so it
# is imported rather than restated: one spelling, one meaning.
from .budget import USD_BASIS_NOTIONAL_API_EQUIVALENT  # noqa: E402

#: A provider redirect is in force and the call is billed to a wallet.
USD_BASIS_INVOICED = "invoiced_api"

USD_BASES: tuple[str, ...] = (USD_BASIS_NOTIONAL_API_EQUIVALENT, USD_BASIS_INVOICED)

# The subscription meter's defaults mirror `token_economy`, which already
# computes both conditions for its effort recommendations. This gate promotes
# them from advice to enforcement: under a subscription a runaway loop costs
# quota and wall-clock, and those are the things worth refusing over.
DEFAULT_SUBSCRIPTION_MIN_SPAWNS = 8


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
    usd_basis: str = USD_BASIS_INVOICED,
) -> dict[str, Any]:
    """Plan ARIA-V3 §B0 — call BEFORE spawning ``claude``. Raises
    GovernanceError when any cap is exceeded; otherwise returns the
    current usage snapshot.

    ARIA-DELIVERY-03 — ``usd_basis`` names the BILLING CHANNEL, because ARIA
    has two and only one of them produces an invoice.

    * ``USD_BASIS_INVOICED`` — a provider redirect is in force (the
      operator-sanctioned z.ai/GLM failover). Real money, real caps.
    * ``USD_BASIS_NOTIONAL_API_EQUIVALENT`` — the default managed Claude Code
      session. ``budget.record_cost_attribution`` already stamps every row
      with this basis and says of the figure: "It is a comparable, not an
      invoice. ... Nothing gates on it." This gate used to contradict that
      label and gate on it anyway. On 2026-09-04 that cost the delivery lane
      its whole night: cap $0.50 against an estimate of $0.8416, 7 dispatches
      attempted, 0 succeeded, `stop=budget_exhausted` — a queue stopped by an
      invoice nobody would ever receive. `claude_runtime._assert_budget_before_spawn`
      had already survived this exact failure ("every spawn was refused before
      it started and the breaker tripped on configuration, not on spend") and
      fixed it in ITS gate only; the executor's second gate kept the defect.

    What binds under a subscription is quota, tokens and wall-clock, not
    dollars — see :func:`assert_within_subscription_budget`, which the caller
    invokes instead on the notional basis. Refusing here on a notional figure
    is refusing on a number the ledger itself calls a comparable.
    """
    if usd_basis not in USD_BASES:
        raise GovernanceError(
            f"cost_budget_unknown_usd_basis: {usd_basis!r}; vocabulary is {USD_BASES}"
        )
    if estimated_run_usd < 0:
        raise GovernanceError(
            f"cost_budget_negative_estimate: {estimated_run_usd}"
        )
    root = ensure_tools_dir(base_dir)
    caps = _load_caps(root)
    spent_daily, spent_monthly = derived_usage(root)
    if usd_basis == USD_BASIS_NOTIONAL_API_EQUIVALENT:
        # No invoice exists on this channel, so no USD cap may refuse work.
        # The snapshot is still returned: the figure remains a comparable an
        # operator or dashboard can read, which is all it ever claimed to be.
        return {
            "status": "ok",
            "usd_basis": usd_basis,
            "gated_on_usd": False,
            "estimated_run_usd": estimated_run_usd,
            "projected_daily_usd": spent_daily + estimated_run_usd,
            "projected_monthly_usd": spent_monthly + estimated_run_usd,
            "caps": caps,
        }

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
        "usd_basis": usd_basis,
        "gated_on_usd": True,
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
    # Plan 032 Faz 032e — a tripped cost breaker is an operator event.
    from .notify import notify_best_effort

    notify_best_effort(
        kind="breaker_tripped", key=f"cost:{cap_name}", base_dir=root,
        title=f"ARIA cost breaker tripped ({cap_name})",
        body=f"amount_usd: {amount} cap_usd: {cap}",
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


def assert_within_subscription_budget(
    base_dir: str | Path,
    *,
    target_agent: str,
    role: str,
    min_spawns: int = DEFAULT_SUBSCRIPTION_MIN_SPAWNS,
    threshold_tokens: float | None = None,
    window_days: int | None = None,
) -> dict[str, Any]:
    """ARIA-DELIVERY-03 — the gate that binds when there is no invoice.

    Under a managed Claude Code session a dollar figure is a comparable, so
    the scarce things a runaway consumes are shared quota, tokens and CI
    minutes. `token_economy` already measures exactly the two conditions that
    identify a runaway — a window of spawns with no accepted result, and an
    excessive token cost per accepted result — but only ever turned them into
    an effort DOWNGRADE RECOMMENDATION. Nothing enforced them, so the loop
    protection the USD cap was standing in for did not exist anywhere.

    Refuses on the agent+role whose dispatch is about to happen, never
    globally: one wasteful role must not stop the lane it shares.

    Fails OPEN when the ledgers are absent or unreadable. A missing usage
    ledger is not evidence of a runaway, and this gate must not become the
    next `cost_budget_per_run_cap_exceeded` — a configuration that refuses
    every dispatch before it starts.
    """
    root = ensure_tools_dir(base_dir)
    try:
        from .token_economy import (
            DEFAULT_TOKENS_PER_ACCEPTED_THRESHOLD,
            DEFAULT_WINDOW_DAYS,
            usage_per_accepted_result,
        )

        limit = (
            DEFAULT_TOKENS_PER_ACCEPTED_THRESHOLD
            if threshold_tokens is None
            else float(threshold_tokens)
        )
        days = DEFAULT_WINDOW_DAYS if window_days is None else int(window_days)
        stats = usage_per_accepted_result(base_dir=root, window_days=days)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return {"status": "ok", "gated": False, "reason": f"usage_unreadable:{type(exc).__name__}"}

    stat = next(
        (s for s in stats if s.target_agent == str(target_agent) and s.role == str(role)),
        None,
    )
    if stat is None:
        return {"status": "ok", "gated": False, "reason": "no_window_history"}

    snapshot = {"status": "ok", "gated": True, "window_days": days, "stat": stat.to_dict()}
    if stat.accepted == 0 and stat.spawns >= int(min_spawns):
        _trip_breaker(root, cap_name="subscription_no_accepted", amount=float(stat.spawns), cap=float(min_spawns))
        raise GovernanceError(
            f"subscription_budget_no_accepted_results: {target_agent}/{role} "
            f"{stat.spawns} spawns and 0 accepted results in {days}d "
            f"(min_spawns={min_spawns})"
        )
    if stat.tokens_per_accepted is not None and stat.tokens_per_accepted > limit:
        _trip_breaker(root, cap_name="subscription_tokens_per_accepted", amount=float(stat.tokens_per_accepted), cap=float(limit))
        raise GovernanceError(
            f"subscription_budget_tokens_per_accepted_exceeded: {target_agent}/{role} "
            f"{int(stat.tokens_per_accepted)} tokens per accepted result > {int(limit)}"
        )
    return snapshot


__all__ = [
    "DEFAULT_SUBSCRIPTION_MIN_SPAWNS",
    "USD_BASES",
    "USD_BASIS_INVOICED",
    "USD_BASIS_NOTIONAL_API_EQUIVALENT",
    "assert_within_budget",
    "assert_within_subscription_budget",
    "current_state",
    "derived_usage",
    "reset_breaker",
]
