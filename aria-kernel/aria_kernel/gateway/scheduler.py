"""Cron table with a CLOSED action vocabulary. Never a free prompt."""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import append_tools_governance, ensure_tools_dir, utc_now

SCHEDULES_SURFACE = "gateway_schedules"
SCHEDULES_RELPATH: tuple[str, ...] = ("gateway", "schedules.jsonl")
SCHEDULE_EVENTS: tuple[str, ...] = ("add", "pause", "resume", "remove", "ran")
# Closed vocabulary. Every entry maps to a kernel command or a repo workflow —
# there is no action that takes text to hand to a model.
SCHEDULE_ACTIONS: tuple[str, ...] = ("cycle", "drain", "daily_report", "doctor", "telemetry_export", "deliver", "inbox_drain")
ACTION_WORKFLOWS: dict[str, tuple[str, dict[str, str]]] = {
    "cycle": ("aria-auto-cycle.yml", {"mode": "cycle"}),
    "drain": ("aria-agent-executor.yml", {}),
    "daily_report": ("aria-daily-report.yml", {}),
}
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")
Runner = Callable[[list[str]], "subprocess.CompletedProcess[str]"]


def _field_matches(spec: str, value: int, lo: int, hi: int) -> bool:
    for part in spec.split(","):
        part = part.strip()
        step = 1
        if "/" in part:
            part, step_text = part.split("/", 1)
            step = int(step_text)
            if step <= 0:
                raise ValueError("cron step must be positive")
        if part == "*":
            start, end = lo, hi
        elif "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a), int(b)
        else:
            start = end = int(part)
        if not (lo <= start <= hi and lo <= end <= hi):
            raise ValueError(f"cron field {spec!r} outside {lo}-{hi}")
        if start <= value <= end and (value - start) % step == 0:
            return True
    return False


def validate_cron(expr: str) -> str:
    fields = expr.split()
    if len(fields) != 5:
        raise ValueError("cron expression needs 5 fields: minute hour day month weekday")
    probe = datetime(2026, 1, 1, tzinfo=timezone.utc)
    cron_matches(expr, probe)  # raises on a malformed field
    return " ".join(fields)


def cron_matches(expr: str, when: datetime) -> bool:
    minute, hour, day, month, weekday = expr.split()
    return (
        _field_matches(minute, when.minute, 0, 59)
        and _field_matches(hour, when.hour, 0, 23)
        and _field_matches(day, when.day, 1, 31)
        and _field_matches(month, when.month, 1, 12)
        and _field_matches(weekday, when.isoweekday() % 7, 0, 6)
    )


@dataclass(frozen=True)
class Schedule:
    name: str
    action: str
    cron: str
    paused: bool
    last_ran_at: str | None
    added_at: str


def schedules_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*SCHEDULES_RELPATH)


def _rows(base_dir: str | Path | None) -> list[dict[str, Any]]:
    path = schedules_path(base_dir)
    return load_declared_jsonl(path, expected_surface=SCHEDULES_SURFACE) if path.exists() else []


