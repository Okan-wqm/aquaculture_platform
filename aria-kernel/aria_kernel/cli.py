from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .apply_engine import plan_apply_worktree
from .agent_genesis import (
    approve_agent_pr,
    draft_agent_from_gap,
    evaluate_genesis_sandbox,
    list_agent_drafts,
    list_genesis_sandbox_runs,
)
from .agent_priors import latest_agent_priors, map_agent_priors
from .architecture import (
    generate_architecture_options,
    list_architecture_option_sets,
    list_architecture_reviews,
    review_architecture_decision,
)
from .auto_merge import GhCliGitHubAdapter, evaluate_auto_merge, merge_if_green, record_pr_lifecycle
from .budget import check_budget, list_budget_usage, record_budget_usage
from .calibration import list_calibration_recommendations, recommend_calibration
from .capability_gap import detect_capability_gaps, list_capability_gaps
from .cycle import run_cycle
from .cycle_diff import run_cycle_diff
from .db_snapshot import write_schema_snapshot
from .discovery import run_discovery
from .feedback_store import list_findings, record_operator_feedback
from .fitness import generate_fitness_report, generate_recommendation_candidate, list_fitness_reports
from .fixture_runner import run_fixture_suite
from .impact import list_impact_plans, plan_impact
from .impact_graph import list_impact_graphs, plan_downstream_impact
from .integrity import verify_integrity
from .llm_bridge import amplify_proposal
from .memory import list_memory, unwithdraw_belief, update_memory, withdraw_belief
from .performance import (
    compare_performance_baseline,
    list_performance_baselines,
    list_performance_comparisons,
    record_performance_baseline,
)
from .pressure import explain_pressure, run_pressure
from .pr_manager import open_pr_for_action
from .proposal import approve_proposal, list_proposals, proposal_packet_from_task, record_proposal, record_proposal_from_amplification
from .promotion import promote_tool
from .quarantine import quarantine_tool
from .reflection import run_reflection
from .research import fetch_research_source, list_research_fetches, list_research_sources, record_research_source
from .self_modification import list_kernel_change_requests, request_kernel_change
from .task import explain_task, generate_task_candidates, latest_tasks
from .tool_health import evaluate_health, record_run
from .tool_registry import GovernanceError, ensure_tools_dir, list_tools, register_tool
from .tool_runner import run_tool
from .validation import list_validation_plans, list_validation_runs, run_validation_commands


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        payload = args.func(args)
    except GovernanceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if payload is not None:
        print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="aria-kernel")
    parser.add_argument("--tools-dir", default=None, help="ARIA tools artifact directory")
    subparsers = parser.add_subparsers(dest="resource", required=True)

    bootstrap = subparsers.add_parser("bootstrap")
    bootstrap_subparsers = bootstrap.add_subparsers(dest="command", required=True)
    bootstrap_init = bootstrap_subparsers.add_parser("init")
    bootstrap_init.add_argument("--workspace-root", default=".")
    bootstrap_init.set_defaults(func=cmd_bootstrap_init)

    cycle = subparsers.add_parser("cycle")
    cycle_subparsers = cycle.add_subparsers(dest="command", required=True)
    cycle_run = cycle_subparsers.add_parser("run")
    cycle_run.add_argument("--workspace-root", default=".")
    cycle_run.add_argument("--cycle-id", required=True)
    cycle_run.add_argument("--discovery-only", action="store_true")
    cycle_run.add_argument("--shadow-only", action="store_true")
    cycle_run.set_defaults(func=cmd_cycle_run)

    discovery = subparsers.add_parser("discovery")
    discovery_subparsers = discovery.add_subparsers(dest="command", required=True)
    discovery_run = discovery_subparsers.add_parser("run")
    discovery_run.add_argument("--workspace-root", default=".")
    discovery_run.add_argument("--cycle-id", required=True)
    discovery_run.set_defaults(func=cmd_discovery_run)

    diff = subparsers.add_parser("diff")
    diff_subparsers = diff.add_subparsers(dest="command", required=True)
    diff_run = diff_subparsers.add_parser("run")
    diff_run.add_argument("--cycle-id", required=True)
    diff_run.set_defaults(func=cmd_diff_run)

    memory = subparsers.add_parser("memory")
    memory_subparsers = memory.add_subparsers(dest="command", required=True)
    memory_update = memory_subparsers.add_parser("update")
    memory_update.add_argument("--cycle-id", required=True)
    memory_update.set_defaults(func=cmd_memory_update)
    memory_list = memory_subparsers.add_parser("list")
    memory_list.add_argument(
        "--kind",
        required=True,
        choices=["beliefs", "observations", "uncertainties", "contradictions", "calibration"],
    )
    memory_list.set_defaults(func=cmd_memory_list)
    memory_withdraw = memory_subparsers.add_parser("withdraw")
    memory_withdraw.add_argument("--belief-id", required=True)
    memory_withdraw.add_argument("--reason", required=True)
    memory_withdraw.set_defaults(func=cmd_memory_withdraw)
    memory_unwithdraw = memory_subparsers.add_parser("unwithdraw")
    memory_unwithdraw.add_argument("--belief-id", required=True)
    memory_unwithdraw.add_argument("--reason", required=True)
    memory_unwithdraw.set_defaults(func=cmd_memory_unwithdraw)

    pressure = subparsers.add_parser("pressure")
    pressure_subparsers = pressure.add_subparsers(dest="command", required=True)
    pressure_run = pressure_subparsers.add_parser("run")
    pressure_run.add_argument("--cycle-id", required=True)
    pressure_run.set_defaults(func=cmd_pressure_run)
    pressure_explain = pressure_subparsers.add_parser("explain")
    pressure_explain.add_argument("--cycle-id", required=True)
    pressure_explain.add_argument("--pressure-id", required=True)
    pressure_explain.set_defaults(func=cmd_pressure_explain)

    reflection = subparsers.add_parser("reflection")
    reflection_subparsers = reflection.add_subparsers(dest="command", required=True)
    reflection_run = reflection_subparsers.add_parser("run")
    reflection_run.add_argument("--cycle-id", required=True)
    reflection_run.set_defaults(func=cmd_reflection_run)

    integrity = subparsers.add_parser("integrity")
    integrity_subparsers = integrity.add_subparsers(dest="command", required=True)
    integrity_verify = integrity_subparsers.add_parser("verify")
    integrity_verify.set_defaults(func=cmd_integrity_verify)

    proposal = subparsers.add_parser("proposal")
    proposal_subparsers = proposal.add_subparsers(dest="command", required=True)
    proposal_record = proposal_subparsers.add_parser("record")
    proposal_record.add_argument("--kind", required=True)
    proposal_record.add_argument("--title", required=True)
    proposal_record.add_argument("--problem", required=True)
    proposal_record.add_argument("--evidence", required=True, help="JSON array of repo evidence paths")
    proposal_record.add_argument("--validation-command", required=True)
    proposal_record.set_defaults(func=cmd_proposal_record)
    proposal_generate = proposal_subparsers.add_parser("generate")
    proposal_generate.add_argument("--task-id", required=True)
    proposal_generate.add_argument("--kind", required=True)
    proposal_generate.add_argument("--llm-response", required=True, help="JSON file containing validated LLM response")
    proposal_generate.add_argument("--estimated-usd", type=float, default=0.0)
    proposal_generate.set_defaults(func=cmd_proposal_generate)
    proposal_approve = proposal_subparsers.add_parser("approve")
    proposal_approve.add_argument("--proposal-id", required=True)
    proposal_approve.add_argument("--operator-approval-ref", required=True)
    proposal_approve.set_defaults(func=cmd_proposal_approve)
    proposal_list = proposal_subparsers.add_parser("list")
    proposal_list.add_argument("--kind", default=None)
    proposal_list.set_defaults(func=cmd_proposal_list)

    task = subparsers.add_parser("task")
    task_subparsers = task.add_subparsers(dest="command", required=True)
    task_generate = task_subparsers.add_parser("generate")
    task_generate.add_argument("--cycle-id", required=True)
    task_generate.add_argument("--limit", type=int, default=10)
    task_generate.set_defaults(func=cmd_task_generate)
    task_list = task_subparsers.add_parser("list")
    task_list.set_defaults(func=cmd_task_list)
    task_explain = task_subparsers.add_parser("explain")
    task_explain.add_argument("--task-id", required=True)
    task_explain.set_defaults(func=cmd_task_explain)

    budget = subparsers.add_parser("budget")
    budget_subparsers = budget.add_subparsers(dest="command", required=True)
    budget_check = budget_subparsers.add_parser("check")
    budget_check.add_argument("--action", required=True)
    budget_check.add_argument("--estimated-usd", type=float, required=True)
    budget_check.set_defaults(func=cmd_budget_check)
    budget_record = budget_subparsers.add_parser("record")
    budget_record.add_argument("--action", required=True)
    budget_record.add_argument("--provider", required=True)
    budget_record.add_argument("--model", required=True)
    budget_record.add_argument("--input-tokens", type=int, default=0)
    budget_record.add_argument("--output-tokens", type=int, default=0)
    budget_record.add_argument("--estimated-usd", type=float, required=True)
    budget_record.set_defaults(func=cmd_budget_record)
    budget_list = budget_subparsers.add_parser("list")
    budget_list.set_defaults(func=cmd_budget_list)

    impact = subparsers.add_parser("impact")
    impact_subparsers = impact.add_subparsers(dest="command", required=True)
    impact_plan = impact_subparsers.add_parser("plan")
    impact_plan.add_argument("--changed-files", required=True, help="JSON array of changed paths")
    impact_plan.add_argument("--action-class", required=True)
    impact_plan.add_argument("--cycle-id", default=None)
    impact_plan.add_argument("--workspace-root", default=None)
    impact_plan.add_argument("--nx-graph-file", default=None)
    impact_plan.set_defaults(func=cmd_impact_plan)
    impact_graph = impact_subparsers.add_parser("graph")
    impact_graph.add_argument("--changed-files", required=True, help="JSON array of changed paths")
    impact_graph.add_argument("--workspace-root", default=".")
    impact_graph.add_argument("--cycle-id", default=None)
    impact_graph.add_argument("--nx-graph-file", default=None)
    impact_graph.set_defaults(func=cmd_impact_graph)
    impact_list = impact_subparsers.add_parser("list")
    impact_list.set_defaults(func=cmd_impact_list)
    impact_graph_list = impact_subparsers.add_parser("list-graphs")
    impact_graph_list.set_defaults(func=cmd_impact_graph_list)

    research = subparsers.add_parser("research")
    research_subparsers = research.add_subparsers(dest="command", required=True)
    research_source = research_subparsers.add_parser("record-source")
    research_source.add_argument("--url", required=True)
    research_source.add_argument("--source-tier", required=True)
    research_source.add_argument("--content-hash", required=True)
    research_source.add_argument("--title", default="")
    research_source.set_defaults(func=cmd_research_record_source)
    research_fetch = research_subparsers.add_parser("fetch")
    research_fetch.add_argument("--url", required=True)
    research_fetch.add_argument("--source-tier", required=True)
    research_fetch.add_argument("--title", default="")
    research_fetch.set_defaults(func=cmd_research_fetch)
    research_list = research_subparsers.add_parser("list-sources")
    research_list.set_defaults(func=cmd_research_list_sources)
    research_fetch_list = research_subparsers.add_parser("list-fetches")
    research_fetch_list.set_defaults(func=cmd_research_list_fetches)

    validation = subparsers.add_parser("validation")
    validation_subparsers = validation.add_subparsers(dest="command", required=True)
    validation_run = validation_subparsers.add_parser("run")
    validation_run.add_argument("--commands", required=True, help="JSON array of approved validation commands")
    validation_run.add_argument("--workspace-root", default=".")
    validation_run.add_argument("--cycle-id", default=None)
    validation_run.add_argument("--validation-plan-id", default=None)
    validation_run.add_argument("--timeout-ms", type=int, default=120000)
    validation_run.add_argument("--allow-dirty", action="store_true")
    validation_run.set_defaults(func=cmd_validation_run)
    validation_list = validation_subparsers.add_parser("list")
    validation_list.set_defaults(func=cmd_validation_list)

    performance = subparsers.add_parser("performance")
    performance_subparsers = performance.add_subparsers(dest="command", required=True)
    performance_record = performance_subparsers.add_parser("record-baseline")
    performance_record.add_argument("--metric", required=True)
    performance_record.add_argument("--value", type=float, required=True)
    performance_record.add_argument("--unit", required=True)
    performance_record.add_argument("--source", required=True)
    performance_record.add_argument("--cycle-id", default=None)
    performance_record.set_defaults(func=cmd_performance_record)
    performance_compare = performance_subparsers.add_parser("compare")
    performance_compare.add_argument("--metric", required=True)
    performance_compare.add_argument("--current-value", type=float, required=True)
    performance_compare.add_argument("--max-regression-pct", type=float, default=5.0)
    performance_compare.add_argument("--cycle-id", default=None)
    performance_compare.set_defaults(func=cmd_performance_compare)
    performance_list = performance_subparsers.add_parser("list")
    performance_list.set_defaults(func=cmd_performance_list)

    fitness = subparsers.add_parser("fitness")
    fitness_subparsers = fitness.add_subparsers(dest="command", required=True)
    fitness_report = fitness_subparsers.add_parser("report")
    fitness_report.add_argument("--cycle-id", required=True)
    fitness_report.set_defaults(func=cmd_fitness_report)
    fitness_recommend = fitness_subparsers.add_parser("recommend")
    fitness_recommend.add_argument("--cycle-id", required=True)
    fitness_recommend.add_argument("--title", required=True)
    fitness_recommend.add_argument("--evidence-refs", required=True)
    fitness_recommend.add_argument("--validation-refs", required=True)
    fitness_recommend.add_argument("--research-refs", required=True)
    fitness_recommend.add_argument("--impact-graph-refs", required=True)
    fitness_recommend.add_argument("--repo-value", required=True)
    fitness_recommend.set_defaults(func=cmd_fitness_recommend)
    fitness_list = fitness_subparsers.add_parser("list")
    fitness_list.set_defaults(func=cmd_fitness_list)

    architecture = subparsers.add_parser("architecture")
    architecture_subparsers = architecture.add_subparsers(dest="command", required=True)
    architecture_review = architecture_subparsers.add_parser("review")
    architecture_review.add_argument("--technology", required=True)
    architecture_review.add_argument("--proposed-action", required=True)
    architecture_review.add_argument("--evidence-refs", required=True)
    architecture_review.add_argument("--root-cause", required=True)
    architecture_review.add_argument("--authoritative-refs", default="[]")
    architecture_review.add_argument("--repo-prior-refs", default="[]")
    architecture_review.add_argument("--replacement-grounds", default="[]")
    architecture_review.add_argument("--migration-plan", default="")
    architecture_review.add_argument("--rollback-plan", default="")
    architecture_review.add_argument("--abstraction-boundary", default="")
    architecture_review.add_argument("--validation-commands", default="[]")
    architecture_review.add_argument("--cleanup-task", default="")
    architecture_review.add_argument("--cycle-id", default=None)
    architecture_review.set_defaults(func=cmd_architecture_review)
    architecture_options = architecture_subparsers.add_parser("options")
    architecture_options.add_argument("--technology", required=True)
    architecture_options.add_argument("--evidence-refs", required=True)
    architecture_options.add_argument("--root-cause", required=True)
    architecture_options.add_argument("--authoritative-refs", default="[]")
    architecture_options.add_argument("--repo-prior-refs", default="[]")
    architecture_options.add_argument("--replacement-grounds", default="[]")
    architecture_options.add_argument("--cycle-id", default=None)
    architecture_options.set_defaults(func=cmd_architecture_options)
    architecture_list = architecture_subparsers.add_parser("list")
    architecture_list.set_defaults(func=cmd_architecture_list)

    calibration = subparsers.add_parser("calibration")
    calibration_subparsers = calibration.add_subparsers(dest="command", required=True)
    calibration_recommend = calibration_subparsers.add_parser("recommend")
    calibration_recommend.add_argument("--cycle-id", required=True)
    calibration_recommend.set_defaults(func=cmd_calibration_recommend)
    calibration_list = calibration_subparsers.add_parser("list")
    calibration_list.set_defaults(func=cmd_calibration_list)

    agent_priors = subparsers.add_parser("agent-priors")
    agent_priors_subparsers = agent_priors.add_subparsers(dest="command", required=True)
    agent_priors_map = agent_priors_subparsers.add_parser("map")
    agent_priors_map.add_argument("--workspace-root", default=".")
    agent_priors_map.add_argument("--cycle-id", default=None)
    agent_priors_map.set_defaults(func=cmd_agent_priors_map)
    agent_priors_latest = agent_priors_subparsers.add_parser("latest")
    agent_priors_latest.set_defaults(func=cmd_agent_priors_latest)

    gaps = subparsers.add_parser("capability-gap")
    gaps_subparsers = gaps.add_subparsers(dest="command", required=True)
    gaps_detect = gaps_subparsers.add_parser("detect")
    gaps_detect.add_argument("--cycle-id", required=True)
    gaps_detect.set_defaults(func=cmd_capability_gap_detect)
    gaps_list = gaps_subparsers.add_parser("list")
    gaps_list.set_defaults(func=cmd_capability_gap_list)

    genesis = subparsers.add_parser("agent-genesis")
    genesis_subparsers = genesis.add_subparsers(dest="command", required=True)
    genesis_draft = genesis_subparsers.add_parser("draft")
    genesis_draft.add_argument("--gap-id", required=True)
    genesis_draft.set_defaults(func=cmd_agent_genesis_draft)
    genesis_sandbox = genesis_subparsers.add_parser("sandbox")
    genesis_sandbox.add_argument("--draft-id", required=True)
    genesis_sandbox.add_argument("--fixture-results", required=True, help="JSON array of fixture result objects")
    genesis_sandbox.set_defaults(func=cmd_agent_genesis_sandbox)
    genesis_approve = genesis_subparsers.add_parser("approve-pr")
    genesis_approve.add_argument("--draft-id", required=True)
    genesis_approve.add_argument("--operator-approval-ref", required=True)
    genesis_approve.set_defaults(func=cmd_agent_genesis_approve)
    genesis_list = genesis_subparsers.add_parser("list")
    genesis_list.set_defaults(func=cmd_agent_genesis_list)

    kernel = subparsers.add_parser("kernel-change")
    kernel_subparsers = kernel.add_subparsers(dest="command", required=True)
    kernel_request = kernel_subparsers.add_parser("request")
    kernel_request.add_argument("--changed-files", required=True)
    kernel_request.add_argument("--operator-approval-ref", required=True)
    kernel_request.add_argument("--validation-refs", required=True)
    kernel_request.add_argument("--full-shadow-cycle-ref", required=True)
    kernel_request.add_argument("--rollback-plan", required=True)
    kernel_request.add_argument("--cycle-id", default=None)
    kernel_request.set_defaults(func=cmd_kernel_change_request)
    kernel_list = kernel_subparsers.add_parser("list")
    kernel_list.set_defaults(func=cmd_kernel_change_list)

    tool = subparsers.add_parser("tool")
    tool_subparsers = tool.add_subparsers(dest="command", required=True)

    register = tool_subparsers.add_parser("register")
    register.add_argument("--file", required=True)
    register.set_defaults(func=cmd_register)

    record = tool_subparsers.add_parser("record-run")
    record.add_argument("--file", required=True)
    record.set_defaults(func=cmd_record_run)

    run = tool_subparsers.add_parser("run")
    run.add_argument("--tool-id", required=True)
    run.add_argument("--input", required=True, help="JSON payload passed to the tool")
    run.add_argument("--cycle-id", required=True)
    run.add_argument("--run-id", default=None)
    run.add_argument("--workspace-root", default=None)
    run.set_defaults(func=cmd_run_tool)

    health = tool_subparsers.add_parser("health")
    health.add_argument("--tool-id", required=True)
    health.set_defaults(func=cmd_health)

    quarantine = tool_subparsers.add_parser("quarantine")
    quarantine.add_argument("--tool-id", required=True)
    quarantine.add_argument("--reason", required=True)
    quarantine.set_defaults(func=cmd_quarantine)

    promote = tool_subparsers.add_parser("promote")
    promote.add_argument("--tool-id", required=True)
    promote.add_argument(
        "--to",
        required=True,
        choices=["DRAFT", "SANDBOX", "SHADOW", "ACTIVE", "CALIBRATE", "QUARANTINED", "ARCHIVED"],
    )
    promote.add_argument("--reason", required=True)
    promote.add_argument("--operator-approval-ref", default=None)
    promote.set_defaults(func=cmd_promote)

    list_parser = tool_subparsers.add_parser("list")
    list_parser.add_argument(
        "--status",
        choices=["DRAFT", "SANDBOX", "SHADOW", "ACTIVE", "CALIBRATE", "QUARANTINED", "ARCHIVED"],
        default=None,
    )
    list_parser.set_defaults(func=cmd_list)

    fixture = subparsers.add_parser("fixture")
    fixture_subparsers = fixture.add_subparsers(dest="command", required=True)
    fixture_run = fixture_subparsers.add_parser("run")
    fixture_run.add_argument("--tool-id", required=True)
    fixture_run.add_argument("--workspace-root", required=True)
    fixture_run.add_argument("--cycle-id", required=True)
    fixture_run.set_defaults(func=cmd_fixture_run)

    finding = subparsers.add_parser("finding")
    finding_subparsers = finding.add_subparsers(dest="command", required=True)
    finding_list = finding_subparsers.add_parser("list")
    finding_list.add_argument("--tool-id", default=None)
    finding_list.add_argument("--status", default=None)
    finding_list.set_defaults(func=cmd_finding_list)

    feedback = subparsers.add_parser("feedback")
    feedback_subparsers = feedback.add_subparsers(dest="command", required=True)
    feedback_record = feedback_subparsers.add_parser("record")
    feedback_record.add_argument("--tool-id", required=True)
    feedback_record.add_argument("--run-id", required=True)
    feedback_record.add_argument("--finding-id", required=True)
    feedback_record.add_argument("--verdict", required=True, choices=["true_positive", "false_positive"])
    feedback_record.add_argument("--severity", required=True, choices=["low", "medium", "high", "critical"])
    feedback_record.add_argument("--note", required=True)
    feedback_record.add_argument("--affected-belief-ids", default=None, help="JSON array of belief ids")
    feedback_record.set_defaults(func=cmd_feedback_record)

    pr = subparsers.add_parser("pr")
    pr_subparsers = pr.add_subparsers(dest="command", required=True)
    pr_record = pr_subparsers.add_parser("record-opened")
    pr_record.add_argument("--file", required=True, help="JSON PR lifecycle payload")
    pr_record.add_argument("--cycle-id", default=None)
    pr_record.set_defaults(func=cmd_pr_record_opened)
    pr_open = pr_subparsers.add_parser("open")
    pr_open.add_argument("--proposal-id", required=True)
    pr_open.add_argument("--workspace-root", default=".")
    pr_open.add_argument("--dry-run", action="store_true")
    pr_open.set_defaults(func=cmd_pr_open)
    pr_merge = pr_subparsers.add_parser("merge-if-green")
    pr_merge.add_argument("--pr-number", type=int, default=None)
    pr_merge.add_argument("--input", default=None, help="JSON snapshot with policy, pr, and github fields")
    pr_merge.add_argument("--policy-file", default=None)
    pr_merge.add_argument("--cycle-id", default=None)
    pr_merge.add_argument("--workspace-root", default=".")
    pr_merge.add_argument("--dry-run", action="store_true")
    pr_merge.set_defaults(func=cmd_pr_merge_if_green)

    db = subparsers.add_parser("db")
    db_subparsers = db.add_subparsers(dest="command", required=True)
    snapshot = db_subparsers.add_parser("snapshot")
    snapshot.add_argument("--service", required=True)
    snapshot.add_argument("--output", required=True)
    snapshot.add_argument("--database-url", default=None)
    snapshot.set_defaults(func=cmd_db_snapshot)

    apply = subparsers.add_parser("apply")
    apply_subparsers = apply.add_subparsers(dest="command", required=True)
    apply_plan = apply_subparsers.add_parser("plan-worktree")
    apply_plan.add_argument("--proposal-id", required=True)
    apply_plan.add_argument("--workspace-root", default=".")
    apply_plan.add_argument("--execute", action="store_true")
    apply_plan.set_defaults(func=cmd_apply_plan_worktree)
    return parser


