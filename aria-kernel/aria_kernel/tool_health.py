from __future__ import annotations

import fnmatch
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .feedback_store import (
    load_feedback,
    mark_findings_need_revalidation,
    record_findings_for_run,
)
from .ledger import append_jsonl as append_chained_jsonl
from .ledger import load_jsonl as load_chained_jsonl
from .quarantine import quarantine_tool
from .tool_registry import GovernanceError, ensure_tools_dir, get_tool, update_tool, utc_now


RUN_STATUSES = (
    "ok",
    "schema_error",
    "scope_violation",
    "evidence_error",
    "crash",
    "budget_exceeded",
)
REQUIRED_RUN_FIELDS = (
    "run_id",
    "tool_id",
    "cycle_id",
    "status",
    "input_hash",
    "output_hash",
    "read_paths",
    "emitted_observations",
    "emitted_findings",
    "evidence_validation",
    "operator_feedback_refs",
    "duration_ms",
    "cost_units",
    "schema_version",
)
DEFAULT_FORBIDDEN_READ_GLOBS = (
    ".claude/**",
    ".git/**",
    "agent-workspace/**",
    ".aria-poc/**",
    "aria-tools/**",
    "node_modules/**",
    "dist/**",
    "coverage/**",
    "build/**",
    "tmp/**",
    "secrets/**",
    ".env",
    ".env.*",
)
SELF_OUTPUT_MARKERS = ("agent-workspace/", ".aria-poc/", "aria-tools/")


def runs_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "runs.jsonl"


def health_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "health.jsonl"


def calibration_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "calibration.jsonl"


