from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


DEFAULT_BUDGET = {
    "schema_version": 1,
    "daily_usd_cap": 5.0,
    "monthly_usd_cap": 100.0,
    "per_action_usd_cap": 1.0,
    "soft_stop_ratio": 0.8,
}


def check_budget(
    *,
    estimated_usd: float,
    action: str,
    base_dir: str | Path | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if estimated_usd < 0:
        raise GovernanceError("estimated_usd must be non-negative")
    active = _normalize_budget(config or {})
    usage = _usage(base_dir)
    daily_after = usage["daily_usd"] + estimated_usd
    monthly_after = usage["monthly_usd"] + estimated_usd
    reasons: list[str] = []
    if estimated_usd > active["per_action_usd_cap"]:
        reasons.append("per-action cap exceeded")
    if daily_after > active["daily_usd_cap"]:
        reasons.append("daily cap exceeded")
    if monthly_after > active["monthly_usd_cap"]:
        reasons.append("monthly cap exceeded")
    soft_stop = (
        daily_after >= active["daily_usd_cap"] * active["soft_stop_ratio"]
        or monthly_after >= active["monthly_usd_cap"] * active["soft_stop_ratio"]
    )
    return {
        "schema_version": 1,
        "action": action,
        "estimated_usd": estimated_usd,
        "allowed": not reasons,
        "soft_stop": soft_stop,
        "reasons": reasons,
        "usage": usage,
        "projected": {"daily_usd": daily_after, "monthly_usd": monthly_after},
        "budget": active,
    }


def record_budget_usage(
    *,
    action: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    estimated_usd: float,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    decision = check_budget(estimated_usd=estimated_usd, action=action, base_dir=base_dir)
    if not decision["allowed"]:
        raise GovernanceError("budget gate blocked usage: " + ", ".join(decision["reasons"]))
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "action": action,
        "provider": provider,
        "model": model,
        "input_tokens": _non_negative_int(input_tokens, "input_tokens"),
        "output_tokens": _non_negative_int(output_tokens, "output_tokens"),
        "estimated_usd": estimated_usd,
        "soft_stop": decision["soft_stop"],
    }
    return append_jsonl(_budget_ledger(base_dir), row)


def list_budget_usage(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(_budget_ledger(base_dir))


def _usage(base_dir: str | Path | None) -> dict[str, float]:
    now = datetime.now(timezone.utc)
    day = now.date().isoformat()
    month = day[:7]
    daily = 0.0
    monthly = 0.0
    for row in load_jsonl(_budget_ledger(base_dir)):
        recorded_at = str(row.get("recorded_at", ""))
        amount = row.get("estimated_usd", 0)
        if not isinstance(amount, (int, float)):
            continue
        if recorded_at.startswith(day):
            daily += float(amount)
        if recorded_at.startswith(month):
            monthly += float(amount)
    return {"daily_usd": round(daily, 6), "monthly_usd": round(monthly, 6)}


def _normalize_budget(config: dict[str, Any]) -> dict[str, float | int]:
    merged = {**DEFAULT_BUDGET, **config}
    for key in ("daily_usd_cap", "monthly_usd_cap", "per_action_usd_cap", "soft_stop_ratio"):
        if not isinstance(merged.get(key), (int, float)) or float(merged[key]) < 0:
            raise GovernanceError(f"budget {key} must be a non-negative number")
    if not 0 <= float(merged["soft_stop_ratio"]) <= 1:
        raise GovernanceError("budget soft_stop_ratio must be in [0, 1]")
    return {
        "schema_version": int(merged.get("schema_version", 1)),
        "daily_usd_cap": float(merged["daily_usd_cap"]),
        "monthly_usd_cap": float(merged["monthly_usd_cap"]),
        "per_action_usd_cap": float(merged["per_action_usd_cap"]),
        "soft_stop_ratio": float(merged["soft_stop_ratio"]),
    }


def _budget_ledger(base_dir: str | Path | None) -> Path:
    return ensure_tools_dir(base_dir) / "budget" / "usage.jsonl"


def _non_negative_int(value: int, field: str) -> int:
    if not isinstance(value, int) or value < 0:
        raise GovernanceError(f"{field} must be a non-negative integer")
    return value