def cmd_bootstrap_init(args: argparse.Namespace) -> dict[str, Any]:
    root = ensure_tools_dir(args.tools_dir)
    for relative in (
        "discovery",
        "memory",
        "pressure",
        "reports/daily",
        "research",
        "proposals",
        "tasks",
        "budget",
        "llm",
        "impact",
        "validation",
        "performance",
        "fitness",
        "calibration",
        "agent-priors",
        "capability-gaps",
        "agent-genesis",
        "genesis-sandbox",
        "kernel-change",
        "apply",
        "cycle-state",
        "cycle-diff",
    ):
        (root / relative).mkdir(parents=True, exist_ok=True)
    return {
        "schema_version": 1,
        "workspace_root": str(Path(args.workspace_root).resolve()),
        "tools_dir": root.as_posix(),
    }


def cmd_cycle_run(args: argparse.Namespace) -> dict[str, Any]:
    return run_cycle(
        workspace_root=args.workspace_root,
        cycle_id=args.cycle_id,
        base_dir=args.tools_dir,
        discovery_only=args.discovery_only,
        shadow_only=args.shadow_only,
    )


def cmd_discovery_run(args: argparse.Namespace) -> dict[str, Any]:
    discovery = run_discovery(workspace_root=args.workspace_root, cycle_id=args.cycle_id, base_dir=args.tools_dir)
    fingerprint = discovery["fingerprint"]
    return {
        "schema_version": 1,
        "cycle_id": args.cycle_id,
        "artifact_dir": discovery["artifact_dir"],
        "completion_proof": discovery["completion_proof"],
        "fingerprint": {
            "tracked_file_count": fingerprint.get("tracked_file_count"),
            "service_count": fingerprint.get("service_count"),
            "web_module_count": fingerprint.get("web_module_count"),
            "platform_lib_count": fingerprint.get("platform_lib_count"),
            "shared_lib_count": fingerprint.get("shared_lib_count"),
            "adr_count": fingerprint.get("adr_count"),
            "migration_count": fingerprint.get("migration_count"),
            "has_nx": fingerprint.get("has_nx"),
            "has_package_json": fingerprint.get("has_package_json"),
        },
    }


