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
        # Plan 032 Faz 032e — the store's own organs: queue, missions, breakers,
        # control, delivery closure, notifications, cost.
        metrics.extend(_store_metrics(root))
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


def _guarded_metrics(name: str, reader: Any) -> list[dict[str, Any]]:
    """A reader that fails becomes a metric, never a missing series."""
    try:
        return list(reader())
    except Exception as exc:  # noqa: BLE001 — telemetry must always render
        return [_metric("aria_telemetry_reader_errors_total", 1, {"reader": name, "error_class": type(exc).__name__})]


def _store_metrics(root: Path) -> list[dict[str, Any]]:
    """Plan 032 Faz 032e — Prometheus view of the tools store."""
    from collections import Counter

    def _requests() -> list[dict[str, Any]]:
        from .agent_invocations import derive_request_states

        counts = Counter(derive_request_states(base_dir=root).values())
        return [_metric("aria_agent_requests", n, {"state": state}) for state, n in sorted(counts.items())]

    def _human_required() -> list[dict[str, Any]]:
        from .human_required import list_human_required

        rows = list_human_required(base_dir=root)
        by_sev = Counter(str(r.get("severity") or "") for r in rows)
        return [_metric("aria_human_required_open", n, {"severity": sev}) for sev, n in sorted(by_sev.items())] or [
            _metric("aria_human_required_open", 0, {"severity": "none"})]

    def _missions() -> list[dict[str, Any]]:
        from .mission import list_open_missions

        counts = Counter(str(m.get("state") or "") for m in list_open_missions(base_dir=root))
        return [_metric("aria_missions_open", n, {"state": state}) for state, n in sorted(counts.items())]

    def _breakers() -> list[dict[str, Any]]:
        from .circuit_breaker import current_state as failure_state
        from .cost_budget import current_state as cost_state

        return [
            _metric("aria_breaker_tripped", 1 if failure_state(root) == "tripped" else 0, {"breaker": "failure"}),
            _metric("aria_breaker_tripped", 1 if cost_state(root) == "tripped" else 0, {"breaker": "cost"}),
        ]

    def _control() -> list[dict[str, Any]]:
        from .control import effective_control

        state = effective_control(root)
        return [
            _metric("aria_executor_paused", 1 if state.paused_all else 0, {}),
            _metric("aria_cancelled_requests", len(state.cancelled), {}),
        ]

    def _delivery() -> list[dict[str, Any]]:
        from .delivery_closure import compute_delivery_closure

        summary = compute_delivery_closure(base_dir=root).summary
        out = [_metric("aria_delivery_requests", n, {"state": state}) for state, n in sorted(summary["by_state"].items())]
        out.extend([
            _metric("aria_delivery_verified_prs", summary["verified_prs"], {}),
            _metric("aria_delivery_false_success", summary["false_success"], {}),
            _metric("aria_delivery_duplicate_prs", summary["duplicate_prs"], {}),
            _metric("aria_delivery_slo_met", 1 if summary["slo"]["met"] else 0, {}),
        ])
        return out

    def _notifications() -> list[dict[str, Any]]:
        from .notify import read_outbox

        counts = Counter((str(r.get("channel") or ""), str(r.get("status") or "")) for r in read_outbox(root))
        return [_metric("aria_notifications_total", n, {"channel": ch, "status": st}) for (ch, st), n in sorted(counts.items())]

    def _cost() -> list[dict[str, Any]]:
        total = 0.0
        by_role: Counter[str] = Counter()
        for path in sorted((root / "cost-attribution").glob("*.jsonl")):
            for row in read_jsonl(path):
                amount = row.get("cost_usd", row.get("usd", row.get("total_cost_usd")))
                if isinstance(amount, (int, float)):
                    total += float(amount)
                    by_role[str(row.get("role") or "")] += float(amount)
        out = [_metric("aria_cost_usd_total", total, {})]
        out.extend(_metric("aria_cost_usd_by_role", value, {"role": role}) for role, value in sorted(by_role.items()))
        return out

    def _economy() -> list[dict[str, Any]]:
        from .token_economy import read_recommendations, usage_per_accepted_result

        out = []
        for stat in usage_per_accepted_result(base_dir=root):
            labels = {"target_agent": stat.target_agent, "role": stat.role}
            out.append(_metric("aria_spawns_total", stat.spawns, labels))
            out.append(_metric("aria_accepted_results_total", stat.accepted, labels))
            if stat.tokens_per_accepted is not None:
                out.append(_metric("aria_tokens_per_accepted_result", stat.tokens_per_accepted, labels))
        active = sum(1 for r in read_recommendations(root) if r.get("kind") == "effort" and r.get("action") == "downgrade")
        out.append(_metric("aria_effort_downgrades_recommended", active, {}))
        return out

    metrics: list[dict[str, Any]] = []
    for name, reader in (("agent_requests", _requests), ("human_required", _human_required), ("missions", _missions),
                         ("breakers", _breakers), ("control", _control), ("delivery", _delivery),
                         ("notifications", _notifications), ("cost", _cost), ("economy", _economy)):
        metrics.extend(_guarded_metrics(name, reader))
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
