"""ARIA adapter and skill health governance kernel."""

from .adapter_calibration import generate_adapter_calibration_report, list_adapter_calibration_reports
from .constants import OUTPUT_CONTRACT_COMPAT_FINDING_ID, OUTPUT_CONTRACT_COMPAT_REMOVAL_VERSION
from .apply_engine import gate_apply_action, plan_apply_worktree
from .agent_genesis import approve_agent_pr, draft_agent_from_gap, evaluate_genesis_sandbox, list_agent_drafts, prepare_agent_pr_lane
from .agent_priors import latest_agent_priors, map_agent_priors, related_agents_for_paths, reviewer_names
from .architecture import (
    draft_architecture_adr,
    generate_architecture_options,
    list_architecture_adr_drafts,
    list_architecture_evidence_packs,
    list_architecture_option_sets,
    list_architecture_reviews,
    record_architecture_evidence_pack,
    review_architecture_decision,
)
from .auto_merge import classify_changed_files, evaluate_auto_merge, merge_if_green, record_pr_lifecycle
from .budget import check_budget, list_budget_usage, record_budget_usage
from .calibration import list_calibration_recommendations, recommend_calibration
from .capability_gap import detect_capability_gaps, latest_capability_gaps, list_capability_gaps
from .ci import (
    evaluate_pr_ci_gate,
    inventory_workflows,
    list_agent_reviews,
    list_ci_failures,
    produce_ci_review,
    record_agent_review_result,
    record_ci_report,
    record_remediation_proposal,
    wait_pr_checks,
)
from .codegen import list_code_change_plans, list_generated_diff_packets, record_code_change_plan, record_generated_diff_packet
from .cycle import run_cycle
from .cycle_diff import run_cycle_diff
from .discovery import run_discovery
from .executor import (
    apply_executor_packet,
    executor_status,
    record_executor_packet,
    register_executor,
    retry_pr,
    review_executor_diff,
)
from .heartbeat import cycle_run_batch, heartbeat_status, heartbeat_tick
from .impact import list_impact_plans, plan_impact
from .impact_graph import list_impact_graphs, plan_downstream_impact
from .integrity import verify_integrity
from .llm_bridge import amplify_proposal
from .memory import unwithdraw_belief, update_memory, withdraw_belief
from .fitness import generate_fitness_report, generate_recommendation_candidate, list_fitness_reports
from .observability import generate_observability_dashboard, list_cycle_metrics, list_observability_dashboards, record_cycle_metrics
from .performance import (
    compare_performance_baseline,
    list_performance_baselines,
    list_performance_comparisons,
    record_performance_baseline,
)
from .plan_convergence import (
    abandon_plan,
    content_hash,
    evaluate_plan,
    fold_plan_state,
    plan_status,
    reap_stale_tasks,
    record_critique,
    record_revision,
    request_critics,
    start_plan,
)
from .pressure import run_pressure
from .proposal import approve_proposal, list_proposals, record_proposal
from .pr_manager import (
    commit_prepared_branch,
    list_pr_actions,
    list_pr_lifecycle_plans,
    list_pr_split_plans,
    open_pr_for_action,
    plan_pr_lifecycle,
    plan_pr_split,
    prepare_branch,
    push_prepared_branch,
)
from .pr_tracking import observe_pr_event, plan_incremental_cycle, plan_pr_impact
from .quarantine import quarantine_tool
from .reflection import run_reflection
from .research import fetch_research_source, list_research_fetches, list_research_policies, list_research_sources, record_research_policy, record_research_source
from .self_modification import list_kernel_change_requests, request_kernel_change
from .validation import compare_validation_groups, evaluate_validation_gate, list_validation_comparisons, list_validation_gates, list_validation_plans, list_validation_runs, run_validation_commands
from .fixture_runner import fixture_status_report, latest_fixture_status, refresh_fixture_suite, run_fixture_suite
from .feedback_store import generate_ai_consensus, generate_judgment_sample, list_judgment_samples, record_ai_feedback_file, record_operator_feedback_batch
from .goldset import list_goldset_proposals, propose_goldset
from .promotion import promote_tool
from .tool_health import can_emit_operator_facing, record_run
from .tool_registry import (
    GovernanceError,
    get_tool,
    list_tools,
    register_tool,
    transition_tool,
)
from .tool_runner import run_tool
from .task import explain_task, generate_task_candidates, latest_tasks