def cmd_diff_run(args: argparse.Namespace) -> dict[str, Any]:
    return run_cycle_diff(cycle_id=args.cycle_id, base_dir=args.tools_dir)


def cmd_memory_update(args: argparse.Namespace) -> dict[str, Any]:
    return update_memory(cycle_id=args.cycle_id, base_dir=args.tools_dir)


def cmd_memory_list(args: argparse.Namespace) -> dict[str, Any]:
    return {"memory": list_memory(kind=args.kind, base_dir=args.tools_dir)}


def cmd_memory_withdraw(args: argparse.Namespace) -> dict[str, Any]:
    return withdraw_belief(belief_id=args.belief_id, reason=args.reason, base_dir=args.tools_dir)


def cmd_memory_unwithdraw(args: argparse.Namespace) -> dict[str, Any]:
    return unwithdraw_belief(belief_id=args.belief_id, reason=args.reason, base_dir=args.tools_dir)


def cmd_pressure_run(args: argparse.Namespace) -> dict[str, Any]:
    return run_pressure(cycle_id=args.cycle_id, base_dir=args.tools_dir)


def cmd_pressure_explain(args: argparse.Namespace) -> dict[str, Any]:
    try:
        return explain_pressure(cycle_id=args.cycle_id, pressure_id=args.pressure_id, base_dir=args.tools_dir)
    except ValueError as exc:
        raise GovernanceError(str(exc)) from exc


