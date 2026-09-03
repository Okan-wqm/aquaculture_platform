"""Plan 020 Phase 13 — cost telemetry (dispatch rationale + 13th metric).

WHY this module exists
----------------------
ARIA dispatches now expose role-based context budget caps (Phase 2),
mock vs real eval segregation (Phase 6), and the validation matrix
(Phase 8). Operators ask "why did the kernel pick THIS model / THIS
context budget for THIS dispatch?" — Phase 13 records the answer.

Each dispatch_rationale row captures:
- estimated_input_tokens / estimated_output_tokens / chosen_model.
- model_choice_reason (a short string).
- soft_cap_remaining / hard_cap_remaining (USD budget snapshot from
  budget.check_budget).
- ci_off_hours_window: bool (eligible for off-hours scheduled run).

Plan 020 surface
----------------
cost_telemetry is in PLAN_020_WRITE_SURFACES; observe BLOCKS (telemetry
mutates dispatch path → not observation-class). Frozen blocks.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, read_jsonl
from .runtime_profile import enforce_profile_for_write
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    ensure_tools_dir_readonly,
    utc_now,
)

COST_TELEMETRY_FILENAME = "cost-telemetry.jsonl"

REQUIRED_RATIONALE_FIELDS: tuple[str, ...] = (
    "estimated_input_tokens",
    "estimated_output_tokens",
    "chosen_model",
    "model_choice_reason",
    "soft_cap_remaining",
    "hard_cap_remaining",
    "ci_off_hours_window",
)


def _ledger_path(tools_root: Path) -> Path:
    return tools_root / COST_TELEMETRY_FILENAME


def _ci_off_hours_window(*, now: datetime | None = None) -> bool:
    """Off-hours window = 22:00-06:00 UTC, mirrors aria-agent-executor
    schedule slot. Operators override per call."""
    n = (now or datetime.now(timezone.utc)).hour
    return n >= 22 or n < 6


def compose_dispatch_rationale(
    *,
    request_id: str,
    role: str,
    estimated_input_tokens: int,
    estimated_output_tokens: int,
    chosen_model: str,
    model_choice_reason: str,
    soft_cap_remaining: float,
    hard_cap_remaining: float,
    ci_off_hours_window: bool | None = None,
) -> dict[str, Any]:
    """Assemble a dispatch_rationale dict (no ledger write)."""
    if estimated_input_tokens < 0 or estimated_output_tokens < 0:
        raise GovernanceError("token estimates must be non-negative")
    if not (chosen_model or "").strip():
        raise GovernanceError("chosen_model is required")
    if not (model_choice_reason or "").strip():
        raise GovernanceError("model_choice_reason is required")
    return {
        "$schema": "aria/dispatch-rationale/v1",
        "schema_version": 1,
        "request_id": request_id,
        "role": role,
        "estimated_input_tokens": int(estimated_input_tokens),
        "estimated_output_tokens": int(estimated_output_tokens),
        "chosen_model": chosen_model,
        "model_choice_reason": model_choice_reason,
        "soft_cap_remaining": float(soft_cap_remaining),
        "hard_cap_remaining": float(hard_cap_remaining),
        "ci_off_hours_window": bool(ci_off_hours_window
                                    if ci_off_hours_window is not None
                                    else _ci_off_hours_window()),
        "recorded_at": utc_now(),
    }


def record_dispatch_rationale(
    *,
    rationale: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Persist a dispatch_rationale row + emit governance event.

    Frozen-aware: enforce_profile_for_write('cost_telemetry', ...).
    Observe also blocks — telemetry mutates the dispatch path so it is
    NOT in OBSERVE_PERMITTED_SURFACES.
    """
    enforce_profile_for_write("cost_telemetry", base_dir=base_dir)
    missing = [f for f in REQUIRED_RATIONALE_FIELDS if f not in rationale]
    if missing:
        raise GovernanceError(
            f"dispatch_rationale missing fields: {missing}"
        )
    row = {**rationale}
    row.setdefault("$schema", "aria/dispatch-rationale/v1")
    row.setdefault("schema_version", 1)
    row.setdefault("recorded_at", utc_now())
    root = ensure_tools_dir(base_dir)
    append_declared_jsonl(
        _ledger_path(root),
        row,
        expected_surface="cost_telemetry",
    )
    append_tools_governance(
        root,
        "dispatch_rationale_recorded",
        {
            "request_id": row.get("request_id"),
            "role": row.get("role"),
            "chosen_model": row.get("chosen_model"),
            "ci_off_hours_window": row.get("ci_off_hours_window"),
        },
    )
    return row


def list_dispatch_rationales(
    *, base_dir: str | Path | None = None,
    request_id: str | None = None,
    role: str | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return []
    path = _ledger_path(root)
    if not path.exists():
        return []
    rows = read_jsonl(path, expected_surface="cost_telemetry")
    if request_id is not None:
        rows = [r for r in rows if r.get("request_id") == request_id]
    if role is not None:
        rows = [r for r in rows if r.get("role") == role]
    if limit is not None and limit > 0:
        rows = rows[-limit:]
    return rows


def count_dispatch_rationales(*, base_dir: str | Path | None = None) -> int:
    """Plan 020 Phase 13 metric feeder — aria_dispatch_rationale_total."""
    return len(list_dispatch_rationales(base_dir=base_dir))


__all__ = [
    "COST_TELEMETRY_FILENAME",
    "REQUIRED_RATIONALE_FIELDS",
    "compose_dispatch_rationale",
    "record_dispatch_rationale",
    "list_dispatch_rationales",
    "count_dispatch_rationales",
]