__all__ = [
    "GovernanceError",
    "amplify_proposal",
    "approve_agent_pr",
    "approve_proposal",
    "abandon_plan",
    "can_emit_operator_facing",
    "check_budget",
    "classify_changed_files",
    "commit_prepared_branch",
    "compare_performance_baseline",
    "compare_validation_groups",
    "content_hash",
    "cycle_run_batch",
    "detect_capability_gaps",
    "draft_architecture_adr",
    "draft_agent_from_gap",
    "evaluate_auto_merge",
    "evaluate_pr_ci_gate",
    "evaluate_plan",
    "evaluate_genesis_sandbox",
    "evaluate_validation_gate",
    "explain_task",
    "executor_status",
    "fetch_research_source",
    "fold_plan_state",
    "generate_architecture_options",
    "generate_adapter_calibration_report",
    "generate_fitness_report",
    "generate_ai_consensus",
    "generate_judgment_sample",
    "heartbeat_status",
    "heartbeat_tick",
    "fixture_status_report",
    "generate_observability_dashboard",
    "generate_recommendation_candidate",
    "generate_task_candidates",
    "get_tool",
    "gate_apply_action",
    "inventory_workflows",
    "latest_agent_priors",
    "latest_capability_gaps",
    "latest_tasks",
    "list_agent_drafts",
    "list_agent_reviews",
    "list_adapter_calibration_reports",
    "list_architecture_adr_drafts",
    "list_architecture_evidence_packs",
    "list_architecture_option_sets",
    "list_architecture_reviews",
    "list_budget_usage",
    "list_calibration_recommendations",
    "list_capability_gaps",
    "list_code_change_plans",
    "list_ci_failures",
    "list_cycle_metrics",
    "list_fitness_reports",
    "list_generated_diff_packets",
    "list_goldset_proposals",
    "list_judgment_samples",
    "list_impact_graphs",
    "list_impact_plans",
    "list_kernel_change_requests",
    "list_observability_dashboards",
    "list_performance_baselines",
    "list_performance_comparisons",
    "list_pr_lifecycle_plans",
    "list_pr_split_plans",
    "list_pr_actions",
    "list_tools",
    "list_proposals",
    "list_research_fetches",
    "list_research_policies",
    "list_research_sources",
    "list_validation_comparisons",
    "list_validation_gates",
    "list_validation_plans",
    "list_validation_runs",
    "open_pr_for_action",
    "OUTPUT_CONTRACT_COMPAT_FINDING_ID",
    "OUTPUT_CONTRACT_COMPAT_REMOVAL_VERSION",
    "observe_pr_event",
    "plan_pr_lifecycle",
    "plan_pr_split",
    "plan_pr_impact",
    "plan_status",
    "plan_apply_worktree",
    "plan_incremental_cycle",
    "plan_downstream_impact",
    "plan_impact",
    "prepare_agent_pr_lane",
    "prepare_branch",
    "produce_ci_review",
    "push_prepared_branch",
    "quarantine_tool",
    "map_agent_priors",
    "record_architecture_evidence_pack",
    "record_code_change_plan",
    "record_cycle_metrics",
    "record_agent_review_result",
    "record_ci_report",
    "record_executor_packet",
    "record_generated_diff_packet",
    "record_performance_baseline",
    "record_budget_usage",
    "record_critique",
    "record_run",
    "record_ai_feedback_file",
    "record_operator_feedback_batch",
    "record_proposal",
    "record_remediation_proposal",
    "record_pr_lifecycle",
    "record_research_policy",
    "record_research_source",
    "record_revision",
    "recommend_calibration",
    "register_tool",
    "register_executor",
    "related_agents_for_paths",
    "reap_stale_tasks",
    "request_kernel_change",
    "request_critics",
    "review_architecture_decision",
    "review_executor_diff",
    "reviewer_names",
    "retry_pr",
    "run_cycle",
    "run_cycle_diff",
    "run_discovery",
    "run_fixture_suite",
    "refresh_fixture_suite",
    "latest_fixture_status",
    "run_validation_commands",
    "merge_if_green",
    "run_pressure",
    "run_reflection",
    "run_tool",
    "start_plan",
    "promote_tool",
    "propose_goldset",
    "transition_tool",
    "unwithdraw_belief",
    "update_memory",
    "verify_integrity",
    "wait_pr_checks",
    "apply_executor_packet",
    "withdraw_belief",
]