def cmd_reflection_run(args: argparse.Namespace) -> dict[str, Any]:
    return run_reflection(cycle_id=args.cycle_id, base_dir=args.tools_dir)


def cmd_integrity_verify(args: argparse.Namespace) -> dict[str, Any]:
    return verify_integrity(base_dir=args.tools_dir)


def cmd_proposal_record(args: argparse.Namespace) -> dict[str, Any]:
    try:
        evidence = json.loads(args.evidence)
    except json.JSONDecodeError as exc:
        raise GovernanceError(f"--evidence must be a JSON array: {exc}") from exc
    return record_proposal(
        kind=args.kind,
        title=args.title,
        problem=args.problem,
        evidence=evidence,
        validation_command=args.validation_command,
        base_dir=args.tools_dir,
    )


def cmd_proposal_generate(args: argparse.Namespace) -> dict[str, Any]:
    tasks = {task["task_id"]: task for task in latest_tasks(base_dir=args.tools_dir) if isinstance(task, dict)}
    if args.task_id not in tasks:
        raise GovernanceError(f"task not found in latest task set: {args.task_id}")
    task = tasks[args.task_id]
    packet = proposal_packet_from_task(task)
    amplification = amplify_proposal(
        packet=packet,
        response=read_json(args.llm_response),
        estimated_usd=args.estimated_usd,
        base_dir=args.tools_dir,
    )
    return record_proposal_from_amplification(task=task, amplification=amplification, kind=args.kind, base_dir=args.tools_dir)


