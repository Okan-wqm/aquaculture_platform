from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .ledger import read_jsonl
from .phase2_utils import atomic_write_json, record_workspace_governance_once, utc_now_iso
from .pressure import append_pressure_state_event, effective_workspace_pressures
from .trust import ref_status_by_feedback_id
from .workspace import WorkspacePaths


def reverify_pressures(
    paths: WorkspacePaths,
    *,
    sample_rate: float = 0.10,
    dry_run: bool = True,
    apply: bool = False,
    acknowledge: bool = False,
    reason: str | None = None,
    reset_cursor: bool = False,
) -> dict[str, Any]:
    if reset_cursor:
        cursor_path(paths).unlink(missing_ok=True)
        return {"schema_version": 1, "mode": "reset_cursor", "cursor": None}
    if apply and not acknowledge:
        raise ValueError("reverify_apply_requires_acknowledge")
    if apply and not reason:
        raise ValueError("reverify_apply_requires_reason")
    mode = "apply" if apply and not dry_run else "dry_run"
    records = [row for row in effective_workspace_pressures(paths) if row.get("effective_state") in {"active", "faded", "sleeping"}]
    records.sort(key=lambda row: str(row.get("event_id") or row.get("pressure_id")))
    sample_count = max(1, math.ceil(len(records) * sample_rate)) if records else 0
    sampled = records[:sample_count]
    statuses = ref_status_by_feedback_id(paths)
    feedback = _feedback_by_id(paths)
    actions: list[dict[str, Any]] = []
    for pressure in sampled:
        action = _reverify_action(pressure, statuses, feedback)
        actions.append(action)
        if mode == "apply":
            record_workspace_governance_once(paths, "reverify_action_recorded", {"mode": mode, **action})
            if action["action"] == "archive":
                append_pressure_state_event(
                    paths,
                    pressure=pressure,
                    to_state="archived",
                    reason=reason or "reverify",
                    cycle_id=None,
                    evidence_refs=[],
                    feedback_event_ids=[],
                    details={"reverify_action": action},
                )
    proposed_cursor = {
        "schema_version": 1,
        "last_visited_pressure_event_id": actions[-1]["pressure_event_id"] if actions else None,
        "last_visit_at": utc_now_iso(),
        "sample_rate_at_last_run": sample_rate,
        "total_eligible_count_at_last_run": len(records),
    }
    if mode == "apply":
        atomic_write_json(cursor_path(paths), proposed_cursor)
    return {
        "schema_version": 1,
        "mode": mode,
        "sample_rate": sample_rate,
        "eligible_count": len(records),
        "sampled_count": len(sampled),
        "actions": actions,
        "cursor": proposed_cursor,
    }


def cursor_path(paths: WorkspacePaths) -> Path:
    return paths.state_dir / "reverify_cursor.json"


def _reverify_action(pressure: dict[str, Any], statuses: dict[str, str], feedback: dict[str, dict[str, Any]]) -> dict[str, Any]:
    pressure_id = str(pressure.get("event_id") or pressure.get("pressure_id") or "")
    if pressure.get("effective_state") == "active":
        return {"pressure_event_id": pressure_id, "action": "needs_operator_review", "reason": "active_pressure"}
    event_ids = [event_id for event_id in pressure.get("feedback_event_ids", []) if isinstance(event_id, str)]
    if not event_ids:
        return {"pressure_event_id": pressure_id, "action": "keep", "reason": "no_feedback_refs"}
    ref_statuses = [statuses.get(event_id, "unknown") for event_id in event_ids]
    if any(status == "fresh" for status in ref_statuses):
        return {"pressure_event_id": pressure_id, "action": "keep", "reason": "fresh_ref_present", "ref_statuses": ref_statuses}
    if any(status == "unknown" for status in ref_statuses):
        return {"pressure_event_id": pressure_id, "action": "keep", "reason": "unknown_ref_present", "ref_statuses": ref_statuses}
    if _has_recent_feedback(event_ids, feedback):
        return {"pressure_event_id": pressure_id, "action": "keep", "reason": "recent_feedback_present", "ref_statuses": ref_statuses}
    if all(status in {"stale", "missing"} for status in ref_statuses):
        return {"pressure_event_id": pressure_id, "action": "archive", "reason": "all_refs_stale_or_missing", "ref_statuses": ref_statuses}
    return {"pressure_event_id": pressure_id, "action": "keep", "reason": "not_all_refs_stale_or_missing", "ref_statuses": ref_statuses}


def _has_recent_feedback(event_ids: list[str], feedback: dict[str, dict[str, Any]]) -> bool:
    threshold = datetime.now(timezone.utc) - timedelta(days=30)
    for event_id in event_ids:
        created = str(feedback.get(event_id, {}).get("created_at") or "")
        try:
            parsed = datetime.fromisoformat(created.replace("Z", "+00:00"))
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        if parsed.astimezone(timezone.utc) >= threshold:
            return True
    return False


def _feedback_by_id(paths: WorkspacePaths) -> dict[str, dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for name in ("unknowns", "missed_signals", "external_feedback"):
        rows.extend(read_jsonl(paths.ledgers[name]))
    return {str(row.get("event_id")): row for row in rows if row.get("event_id")}
