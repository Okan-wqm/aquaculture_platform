from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ledger import read_jsonl
from .pressure import effective_workspace_pressures
from .workspace import WorkspacePaths


def export_telemetry(paths: WorkspacePaths, *, format: str = "prometheus", tools_root: str | Path | None = None) -> str:
    metrics = collect_metrics(paths, tools_root=tools_root)
    if format == "prometheus":
        return _prometheus(metrics)
    if format == "otel":
        return json.dumps({"resourceMetrics": [{"scopeMetrics": [{"metrics": metrics}]}]}, indent=2, sort_keys=True) + "\n"
    raise ValueError(f"unsupported telemetry format: {format}")


def collect_metrics(paths: WorkspacePaths, *, tools_root: str | Path | None = None) -> list[dict[str, Any]]:
    pressures = effective_workspace_pressures(paths)
    governance = read_jsonl(paths.ledgers["governance"])
    rejections = read_jsonl(paths.ledgers["vocabulary_rejections"])
    metrics: list[dict[str, Any]] = []
    for state in sorted({str(row.get("effective_state")) for row in pressures} | {"active", "faded", "sleeping", "archived", "closed", "satisfied"}):
        metrics.append(_metric("aria_pressure_count", sum(1 for row in pressures if row.get("effective_state") == state), {"state": state}))
    for row in pressures:
        metrics.append(
            _metric(
                "aria_pressure_effective_magnitude_sum",
                float(row.get("effective_magnitude") or row.get("magnitude") or 0),
                {
                    "trusted_effective": str(bool(row.get("trusted_effective"))).lower(),
                    "ref_stale": str(row.get("ref_stale") or "unknown"),
                },
            ),
        )
    for row in governance:
        kind = row.get("kind")
        details = row.get("details", {})
        if kind == "learning_hook_failed":
            metrics.append(_metric("aria_learning_hook_failures_total", 1, {"hook_name": details.get("hook_name", ""), "error_class": details.get("error_class", "")}))
        elif kind == "learning_hook_items_failed":
            # Per-item containment keeps a batch hook running past one bad
            # item. Without its own metric the contained failures would be
            # invisible here, and a quieter dashboard would read as a
            # healthier one.
            for failure in details.get("failures", []):
                metrics.append(
                    _metric(
                        "aria_learning_hook_item_failures_total",
                        1,
                        {
                            "hook_name": details.get("hook_name", ""),
                            "item_kind": failure.get("item_kind", ""),
                            "error_class": failure.get("error_class", ""),
                        },
                    ),
                )
        elif kind == "pressure_decayed":
            for transition in details.get("transitions", []):
                metrics.append(_metric("aria_pressure_decays_total", 1, {"to_state": transition.get("to_state", "")}))
        elif kind == "pressure_closed_via_trailer":
            metrics.append(_metric("aria_pressure_closed_via_trailer_total", 1, {}))
        elif kind == "pressure_addresses_recorded":
            metrics.append(_metric("aria_pressure_addresses_recorded_total", 1, {}))
        elif kind == "pressure_satisfied_by_skill":
            metrics.append(_metric("aria_pressure_satisfied_total", 1, {"evidence_kind": details.get("evidence_kind", "")}))
        elif kind == "agent_removed":
            metrics.append(_metric("aria_agent_removed_total", 1, {}))
        elif kind == "feedback_escalated_to_trusted":
            metrics.append(_metric("aria_feedback_trusted_effective_count", 1, {}))
        elif kind == "ref_stale_detected":
            metrics.append(_metric("aria_ref_stale_detected_total", 1, {"status": details.get("status", "")}))
        elif kind == "reverify_action_recorded":
            metrics.append(_metric("aria_reverify_actions_total", 1, {"mode": details.get("mode", ""), "action": details.get("action", "")}))
        elif kind == "vocabulary_extension_proposed":
            metrics.append(_metric("aria_vocabulary_extension_proposals_total", 1, {}))
        elif kind == "cycle_artifact_archived":
            metrics.append(_metric("aria_cycle_artifacts_archived_total", 1, {"scope": details.get("scope", "")}))
        elif kind == "agent_report_ingested":
            metrics.append(_metric("aria_agent_report_ingested_total", 1, {"owner_agent": details.get("owner_agent", ""), "severity": details.get("severity", "")}))
        elif kind == "report_ingestion_skipped":
            metrics.append(_metric("aria_report_ingestion_skipped_total", 1, {"reason": details.get("reason", "")}))
        elif kind == "report_ingestion_cache_missing":
            metrics.append(_metric("aria_report_ingestion_cache_missing_total", 1, {}))
    for row in rejections:
        metrics.append(_metric("aria_vocabulary_rejections_total", 1, {"surface": row.get("surface", ""), "parser_kind": row.get("parser_kind", "")}))
    root = Path(tools_root) if tools_root is not None else paths.repo_root / "aria-tools"
    if root.exists():
        metrics.extend(_tools_metrics(root))
    return metrics


def _tools_metrics(root: Path) -> list[dict[str, Any]]:
    metrics: list[dict[str, Any]] = []
    for row in read_jsonl(root / "problem_clusters.jsonl"):
        metrics.append(_metric("aria_semantic_cluster_size", len(row.get("member_pressures", []) or []), {"primary_pressure": row.get("primary_pressure", "")}))
    for row in read_jsonl(root / "triage" / "decisions.jsonl"):
        metrics.append(_metric("aria_pressure_triage_total", 1, {"tier": row.get("triage_tier", "")}))
    for row in read_jsonl(root / "dispatch" / "requests.jsonl"):
        metrics.append(_metric("aria_dispatch_requests_total", 1, {"state": row.get("state", ""), "target_agent": row.get("target_agent", "")}))
    for row in read_jsonl(root / "dispatch" / "worker-results.jsonl"):
        metrics.append(_metric("aria_worker_results_total", 1, {"result": row.get("state", ""), "target_agent": row.get("target_agent", "")}))
    for row in read_jsonl(root / "dispatch" / "verification-results.jsonl"):
        metrics.append(_metric("aria_verification_gate_total", 1, {"result": row.get("status", "")}))
    for row in read_jsonl(root / "fitness" / "agent-fitness.jsonl"):
        metrics.append(_metric("aria_agent_fitness_score", float(row.get("score") or 0), {"agent_name": row.get("agent_name", "")}))
    return metrics


def _metric(name: str, value: float, labels: dict[str, Any]) -> dict[str, Any]:
    return {"name": name, "value": value, "labels": {key: str(value) for key, value in labels.items()}}


def _prometheus(metrics: list[dict[str, Any]]) -> str:
    aggregated: dict[tuple[str, tuple[tuple[str, str], ...]], float] = {}
    for metric in metrics:
        labels = tuple(sorted(metric["labels"].items()))
        key = (metric["name"], labels)
        aggregated[key] = aggregated.get(key, 0.0) + float(metric["value"])
    lines = []
    for (name, labels), value in sorted(aggregated.items()):
        label_text = ""
        if labels:
            label_text = "{" + ",".join(f'{key}="{_escape_label(val)}"' for key, val in labels) + "}"
        lines.append(f"{name}{label_text} {value:g}")
    return "\n".join(lines) + "\n"


def _escape_label(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