def cmd_proposal_approve(args: argparse.Namespace) -> dict[str, Any]:
    return approve_proposal(
        proposal_id=args.proposal_id,
        operator_approval_ref=args.operator_approval_ref,
        base_dir=args.tools_dir,
    )


def cmd_proposal_list(args: argparse.Namespace) -> dict[str, Any]:
    return {"proposals": list_proposals(base_dir=args.tools_dir, kind=args.kind)}


def cmd_task_generate(args: argparse.Namespace) -> dict[str, Any]:
    return generate_task_candidates(cycle_id=args.cycle_id, limit=args.limit, base_dir=args.tools_dir)


def cmd_task_list(args: argparse.Namespace) -> dict[str, Any]:
    return {"tasks": latest_tasks(base_dir=args.tools_dir)}


def cmd_task_explain(args: argparse.Namespace) -> dict[str, Any]:
    try:
        return explain_task(task_id=args.task_id, base_dir=args.tools_dir)
    except ValueError as exc:
        raise GovernanceError(str(exc)) from exc


def cmd_budget_check(args: argparse.Namespace) -> dict[str, Any]:
    return check_budget(action=args.action, estimated_usd=args.estimated_usd, base_dir=args.tools_dir)


def cmd_budget_record(args: argparse.Namespace) -> dict[str, Any]:
    return record_budget_usage(
        action=args.action,
        provider=args.provider,
        model=args.model,
        input_tokens=args.input_tokens,
        output_tokens=args.output_tokens,
        estimated_usd=args.estimated_usd,
        base_dir=args.tools_dir,
    )


