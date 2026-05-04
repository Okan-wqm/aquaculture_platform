from __future__ import annotations

from pathlib import Path
from typing import Any

from .impact_graph import list_impact_graphs
from .ledger import append_jsonl, load_jsonl
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
    runs = load_jsonl(runs_path(root))
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
    overall = round(sum(dimensions.values()) / len(DIMENSIONS), 3)
    previous_reports = list_fitness_reports(base_dir=base_dir)
    trend = _trend(previous_reports, dimensions, overall)
    blockers = _blockers(dimensions)
    report = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "overall_score": overall,
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
    return append_jsonl(root / "fitness" / "fitness-reports.jsonl", report)


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
    return append_jsonl(ensure_tools_dir(base_dir) / "fitness" / "recommendation-candidates.jsonl", row)


def list_fitness_reports(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "fitness" / "fitness-reports.jsonl")


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
