from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_health import runs_path
from .tool_registry import ensure_tools_dir, utc_now


def run_reflection(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    runs = [row for row in load_jsonl(runs_path(base_dir)) if row.get("cycle_id") == cycle_id]
    pressures = _load_pressure_summary(root, cycle_id)
    reflection = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "tool_run_count": len(runs),
        "ok_run_count": sum(1 for run in runs if run.get("status") == "ok"),
        "failed_run_count": sum(1 for run in runs if run.get("status") != "ok"),
        "operator_facing_findings": sum(len(run.get("emitted_findings", [])) for run in runs),
        "operator_facing_observations": sum(len(run.get("emitted_observations", [])) for run in runs),
        "pressure_summary": pressures,
    }
    append_jsonl(root / "reflections.jsonl", reflection)
    _write_daily_report(root, reflection)
    return reflection


def _load_pressure_summary(root: Path, cycle_id: str) -> dict[str, Any]:
    path = root / "pressure" / f"{cycle_id}.json"
    if not path.exists():
        return {}
    import json

    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload.get("summary", {}) if isinstance(payload, dict) else {}


def _write_daily_report(root: Path, reflection: dict[str, Any]) -> None:
    day = str(reflection["recorded_at"])[:10]
    path = root / "reports" / "daily" / f"{day}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"# ARIA Daily Report {day}",
        "",
        f"- Cycle: `{reflection['cycle_id']}`",
        f"- Tool runs: {reflection['tool_run_count']}",
        f"- OK runs: {reflection['ok_run_count']}",
        f"- Failed runs: {reflection['failed_run_count']}",
        f"- Operator-facing findings: {reflection['operator_facing_findings']}",
        f"- Operator-facing observations: {reflection['operator_facing_observations']}",
        f"- Pressure: {reflection['pressure_summary']}",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")