def cmd_budget_list(args: argparse.Namespace) -> dict[str, Any]:
    return {"usage": list_budget_usage(base_dir=args.tools_dir)}


def cmd_impact_plan(args: argparse.Namespace) -> dict[str, Any]:
    try:
        changed_files = json.loads(args.changed_files)
    except json.JSONDecodeError as exc:
        raise GovernanceError(f"--changed-files must be a JSON array: {exc}") from exc
    return plan_impact(
        changed_files=changed_files,
        action_class=args.action_class,
        workspace_root=args.workspace_root,
        cycle_id=args.cycle_id,
        nx_graph_file=args.nx_graph_file,
        base_dir=args.tools_dir,
    )


def cmd_impact_graph(args: argparse.Namespace) -> dict[str, Any]:
    try:
        changed_files = json.loads(args.changed_files)
    except json.JSONDecodeError as exc:
        raise GovernanceError(f"--changed-files must be a JSON array: {exc}") from exc
    return plan_downstream_impact(
        changed_files=changed_files,
        workspace_root=args.workspace_root,
        cycle_id=args.cycle_id,
        nx_graph_file=args.nx_graph_file,
        base_dir=args.tools_dir,
    )


def cmd_impact_list(args: argparse.Namespace) -> dict[str, Any]:
    return {"impact_plans": list_impact_plans(base_dir=args.tools_dir)}


def cmd_impact_graph_list(args: argparse.Namespace) -> dict[str, Any]:
    return {"impact_graphs": list_impact_graphs(base_dir=args.tools_dir)}


def cmd_research_record_source(args: argparse.Namespace) -> dict[str, Any]:
    return record_research_source(
        url=args.url,
        source_tier=args.source_tier,
        content_hash=args.content_hash,
        title=args.title,
        base_dir=args.tools_dir,
    )


def cmd_research_fetch(args: argparse.Namespace) -> dict[str, Any]:
    return fetch_research_source(
        url=args.url,
        source_tier=args.source_tier,
        title=args.title,
        base_dir=args.tools_dir,
    )


def cmd_research_list_sources(args: argparse.Namespace) -> dict[str, Any]:
    return {"sources": list_research_sources(base_dir=args.tools_dir)}


def cmd_research_list_fetches(args: argparse.Namespace) -> dict[str, Any]:
    return {"fetches": list_research_fetches(base_dir=args.tools_dir)}


def cmd_validation_run(args: argparse.Namespace) -> dict[str, Any]:
    try:
        commands = json.loads(args.commands)
    except json.JSONDecodeError as exc:
        raise GovernanceError(f"--commands must be a JSON array: {exc}") from exc
    return run_validation_commands(
        commands=commands,
        workspace_root=args.workspace_root,
        cycle_id=args.cycle_id,
        validation_plan_id=args.validation_plan_id,
        timeout_ms=args.timeout_ms,
        require_clean_worktree=not args.allow_dirty,
        base_dir=args.tools_dir,
    )


def cmd_validation_list(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "plans": list_validation_plans(base_dir=args.tools_dir),
        "runs": list_validation_runs(base_dir=args.tools_dir),
    }


def cmd_performance_record(args: argparse.Namespace) -> dict[str, Any]:
    return record_performance_baseline(
        metric=args.metric,
        value=args.value,
        unit=args.unit,
        source=args.source,
        cycle_id=args.cycle_id,
        base_dir=args.tools_dir,
    )


