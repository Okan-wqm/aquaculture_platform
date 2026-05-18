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


# ---------------------------------------------------------------------------
# Plan ARIA-V8 §4 Phase 8.0 (B-V2-11) — per-run reservation discipline.
#
# WHY: existing daily/monthly cap (above) bounds long-term spend but not
# per-run cost spikes. With V8's P+C+CR pipeline tripling LLM calls per
# cycle, an uncapped 30-cycle smoke could silently drift past the daily
# cap mid-run. C0 adds a per-RUN cap with cycle-level reservation +
# envelope-level reconciliation, recorded to a separate ledger at
# ``aria-tools/budget-ledger.jsonl`` (hash-chained, append-only).
#
# Fails closed: missing/unknown reservation_token raises
# BudgetReservationMissing; over-cap reservation raises BudgetExhausted.
# No silent "no cap" path.
# ---------------------------------------------------------------------------

import hashlib  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402

from .file_lock import with_exclusive_lock  # noqa: E402

PER_RUN_BUDGET_LEDGER_FILENAME = "budget-ledger.jsonl"
DEFAULT_MAX_BUDGET_USD_PER_RUN = 20.00


class BudgetReservationMissing(GovernanceError):
    """Raised when a reservation_token is not on the per-run ledger."""


class BudgetExhausted(GovernanceError):
    """Raised when remaining budget cannot cover the next envelope."""


def _per_run_ledger_path(base_dir: str | Path) -> Path:
    return ensure_tools_dir(base_dir) / PER_RUN_BUDGET_LEDGER_FILENAME


def _per_run_canonical_hash(row: dict[str, Any]) -> str:
    payload = json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _per_run_previous_hash(ledger_path: Path) -> str | None:
    if not ledger_path.exists():
        return None
    with ledger_path.open("r", encoding="utf-8") as fh:
        last_line = None
        for line in fh:
            if line.strip():
                last_line = line
    if last_line is None:
        return None
    try:
        return json.loads(last_line).get("ledger_hash")
    except json.JSONDecodeError:
        return None


def _per_run_append(base_dir: str | Path, row: dict[str, Any]) -> dict[str, Any]:
    ledger_path = _per_run_ledger_path(base_dir)
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = Path(str(ledger_path) + ".lock")
    with with_exclusive_lock(lock_path, timeout_seconds=5.0):
        previous_hash = _per_run_previous_hash(ledger_path)
        body = {k: v for k, v in row.items() if k not in ("ledger_hash", "previous_ledger_hash")}
        body["previous_ledger_hash"] = previous_hash
        body["ledger_hash"] = _per_run_canonical_hash(body)
        with ledger_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(body, ensure_ascii=False) + "\n")
        return body


def _per_run_load(base_dir: str | Path) -> list[dict[str, Any]]:
    ledger_path = _per_run_ledger_path(base_dir)
    if not ledger_path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with ledger_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def _per_run_remaining(base_dir: str | Path, cap: float) -> float:
    consumed = 0.0
    for row in _per_run_load(base_dir):
        if row.get("kind") == "envelope_reconciliation":
            try:
                consumed += float(row.get("actual_cost_usd", 0))
            except (TypeError, ValueError):
                continue
    return max(0.0, cap - consumed)


def reserve_cycle_budget(
    *,
    cycle_id: str,
    estimated_cost_usd: float,
    base_dir: str | Path,
    max_budget_usd_per_run: float | None = None,
) -> str:
    """Reserve cycle budget; return reservation_token (ledger_hash)."""
    if not isinstance(estimated_cost_usd, (int, float)) or estimated_cost_usd <= 0:
        raise GovernanceError(
            f"estimated_cost_usd must be > 0, got {estimated_cost_usd!r}"
        )
    cap = float(
        max_budget_usd_per_run
        if max_budget_usd_per_run is not None
        else os.environ.get("MAX_BUDGET_USD_PER_RUN", DEFAULT_MAX_BUDGET_USD_PER_RUN)
    )
    remaining = _per_run_remaining(base_dir, cap)
    if estimated_cost_usd > remaining:
        raise BudgetExhausted(
            f"reserve_cycle_budget: cycle_id={cycle_id} estimated=${estimated_cost_usd:.4f} "
            f"> remaining_run=${remaining:.4f} (cap=${cap:.4f})"
        )
    row = {
        "$schema": "aria/budget-reservation/v1",
        "kind": "cycle_reservation",
        "cycle_id": cycle_id,
        "estimated_cost_usd": float(estimated_cost_usd),
        "max_budget_usd_per_run": cap,
        "recorded_at": utc_now(),
        "schema_version": 1,
    }
    persisted = _per_run_append(base_dir, row)
    return str(persisted["ledger_hash"])


def _find_reservation(base_dir: str | Path, reservation_token: str) -> dict[str, Any] | None:
    for row in _per_run_load(base_dir):
        if row.get("kind") == "cycle_reservation" and row.get("ledger_hash") == reservation_token:
            return row
    return None


def reconcile_envelope_cost(
    *,
    reservation_token: str,
    envelope_id: str,
    actual_cost_usd: float,
    base_dir: str | Path,
) -> dict[str, Any]:
    """Record actual envelope cost against a prior cycle reservation."""
    if not isinstance(actual_cost_usd, (int, float)) or actual_cost_usd < 0:
        raise GovernanceError(
            f"actual_cost_usd must be >= 0, got {actual_cost_usd!r}"
        )
    if _find_reservation(base_dir, reservation_token) is None:
        raise BudgetReservationMissing(
            f"reservation_token={reservation_token[:24]}... not found on per-run ledger"
        )
    row = {
        "$schema": "aria/budget-reconciliation/v1",
        "kind": "envelope_reconciliation",
        "reservation_token": reservation_token,
        "envelope_id": envelope_id,
        "actual_cost_usd": float(actual_cost_usd),
        "recorded_at": utc_now(),
        "schema_version": 1,
    }
    return _per_run_append(base_dir, row)


def check_remaining_budget(
    *,
    reservation_token: str,
    base_dir: str | Path,
) -> float:
    """Reserved - reconciled, for THIS reservation."""
    reservation = _find_reservation(base_dir, reservation_token)
    if reservation is None:
        raise BudgetReservationMissing(
            f"reservation_token={reservation_token[:24]}... not found"
        )
    reserved = float(reservation.get("estimated_cost_usd", 0))
    reconciled = 0.0
    for row in _per_run_load(base_dir):
        if row.get("kind") == "envelope_reconciliation" and row.get("reservation_token") == reservation_token:
            try:
                reconciled += float(row.get("actual_cost_usd", 0))
            except (TypeError, ValueError):
                continue
    return max(0.0, reserved - reconciled)
