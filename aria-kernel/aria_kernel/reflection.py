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
    pressure_payload = _load_pressure(root, cycle_id)
    pressures = pressure_payload.get("summary", {})
    auto_merge_decisions = [row for row in load_jsonl(root / "auto-merge-decisions.jsonl") if row.get("cycle_id") == cycle_id]
    beliefs = _latest_by_id(load_jsonl(root / "memory" / "beliefs.jsonl"), "belief_id")
    top_pressures = pressure_payload.get("pressures", [])[:3] if isinstance(pressure_payload.get("pressures"), list) else []
    reflection = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "coverage": _coverage(root, cycle_id),
        "tool_run_count": len(runs),
        "ok_run_count": sum(1 for run in runs if run.get("status") == "ok"),
        "failed_run_count": sum(1 for run in runs if run.get("status") != "ok"),
        "operator_facing_findings": sum(len(run.get("emitted_findings", [])) for run in runs),
        "operator_facing_observations": sum(len(run.get("emitted_observations", [])) for run in runs),
        "suppressed_shadow_findings": sum(run.get("runner", {}).get("raw_findings_count", 0) for run in runs)
        - sum(len(run.get("emitted_findings", [])) for run in runs),
        "belief_summary": _belief_summary(beliefs),
        "pressure_summary": pressures,
        "top_pressures": top_pressures,
        "tool_health": _tool_health(runs),
        "auto_merge_summary": _auto_merge_summary(auto_merge_decisions),
        "next_cycle_plan": [
            {
                "pressure_id": item.get("pressure_id"),
                "recommended_action": item.get("recommended_action"),
                "candidate_tools": item.get("candidate_tools", []),
            }
            for item in top_pressures
        ],
    }
    append_jsonl(root / "reflections.jsonl", reflection)
    _write_daily_report(root, reflection)
    return reflection


def _load_pressure(root: Path, cycle_id: str) -> dict[str, Any]:
    path = root / "pressure" / f"{cycle_id}.json"
    if not path.exists():
        return {}
    import json

    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}


def _write_daily_report(root: Path, reflection: dict[str, Any]) -> None:
    day = str(reflection["recorded_at"])[:10]
    path = root / "reports" / "daily" / f"{day}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"# ARIA Daily Report {day}",
        "",
        "## Coverage",
        "",
        f"- Tracked files: {reflection['coverage'].get('tracked_file_count', 0)}",
        f"- Discovery complete: {reflection['coverage'].get('complete', False)}",
        "",
        "## Beliefs",
        "",
        f"- Total: {reflection['belief_summary'].get('total', 0)}",
        f"- Supported: {reflection['belief_summary'].get('supported', 0)}",
        "",
        "## Stale / Revalidation",
        "",
        f"- Needs revalidation: {reflection['belief_summary'].get('needs_revalidation', 0)}",
        f"- Stale: {reflection['belief_summary'].get('stale', 0)}",
        "",
        "## Top Pressures",
        "",
        *[
            f"- {item.get('pressure_id')}: {item.get('score')} - {item.get('reason')}"
            for item in reflection.get("top_pressures", [])
        ],
        "",
        "## Tool Health",
        "",
        f"- Cycle: `{reflection['cycle_id']}`",
        f"- Tool runs: {reflection['tool_run_count']}",
        f"- OK runs: {reflection['ok_run_count']}",
        f"- Failed runs: {reflection['failed_run_count']}",
        f"- Operator-facing findings: {reflection['operator_facing_findings']}",
        f"- Operator-facing observations: {reflection['operator_facing_observations']}",
        f"- Suppressed SHADOW findings: {reflection['suppressed_shadow_findings']}",
        f"- Pressure: {reflection['pressure_summary']}",
        "",
        "## Auto-Merge",
        "",
        f"- Eligible: {reflection['auto_merge_summary'].get('eligible', 0)}",
        f"- Blocked: {reflection['auto_merge_summary'].get('blocked', 0)}",
        f"- Merged: {reflection['auto_merge_summary'].get('merged', 0)}",
        f"- Failed: {reflection['auto_merge_summary'].get('failed', 0)}",
        "",
        "## Next Cycle Plan",
        "",
        *[
            f"- {item.get('pressure_id')}: {item.get('recommended_action')}"
            for item in reflection.get("next_cycle_plan", [])
        ],
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def _coverage(root: Path, cycle_id: str) -> dict[str, Any]:
    path = root / "discovery" / cycle_id / "COMPLETION_PROOF.json"
    if not path.exists():
        return {}
    import json

    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}


def _belief_summary(beliefs: list[dict[str, Any]]) -> dict[str, int]:
    statuses = ["supported", "contradicted", "needs_revalidation", "stale", "withdrawn"]
    summary = {"total": len(beliefs)}
    for status in statuses:
        summary[status] = sum(1 for belief in beliefs if belief.get("status") == status)
    return summary


def _tool_health(runs: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "tools": sorted({str(run.get("tool_id")) for run in runs if run.get("tool_id")}),
        "quarantine_signals": sum(1 for run in runs if run.get("status") in ("evidence_error", "scope_violation")),
    }


def _auto_merge_summary(decisions: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "eligible": sum(1 for row in decisions if row.get("decision") == "eligible"),
        "blocked": sum(1 for row in decisions if row.get("decision") == "blocked"),
        "merged": sum(1 for row in decisions if row.get("decision") == "merged"),
        "failed": sum(1 for row in decisions if row.get("decision") == "failed"),
    }


def _latest_by_id(rows: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        value = row.get(key)
        if isinstance(value, str) and value:
            latest[value] = row
    return list(latest.values())
