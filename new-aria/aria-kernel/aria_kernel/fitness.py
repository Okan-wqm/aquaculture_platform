from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .batch_containment import guard_item, with_item_failures
from .impact_graph import list_impact_graphs
from .ledger import append_declared_jsonl, load_declared_jsonl
from .runs_reader import read_runs_rows
from .performance import list_performance_baselines
from .research import list_research_sources
from .tool_health import runs_path
from .tool_registry import ensure_tools_dir, utc_now
from .validation import list_validation_plans


DIMENSIONS = (
    "security_boundary",
    "tenant_isolation",
    "schema_drift",
    "event_contracts",
    "test_coverage",
    "performance_baseline",
    "dependency_currency",
    "operational_safety",
)


def generate_fitness_report(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    runs = list(read_runs_rows(runs_path(root), base_dir=root))
    validation_plans = list_validation_plans(base_dir=base_dir)
    impact_graphs = list_impact_graphs(base_dir=base_dir)
    research_sources = list_research_sources(base_dir=base_dir)
    perf_baselines = list_performance_baselines(base_dir=base_dir)
    dimensions = {
        "security_boundary": _adapter_score(runs, "security-boundary-adapter"),
        "tenant_isolation": _adapter_score(runs, "tenant-scoping-adapter"),
        "schema_drift": _clean_adapter_score(runs, "typeorm-entity-schema-adapter"),
        "event_contracts": _clean_adapter_score(runs, "event-contracts-adapter"),
        "test_coverage": _adapter_score(runs, "test-gap-adapter"),
        "performance_baseline": _presence_score(perf_baselines),
        "dependency_currency": _presence_score([row for row in research_sources if row.get("source_tier") in ("security_advisory", "vendor", "official")]),
        "operational_safety": _operational_score(validation_plans, impact_graphs),
    }
    evidence_score = round(sum(dimensions.values()) / len(DIMENSIONS), 3)
    trust_score = _trust_score(runs)
    finding_debt = _finding_debt(runs)
    overall = round(max(0.0, (evidence_score * 0.55) + (trust_score * 0.35) - (finding_debt * 0.10)), 3)
    previous_reports = list_fitness_reports(base_dir=base_dir)
    trend = _trend(previous_reports, dimensions, overall)
    blockers = _blockers(dimensions)
    report = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "overall_score": overall,
        "evidence_score": evidence_score,
        "trust_score": trust_score,
        "finding_debt": finding_debt,
        "score_explanation": "overall_score = evidence_score*0.55 + trust_score*0.35 - finding_debt*0.10",
        "dimensions": dimensions,
        "trend": trend,
        "blocked_by": blockers,
        "recommended_next_action": _recommended_next_action(dimensions, blockers),
        "recommendation_ready": False,
        "evidence": {
            "adapter_runs": len(runs),
            "validation_plans": len(validation_plans),
            "impact_graphs": len(impact_graphs),
            "research_sources": len(research_sources),
            "performance_baselines": len(perf_baselines),
        },
    }
    return append_declared_jsonl(
        root / "fitness" / "fitness-reports.jsonl",
        report,
        expected_surface="fitness_reports",
    )


def generate_recommendation_candidate(
    *,
    cycle_id: str,
    title: str,
    evidence_refs: list[str],
    validation_refs: list[str],
    research_refs: list[str],
    impact_graph_refs: list[str],
    repo_value: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    complete = all(
        [
            title.strip(),
            evidence_refs,
            validation_refs,
            research_refs,
            impact_graph_refs,
            repo_value.strip(),
        ],
    )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "title": title,
        "evidence_refs": evidence_refs,
        "validation_refs": validation_refs,
        "research_refs": research_refs,
        "impact_graph_refs": impact_graph_refs,
        "repo_value": repo_value,
        "status": "ready_for_operator" if complete else "blocked",
        "blocked_by": [] if complete else ["recommendation_evidence_incomplete"],
    }
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "fitness" / "recommendation-candidates.jsonl",
        row,
        expected_surface="fitness_recommendation_candidates",
    )


def list_fitness_reports(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        ensure_tools_dir(base_dir) / "fitness" / "fitness-reports.jsonl",
        expected_surface="fitness_reports",
    )


