"""Critical Observation persistence + escalation (Plan 016 Faz E3, CONTRACTS §7).

Critical observations bypass the >=2-evidence requirement (single trigger
sufficient per L1) but cannot be lost: each one MUST be persisted to disk
synchronously before the next tool call. SLA windows are tiered by
severity, and escalations get progressively louder until acknowledged.

CONTRACTS §7 schema:
- observation_id: CO-YYYY-MM-DD-NNN
- severity: CRITICAL | HIGH | MEDIUM
- category: security | data_integrity | regulatory | production_affecting | plc_safety
- persisted_before_next_tool_call: true (hard invariant — record_critical_observation
  forces an fsync before returning so the caller's next tool call cannot run before
  the file is durable)

SLA windows:
- CRITICAL: acknowledge 24h, resolve 7d
- HIGH:     acknowledge 72h, resolve 30d
- MEDIUM:   acknowledge 7d,  resolve 90d

Escalation tiers (for daily report rendering):
- N + 2*SLA: highlighted in daily report
- N + 3*SLA: top-of-page in weekly report
- N + 5*SLA: top-of-page in EVERY daily report until acknowledged
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir


CRITICAL_SEVERITIES = ("CRITICAL", "HIGH", "MEDIUM")
CRITICAL_CATEGORIES = (
    "security",
    "data_integrity",
    "regulatory",
    "production_affecting",
    "plc_safety",
)
CRITICAL_STATUSES = ("open", "acknowledged", "resolved")

# SLA windows per severity. (acknowledge_within, resolve_within).
SLA_WINDOWS = {
    "CRITICAL": (timedelta(hours=24), timedelta(days=7)),
    "HIGH": (timedelta(hours=72), timedelta(days=30)),
    "MEDIUM": (timedelta(days=7), timedelta(days=90)),
}

CO_ID_RE = re.compile(r"^CO-\d{4}-\d{2}-\d{2}-\d{3}$")
SCHEMA_VERSION = 1


def _co_dir(tools_root: Path) -> Path:
    return tools_root / "critical-observations"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _allocate_co_id(tools_root: Path, *, when: datetime) -> str:
    """Date-stamped sequential ID: CO-YYYY-MM-DD-NNN."""
    co_dir = _co_dir(tools_root)
    prefix = when.strftime("CO-%Y-%m-%d-")
    if not co_dir.exists():
        return f"{prefix}001"
    existing = [
        p.stem for p in co_dir.glob(f"{prefix}*.json") if CO_ID_RE.match(p.stem)
    ]
    if not existing:
        return f"{prefix}001"
    last_num = max(int(stem.rsplit("-", 1)[1]) for stem in existing)
    return f"{prefix}{last_num + 1:03d}"


def _atomic_fsync_write(path: Path, payload: dict[str, Any]) -> None:
    """Write JSON + fsync the file AND its parent dir.

    Plan 016 §Critical Observation hard invariant: persisted_before_next_
    tool_call. This helper makes the persistence durable on POSIX —
    fsync the file descriptor and the containing directory so the
    record survives a crash that happens between this call and the
    caller's next tool invocation.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    data = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        os.write(fd, data.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    tmp.replace(path)
    # fsync the directory so the rename is durable.
    dir_fd = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def record_critical_observation(
    *,
    severity: str,
    category: str,
    summary: str,
    evidence_ref: str,
    detail: str = "",
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Persist a critical observation BEFORE returning to the caller.

    Single concrete evidence_ref is sufficient (CONTRACTS §7 — critical
    observations bypass the >=2-evidence requirement). Returns the
    persisted record with computed SLA deadlines.

    Plan 026R §A.4 — frozen-profile gate at function entry. Critical-
    observation emission is one of the 8 §A.4 legacy mutators; under
    frozen the operator's incident-response intent (no writes) is now
    honoured by this surface too.
    """
    from .runtime_profile import enforce_profile_for_write
    enforce_profile_for_write("critical_observation", base_dir=base_dir)
    if severity not in CRITICAL_SEVERITIES:
        raise GovernanceError(
            f"critical observation severity must be one of {CRITICAL_SEVERITIES}, got {severity!r}"
        )
    if category not in CRITICAL_CATEGORIES:
        raise GovernanceError(
            f"critical observation category must be one of {CRITICAL_CATEGORIES}, got {category!r}"
        )
    if not isinstance(summary, str) or not summary.strip():
        raise GovernanceError("summary is required")
    if not isinstance(evidence_ref, str) or not evidence_ref.strip():
        raise GovernanceError("evidence_ref is required (single concrete ref OK per §7)")

    tools_root = ensure_tools_dir(base_dir)
    ts = now or _utc_now()
    ack_window, resolve_window = SLA_WINDOWS[severity]

    co_id = _allocate_co_id(tools_root, when=ts)
    record = {
        "$schema": "aria/critical-observation/v1",
        "schema_version": SCHEMA_VERSION,
        "observation_id": co_id,
        "severity": severity,
        "category": category,
        "summary": summary,
        "detail": detail,
        "evidence_ref": evidence_ref,
        "cycle_id": cycle_id,
        "recorded_at": _iso(ts),
        "ack_deadline": _iso(ts + ack_window),
        "resolve_deadline": _iso(ts + resolve_window),
        "status": "open",
        "acknowledged_at": None,
        "acknowledged_by": None,
        "resolved_at": None,
        "resolved_by": None,
        "resolution_note": None,
        "persisted_before_next_tool_call": True,
    }

    out_path = _co_dir(tools_root) / f"{co_id}.json"
    if out_path.exists():
        raise GovernanceError(f"critical observation {co_id} already exists at {out_path}")
    _atomic_fsync_write(out_path, record)

    append_tools_governance(
        tools_root,
        "critical_observation_recorded",
        {
            "observation_id": co_id,
            "severity": severity,
            "category": category,
            "ack_deadline": record["ack_deadline"],
            "resolve_deadline": record["resolve_deadline"],
            "path": out_path.relative_to(tools_root).as_posix(),
        },
    )
    return record


def list_critical_observations(
    *,
    base_dir: str | Path | None = None,
    include_resolved: bool = False,
) -> list[dict[str, Any]]:
    """List recorded observations, sorted by ack_deadline (earliest first)."""
    tools_root = ensure_tools_dir(base_dir)
    co_dir = _co_dir(tools_root)
    if not co_dir.exists():
        return []
    rows: list[dict[str, Any]] = []
    for path in co_dir.glob("CO-*.json"):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not include_resolved and doc.get("status") == "resolved":
            continue
        rows.append(doc)
    rows.sort(key=lambda r: r.get("ack_deadline", ""))
    return rows


def acknowledge_critical_observation(
    *,
    observation_id: str,
    acknowledged_by: str,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    if not acknowledged_by or not acknowledged_by.strip():
        raise GovernanceError("acknowledged_by is required")
    tools_root = ensure_tools_dir(base_dir)
    path = _co_dir(tools_root) / f"{observation_id}.json"
    if not path.exists():
        raise GovernanceError(f"critical observation {observation_id} not found")
    record = json.loads(path.read_text(encoding="utf-8"))
    if record.get("status") in {"acknowledged", "resolved"}:
        return record
    ts = now or _utc_now()
    record["status"] = "acknowledged"
    record["acknowledged_at"] = _iso(ts)
    record["acknowledged_by"] = acknowledged_by
    _atomic_fsync_write(path, record)
    append_tools_governance(
        tools_root,
        "critical_observation_acknowledged",
        {"observation_id": observation_id, "acknowledged_by": acknowledged_by},
    )
    return record


def resolve_critical_observation(
    *,
    observation_id: str,
    resolved_by: str,
    resolution_note: str,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    if not resolved_by or not resolved_by.strip():
        raise GovernanceError("resolved_by is required")
    if not isinstance(resolution_note, str) or not resolution_note.strip():
        raise GovernanceError("resolution_note is required")
    tools_root = ensure_tools_dir(base_dir)
    path = _co_dir(tools_root) / f"{observation_id}.json"
    if not path.exists():
        raise GovernanceError(f"critical observation {observation_id} not found")
    record = json.loads(path.read_text(encoding="utf-8"))
    if record.get("status") == "resolved":
        return record
    ts = now or _utc_now()
    record["status"] = "resolved"
    record["resolved_at"] = _iso(ts)
    record["resolved_by"] = resolved_by
    record["resolution_note"] = resolution_note
    _atomic_fsync_write(path, record)
    append_tools_governance(
        tools_root,
        "critical_observation_resolved",
        {"observation_id": observation_id, "resolved_by": resolved_by},
    )
    return record


def compute_escalation_tier(record: dict[str, Any], *, now: datetime | None = None) -> str:
    """Return one of: 'within_sla', 'highlighted', 'weekly_top', 'every_daily_top'.

    Plan 016 §Critical Observation escalation tiers based on N+kxSLA:
    - within_sla: ack_deadline still in the future
    - highlighted: now >= recorded + 2 * ack_window (but < 3*)
    - weekly_top: now >= recorded + 3 * ack_window (but < 5*)
    - every_daily_top: now >= recorded + 5 * ack_window
    """
    if record.get("status") in {"acknowledged", "resolved"}:
        return "within_sla"
    severity = record.get("severity", "MEDIUM")
    ack_window, _ = SLA_WINDOWS.get(severity, SLA_WINDOWS["MEDIUM"])
    try:
        recorded = datetime.fromisoformat(str(record.get("recorded_at", "")).replace("Z", "+00:00"))
    except ValueError:
        return "within_sla"
    ts = now or _utc_now()
    age = ts - recorded
    if age >= 5 * ack_window:
        return "every_daily_top"
    if age >= 3 * ack_window:
        return "weekly_top"
    if age >= 2 * ack_window:
        return "highlighted"
    return "within_sla"