def record_run(
    run: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    envelope = validate_run_envelope(run)
    tool = get_tool(envelope["tool_id"], base_dir)
    emission_count = _count(envelope["emitted_observations"]) + _count(envelope["emitted_findings"])
    if emission_count and not can_emit_operator_facing(envelope["tool_id"], base_dir=base_dir):
        raise GovernanceError(
            f"{tool['status']} tool cannot emit operator-facing observations or findings",
        )

    scope_violations = find_scope_violations(tool, envelope["read_paths"])
    if scope_violations and envelope["status"] == "ok":
        envelope["status"] = "scope_violation"
        envelope["scope_violations"] = scope_violations
    if envelope["status"] == "ok" and envelope["evidence_validation"].get("valid") is False:
        envelope["status"] = "evidence_error"

    append_jsonl(runs_path(base_dir), {"recorded_at": utc_now(), **envelope})
    record_findings_for_run(envelope, base_dir=base_dir)
    decision = evaluate_health(envelope["tool_id"], base_dir=base_dir, latest_run=envelope)
    append_jsonl(health_path(base_dir), decision)
    return decision


def validate_run_envelope(run: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(run, dict):
        raise GovernanceError("run envelope must be a JSON object")
    missing = [field for field in REQUIRED_RUN_FIELDS if field not in run]
    if missing:
        raise GovernanceError(f"run envelope missing required field(s): {', '.join(missing)}")
    candidate = dict(run)
    for field in ("run_id", "tool_id", "cycle_id", "input_hash", "output_hash"):
        if not isinstance(candidate[field], str) or not candidate[field].strip():
            raise GovernanceError(f"{field} must be a non-empty string")
    if candidate["status"] not in RUN_STATUSES:
        raise GovernanceError(f"unknown run status: {candidate['status']}")
    if not isinstance(candidate["read_paths"], list):
        raise GovernanceError("read_paths must be an array")
    if not isinstance(candidate["evidence_validation"], dict):
        raise GovernanceError("evidence_validation must be an object")
    if not isinstance(candidate["operator_feedback_refs"], list):
        raise GovernanceError("operator_feedback_refs must be an array")
    if not isinstance(candidate["duration_ms"], (int, float)) or candidate["duration_ms"] < 0:
        raise GovernanceError("duration_ms must be a non-negative number")
    if not isinstance(candidate["cost_units"], (int, float)) or candidate["cost_units"] < 0:
        raise GovernanceError("cost_units must be a non-negative number")
    return candidate


def evaluate_health(
    tool_id: str,
    *,
    base_dir: str | Path | None = None,
    latest_run: dict[str, Any] | None = None,
) -> dict[str, Any]:
    tool = get_tool(tool_id, base_dir)
    runs = load_jsonl(runs_path(base_dir), tool_id=tool_id)
    latest = latest_run or (runs[-1] if runs else None)
    decision = {
        "schema_version": 1,
        "at": utc_now(),
        "tool_id": tool_id,
        "status": tool["status"],
        "action": "none",
        "reason": "no health transition required",
        "metrics": compute_metrics(tool, runs, base_dir=base_dir),
    }
    if latest is None:
        return decision

    quarantine_reason = immediate_quarantine_reason(tool, latest)
    if quarantine_reason is None:
        metrics = compute_metrics(tool, runs, base_dir=base_dir)
        if metrics["critical_false_positives"] > tool["health_thresholds"]["critical_false_positives"]:
            quarantine_reason = "operator-confirmed critical false positive"
    if quarantine_reason:
        updated = quarantine_tool(tool_id, quarantine_reason, base_dir=base_dir, run_id=latest["run_id"])
        revalidation_count = mark_findings_need_revalidation(tool_id, base_dir=base_dir)
        decision.update(
            {
                "status": updated["status"],
                "action": "quarantine",
                "reason": quarantine_reason,
                "metrics": compute_metrics(updated, load_jsonl(runs_path(base_dir), tool_id=tool_id), base_dir=base_dir),
                "revalidation_required": revalidation_count,
            },
        )
        return decision

    calibrate_reason = auto_calibrate_reason(tool, runs, base_dir=base_dir)
    if calibrate_reason and tool["status"] not in ("CALIBRATE", "QUARANTINED", "ARCHIVED"):
        updated = update_tool(
            tool_id,
            {
                "status": "CALIBRATE",
                "last_transition": {
                    "at": utc_now(),
                    "from": tool["status"],
                    "to": "CALIBRATE",
                    "reason": calibrate_reason,
                },
            },
            base_dir,
        )
        append_jsonl(
            calibration_path(base_dir),
            {
                "schema_version": 1,
                "at": utc_now(),
                "tool_id": tool_id,
                "reason": calibrate_reason,
                "previous_status": tool["status"],
                "status": "CALIBRATE",
            },
        )
        decision.update(
            {
                "status": updated["status"],
                "action": "calibrate",
                "reason": calibrate_reason,
                "metrics": compute_metrics(updated, runs, base_dir=base_dir),
            },
        )
    return decision


def can_emit_operator_facing(
    tool_id: str,
    *,
    base_dir: str | Path | None = None,
) -> bool:
    return get_tool(tool_id, base_dir)["status"] == "ACTIVE"


def immediate_quarantine_reason(tool: dict[str, Any], run: dict[str, Any]) -> str | None:
    if run["status"] == "scope_violation" or find_scope_violations(tool, run["read_paths"]):
        return "scope violation: read outside declared scope or forbidden generated/secrets path"
    if run["status"] == "schema_error":
        return "invalid output schema"
    if run["status"] == "evidence_error" or has_self_output_evidence(run):
        return "self-output evidence or invalid evidence chain"
    if run["evidence_validation"].get("repository_mutation_attempt"):
        return "repository mutation attempt"
    if run["status"] == "crash" and run["evidence_validation"].get("ledger_corruption"):
        return "crash corrupted ledger state"
    if has_critical_false_positive(run):
        return "operator-confirmed critical false positive"
    return None


def auto_calibrate_reason(
    tool: dict[str, Any],
    runs: list[dict[str, Any]],
    *,
    base_dir: str | Path | None = None,
) -> str | None:
    metrics = compute_metrics(tool, runs, base_dir=base_dir)
    thresholds = tool["health_thresholds"]
    if metrics["judged_samples"] >= 10 and metrics["precision"] < thresholds["precision_min"]:
        return "precision below threshold after judged samples"
    if metrics["non_critical_false_positives_30d"] >= thresholds["non_critical_false_positives_30d"]:
        return "three non-critical false positives in 30 days"
    if metrics["contradictions_last_10"] >= 2:
        return "repeated contradiction with another ACTIVE tool"
    if metrics["last_10_runs"] >= 10 and metrics["crash_rate_last_10"] > thresholds["crash_rate_last_10"]:
        return "crash rate above threshold over last 10 runs"
    if metrics["budget_exceeded_7d"] >= 2:
        return "budget use above declared cap twice in 7 days"
    return None


def compute_metrics(
    tool: dict[str, Any],
    runs: list[dict[str, Any]],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    judged = 0
    true_positive = 0
    false_positive = 0
    non_critical_30d = 0
    human_judged = 0
    ai_consensus_judged = 0
    feedback_rows = load_feedback(tool_id=tool["tool_id"], base_dir=base_dir)
    feedback_by_run: dict[str, list[dict[str, Any]]] = {}
    for feedback in feedback_rows:
        feedback_by_run.setdefault(str(feedback.get("run_id")), []).append(feedback)
    for run in runs:
        combined_feedback = list(run.get("operator_feedback_refs", [])) + feedback_by_run.get(
            str(run.get("run_id")),
            [],
        )
        for feedback in combined_feedback:
            kind = feedback_kind(feedback)
            if kind in ("true_positive", "false_positive"):
                judged += 1
                source_type = str(feedback.get("source_type") or "human") if isinstance(feedback, dict) else "human"
                if source_type == "ai_consensus":
                    ai_consensus_judged += 1
                elif source_type != "ai_judge":
                    human_judged += 1
            if kind == "true_positive":
                true_positive += 1
            if kind == "false_positive":
                false_positive += 1
                if feedback_severity(feedback) != "critical" and _within_days(run, now, 30):
                    non_critical_30d += 1

    last_10 = runs[-10:]
    crash_count = sum(1 for run in last_10 if run.get("status") == "crash")
    cap = tool["health_thresholds"].get("max_cost_units")
    budget_exceeded_7d = sum(
        1
        for run in runs
        if _within_days(run, now, 7)
        and (
            run.get("status") == "budget_exceeded"
            or (cap is not None and float(run.get("cost_units", 0)) > float(cap))
        )
    )

    precision = 0.0 if judged == 0 else true_positive / max(true_positive + false_positive, 1)
    raw_findings = sum(_count(run.get("emitted_findings")) + _count(run.get("runner", {}).get("raw_findings_sample")) for run in runs)
    return {
        "judged_samples": judged,
        "precision": precision,
        "precision_status": _precision_status(judged, human_judged, ai_consensus_judged, raw_findings),
        "human_judged_samples": human_judged,
        "ai_consensus_judged_samples": ai_consensus_judged,
        "critical_false_positives": sum(1 for run in runs if has_critical_false_positive(run))
        + sum(
            1
            for feedback in feedback_rows
            if feedback_kind(feedback) == "false_positive" and feedback_severity(feedback) == "critical"
        ),
        "non_critical_false_positives_30d": non_critical_30d,
        "last_10_runs": len(last_10),
        "crash_rate_last_10": 0.0 if not last_10 else crash_count / len(last_10),
        "budget_exceeded_7d": budget_exceeded_7d,
        "contradictions_last_10": sum(
            1 for run in last_10 if run.get("evidence_validation", {}).get("contradicts_active_tool")
        ),
    }


def _precision_status(judged: int, human_judged: int, ai_consensus_judged: int, raw_findings: int) -> str:
    if judged == 0 and raw_findings == 0:
        return "no_findings_to_judge"
    if judged == 0:
        return "unjudged"
    if human_judged and ai_consensus_judged:
        return "mixed_judged"
    if human_judged:
        return "human_judged"
    if ai_consensus_judged:
        return "ai_consensus_judged"
    return "unjudged"


def find_scope_violations(tool: dict[str, Any], read_paths: list[Any]) -> list[str]:
    violations = []
    allowed = tool.get("allowed_read_globs", [])
    forbidden = list(DEFAULT_FORBIDDEN_READ_GLOBS) + list(tool.get("forbidden_read_globs", []))
    for raw_path in read_paths:
        normalized = normalize_path(raw_path)
        if any(matches_glob(normalized, pattern) for pattern in forbidden):
            violations.append(normalized)
            continue
        if not any(matches_glob(normalized, pattern) for pattern in allowed):
            violations.append(normalized)
    return violations


def has_self_output_evidence(run: dict[str, Any]) -> bool:
    validation = run.get("evidence_validation", {})
    if validation.get("self_output_evidence"):
        return True
    sources = validation.get("evidence_sources", [])
    return any(normalize_path(source).startswith(SELF_OUTPUT_MARKERS) for source in sources)


def has_critical_false_positive(run: dict[str, Any]) -> bool:
    return any(
        feedback_kind(feedback) == "false_positive" and feedback_severity(feedback) == "critical"
        for feedback in run.get("operator_feedback_refs", [])
    )


def feedback_kind(feedback: Any) -> str | None:
    if isinstance(feedback, str):
        return feedback
    if isinstance(feedback, dict):
        return feedback.get("kind") or feedback.get("type") or feedback.get("judgement") or feedback.get("verdict")
    return None


def feedback_severity(feedback: Any) -> str | None:
    if isinstance(feedback, dict):
        return feedback.get("severity")
    return None


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    append_chained_jsonl(path, payload)


def load_jsonl(path: Path, *, tool_id: str | None = None) -> list[dict[str, Any]]:
    rows = load_chained_jsonl(path)
    if tool_id is not None:
        rows = [row for row in rows if row.get("tool_id") == tool_id]
    return rows


def normalize_path(raw_path: Any) -> str:
    path = str(raw_path).replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def matches_glob(path: str, pattern: str) -> bool:
    normalized_pattern = normalize_path(pattern)
    if fnmatch.fnmatch(path, normalized_pattern):
        return True
    if "/**/" in normalized_pattern:
        zero_segment_pattern = normalized_pattern.replace("/**/", "/")
        return fnmatch.fnmatch(path, zero_segment_pattern)
    return False


def _count(value: Any) -> int:
    if isinstance(value, list):
        return len(value)
    if isinstance(value, int):
        return value
    return 0


def _within_days(run: dict[str, Any], now: datetime, days: int) -> bool:
    raw = run.get("recorded_at") or run.get("at")
    if not raw:
        return True
    try:
        recorded = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return True
    return recorded >= now - timedelta(days=days)