def cmd_performance_compare(args: argparse.Namespace) -> dict[str, Any]:
    return compare_performance_baseline(
        metric=args.metric,
        current_value=args.current_value,
        max_regression_pct=args.max_regression_pct,
        cycle_id=args.cycle_id,
        base_dir=args.tools_dir,
    )


def cmd_performance_list(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "baselines": list_performance_baselines(base_dir=args.tools_dir),
        "comparisons": list_performance_comparisons(base_dir=args.tools_dir),
    }


def cmd_fitness_report(args: argparse.Namespace) -> dict[str, Any]:
    return generate_fitness_report(cycle_id=args.cycle_id, base_dir=args.tools_dir)


def cmd_fitness_recommend(args: argparse.Namespace) -> dict[str, Any]:
    return generate_recommendation_candidate(
        cycle_id=args.cycle_id,
        title=args.title,
        evidence_refs=_json_array_arg(args.evidence_refs, "--evidence-refs"),
        validation_refs=_json_array_arg(args.validation_refs, "--validation-refs"),
        research_refs=_json_array_arg(args.research_refs, "--research-refs"),
        impact_graph_refs=_json_array_arg(args.impact_graph_refs, "--impact-graph-refs"),
        repo_value=args.repo_value,
        base_dir=args.tools_dir,
    )


def cmd_fitness_list(args: argparse.Namespace) -> dict[str, Any]:
    return {"reports": list_fitness_reports(base_dir=args.tools_dir)}


def cmd_architecture_review(args: argparse.Namespace) -> dict[str, Any]:
    return review_architecture_decision(
        technology=args.technology,
        proposed_action=args.proposed_action,
        evidence_refs=_json_array_arg(args.evidence_refs, "--evidence-refs"),
        root_cause=args.root_cause,
        authoritative_refs=_json_array_arg(args.authoritative_refs, "--authoritative-refs"),
        repo_prior_refs=_json_array_arg(args.repo_prior_refs, "--repo-prior-refs"),
        replacement_grounds=_json_array_arg(args.replacement_grounds, "--replacement-grounds"),
        migration_plan=args.migration_plan,
        rollback_plan=args.rollback_plan,
        abstraction_boundary=args.abstraction_boundary,
        validation_commands=_json_array_arg(args.validation_commands, "--validation-commands"),
        cleanup_task=args.cleanup_task,
        cycle_id=args.cycle_id,
        base_dir=args.tools_dir,
    )


def cmd_architecture_options(args: argparse.Namespace) -> dict[str, Any]:
    return generate_architecture_options(
        technology=args.technology,
        evidence_refs=_json_array_arg(args.evidence_refs, "--evidence-refs"),
        root_cause=args.root_cause,
        authoritative_refs=_json_array_arg(args.authoritative_refs, "--authoritative-refs"),
        repo_prior_refs=_json_array_arg(args.repo_prior_refs, "--repo-prior-refs"),
        replacement_grounds=_json_array_arg(args.replacement_grounds, "--replacement-grounds"),
        cycle_id=args.cycle_id,
        base_dir=args.tools_dir,
    )


def cmd_architecture_list(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "reviews": list_architecture_reviews(base_dir=args.tools_dir),
        "option_sets": list_architecture_option_sets(base_dir=args.tools_dir),
    }


def cmd_calibration_recommend(args: argparse.Namespace) -> dict[str, Any]:
    return recommend_calibration(cycle_id=args.cycle_id, base_dir=args.tools_dir)


def cmd_calibration_list(args: argparse.Namespace) -> dict[str, Any]:
    return {"recommendations": list_calibration_recommendations(base_dir=args.tools_dir)}


def cmd_agent_priors_map(args: argparse.Namespace) -> dict[str, Any]:
    return map_agent_priors(
        workspace_root=args.workspace_root,
        cycle_id=args.cycle_id,
        base_dir=args.tools_dir,
    )


def cmd_agent_priors_latest(args: argparse.Namespace) -> dict[str, Any]:
    return {"agent_priors": latest_agent_priors(base_dir=args.tools_dir)}


def cmd_capability_gap_detect(args: argparse.Namespace) -> dict[str, Any]:
    return detect_capability_gaps(cycle_id=args.cycle_id, base_dir=args.tools_dir)


def cmd_capability_gap_list(args: argparse.Namespace) -> dict[str, Any]:
    return {"capability_gaps": list_capability_gaps(base_dir=args.tools_dir)}


def cmd_agent_genesis_draft(args: argparse.Namespace) -> dict[str, Any]:
    return draft_agent_from_gap(gap_id=args.gap_id, base_dir=args.tools_dir)


def cmd_agent_genesis_sandbox(args: argparse.Namespace) -> dict[str, Any]:
    try:
        fixture_results = json.loads(args.fixture_results)
    except json.JSONDecodeError as exc:
        raise GovernanceError(f"--fixture-results must be a JSON array: {exc}") from exc
    if not isinstance(fixture_results, list):
        raise GovernanceError("--fixture-results must be a JSON array")
    return evaluate_genesis_sandbox(
        draft_id=args.draft_id,
        fixture_results=fixture_results,
        base_dir=args.tools_dir,
    )


def cmd_agent_genesis_approve(args: argparse.Namespace) -> dict[str, Any]:
    return approve_agent_pr(
        draft_id=args.draft_id,
        operator_approval_ref=args.operator_approval_ref,
        base_dir=args.tools_dir,
    )


def cmd_agent_genesis_list(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "drafts": list_agent_drafts(base_dir=args.tools_dir),
        "sandbox_runs": list_genesis_sandbox_runs(base_dir=args.tools_dir),
    }