def agent_fitness_score(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
    force: bool = False,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    now = _agent_fitness_now()
    previous = load_declared_jsonl(
        root / "fitness" / "agent-fitness.jsonl",
        expected_surface="fitness_agent",
    )
    last_at = _last_computed_at(previous)
    if not force and last_at is not None and now - last_at < timedelta(days=6):
        return {"schema_version": 1, "cycle_id": cycle_id, "status": "skipped", "reason": "weekly_gate", "last_computed_at": _format_dt(last_at)}
    rows = _compute_agent_fitness(root, cycle_id=cycle_id, computed_at=now)
    item_failures: list[dict[str, Any]] = []
    written: list[dict[str, Any]] = []
    for row in rows:
        # A weekly-gated hook: losing the batch to one bad row means no fitness
        # data for six days, while the rows written before it stay on disk and
        # `agent_fitness_computed` never reports them.
        ok, _stored = guard_item(
            item_failures,
            item_kind="agent_fitness_row",
            item_id=str(row.get("agent") or row.get("agent_path") or ""),
            work=lambda row=row: append_declared_jsonl(
                root / "fitness" / "agent-fitness.jsonl",
                row,
                expected_surface="fitness_agent",
            ),
        )
        if ok:
            written.append(row)
    from .tool_registry import append_tools_governance, update_tools_index

    update_tools_index(root)
    append_tools_governance(root, "agent_fitness_computed", {"cycle_id": cycle_id, "agent_count": len(written), "computed_at": _format_dt(now)})
    return with_item_failures(
        {"schema_version": 1, "cycle_id": cycle_id, "status": "computed", "computed_at": _format_dt(now), "agent_count": len(written), "agents": written},
        item_failures,
    )


def latest_agent_fitness(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    root = ensure_tools_dir(base_dir)
    latest: dict[str, dict[str, Any]] = {}
    for row in load_declared_jsonl(
        root / "fitness" / "agent-fitness.jsonl",
        expected_surface="fitness_agent",
    ):
        name = row.get("agent_name")
        if isinstance(name, str) and name:
            latest[name] = row
    return list(latest.values())


def _compute_agent_fitness(root: Path, *, cycle_id: str, computed_at: datetime) -> list[dict[str, Any]]:
    requests = load_declared_jsonl(root / "dispatch" / "requests.jsonl", expected_surface="dispatch_requests")
    verifications = load_declared_jsonl(root / "dispatch" / "verification-results.jsonl", expected_surface="dispatch_verification_results")
    by_assignment = {str(row.get("assignment_id")): row for row in verifications if row.get("assignment_id")}
    agents = sorted({str(row.get("target_agent")) for row in requests if isinstance(row.get("target_agent"), str) and row.get("target_agent")})
    rows: list[dict[str, Any]] = []
    for agent in agents:
        agent_requests = [row for row in requests if row.get("target_agent") == agent]
        outcomes = [by_assignment.get(str(row.get("assignment_id"))) for row in agent_requests]
        outcomes = [row for row in outcomes if row]
        passed = sum(1 for row in outcomes if row.get("status") == "passed")
        failed = sum(1 for row in outcomes if row.get("status") == "failed")
        if not outcomes:
            score = 0.4
            tier = "CALIBRATE"
            max_triage_tier = "needs_review"
        else:
            score = round(passed / max(1, passed + failed), 3)
            tier = "ACTIVE" if score >= 0.5 else ("DOWNGRADED" if score >= 0.3 else "QUARANTINED")
            max_triage_tier = "auto_fix_safe" if tier == "ACTIVE" else ("needs_review" if tier in {"CALIBRATE", "DOWNGRADED"} else "blocked")
        rows.append(
            {
                "$schema": "aria/agent-fitness/v1",
                "schema_version": 1,
                "cycle_id": cycle_id,
                # Plan 022 §H-3 — dual-write recorded_at (canonical, the
                # field every consumer reads via _load_fitness_row) AND
                # computed_at (legacy alias preserved for 2-release
                # deprecation window). Pre-fix consumers that read
                # recorded_at saw missing field and treated fresh rows
                # as stale; consumers that read computed_at saw correct
                # data. Dual-write makes both paths idempotent.
                "recorded_at": _format_dt(computed_at),
                "computed_at": _format_dt(computed_at),
                "agent_name": agent,
                "score": score,
                "tier": tier,
                "max_triage_tier": max_triage_tier,
                "evidence": {"dispatch_count": len(agent_requests), "verification_passed": passed, "verification_failed": failed},
            },
        )
    return rows


def _agent_fitness_now() -> datetime:
    override = os.environ.get("ARIA_FITNESS_CLOCK_OVERRIDE")
    if override:
        parsed = datetime.fromisoformat(override.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    return datetime.now(timezone.utc)


def _last_computed_at(rows: list[dict[str, Any]]) -> datetime | None:
    values = []
    for row in rows:
        # Plan 022 §H-3 — alias-aware read. Prefer canonical
        # `recorded_at` (Plan 022+) and fall back to legacy `computed_at`
        # for historical fitness rows that pre-date the dual-write.
        value = row.get("recorded_at") or row.get("computed_at")
        if not isinstance(value, str) or not value:
            continue
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        values.append(parsed.astimezone(timezone.utc))
    return max(values) if values else None


def _load_fitness_row_timestamp(row: dict[str, Any]) -> str | None:
    """Plan 022 §H-3 helper — canonical recorded_at first, legacy
    computed_at fallback. Returned to callers as a string so the
    historical caller pattern (datetime.fromisoformat(...)) still
    works."""
    if not isinstance(row, dict):
        return None
    value = row.get("recorded_at") or row.get("computed_at")
    if isinstance(value, str) and value.strip():
        return value
    return None


def _format_dt(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _trend(previous_reports: list[dict[str, Any]], dimensions: dict[str, float], overall: float) -> dict[str, Any]:
    if not previous_reports:
        return {"overall_delta": 0.0, "dimension_deltas": {}, "window": 0}
    previous = previous_reports[-1]
    previous_dimensions = previous.get("dimensions", {}) if isinstance(previous.get("dimensions"), dict) else {}
    return {
        "overall_delta": round(overall - float(previous.get("overall_score") or 0), 3),
        "dimension_deltas": {
            dimension: round(score - float(previous_dimensions.get(dimension, 0)), 3)
            for dimension, score in dimensions.items()
        },
        "window": min(90, len(previous_reports)),
    }


def _blockers(dimensions: dict[str, float]) -> list[str]:
    return [f"low_fitness:{dimension}" for dimension, score in sorted(dimensions.items()) if score <= 0.25]


def _recommended_next_action(dimensions: dict[str, float], blockers: list[str]) -> dict[str, Any]:
    if not blockers:
        return {"action": "maintain", "dimension": None, "reason": "all fitness dimensions have evidence"}
    lowest_dimension = sorted(dimensions.items(), key=lambda item: (item[1], item[0]))[0][0]
    action_by_dimension = {
        "dependency_currency": "run_research_policy_and_currency_adapter",
        "performance_baseline": "record_performance_baseline",
        "operational_safety": "run_validation_and_impact_graph",
    }
    return {
        "action": action_by_dimension.get(lowest_dimension, "triage_adapter_or_capability_gap"),
        "dimension": lowest_dimension,
        "reason": f"{lowest_dimension} has the lowest evidence score",
    }


def _adapter_score(runs: list[dict[str, Any]], tool_id: str) -> float:
    latest = _latest_run(runs, tool_id)
    if latest is None or latest.get("status") != "ok":
        return 0.0
    raw_findings = int(latest.get("runner", {}).get("raw_findings_count") or 0)
    return max(0.0, round(1.0 - min(raw_findings, 100) / 100, 3))


def _clean_adapter_score(runs: list[dict[str, Any]], tool_id: str) -> float:
    latest = _latest_run(runs, tool_id)
    if latest is None or latest.get("status") != "ok":
        return 0.0
    return 1.0 if int(latest.get("runner", {}).get("raw_findings_count") or 0) == 0 else 0.5


def _presence_score(rows: list[dict[str, Any]]) -> float:
    return 1.0 if rows else 0.0


def _operational_score(validation_plans: list[dict[str, Any]], impact_graphs: list[dict[str, Any]]) -> float:
    score = 0.0
    if validation_plans:
        score += 0.5
    if impact_graphs:
        score += 0.5
    return score


def _latest_run(runs: list[dict[str, Any]], tool_id: str) -> dict[str, Any] | None:
    for run in reversed(runs):
        if run.get("tool_id") == tool_id:
            return run
    return None


def _trust_score(runs: list[dict[str, Any]]) -> float:
    latest_by_tool: dict[str, dict[str, Any]] = {}
    for run in runs:
        if run.get("tool_id"):
            latest_by_tool[str(run.get("tool_id"))] = run
    if not latest_by_tool:
        return 0.0
    ok = sum(1 for run in latest_by_tool.values() if run.get("status") == "ok")
    judged = sum(1 for run in latest_by_tool.values() if run.get("operator_feedback_refs"))
    return round((ok / len(latest_by_tool) * 0.7) + (judged / len(latest_by_tool) * 0.3), 3)


def _finding_debt(runs: list[dict[str, Any]]) -> float:
    raw = sum(int(run.get("runner", {}).get("raw_findings_count") or 0) for run in runs if run.get("status") == "ok")
    return round(min(raw, 500) / 500, 3)
