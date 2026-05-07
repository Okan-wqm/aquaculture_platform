"""Plan 016 §Logs and telemetry — nine-metric counter set + dashboard writer.

Why a dedicated module: existing `observability.py` records per-cycle
metrics (durations, artifact counts, cost units) and a generic
dashboard. Plan 016's nine counters are SPECIFIC to bound-agent
execution and live in append-only ledgers (governance.jsonl,
claims.jsonl, requests.jsonl, results.jsonl) instead of cycle-bound
metrics rows. Computing them here keeps `observability.py` focused on
its existing per-cycle shape and gives Plan 016 a stable named-counter
surface the dashboard can render.

The nine counters (Plan 016 §Logs and telemetry):
- aria_agent_request_total
- aria_agent_claim_active            (current — derived state)
- aria_agent_claim_expired_total
- aria_agent_satisfaction_failed_total
- aria_plan_rounds_total
- aria_plan_stale_total
- aria_impact_unknown_total
- aria_self_approval_rejected_total
- aria_pr_created_total
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .agent_invocations import derive_request_state
from .ledger import load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


PLAN_016_METRIC_NAMES = (
    "aria_agent_request_total",
    "aria_agent_claim_active",
    "aria_agent_claim_expired_total",
    "aria_agent_satisfaction_failed_total",
    "aria_plan_rounds_total",
    "aria_plan_stale_total",
    "aria_impact_unknown_total",
    "aria_self_approval_rejected_total",
    "aria_pr_created_total",
)


def _governance_kinds(tools_root: Path) -> list[str]:
    rows = load_jsonl(tools_root / "governance.jsonl")
    return [str(r.get("kind", "")) for r in rows]


def _claim_active_count(tools_root: Path) -> int:
    """Count requests whose derived state is CLAIMED or RUNNING right now."""
    requests = load_jsonl(tools_root / "agent-invocations" / "requests.jsonl")
    active = 0
    for req in requests:
        rid = req.get("request_id")
        if not rid:
            continue
        try:
            state = derive_request_state(request_id=rid, base_dir=tools_root)
        except GovernanceError:
            continue
        if state in {"CLAIMED", "RUNNING"}:
            active += 1
    return active


def _impact_unknown_count(tools_root: Path) -> int:
    """Count impact-graph entries with status='unknown' across all recorded graphs.

    Walks `aria-tools/impact-graphs/*.json` (when present); also tolerates
    inline impact entries inside `aria-tools/cycle-diff/*.json`. Either
    shape contributes to the unknown total without double-counting.
    """
    count = 0
    impact_dir = tools_root / "impact-graphs"
    if impact_dir.exists():
        for path in impact_dir.glob("*.json"):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            entries = payload.get("entries") or []
            count += sum(
                1 for e in entries
                if isinstance(e, dict) and e.get("status") == "unknown"
            )
    return count


def _plan_round_total(tools_root: Path) -> int:
    """Sum of rounds across all plan-convergence records."""
    plans_dir = tools_root / "plans"
    if not plans_dir.exists():
        return 0
    total = 0
    for path in plans_dir.rglob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        rounds = payload.get("round_count") or payload.get("rounds")
        if isinstance(rounds, int) and rounds > 0:
            total += rounds
    return total


def compute_plan_016_metrics(*, base_dir: str | Path | None = None) -> dict[str, int]:
    """Return the nine Plan 016 counters as a flat dict {metric_name: int}.

    Pure read over append-only ledgers — safe to call repeatedly without
    side effects.
    """
    tools_root = ensure_tools_dir(base_dir)
    requests = load_jsonl(tools_root / "agent-invocations" / "requests.jsonl")
    results = load_jsonl(tools_root / "agent-invocations" / "results.jsonl")
    claims = load_jsonl(tools_root / "agent-invocations" / "claims.jsonl")
    kinds = _governance_kinds(tools_root)

    return {
        "aria_agent_request_total": len(requests),
        "aria_agent_claim_active": _claim_active_count(tools_root),
        "aria_agent_claim_expired_total": sum(
            1 for c in claims if c.get("event") == "stale"
        ),
        "aria_agent_satisfaction_failed_total": sum(
            1 for r in results
            if r.get("status") == "rejected"
            and any("satisfaction" in str(reason).lower() for reason in (r.get("rejection_reasons") or []))
        ),
        "aria_plan_rounds_total": _plan_round_total(tools_root),
        "aria_plan_stale_total": sum(1 for k in kinds if k == "plan_stale"),
        "aria_impact_unknown_total": _impact_unknown_count(tools_root),
        "aria_self_approval_rejected_total": sum(
            1 for k in kinds if k == "self_approval_rejected"
        ),
        "aria_pr_created_total": sum(1 for k in kinds if k == "pr_created"),
    }


def _gate_activity_for_dashboard(tools_root: Path) -> dict[str, int]:
    """Plan 017 Phase 6.3 — read top governance event kinds for dashboard.

    Returns {kind: count} sorted desc, top 12.
    """
    governance = tools_root / "governance.jsonl"
    if not governance.exists():
        return {}
    counts: dict[str, int] = {}
    for line in governance.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            kind = json.loads(line).get("kind") or "?"
        except json.JSONDecodeError:
            continue
        counts[kind] = counts.get(kind, 0) + 1
    sorted_items = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:12]
    return dict(sorted_items)


def render_dashboard_markdown(
    *,
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
) -> str:
    """Render the Plan 016 dashboard as Markdown.

    Sections (Plan 016 §Logs and telemetry):
    - active plans
    - rounds
    - unresolved risks (HUMAN_REQUIRED + open findings + open debts)
    - pending agent requests
    - failed satisfaction items
    - PR readiness
    """
    from .cycle_guard import _open_debt_count, _open_finding_count, _resolve_repo_root
    from .human_required import list_human_required

    tools_root = ensure_tools_dir(base_dir)
    metrics = compute_plan_016_metrics(base_dir=tools_root)
    repo_path = (
        Path(repo_root) if repo_root is not None
        else _resolve_repo_root(tools_root)
    )
    open_findings = _open_finding_count(repo_path) if repo_path is not None else 0
    open_debts = _open_debt_count(repo_path) if repo_path is not None else 0
    hr_open = len(list_human_required(base_dir=tools_root))
    gate_activity = _gate_activity_for_dashboard(tools_root)

    now = utc_now()
    lines = [
        f"# ARIA Plan 016 Dashboard ({now})",
        "",
        "## Active Plans",
        "",
        f"- aria_plan_rounds_total: {metrics['aria_plan_rounds_total']}",
        f"- aria_plan_stale_total: {metrics['aria_plan_stale_total']}",
        "",
        "## Unresolved Risks",
        "",
        f"- HUMAN_REQUIRED open: {hr_open}",
        f"- Open findings: {open_findings}",
        f"- Open debts: {open_debts}",
        "",
        "## Pending Agent Requests",
        "",
        f"- aria_agent_request_total: {metrics['aria_agent_request_total']}",
        f"- aria_agent_claim_active: {metrics['aria_agent_claim_active']}",
        f"- aria_agent_claim_expired_total: {metrics['aria_agent_claim_expired_total']}",
        "",
        "## Failed Satisfaction Items",
        "",
        f"- aria_agent_satisfaction_failed_total: {metrics['aria_agent_satisfaction_failed_total']}",
        f"- aria_self_approval_rejected_total: {metrics['aria_self_approval_rejected_total']}",
        "",
        "## Impact Coverage",
        "",
        f"- aria_impact_unknown_total: {metrics['aria_impact_unknown_total']}",
        "",
        "## PR Readiness",
        "",
        f"- aria_pr_created_total: {metrics['aria_pr_created_total']}",
        "",
        "## Gate Activity (top 12 governance event kinds)",
        "",
        *(
            [f"- {kind}: {count}" for kind, count in gate_activity.items()]
            or ["- (no governance events)"]
        ),
        "",
        "---",
        f"_Computed at {now} from append-only ledgers — safe to recompute._",
        "",
    ]
    return "\n".join(lines)


def write_dashboard(
    *,
    base_dir: str | Path | None = None,
    repo_root: str | Path | None = None,
    out_path: str | Path | None = None,
) -> Path:
    """Render and persist the dashboard at `aria-tools/reports/dashboard.md` (default)."""
    tools_root = ensure_tools_dir(base_dir)
    text = render_dashboard_markdown(base_dir=tools_root, repo_root=repo_root)
    target = Path(out_path) if out_path is not None else tools_root / "reports" / "dashboard.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return target