def cmd_kernel_change_request(args: argparse.Namespace) -> dict[str, Any]:
    return request_kernel_change(
        changed_files=_json_array_arg(args.changed_files, "--changed-files"),
        operator_approval_ref=args.operator_approval_ref,
        validation_refs=_json_array_arg(args.validation_refs, "--validation-refs"),
        full_shadow_cycle_ref=args.full_shadow_cycle_ref,
        rollback_plan=args.rollback_plan,
        cycle_id=args.cycle_id,
        base_dir=args.tools_dir,
    )


def cmd_kernel_change_list(args: argparse.Namespace) -> dict[str, Any]:
    return {"requests": list_kernel_change_requests(base_dir=args.tools_dir)}


def cmd_register(args: argparse.Namespace) -> dict[str, Any]:
    payload = read_json(args.file)
    if isinstance(payload, list):
        tools = [register_tool(item, base_dir=args.tools_dir) for item in payload]
        return {"registered": tools}
    return register_tool(payload, base_dir=args.tools_dir)


def cmd_record_run(args: argparse.Namespace) -> dict[str, Any]:
    return record_run(read_json(args.file), base_dir=args.tools_dir)


def cmd_run_tool(args: argparse.Namespace) -> dict[str, Any]:
    try:
        input_payload = json.loads(args.input)
    except json.JSONDecodeError as exc:
        raise GovernanceError(f"--input must be valid JSON: {exc}") from exc
    return run_tool(
        args.tool_id,
        input_payload,
        args.cycle_id,
        run_id=args.run_id,
        workspace_root=args.workspace_root,
        base_dir=args.tools_dir,
    )


def cmd_health(args: argparse.Namespace) -> dict[str, Any]:
    return evaluate_health(args.tool_id, base_dir=args.tools_dir)


def cmd_quarantine(args: argparse.Namespace) -> dict[str, Any]:
    return quarantine_tool(args.tool_id, args.reason, base_dir=args.tools_dir)


def cmd_promote(args: argparse.Namespace) -> dict[str, Any]:
    return promote_tool(
        args.tool_id,
        args.to,
        reason=args.reason,
        operator_approval_ref=args.operator_approval_ref,
        base_dir=args.tools_dir,
    )


def cmd_list(args: argparse.Namespace) -> dict[str, Any]:
    return {"tools": list_tools(status=args.status, base_dir=args.tools_dir)}


def cmd_fixture_run(args: argparse.Namespace) -> dict[str, Any]:
    return run_fixture_suite(
        args.tool_id,
        workspace_root=args.workspace_root,
        cycle_id=args.cycle_id,
        base_dir=args.tools_dir,
    )


def cmd_finding_list(args: argparse.Namespace) -> dict[str, Any]:
    return {"findings": list_findings(tool_id=args.tool_id, status=args.status, base_dir=args.tools_dir)}


def cmd_feedback_record(args: argparse.Namespace) -> dict[str, Any]:
    affected_belief_ids = None
    if args.affected_belief_ids is not None:
        try:
            affected_belief_ids = json.loads(args.affected_belief_ids)
        except json.JSONDecodeError as exc:
            raise GovernanceError(f"--affected-belief-ids must be a JSON array: {exc}") from exc
    return record_operator_feedback(
        tool_id=args.tool_id,
        run_id=args.run_id,
        finding_id=args.finding_id,
        verdict=args.verdict,
        severity=args.severity,
        note=args.note,
        affected_belief_ids=affected_belief_ids,
        base_dir=args.tools_dir,
    )


def cmd_pr_record_opened(args: argparse.Namespace) -> dict[str, Any]:
    return record_pr_lifecycle(
        read_json(args.file),
        event="opened",
        base_dir=args.tools_dir,
        cycle_id=args.cycle_id,
    )


def cmd_pr_open(args: argparse.Namespace) -> dict[str, Any]:
    return open_pr_for_action(
        proposal_id=args.proposal_id,
        workspace_root=args.workspace_root,
        base_dir=args.tools_dir,
        dry_run=args.dry_run,
    )


def cmd_pr_merge_if_green(args: argparse.Namespace) -> dict[str, Any]:
    policy = read_json(args.policy_file) if args.policy_file else None
    if args.input:
        payload = read_json(args.input)
        active_policy = payload.get("policy", policy)
        if not args.dry_run:
            raise GovernanceError("--input snapshots can only be evaluated with --dry-run")
        return evaluate_auto_merge(
            pr=payload["pr"],
            github=payload.get("github", {}),
            policy=active_policy,
            base_dir=args.tools_dir,
            cycle_id=args.cycle_id,
            dry_run=True,
        )
    if args.pr_number is None:
        raise GovernanceError("--pr-number is required when --input is not provided")
    return merge_if_green(
        adapter=GhCliGitHubAdapter(cwd=args.workspace_root),
        pr_number=args.pr_number,
        policy=policy,
        base_dir=args.tools_dir,
        cycle_id=args.cycle_id,
        dry_run=args.dry_run,
    )


def cmd_db_snapshot(args: argparse.Namespace) -> dict[str, Any]:
    return write_schema_snapshot(
        service=args.service,
        output=args.output,
        database_url=args.database_url,
    )


def cmd_apply_plan_worktree(args: argparse.Namespace) -> dict[str, Any]:
    return plan_apply_worktree(
        proposal_id=args.proposal_id,
        workspace_root=args.workspace_root,
        base_dir=args.tools_dir,
        dry_run=not args.execute,
    )


def read_json(path: str) -> Any:
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _json_array_arg(value: str, flag: str) -> list[str]:
    try:
        payload = json.loads(value)
    except json.JSONDecodeError as exc:
        raise GovernanceError(f"{flag} must be a JSON array: {exc}") from exc
    if not isinstance(payload, list) or not all(isinstance(item, str) and item.strip() for item in payload):
        raise GovernanceError(f"{flag} must be a JSON array of non-empty strings")
    return payload
