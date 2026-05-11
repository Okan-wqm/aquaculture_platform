from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .governance_reader import read_governance_rows
from .ledger import append_jsonl, load_jsonl_verified
from .snapshot import file_counts_from_payload
from .tool_health import runs_path
from .tool_registry import ensure_tools_dir, utc_now


def run_reflection(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    # Plan 026R §A.2 — hot-path consumers move from `load_jsonl` (silent
    # accept of tampered / hashless rows) to `load_jsonl_verified` which
    # raises `LedgerIntegrityError` on chain mismatch, missing
    # `ledger_hash`, or canonical drift. All four ledgers below are
    # written via `append_jsonl` so every row is hash-chained at write
    # time; a strict read here is the read-side gate that catches mid-
    # flight tamper or partial-write visible to a reader.
    all_runs = load_jsonl_verified(runs_path(base_dir))
    runs = [row for row in all_runs if row.get("cycle_id") == cycle_id]
    tool_runtime = _tool_runtime_table(runs, all_runs, cycle_id)
    pressure_payload = _load_pressure(root, cycle_id)
    pressures = pressure_payload.get("summary", {})
    auto_merge_decisions = [
        row
        for row in load_jsonl_verified(root / "auto-merge-decisions.jsonl")
        if row.get("cycle_id") == cycle_id
    ]
    beliefs = _latest_by_id(
        load_jsonl_verified(root / "memory" / "beliefs.jsonl"), "belief_id"
    )
    top_pressures = pressure_payload.get("pressures", [])[:3] if isinstance(pressure_payload.get("pressures"), list) else []
    committed = _committed_findings_and_debts(root, repo_root_override=repo_root)
    human_required = _human_required_summary(root)
    gate_activity = _gate_activity_summary(root)
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
        "committed_findings": committed["findings"],
        "committed_debts": committed["debts"],
        "human_required": human_required,
        "gate_activity": gate_activity,
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
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else {}


def _resolve_repo_root(tools_root: Path) -> Path | None:
    """Read the bound repo_root from the tools-dir identity file.

    Reflection is invoked with `base_dir` = tools-root only, but committed
    findings/debts live under the repo root (`aria-findings/`, `aria-debts/`).
    Use the bound identity to locate them; return None if the binding is
    unset (no committed surfaces to report).
    """
    identity_path = tools_root / "repo_identity.json"
    if not identity_path.exists():
        return None
    try:
        identity = json.loads(identity_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    bound = identity.get("bound_repo_root")
    if not bound:
        return None
    candidate = Path(bound)
    return candidate if candidate.exists() else None


def _gate_activity_summary(tools_root: Path, *, window_hours: int = 24) -> dict[str, Any]:
    """Plan 017 Phase 6.2 — aggregate governance event counts by kind.

    Walks aria-tools/governance.jsonl, partitions events by `kind`, and
    returns top-N counts plus a 24h-window subset (events recorded within
    the last `window_hours`). The daily report renders this so the
    operator can see at a glance which gates fired in the cycle window.
    """
    governance = tools_root / "governance.jsonl"
    if not governance.exists():
        return {"total_events": 0, "by_kind": {}, "recent_24h": {}}
    cutoff = datetime.now(timezone.utc) - timedelta(hours=window_hours)
    by_kind: dict[str, int] = {}
    recent: dict[str, int] = {}
    # Plan 026R §A.3 — strict governance.jsonl reader for gate-activity
    # summary. Pre-§A.3 silent-skip on corrupt rows would understate
    # gate activity (operator dashboard misled). Strict raises via the
    # governance_reader contract.
    total = 0
    for row in read_governance_rows(governance, base_dir=tools_root):
        kind = str(row.get("kind") or "?")
        by_kind[kind] = by_kind.get(kind, 0) + 1
        total += 1
        ts_str = row.get("ts")
        if isinstance(ts_str, str):
            try:
                ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            except ValueError:
                ts = None
            if ts is not None and ts >= cutoff:
                recent[kind] = recent.get(kind, 0) + 1
    return {
        "total_events": total,
        "by_kind": dict(sorted(by_kind.items(), key=lambda kv: kv[1], reverse=True)),
        "recent_24h": dict(sorted(recent.items(), key=lambda kv: kv[1], reverse=True)),
        "window_hours": window_hours,
    }


def _human_required_summary(tools_root: Path) -> dict[str, Any]:
    """Plan 016 Faz D9 — surface the HUMAN_REQUIRED ledger at the top of daily reports.

    Returns: {open: <int>, breaching_sla: <int>, items: [<sorted by deadline>...]}.
    """
    from .human_required import list_human_required

    items = list_human_required(base_dir=tools_root, include_resolved=False)
    if not items:
        return {"open": 0, "breaching_sla": 0, "items": []}
    now = datetime.now(timezone.utc)
    breaching = 0
    for item in items:
        deadline = item.get("sla_deadline")
        if not isinstance(deadline, str):
            continue
        try:
            dt = datetime.fromisoformat(deadline.replace("Z", "+00:00"))
        except ValueError:
            continue
        if dt < now:
            breaching += 1
    return {"open": len(items), "breaching_sla": breaching, "items": items[:5]}


def _committed_findings_and_debts(
    tools_root: Path,
    *,
    repo_root_override: str | Path | None = None,
) -> dict[str, dict[str, Any]]:
    """Load the operator-facing finding + debt indexes for the daily report.

    Counts are derived from `aria-findings/_index.json` + `aria-debts/_index.json`.
    Overdue debt detection uses the recorded `due_date` against current time.

    `repo_root_override` lets a worktree-aware caller (e.g. cycle.py running on
    snowball when tools-dir was first bound by main) point at the active
    worktree directly. Without it, fall back to the recorded binding.
    """
    empty_findings = {"total": 0, "open": 0, "recent": []}
    empty_debts = {"total": 0, "open": 0, "overdue": 0, "recent": []}
    if repo_root_override is not None:
        candidate = Path(repo_root_override)
        repo_root = candidate if candidate.exists() else None
    else:
        repo_root = _resolve_repo_root(tools_root)
    if repo_root is None:
        return {"findings": empty_findings, "debts": empty_debts}

    findings_index = repo_root / "aria-findings" / "_index.json"
    debts_index = repo_root / "aria-debts" / "_index.json"

    findings_summary = dict(empty_findings)
    if findings_index.exists():
        try:
            payload = json.loads(findings_index.read_text(encoding="utf-8"))
            rows = payload.get("findings", []) if isinstance(payload, dict) else []
            findings_summary["total"] = len(rows)
            findings_summary["open"] = sum(1 for r in rows if r.get("status") == "OPEN")
            findings_summary["recent"] = sorted(
                rows, key=lambda r: r.get("created_at", ""), reverse=True
            )[:5]
        except (OSError, json.JSONDecodeError):
            pass

    debts_summary = dict(empty_debts)
    if debts_index.exists():
        try:
            payload = json.loads(debts_index.read_text(encoding="utf-8"))
            rows = payload.get("debts", []) if isinstance(payload, dict) else []
            now = datetime.now(timezone.utc)
            debts_summary["total"] = len(rows)
            open_rows = [r for r in rows if r.get("current_status") in {"OPEN", "IN_PROGRESS"}]
            debts_summary["open"] = len(open_rows)
            overdue = 0
            for row in open_rows:
                due_iso = row.get("due_date")
                if not due_iso:
                    continue
                try:
                    due = datetime.fromisoformat(str(due_iso).replace("Z", "+00:00"))
                except ValueError:
                    continue
                if due.tzinfo is None:
                    due = due.replace(tzinfo=timezone.utc)
                if due < now:
                    overdue += 1
            debts_summary["overdue"] = overdue
            debts_summary["recent"] = sorted(
                rows, key=lambda r: r.get("due_date", ""), reverse=False
            )[:5]
        except (OSError, json.JSONDecodeError):
            pass

    return {"findings": findings_summary, "debts": debts_summary}


def _write_daily_report(root: Path, reflection: dict[str, Any]) -> None:
    day = str(reflection["recorded_at"])[:10]
    path = root / "reports" / "daily" / f"{day}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    file_counts = file_counts_from_payload(reflection.get("coverage", {}))
    hr = reflection.get("human_required") or {"open": 0, "breaching_sla": 0, "items": []}
    hr_open = hr.get("open", 0)
    hr_breach = hr.get("breaching_sla", 0)
    ga = reflection.get("gate_activity") or {"total_events": 0, "by_kind": {}, "recent_24h": {}, "window_hours": 24}
    ga_recent = ga.get("recent_24h") or {}
    top_recent = list(ga_recent.items())[:8]
    lines = [
        f"# ARIA Daily Report {day}",
        "",
        "## Gate Activity",
        "",
        f"- Total governance events: {ga.get('total_events', 0)}",
        f"- Events in last {ga.get('window_hours', 24)}h: {sum(ga_recent.values())}",
        *(
            [f"  - {kind}: {count}" for kind, count in top_recent]
            or ["  - (no governance events in window)"]
        ),
        "",
        "## HUMAN_REQUIRED",
        "",
        f"- Open: {hr_open}",
        f"- Breaching SLA: {hr_breach}",
        *(
            [
                f"- {item.get('request_id')} [{item.get('severity')}] sla {item.get('sla_deadline')} — {item.get('reason', '')[:80]}"
                for item in hr.get("items") or []
            ]
            or ["- (no operator-triage queue items)"]
        ),
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
        "## Committed Findings",
        "",
        f"- Total: {reflection.get('committed_findings', {}).get('total', 0)}",
        f"- Open: {reflection.get('committed_findings', {}).get('open', 0)}",
        *(
            [f"- Recent: {row.get('finding_id')} [{row.get('severity')}] ({row.get('claim_type')}) — {row.get('claim_summary', '')[:80]}"
             for row in reflection.get('committed_findings', {}).get('recent', [])]
            or ["- (no committed findings yet)"]
        ),
        "",
        "## Open Debts",
        "",
        f"- Total: {reflection.get('committed_debts', {}).get('total', 0)}",
        f"- Open: {reflection.get('committed_debts', {}).get('open', 0)}",
        f"- Overdue: {reflection.get('committed_debts', {}).get('overdue', 0)}",
        *(
            [f"- {row.get('debt_id')} [{row.get('severity')}] due {row.get('due_date', '')} — owner {row.get('permanent_fix_owner')} (originating {row.get('originating_finding_id')})"
             for row in reflection.get('committed_debts', {}).get('recent', [])]
            or ["- (no committed debts yet)"]
        ),
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
