from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .feedback_store import (
    ANCHOR_PROMOTION_MIN_JUDGMENTS,
    anchor_group_keys,
    operator_group_keys,
)
from .fixture_runner import latest_fixture_status
from .runs_reader import read_runs_rows
from .tool_health import compute_metrics, runs_path
from .tool_registry import GovernanceError, effective_freshness_window_hours, get_tool


# JJ-2a (ORPHAN-HIGH-732) — ACCEPTED_PRECISION_STATUSES left with the blocker
# it fed. It listed the tool_health precision_status values that counted as
# "judged", which blessed a lane where TWO unexamined judges unlocked
# promotion; the successor question is anchor VOLUME, and a status string
# cannot carry it. Removed rather than left unread (İ2).
ZERO_FINDING_PRECISION_STATUS = "no_findings_to_judge"
SEMANTIC_FIXTURE_REQUIRED_TOOLS = {
    "security-boundary-adapter",
    "tenant-scoping-adapter",
    "test-gap-adapter",
}


def adapter_active_readiness(
    tool_id: str,
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    tool = get_tool(tool_id, base_dir)
    if tool.get("kind") != "adapter":
        raise GovernanceError(f"tool is not an adapter: {tool_id}")
    runs = list(read_runs_rows(runs_path(base_dir), tool_id=tool_id, base_dir=Path(base_dir) if base_dir is not None else None))
    latest_runs = runs[-5:]
    fixture_status = latest_fixture_status(tool_id, base_dir=base_dir)
    fixture_pass = fixture_status["current_tool_passed"]
    semantic_required = tool_id in SEMANTIC_FIXTURE_REQUIRED_TOOLS
    metrics = compute_metrics(tool, runs, base_dir=base_dir)
    precision = float(metrics.get("precision", 0.0))
    precision_status = str(metrics.get("precision_status") or "unjudged")
    precision_min = float(tool.get("health_thresholds", {}).get("precision_min", 0.85))
    stable_runs = sum(1 for run in latest_runs if is_stable_shadow_run(run))
    zero_finding_runs = sum(1 for run in latest_runs if is_zero_finding_stable_shadow_run(run))

    # JJ-2a (ORPHAN-HIGH-732) — "operator_precision_unjudged" required a
    # PERSON. Operator directive 2026-08-18: a human must be nowhere
    # REQUIRED. The blocker is now satisfied by evidence a fleet of judges
    # can produce on its own — ANCHOR_PROMOTION_MIN_JUDGMENTS judgments
    # settled by >= 3 judges (JJ-1) — while an operator verdict still
    # satisfies it outright, because the operator is higher trust, not
    # merely another vote. Accepted, never required: exactly one direction
    # of the old asymmetry is removed.
    #
    # Counted per JUDGMENT, not per row (anchor upgrades append over their
    # own 2-judge predecessor), and per TOOL rather than per run window: the
    # question is how much examined evidence exists about this adapter, and
    # a finding judged three ways does not stop being judged when its run
    # ages out of the last-5 window.
    #
    # JJ-2a hardening — the volume must be about runs THIS REGISTRY RECORDED.
    # Both key sets are folded straight off the feedback ledger and joined
    # nothing, so a judgment naming a run_id that never entered runs.jsonl
    # counted toward the gate that promotes an adapter to ACTIVE. The join
    # is here rather than in feedback_store because this is the gate: the
    # ledger may legitimately hold judgments about anything, but only
    # evidence about recorded runs may buy an authority. runs is already
    # tool-scoped (read_runs_rows above), so the join is a set membership.
    recorded_run_ids = {str(run.get("run_id") or "") for run in runs}
    recorded_run_ids.discard("")
    anchor_judged = len({
        key for key in anchor_group_keys(tool_id=tool_id, base_dir=base_dir)
        if key[0] in recorded_run_ids
    })
    operator_judged = len({
        key for key in operator_group_keys(tool_id=tool_id, base_dir=base_dir)
        if key[0] in recorded_run_ids
    })
    precision_anchored = (
        operator_judged > 0 or anchor_judged >= ANCHOR_PROMOTION_MIN_JUDGMENTS
    )

    blockers: list[str] = []
    if tool.get("status") != "SHADOW":
        blockers.append("tool_not_shadow")
    if not fixture_pass:
        blockers.append("latest_current_fixture_not_passed")
    if not fixture_status["fixture_baseline_passed"]:
        blockers.append("fixture_baseline_not_passed")
    if semantic_required and not fixture_status["semantic_fixture_passed"]:
        blockers.append("semantic_fixture_not_passed")
    if len(latest_runs) < 5:
        blockers.append("fewer_than_5_shadow_runs")
    if stable_runs < 5:
        blockers.append("last_5_runs_not_stable")

    # E13-C11 — first reader of the manifest-owned freshness metadata:
    # SHADOW evidence older than the tool's freshness_window_hours cannot
    # justify an ACTIVE promotion, because the repo (and possibly the parse
    # window) has moved on since the run. Fail-closed: no OK run at all, or
    # an OK run that cannot prove WHEN it happened (missing/corrupt
    # recorded_at), counts as stale — a promotion gate must not treat
    # unprovable freshness as fresh (contrast tool_health._within_days,
    # which is deliberately lenient for FP-window *counting*, not gating).
    freshness_window_hours = effective_freshness_window_hours(tool)
    last_ok_recorded_at = _last_ok_run_recorded_at(runs)
    last_ok_age_hours = _age_hours(last_ok_recorded_at)
    stale_run_evidence = (
        last_ok_age_hours is None or last_ok_age_hours > freshness_window_hours
    )
    if stale_run_evidence:
        blockers.append("stale_run_evidence")

    zero_finding_lane = precision_status == ZERO_FINDING_PRECISION_STATUS
    if zero_finding_lane:
        if zero_finding_runs < 5:
            blockers.append("last_5_runs_not_zero_finding")
    elif not precision_anchored:
        blockers.append("precision_not_anchor_judged")
    elif precision < precision_min:
        blockers.append("precision_below_threshold")

    critical_false_positives = int(metrics.get("critical_false_positives", 0))
    if critical_false_positives > 0:
        blockers.append("critical_false_positive_present")

    return {
        "tool_id": tool_id,
        "status": tool.get("status"),
        "runtime_ok": bool(runs and runs[-1].get("status") == "ok"),
        "fixture_pass": fixture_pass,
        "fixture_baseline_passed": fixture_status["fixture_baseline_passed"],
        "semantic_fixture_passed": fixture_status["semantic_fixture_passed"],
        "semantic_fixture_required": semantic_required,
        "fixture_current_tool_version_passed": fixture_pass,
        "fixture_status": fixture_status,
        "run_count": len(runs),
        "stable_shadow_runs_last_5": stable_runs,
        "stable_shadow_runs": stable_runs >= 5,
        "zero_finding_shadow_runs_last_5": zero_finding_runs,
        "zero_finding_lane": zero_finding_lane,
        "precision": precision,
        "precision_status": precision_status,
        "anchor_judged_count": anchor_judged,
        "anchor_judged_min": ANCHOR_PROMOTION_MIN_JUDGMENTS,
        "operator_judged_count": operator_judged,
        "precision_anchored": precision_anchored,
        "operator_judged_precision": precision if precision_status in ("human_judged", "mixed_judged") else None,
        "precision_min": precision_min,
        "critical_false_positives": critical_false_positives,
        "freshness_window_hours": freshness_window_hours,
        "last_ok_run_recorded_at": last_ok_recorded_at,
        "last_ok_run_age_hours": last_ok_age_hours,
        "stale_run_evidence": stale_run_evidence,
        "active_ready": not blockers,
        "blocked_by": blockers,
    }


def _last_ok_run_recorded_at(runs: list[dict[str, Any]]) -> str | None:
    """recorded_at of the newest status=="ok" run, or None when absent."""
    for run in reversed(runs):
        if run.get("status") != "ok":
            continue
        raw = run.get("recorded_at") or run.get("at")
        return str(raw) if raw else None
    return None


def _age_hours(recorded_at: str | None) -> float | None:
    """Hours elapsed since an ISO-8601 timestamp; None when unprovable."""
    if not recorded_at:
        return None
    try:
        recorded = datetime.fromisoformat(recorded_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    if recorded.tzinfo is None:
        # Ledger rows are written by tool_registry.utc_now() (UTC-aware);
        # a naive value can only come from a legacy/hand-written row, and
        # UTC is the only clock the kernel ever records in.
        recorded = recorded.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - recorded).total_seconds() / 3600.0


def is_stable_shadow_run(run: dict[str, Any]) -> bool:
    if run.get("status") != "ok":
        return False
    validation = run.get("evidence_validation", {})
    if validation.get("valid") is not True:
        return False
    return not validation.get("repository_mutation_attempt")


def is_zero_finding_stable_shadow_run(run: dict[str, Any]) -> bool:
    if not is_stable_shadow_run(run):
        return False
    runner = run.get("runner", {})
    return int(runner.get("raw_findings_count") or 0) == 0