def _append(base_dir: str | Path | None, row: dict[str, Any]) -> dict[str, Any]:
    path = schedules_path(base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    return append_declared_jsonl(path, {"schema_version": 1, "recorded_at": utc_now(), **row}, expected_surface=SCHEDULES_SURFACE)


def fold_schedules(base_dir: str | Path | None = None) -> dict[str, Schedule]:
    table: dict[str, dict[str, Any]] = {}
    for row in _rows(base_dir):
        name, event = str(row.get("name") or ""), str(row.get("event") or "")
        if event == "add":
            table[name] = {"action": row.get("action"), "cron": row.get("cron"), "paused": False, "last_ran_at": None, "added_at": row.get("recorded_at")}
        elif name in table and event == "pause":
            table[name]["paused"] = True
        elif name in table and event == "resume":
            table[name]["paused"] = False
        elif name in table and event == "ran":
            table[name]["last_ran_at"] = row.get("recorded_at")
        elif event == "remove":
            table.pop(name, None)
    return {name: Schedule(name=name, action=str(v["action"]), cron=str(v["cron"]), paused=bool(v["paused"]),
                           last_ran_at=v["last_ran_at"], added_at=str(v["added_at"])) for name, v in table.items()}


def add_schedule(*, name: str, action: str, cron: str, base_dir: str | Path | None = None, operator_ref: str | None = None) -> dict[str, Any]:
    if not _NAME_RE.match(name):
        raise ValueError(f"schedule name {name!r} must match {_NAME_RE.pattern}")
    if action not in SCHEDULE_ACTIONS:
        raise ValueError(f"unknown action {action!r}; the vocabulary is closed: {SCHEDULE_ACTIONS}")
    expr = validate_cron(cron)
    row = _append(base_dir, {"event": "add", "name": name, "action": action, "cron": expr, "operator_ref": operator_ref})
    append_tools_governance(ensure_tools_dir(base_dir), "gateway_schedule_changed", {"event": "add", "name": name, "action": action, "cron": expr})
    return row


def change_schedule(event: str, *, name: str, base_dir: str | Path | None = None, operator_ref: str | None = None) -> dict[str, Any]:
    if event not in {"pause", "resume", "remove"}:
        raise ValueError(f"unknown schedule event {event!r}")
    if name not in fold_schedules(base_dir):
        raise ValueError(f"unknown schedule {name!r}")
    row = _append(base_dir, {"event": event, "name": name, "operator_ref": operator_ref})
    append_tools_governance(ensure_tools_dir(base_dir), "gateway_schedule_changed", {"event": event, "name": name})
    return row


def due_schedules(*, now: datetime, base_dir: str | Path | None = None) -> list[Schedule]:
    due: list[Schedule] = []
    minute_key = now.strftime("%Y-%m-%dT%H:%M")
    for schedule in fold_schedules(base_dir).values():
        if schedule.paused or not cron_matches(schedule.cron, now):
            continue
        if schedule.last_ran_at and str(schedule.last_ran_at)[:16] == minute_key:
            continue
        due.append(schedule)
    return due


def _default_runner(argv: list[str]) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(argv, capture_output=True, text=True, timeout=120, check=False)


def run_action(action: str, *, base_dir: str | Path | None, workspace_root: str | Path, runner: Runner | None = None,
               schedule_name: str | None = None, ref: str = "main") -> dict[str, Any]:
    """Execute one closed action. Workflow actions respect the operator pause
    and the host lease; local actions run in-process."""
    if action not in SCHEDULE_ACTIONS:
        raise ValueError(f"unknown action {action!r}")
    root = ensure_tools_dir(base_dir)
    run = runner or _default_runner
    result: dict[str, Any] = {"action": action, "status": "ran", "detail": {}}
    if action in ACTION_WORKFLOWS:
        from ..control import effective_control

        if effective_control(root).paused_all:
            result.update({"status": "skipped", "detail": {"reason": "operator_paused"}})
        else:
            workflow, inputs = ACTION_WORKFLOWS[action]
            argv = ["gh", "workflow", "run", workflow, "--ref", ref]
            for key, value in inputs.items():
                argv += ["-f", f"{key}={value}"]
            done = run(argv)
            result["detail"] = {"workflow": workflow, "returncode": done.returncode, "stderr": (done.stderr or "")[:200]}
            if done.returncode != 0:
                result["status"] = "failed"
    elif action == "doctor":
        from ..doctor import run_doctor

        report = run_doctor(base_dir=root, workspace_root=workspace_root)
        result["detail"] = {"healthy": report.healthy, "summary": report.to_dict()["summary"]}
        if not report.healthy:
            from ..notify import notify_best_effort

            failing = [c.name for c in report.checks if c.status == "fail"]
            notify_best_effort(kind="doctor_unhealthy", key=",".join(failing), base_dir=root,
                               title="ARIA doctor unhealthy: " + ", ".join(failing), body=json.dumps(report.to_dict()["summary"]))
    elif action == "telemetry_export":
        from ..telemetry import export_telemetry
        from ..workspace import workspace_paths

        text = export_telemetry(workspace_paths(Path(workspace_root).resolve()), format="prometheus", tools_root=root)
        out = root / "gateway" / "telemetry.prom"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        result["detail"] = {"path": str(out), "bytes": len(text)}
    elif action == "deliver":
        from ..delivery_closure import compute_delivery_closure
        from ..notify import notify_best_effort

        summary = compute_delivery_closure(base_dir=root).summary
        rows = notify_best_effort(kind="daily_report", key=utc_now()[:10], base_dir=root, title="ARIA daily delivery summary",
                                  body=json.dumps(summary, sort_keys=True))
        result["detail"] = {"channels": [r["channel"] + ":" + r["status"] for r in rows]}
    elif action == "inbox_drain":
        from .router import drain_inbox

        routed = drain_inbox(base_dir=root, workspace_root=workspace_root)
        result["detail"] = {"routed": len(routed), "errors": sum(1 for r in routed if r.get("error"))}
    if schedule_name:
        _append(root, {"event": "ran", "name": schedule_name, "action": action, "status": result["status"], "detail": result["detail"]})
    append_tools_governance(root, "gateway_action_ran", {"action": action, "schedule": schedule_name, "status": result["status"]})
    return result


def tick(*, base_dir: str | Path | None, workspace_root: str | Path, now: datetime | None = None, runner: Runner | None = None,
         drain_inbox_first: bool = True) -> dict[str, Any]:
    """One scheduler beat: route what arrived, run what is due, write the heartbeat."""
    from .server import HEARTBEAT_RELPATH

    root = ensure_tools_dir(base_dir)
    stamp = now or datetime.now(timezone.utc)
    routed: list[dict[str, Any]] = []
    if drain_inbox_first:
        from .router import drain_inbox

        routed = drain_inbox(base_dir=root, workspace_root=workspace_root)
    ran = [run_action(s.action, base_dir=root, workspace_root=workspace_root, runner=runner, schedule_name=s.name)
           for s in due_schedules(now=stamp, base_dir=root)]
    beat = {"schema_version": 1, "recorded_at": utc_now(), "tick_at": stamp.isoformat(), "routed": len(routed),
            "ran": [r["action"] + ":" + r["status"] for r in ran]}
    path = root.joinpath(*HEARTBEAT_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(beat, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)
    return {"routed": routed, "ran": ran, "heartbeat": beat}


__all__ = ["ACTION_WORKFLOWS", "SCHEDULES_RELPATH", "SCHEDULES_SURFACE", "SCHEDULE_ACTIONS", "SCHEDULE_EVENTS", "Schedule",
           "add_schedule", "change_schedule", "cron_matches", "due_schedules", "fold_schedules", "run_action", "schedules_path",
           "tick", "validate_cron"]
