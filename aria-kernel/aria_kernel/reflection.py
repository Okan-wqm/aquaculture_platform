from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .snapshot import file_counts_from_payload
from .tool_health import runs_path
from .tool_registry import ensure_tools_dir, utc_now


def run_reflection(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    runs = [row for row in load_jsonl(runs_path(base_dir)) if row.get("cycle_id") == cycle_id]
    all_runs = load_jsonl(runs_path(base_dir))
    tool_runtime = _tool_runtime_table(runs, all_runs, cycle_id)
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
        "invalid_evidence_count": _invalid_evidence_count(runs),
        "snapshot_outside_path_count": _snapshot_outside_path_count(runs),
        "tool_runtime": tool_runtime,
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
    file_counts = file_counts_from_payload(reflection.get("coverage", {}))
    lines = [
        f"# ARIA Daily Report {day}",
        "",
        "## Coverage",
        "",
        f"- Git tracked: {file_counts.get('git_tracked', 0)}",
        f"- Working-tree: {file_counts.get('working_tree', 0)}",
        f"- Allowed: {file_counts.get('allowed', 0)}",
        f"- Generated: {file_counts.get('generated', 0)}",
        f"- Fated: {file_counts.get('fated', 0)}",
        f"- Discovery complete: {reflection['coverage'].get('complete', False)}",
        f"- Snapshot mode: {reflection['coverage'].get('snapshot_mode', 'unknown')}",
        f"- Dirty snapshot: {reflection['coverage'].get('dirty_snapshot', False)}",
        f"- Dirty path count: {reflection['coverage'].get('dirty_path_count', 0)}",
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
        f"- Invalid evidence count: {reflection['invalid_evidence_count']}",
        f"- Snapshot outside path count: {reflection['snapshot_outside_path_count']}",
        f"- Pressure: {reflection['pressure_summary']}",
        "",
        "### Raw Adapter Runtime",
        "",
        "| Tool | Raw findings | Raw observations | Emitted findings | Emitted observations | Suppressed SHADOW findings | Invalid evidence | Delta vs previous cycle |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        *[
            "| {tool_id} | {raw_findings} | {raw_observations} | {emitted_findings} | {emitted_observations} | {suppressed_shadow_findings} | {invalid_evidence_count} | {raw_finding_delta_vs_prev_cycle} |".format(**row)
            for row in reflection.get("tool_runtime", [])
        ],
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


def _tool_runtime_table(
    runs: list[dict[str, Any]],
    all_runs: list[dict[str, Any]],
    cycle_id: str,
) -> list[dict[str, Any]]:
    rows = []
    for run in sorted(runs, key=lambda item: str(item.get("tool_id"))):
        tool_id = str(run.get("tool_id") or "")
        raw_findings = int(run.get("runner", {}).get("raw_findings_count") or 0)
        raw_observations = int(run.get("runner", {}).get("raw_observations_count") or 0)
        emitted_findings = len(run.get("emitted_findings", [])) if isinstance(run.get("emitted_findings"), list) else 0
        emitted_observations = len(run.get("emitted_observations", [])) if isinstance(run.get("emitted_observations"), list) else 0
        previous = _previous_tool_run(all_runs, tool_id, cycle_id)
        previous_raw = int(previous.get("runner", {}).get("raw_findings_count") or 0) if previous else 0
        rows.append(
            {
                "tool_id": tool_id,
                "raw_findings": raw_findings,
                "raw_observations": raw_observations,
                "emitted_findings": emitted_findings,
                "emitted_observations": emitted_observations,
                "suppressed_shadow_findings": max(0, raw_findings - emitted_findings),
                "invalid_evidence_count": _invalid_evidence_count([run]),
                "snapshot_outside_path_count": _snapshot_outside_path_count([run]),
                "raw_finding_delta_vs_prev_cycle": raw_findings - previous_raw,
                "previous_cycle_id": previous.get("cycle_id") if previous else None,
            },
        )
    return rows


def _invalid_evidence_count(runs: list[dict[str, Any]]) -> int:
    return sum(1 for run in runs for error in _validation_errors(run) if str(error.get("code", "")).endswith("_outside_snapshot") or str(error.get("code")) in {"read_path_outside_snapshot", "evidence_outside_snapshot"})


def _snapshot_outside_path_count(runs: list[dict[str, Any]]) -> int:
    paths = set()
    for run in runs:
        for error in _validation_errors(run):
            if str(error.get("code", "")).endswith("_outside_snapshot") or str(error.get("code")) in {"read_path_outside_snapshot", "evidence_outside_snapshot"}:
                path = error.get("path")
                if isinstance(path, str) and path:
                    paths.add(path)
    return len(paths)


def _validation_errors(run: dict[str, Any]) -> list[dict[str, Any]]:
    errors = run.get("evidence_validation", {}).get("errors", [])
    return [error for error in errors if isinstance(error, dict)] if isinstance(errors, list) else []


def _previous_tool_run(all_runs: list[dict[str, Any]], tool_id: str, cycle_id: str) -> dict[str, Any] | None:
    previous = [
        run
        for run in all_runs
        if run.get("tool_id") == tool_id and run.get("cycle_id") != cycle_id and str(run.get("cycle_id")) < cycle_id
    ]
    return previous[-1] if previous else None


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
