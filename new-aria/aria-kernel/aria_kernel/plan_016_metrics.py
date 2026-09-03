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
from .ledger import load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


# Plan 016 baseline counters (9). Plan 020 adds 4 (Phase 6 ×2 + Phase 9
# + Phase 13); the union is exposed as PLAN_016_METRIC_NAMES so the
# dashboard renderer + invariant test cover the full surface.
PLAN_016_BASELINE_METRIC_NAMES = (
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
# Plan 020 Phase 6 — mock vs real eval counter segregation.
PLAN_020_PHASE_6_METRIC_NAMES = (
    "aria_agent_eval_mock_only_total",
    "aria_agent_eval_real_total",
)
# Plan 020 Phase 9 — change-chain validation percentage.
# Numerator: enforced-mode validated chains; denominator: committed chains.
# historical_attestation rows are EXCLUDED from the numerator (audit trail
# only; not a real validation closure per Plan v3.3 §Phase 9).
PLAN_020_PHASE_9_METRIC_NAMES = (
    "aria_change_chain_validation_pct",
)
# Plan 020 Phase 13 — dispatch rationale telemetry counter.
PLAN_020_PHASE_13_METRIC_NAMES = (
    "aria_dispatch_rationale_total",
)
PLAN_016_METRIC_NAMES = (
    PLAN_016_BASELINE_METRIC_NAMES
    + PLAN_020_PHASE_6_METRIC_NAMES
    + PLAN_020_PHASE_9_METRIC_NAMES
    + PLAN_020_PHASE_13_METRIC_NAMES
)


def _governance_kinds(tools_root: Path) -> list[str]:
    rows = load_declared_jsonl(tools_root / "governance.jsonl", expected_surface="tools_governance")
    return [str(r.get("kind", "")) for r in rows]


def _claim_active_count(tools_root: Path) -> int:
    """Count requests whose derived state is CLAIMED or RUNNING right now."""
    requests = load_declared_jsonl(
        tools_root / "agent-invocations" / "requests.jsonl",
        expected_surface="agent_invocation_requests",
    )
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
    """Plan 019 Phase 7.5 — read latest impact-graph unknown count from governance.

    Operator critique #5+#6 caught the prior semantic: the function used
    to walk `aria-tools/impact-graphs/*.json` and sum unknown entries
    across ALL graphs, double-counting old runs and breaking when the
    directory is gitignored (Plan 019 Phase 0.3). The governance event
    `impact_graph_computed` is the hash-chained SSoT for graph summaries
    (the local impact-graphs/ JSON is a runtime artifact). This function
    now reads governance.jsonl and returns the LATEST event's
    unknown_count, matching the Plan 019 acceptance ("latest graph
    unknown=0", not directory aggregate).

    Returns 0 when no impact_graph_computed event exists yet (clean slate).
    """
    # Plan 026R §A.3 — strict governance.jsonl reader. The metrics
    # dashboard reads MUST surface a corrupt governance row as an
    # operator-visible failure rather than silently dropping the row
    # and reporting a lower unknown count.
    from .governance_reader import read_governance_rows
    governance = tools_root / "governance.jsonl"
    latest_unknown = 0
    latest_ts = ""
    for row in read_governance_rows(governance, base_dir=tools_root):
        if row.get("kind") != "impact_graph_computed":
            continue
        ts = str(row.get("ts") or "")
        if ts >= latest_ts:
            latest_ts = ts
            latest_unknown = int(row.get("details", {}).get("unknown_count", 0) or 0)
    return latest_unknown


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
    """Return the Plan 016 + Plan 020 counter set as a flat dict.

    Pure read over append-only ledgers — safe to call repeatedly without
    side effects.

    Counter set:
    - 9 Plan 016 baseline counters.
    - Plan 020 Phase 6: aria_agent_eval_mock_only_total + aria_agent_eval
      _real_total (segregated mock vs real eval streams; never conflated
      so historical mock data does not retroactively pollute real-mode
      averages).
    - Plan 020 Phase 9: aria_change_chain_validation_pct (added there).
    - Plan 020 Phase 13: aria_dispatch_rationale_total (added there).
    """
    from .agent_eval import count_eval_runs_by_mode

    tools_root = ensure_tools_dir(base_dir)
    requests = load_declared_jsonl(
        tools_root / "agent-invocations" / "requests.jsonl",
        expected_surface="agent_invocation_requests",
    )
    results = load_declared_jsonl(
        tools_root / "agent-invocations" / "results.jsonl",
        expected_surface="agent_invocation_results",
    )
    claims = load_declared_jsonl(
        tools_root / "agent-invocations" / "claims.jsonl",
        expected_surface="agent_invocation_claims",
    )
    kinds = _governance_kinds(tools_root)
    from .cost_telemetry import count_dispatch_rationales
    eval_counts = count_eval_runs_by_mode(base_dir=tools_root)
    chain_pct = _change_chain_validation_pct(tools_root)
    dispatch_total = count_dispatch_rationales(base_dir=tools_root)

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
        # Plan 020 Phase 6 — mock vs real eval segregation.
        "aria_agent_eval_mock_only_total": eval_counts["aria_agent_eval_mock_only_total"],
        "aria_agent_eval_real_total": eval_counts["aria_agent_eval_real_total"],
        # Plan 020 Phase 9 — change-chain validation percentage (0..100,
        # enforced rows / committed rows). historical_attestation rows
        # excluded from numerator (audit trail only).
        "aria_change_chain_validation_pct": chain_pct,
        # Plan 020 Phase 13 — total dispatch_rationale rows recorded.
        "aria_dispatch_rationale_total": dispatch_total,
    }


def _change_chain_validation_pct(tools_root: Path) -> int:
    """Plan 020 Phase 9 metric: percentage of committed chains validated
    in 'enforced' mode (NOT historical_attestation).

    0 when no committed chains. Returned as int 0..100 to keep the
    counter set int-typed.
    """
    committed_path = tools_root / "change-ledger" / "committed.jsonl"
    validated_path = tools_root / "change-ledger" / "validated.jsonl"
    if not committed_path.exists():
        return 0
    committed = load_declared_jsonl(committed_path, expected_surface="change_committed")
    if not committed:
        return 0
    validated = (
        load_declared_jsonl(validated_path, expected_surface="change_validated")
        if validated_path.exists()
        else []
    )
    enforced_change_ids = {
        row.get("change_id") for row in validated
        if row.get("validation_mode") == "enforced"
    }
    if not enforced_change_ids:
        return 0
    enforced_committed = sum(
        1 for c in committed if c.get("change_id") in enforced_change_ids
    )
    return int(round((enforced_committed / len(committed)) * 100))


def _gate_activity_for_dashboard(tools_root: Path) -> dict[str, int]:
    """Plan 017 Phase 6.3 — read top governance event kinds for dashboard.

    Returns {kind: count} sorted desc, top 12.
    """
    # Plan 026R §A.3 — strict governance.jsonl reader for the kind-count
    # dashboard widget. Strict-by-default — a corrupt row blocks the
    # widget rather than understating the count.
    from .governance_reader import read_governance_rows
    governance = tools_root / "governance.jsonl"
    counts: dict[str, int] = {}
    for row in read_governance_rows(governance, base_dir=tools_root):
        kind = str(row.get("kind") or "?")
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
