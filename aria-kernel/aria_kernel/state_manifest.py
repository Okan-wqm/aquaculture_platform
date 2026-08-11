"""Executable ARIA state/ledger surface manifest.

The manifest is the first implementation slice of the 2026-05-25 plan:
every ledger, runtime state file, index, and artifact surface that can
drive writes must be declared here before autonomous real mode can trust
it. Reducers can use this module to look up lock/index/strict-read
policy instead of duplicating path rules.
"""
from __future__ import annotations

from dataclasses import dataclass
from fnmatch import fnmatch
from pathlib import Path
from typing import Literal


RootKind = Literal["tools", "workspace", "repo"]
StateClass = Literal["ledger", "index", "runtime_state", "artifact", "lock"]
DurabilityPolicy = Literal["append_fsync", "rewrite_fsync", "ephemeral"]
ObserveClass = Literal["observation", "action", "mutation", "diagnostic"]


_PROFILE_SURFACE_BY_NAME: dict[str, str] = {
    "agent_invocation_requests": "agent_claim",
    "agent_invocation_claims": "agent_claim",
    "agent_invocation_results": "agent_claim",
    "agent_invocation_transcripts": "agent_claim",
    "agent_invocation_contexts": "agent_claim",
    "agent_invocation_prompts": "agent_claim",
    "agent_result_bridge_status": "agent_claim",
    "ack_ledger": "observation",
    "next_cycle_queue": "plan_promotion_dispatch",
    "worker_dispatch": "worker_result",
    "autonomous_host_local_lease": "local_cas_lease",
    "autonomous_host_remote_cas_lease": "remote_cas_lease",
    "agent_output_artifacts": "agent_claim",
    "runs": "tool_runs",
    "runs_by_cycle": "tool_runs",
    "health": "observation",
    "cycles": "observation",
    "tools_governance": "tool_governance",
    "tool_registry": "tool_registry",
    "runtime_profile_state": "tool_governance",
    "runtime_profile_history": "tool_governance",
    "raw_findings": "finding",
    "change_planned": "change_ledger_committed",
    "change_committed": "change_ledger_committed",
    "change_validated": "change_ledger_validated",
    "pr_actions": "pr_action",
    "pr_lifecycle": "pr_lifecycle",
    "pr_lifecycle_plans": "pr_lifecycle",
    "pr_split_plans": "pr_lifecycle",
    "pr_events": "pr_lifecycle",
    "merge_events": "pr_lifecycle",
    "auto_merge_decisions": "pr_lifecycle",
    "evidence_impact": "observation",
    "proposals": "observation",
    "impact_graphs": "observation",
    "impact_plans": "observation",
    "executor_registry": "observation",
    "executor_packets": "observation",
    "executor_diff_reviews": "observation",
    "executor_prompts": "observation",
    "executor_applications": "observation",
    "executor_locks": "observation",
    "executor_retries": "observation",
    "executor_operator_takeovers": "observation",
    "executor_flaky_fingerprints": "observation",
    "cycle_incremental_plans": "observation",
    "runtime_v2_promotions": "runtime_v2_promotion",
    "discovery_artifacts": "observation",
    "cycle_diffs": "observation",
    "memory_observations": "observation",
    "memory_beliefs": "observation",
    "memory_uncertainties": "observation",
    "memory_contradictions": "observation",
    "memory_calibration": "observation",
    "memory_learning_events": "observation",
    "goldset_proposals": "observation",
    "pressure_artifacts": "observation",
    "pressure_log": "observation",
    "triage_decisions": "observation",
    "apply_actions": "pr_action",
    "performance_baselines": "observation",
    "performance_comparisons": "observation",
    "fitness_reports": "observation",
    "fitness_recommendation_candidates": "observation",
    "fitness_agent": "observation",
    "heartbeat_ticks": "observation",
    "heartbeat_cycle_batches": "observation",
    "ci_workflow_inventory": "ci",
    "ci_workflow_runs": "ci",
    "ci_failures": "ci",
    "ci_reports": "ci",
    "ci_source": "ci",
    "ci_pr_gates": "ci",
    "ci_agent_review_tasks": "ci",
    "ci_agent_reviews": "ci",
    "ci_remediation_proposals": "ci",
    "report_ingestion_findings": "observation",
    "report_ingestion_cache_events": "observation",
    "reports_daily": "observation",
    "burn_in_reports": "observation",
    "plan_convergence_events": "observation",
    "mission_events": "observation",
    "mission_index": "observation",
    "agent_genesis_requests": "agent_genesis",
    "agent_genesis_drafts": "agent_genesis",
    "agent_genesis_pr_lanes": "agent_genesis",
    "agent_genesis_materializations": "agent_genesis",
    "agent_genesis_extension_decisions": "agent_genesis",
    "genesis_sandbox_runs": "agent_genesis",
    "skill_genesis_requests": "skill_genesis",
    "skill_genesis_drafts": "skill_genesis",
    "skill_genesis_sandbox": "skill_genesis",
    "skill_genesis_materializations": "skill_genesis",
    "genesis_lifecycle_events": "genesis_lifecycle",
    "operator_provenance": "genesis_lifecycle",
    "enterprise_readiness_claims": "pr_merge",
    "enterprise_remote_cas_proofs": "remote_cas_lease",
    "enterprise_waivers": "pr_merge",
    "enterprise_rollback_proofs": "pr_merge",
    "enterprise_branch_protection_proofs": "pr_merge",
    "enterprise_workflow_run_proofs": "pr_merge",
    "enterprise_artifact_proofs": "pr_merge",
    "enterprise_retention_proofs": "pr_merge",
    "enterprise_dlp_proofs": "pr_merge",
    "enterprise_token_proofs": "pr_merge",
    "enterprise_risk_decisions": "pr_merge",
    "enterprise_autonomy_unlock_events": "pr_merge",
    "enterprise_policy_approvals": "pr_merge",
    "enterprise_rollback_bundles": "pr_merge",
    "enterprise_rollback_simulations": "pr_merge",
    "enterprise_incidents": "pr_merge",
    "enterprise_acceptance_events": "pr_merge",
    "enterprise_runner_attestations": "pr_merge",
    "capability_resolution_decisions": "agent_genesis",
    "workspace_memory_unknowns": "observation",
    "workspace_memory_missed_signals": "observation",
    "workspace_memory_external_feedback": "observation",
    "workspace_memory_pressure": "observation",
    "workspace_memory_pressure_state": "observation",
    "workspace_memory_vocabulary_rejections": "observation",
    "workspace_memory_since_migration_events": "observation",
    "workspace_memory_governance": "tool_governance",
    "workspace_integrity_index": "observation",
    "workspace_ingested_findings_snapshot": "observation",
    "repo_finding_events": "finding",
    "repo_finding_docs": "finding",
    "repo_finding_index": "finding",
    "repo_debt_events": "debt",
    "repo_debt_docs": "debt",
    "repo_debt_index": "debt",
}


_OBSERVATION_PROFILE_SURFACES: frozenset[str] = frozenset({
    "context_audits",
    "debt",
    "finding",
    "handoffs",
    "instinct_candidates",
    "observation",
    "surface_validations",
    "tool_governance",
})


_OBSERVATION_NAMES: frozenset[str] = frozenset(
    name
    for name, profile_surface in _PROFILE_SURFACE_BY_NAME.items()
    if profile_surface in _OBSERVATION_PROFILE_SURFACES
    or profile_surface == "observation"
)


def _infer_profile_surface(name: str, lock_group: str) -> str:
    return _PROFILE_SURFACE_BY_NAME.get(name, lock_group)


def _infer_observe_class(name: str, profile_surface: str) -> ObserveClass:
    if profile_surface in _OBSERVATION_PROFILE_SURFACES or name in _OBSERVATION_NAMES:
        return "observation"
    if "diagnostic" in profile_surface or "diagnostic" in name:
        return "diagnostic"
    if profile_surface in {
        "agent_claim",
        "change_ledger_committed",
        "change_ledger_validated",
        "plan_promotion_dispatch",
        "pr_action",
        "pr_lifecycle",
        "pr_merge",
        "remote_cas_lease",
        "runtime_v2_promotion",
        "skill_genesis",
        "agent_genesis",
        "tool_runs",
        "worker_result",
        "worker_verification",
    }:
        return "action"
    return "mutation"


@dataclass(frozen=True)
class StateSurface:
    name: str
    path_pattern: str
    state_class: StateClass
    lock_group: str
    index_group: str | None
    strict_read: bool
    durability: DurabilityPolicy
    write_driving: bool
    root_kind: RootKind = "tools"
    profile_surface: str | None = None
    observe_class: ObserveClass | None = None
    enterprise_required: bool = True

    def __post_init__(self) -> None:
        profile_surface = self.profile_surface or _infer_profile_surface(
            self.name,
            self.lock_group,
        )
        observe_class = self.observe_class or _infer_observe_class(
            self.name,
            profile_surface,
        )
        object.__setattr__(self, "profile_surface", profile_surface)
        object.__setattr__(self, "observe_class", observe_class)


STATE_SURFACES: tuple[StateSurface, ...] = (
    StateSurface(
        name="agent_invocation_requests",
        path_pattern="agent-invocations/requests.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_invocation_claims",
        path_pattern="agent-invocations/claims.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_invocation_results",
        path_pattern="agent-invocations/results.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_invocation_transcripts",
        path_pattern="agent-invocations/transcripts.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_invocation_contexts",
        path_pattern="agent-invocations/contexts.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_invocation_prompts",
        path_pattern="agent-invocations/prompts.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_result_bridge_status",
        path_pattern="agent-invocations/agent-result-bridge-status.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="ack_ledger",
        path_pattern="acks/acks.jsonl",
        state_class="ledger",
        lock_group="acks",
        index_group=None,
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="next_cycle_queue",
        path_pattern="queues/next_cycle_queue.jsonl",
        state_class="ledger",
        lock_group="queue",
        index_group=None,
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="worker_dispatch",
        path_pattern="dispatch/*.jsonl",
        state_class="ledger",
        lock_group="dispatch",
        index_group=None,
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="autonomous_host_local_lease",
        path_pattern="locks/autonomous-host.lock",
        state_class="lock",
        lock_group="autonomous_host",
        index_group=None,
        strict_read=True,
        durability="rewrite_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="autonomous_host_remote_cas_lease",
        path_pattern="locks/autonomous-host.cas.json",
        state_class="lock",
        lock_group="autonomous_host",
        index_group=None,
        strict_read=True,
        durability="rewrite_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_output_artifacts",
        path_pattern="agent-invocations/outputs/*.json",
        state_class="artifact",
        lock_group="agent_invocations",
        index_group=None,
        strict_read=True,
        durability="rewrite_fsync",
        write_driving=False,
    ),
    StateSurface("runs", "runs.jsonl", "ledger", "runtime", "runtime", True, "append_fsync", True),
    StateSurface("runs_by_cycle", "runs/by-cycle/*.jsonl", "ledger", "runtime", "runtime", True, "append_fsync", True),
    StateSurface("health", "health.jsonl", "ledger", "runtime", "runtime", True, "append_fsync", True),
    StateSurface("cycles", "cycles.jsonl", "ledger", "runtime", "runtime", True, "append_fsync", True),
    StateSurface("tools_governance", "governance.jsonl", "ledger", "governance", "tools", True, "append_fsync", True),
    StateSurface("tool_registry", "registry.json", "index", "registry", "tools", True, "rewrite_fsync", True),
    # `repo_identity.json` is deliberately ABSENT from this list, and the
    # reason is worth stating where someone would next think to add it (PLAN
    # Wave 1 PR 2.6b nearly did). It is the file that makes a tools root
    # resolvable — `_has_valid_tools_identity` refuses the root without it, and
    # `state_store` commits exactly the paths this manifest names — so a
    # restored store genuinely cannot be read until it exists. But it records
    # `bound_repo_root`, an ABSOLUTE PATH on the host that wrote it, and the
    # state branch is shared by every runner. Declaring it would publish
    # machine-local state that means nothing on the next host and rewrites on
    # every one.
    #
    # It is DERIVED state, re-established per runner by
    # `tools_binding.bind_tools_root`, which the restore action runs
    # immediately after the checkout — one definition, rather than each lane
    # remembering to bind. See .github/actions/restore-aria-state.
    #
    # ORPHAN-HIGH-556 — but only the HOST half is derived, and treating the
    # whole file as host-local was the defect. `tools_contract.json` below
    # carries the part that is a property of the TREE and the REPOSITORY:
    # the contract version and the environment-independent canonical
    # identity. Publishing it is what lets a restored tree state what it
    # already is. Without it `tools_contract_version` read 0 on a healthy v3
    # tree, so the nightly bind ran a full v0→v2→v3 MIGRATION every night —
    # a whole-tree backup and a rewrite of every covered ledger, to
    # re-establish a binding.
    # `profile_surface` is DECLARED rather than inferred. The fallback is the
    # lock group, which would have minted a brand-new profile surface
    # ("registry") that no callsite ever names — a gate with no consumer,
    # which is ORPHAN-CRITICAL-498's shape. `tool_governance` is the gate
    # every writer of this file actually passes through.
    StateSurface(
        "tools_contract", "tools_contract.json", "index", "registry", "tools", True,
        "rewrite_fsync", True, profile_surface="tool_governance",
    ),
    StateSurface("runtime_profile_state", "runtime-profile.json", "runtime_state", "runtime_profile", "tools", True, "rewrite_fsync", True),
    StateSurface("runtime_profile_history", "runtime-profile-history.jsonl", "ledger", "runtime_profile", "tools", True, "append_fsync", True),
    StateSurface("raw_findings", "raw-findings.jsonl", "ledger", "runtime", "runtime", True, "append_fsync", True),
    StateSurface("change_planned", "change-ledger/planned.jsonl", "ledger", "change_ledger", "runtime", True, "append_fsync", True),
    StateSurface("change_committed", "change-ledger/committed.jsonl", "ledger", "change_ledger", "runtime", True, "append_fsync", True),
    StateSurface("change_validated", "change-ledger/validated.jsonl", "ledger", "change_ledger", "runtime", True, "append_fsync", True),
    StateSurface("pr_actions", "pr-actions.jsonl", "ledger", "pr_lifecycle", "runtime", True, "append_fsync", True),
    StateSurface("pr_lifecycle", "pr-lifecycle.jsonl", "ledger", "pr_lifecycle", "runtime", True, "append_fsync", True),
    StateSurface("pr_lifecycle_plans", "pr-lifecycle-plans.jsonl", "ledger", "pr_lifecycle", "runtime", True, "append_fsync", True),
    StateSurface("pr_split_plans", "pr-split-plans.jsonl", "ledger", "pr_lifecycle", "runtime", True, "append_fsync", True),
    StateSurface("pr_events", "pr-events.jsonl", "ledger", "pr_lifecycle", "runtime", True, "append_fsync", True),
    StateSurface("merge_events", "merge-events.jsonl", "ledger", "pr_lifecycle", "runtime", True, "append_fsync", True),
    StateSurface("auto_merge_decisions", "auto-merge-decisions.jsonl", "ledger", "pr_lifecycle", "runtime", True, "append_fsync", True),
    StateSurface("evidence_impact", "evidence-impact.jsonl", "ledger", "pr_lifecycle", "runtime", True, "append_fsync", True),
    StateSurface("proposals", "proposals/proposals.jsonl", "ledger", "planning", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="action"),
    StateSurface("cycle_incremental_plans", "cycle-state/incremental-plans.jsonl", "ledger", "planning", "runtime", True, "append_fsync", True),
    StateSurface("context_audits", "context-audits.jsonl", "ledger", "context_audits", "runtime", True, "append_fsync", True, profile_surface="context_audits", observe_class="observation"),
    StateSurface("handoffs", "handoffs.jsonl", "ledger", "handoffs", "runtime", True, "append_fsync", True, profile_surface="handoffs", observe_class="observation"),
    StateSurface("agent_evals", "agent-evals/runs.jsonl", "ledger", "agent_evals", "runtime", True, "append_fsync", True, profile_surface="agent_evals", observe_class="action"),
    StateSurface("agent_eval_fixtures", "agent-evals/fixtures.jsonl", "ledger", "agent_evals", "runtime", True, "append_fsync", True, profile_surface="agent_evals", observe_class="action"),
    StateSurface("agent_eval_fixture_files", "agent-evals/fixtures/*.json", "artifact", "agent_evals", "runtime", True, "rewrite_fsync", True, profile_surface="agent_evals", observe_class="action"),
    StateSurface("agent_eval_fixture_runs", "fixture-runs.jsonl", "ledger", "agent_evals", "runtime", True, "append_fsync", True, profile_surface="agent_evals", observe_class="action"),
    StateSurface("agent_compliance", "agent-compliance.jsonl", "ledger", "agent_compliance", "runtime", True, "append_fsync", True, profile_surface="agent_compliance", observe_class="action"),
    StateSurface("surface_validations", "surface-validations.jsonl", "ledger", "surface_validations", "runtime", True, "append_fsync", True, profile_surface="surface_validations", observe_class="observation"),
    StateSurface("instinct_candidates", "instinct-candidates.jsonl", "ledger", "instinct_candidates", "runtime", True, "append_fsync", True, profile_surface="instinct_candidates", observe_class="observation"),
    StateSurface("cost_telemetry", "cost-telemetry.jsonl", "ledger", "cost_telemetry", "runtime", True, "append_fsync", True, profile_surface="cost_telemetry", observe_class="mutation"),
    StateSurface("cost_attribution", "cost-attribution/*.jsonl", "ledger", "budget", "runtime", True, "append_fsync", True, profile_surface="cost_telemetry", observe_class="mutation"),
    StateSurface("validation_plans", "validation/validation-plans.jsonl", "ledger", "validation", "runtime", True, "append_fsync", True, profile_surface="validation_matrix", observe_class="mutation"),
    StateSurface("validation_runs", "validation/validation-runs.jsonl", "ledger", "validation", "runtime", True, "append_fsync", True, profile_surface="validation_matrix", observe_class="mutation"),
    StateSurface("validation_comparisons", "validation/validation-comparisons.jsonl", "ledger", "validation", "runtime", True, "append_fsync", True, profile_surface="validation_matrix", observe_class="mutation"),
    StateSurface("validation_gates", "validation/validation-gates.jsonl", "ledger", "validation", "runtime", True, "append_fsync", True, profile_surface="validation_matrix", observe_class="mutation"),
    StateSurface("critical_observations", "critical-observations/*.json", "artifact", "critical_observation", "runtime", True, "rewrite_fsync", True, profile_surface="critical_observation", observe_class="mutation"),
    StateSurface("human_required_requests", "human-required/*.json", "artifact", "human_required", "runtime", True, "rewrite_fsync", True, profile_surface="human_required", observe_class="mutation"),
    # ORPHAN-HIGH-426 — the panel's decision ledger. Declared so the
    # record that can CLEAR an escalation is covered by the same integrity
    # chain as the escalation itself; an adjudication ledger outside the
    # manifest would be a decision surface nothing verifies.
    StateSurface("human_required_adjudications", "human-required/adjudications.jsonl", "ledger", "human_required", "runtime", True, "append_fsync", True, profile_surface="human_required", observe_class="mutation"),
    StateSurface("dispatch_requests", "dispatch/requests.jsonl", "ledger", "dispatch", "runtime", True, "append_fsync", True, profile_surface="worker_result", observe_class="action"),
    StateSurface("dispatch_claims", "dispatch/claims.jsonl", "ledger", "dispatch", "runtime", True, "append_fsync", True, profile_surface="worker_result", observe_class="action"),
    StateSurface("dispatch_worker_results", "dispatch/worker-results.jsonl", "ledger", "dispatch", "runtime", True, "append_fsync", True, profile_surface="worker_result", observe_class="action"),
    StateSurface("dispatch_verification_results", "dispatch/verification-results.jsonl", "ledger", "dispatch", "runtime", True, "append_fsync", True, profile_surface="worker_verification", observe_class="action"),
    StateSurface("dispatch_artifacts", "dispatch/artifacts/**/*.json", "artifact", "dispatch", "runtime", True, "rewrite_fsync", True, profile_surface="worker_result", observe_class="action"),
    StateSurface("runtime_artifact_index", "run-artifacts/artifact-index.jsonl", "ledger", "runtime_artifacts", "runtime", True, "append_fsync", True),
    StateSurface("runtime_artifact_manifest", "run-artifacts/manifest.jsonl", "ledger", "runtime_artifacts", "runtime", True, "append_fsync", True),
    StateSurface("runtime_artifact_inventory", "observability/artifact-inventory.jsonl", "ledger", "runtime_artifacts", "runtime", True, "append_fsync", True),
    StateSurface("runtime_artifact_hot", "run-artifacts/hot/**/*.json", "artifact", "runtime_artifacts", "runtime", True, "rewrite_fsync", True),
    StateSurface("retention_events", "retention/events.jsonl", "ledger", "runtime_artifacts", "runtime", True, "append_fsync", True),
    StateSurface("runtime_v2_promotions", "runtime/v2-promotions.jsonl", "ledger", "runtime", "runtime", True, "append_fsync", True),
    StateSurface("autonomy_state", "autonomy_state.jsonl", "ledger", "autonomy", "runtime", True, "append_fsync", True),
    StateSurface("discovery_artifacts", "discovery/**/*.json", "artifact", "discovery", "runtime", True, "rewrite_fsync", True),
    StateSurface("cycle_diffs", "cycle-diffs.jsonl", "ledger", "discovery", "runtime", True, "append_fsync", True),
    StateSurface("memory_observations", "memory/observations.jsonl", "ledger", "memory", "runtime", True, "append_fsync", True),
    StateSurface("memory_beliefs", "memory/beliefs.jsonl", "ledger", "memory", "runtime", True, "append_fsync", True),
    StateSurface("memory_uncertainties", "memory/uncertainties.jsonl", "ledger", "memory", "runtime", True, "append_fsync", True),
    StateSurface("memory_contradictions", "memory/contradictions.jsonl", "ledger", "memory", "runtime", True, "append_fsync", True),
    StateSurface("memory_calibration", "memory/calibration.jsonl", "ledger", "memory", "runtime", True, "append_fsync", True),
    StateSurface("memory_learning_events", "memory/learning-events.jsonl", "ledger", "memory", "runtime", True, "append_fsync", True),
    StateSurface("goldset_proposals", "goldsets/proposals.jsonl", "ledger", "goldset", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="action"),
    StateSurface("pressure_artifacts", "pressure/*.json", "artifact", "pressure", "runtime", True, "rewrite_fsync", True),
    StateSurface("pressure_log", "pressure/pressure-log.jsonl", "ledger", "pressure", "runtime", True, "append_fsync", True),
    StateSurface("triage_decisions", "triage/decisions.jsonl", "ledger", "triage", "runtime", True, "append_fsync", True),
    StateSurface("impact_graphs", "impact/impact-graphs.jsonl", "ledger", "impact", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="observation"),
    StateSurface("impact_plans", "impact/impact-plans.jsonl", "ledger", "impact", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="observation"),
    # Wave 3 Twin-lite — the repository map (twin.py). DERIVED data: every
    # byte recomputable from the repo at indexed_sha, hence index-class and
    # write_driving=False; it informs reads, it never authorises an action.
    StateSurface("twin_map", "twin/map.json", "index", "impact", "runtime", True, "rewrite_fsync", False, profile_surface="observation", observe_class="observation"),
    StateSurface("executor_registry", "executor/registry.jsonl", "ledger", "executor", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="action"),
    StateSurface("executor_packets", "executor/packets.jsonl", "ledger", "executor", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="action"),
    StateSurface("executor_diff_reviews", "executor/diff-reviews.jsonl", "ledger", "executor", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="action"),
    StateSurface("executor_prompts", "executor/prompts.jsonl", "ledger", "executor", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="action"),
    StateSurface("executor_applications", "executor/applications.jsonl", "ledger", "executor", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="action"),
    StateSurface("executor_locks", "executor/locks.jsonl", "ledger", "executor", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="action"),
    StateSurface("executor_retries", "executor/retries.jsonl", "ledger", "executor", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="action"),
    StateSurface("executor_operator_takeovers", "executor/operator-takeovers.jsonl", "ledger", "executor", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="action"),
    StateSurface("executor_flaky_fingerprints", "executor/flaky-fingerprints.jsonl", "ledger", "executor", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="action"),
    StateSurface("apply_actions", "apply/actions.jsonl", "ledger", "apply", "runtime", True, "append_fsync", True, profile_surface="pr_action", observe_class="action"),
    StateSurface("performance_baselines", "performance/baselines.jsonl", "ledger", "performance", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="observation"),
    StateSurface("performance_comparisons", "performance/comparisons.jsonl", "ledger", "performance", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="observation"),
    StateSurface("fitness_reports", "fitness/fitness-reports.jsonl", "ledger", "fitness", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="observation"),
    StateSurface("fitness_recommendation_candidates", "fitness/recommendation-candidates.jsonl", "ledger", "fitness", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="observation"),
    StateSurface("fitness_agent", "fitness/agent-fitness.jsonl", "ledger", "fitness", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="observation"),
    StateSurface("heartbeat_ticks", "heartbeat/ticks.jsonl", "ledger", "heartbeat", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="observation"),
    StateSurface("heartbeat_cycle_batches", "heartbeat/cycle-batches.jsonl", "ledger", "heartbeat", "runtime", True, "append_fsync", True, profile_surface="observation", observe_class="observation"),
    StateSurface("ci_workflow_inventory", "ci/workflow-inventory.jsonl", "ledger", "ci", "runtime", True, "append_fsync", True, profile_surface="ci", observe_class="action"),
    StateSurface("ci_workflow_runs", "ci/workflow-runs.jsonl", "ledger", "ci", "runtime", True, "append_fsync", True, profile_surface="ci", observe_class="action"),
    StateSurface("ci_failures", "ci/failures.jsonl", "ledger", "ci", "runtime", True, "append_fsync", True, profile_surface="ci", observe_class="action"),
    StateSurface("ci_reports", "ci/ci-reports.jsonl", "ledger", "ci", "runtime", True, "append_fsync", True, profile_surface="ci", observe_class="action"),
    StateSurface("ci_source", "ci/source.jsonl", "ledger", "ci", "runtime", True, "append_fsync", True, profile_surface="ci", observe_class="action"),
    StateSurface("ci_pr_gates", "ci/pr-ci-gates.jsonl", "ledger", "ci", "runtime", True, "append_fsync", True, profile_surface="ci", observe_class="action"),
    # Own-PR CI feedback bridge (ORPHAN-HIGH-626): latest row per PR is the
    # red/cleared state the pressure producer reads back.
    StateSurface("own_pr_checks", "ci/own-pr-checks.jsonl", "ledger", "ci", "runtime", True, "append_fsync", True, profile_surface="ci", observe_class="action"),
    StateSurface("ci_agent_review_tasks", "ci/agent-review-tasks.jsonl", "ledger", "ci", "runtime", True, "append_fsync", True, profile_surface="ci", observe_class="action"),
    StateSurface("ci_agent_reviews", "ci/agent-reviews.jsonl", "ledger", "ci", "runtime", True, "append_fsync", True, profile_surface="ci", observe_class="action"),
    StateSurface("ci_remediation_proposals", "ci/remediation-proposals.jsonl", "ledger", "ci", "runtime", True, "append_fsync", True, profile_surface="ci", observe_class="action"),
    StateSurface("report_ingestion_findings", "report-ingestion/findings.jsonl", "ledger", "report_ingestion", "runtime", True, "append_fsync", True),
    StateSurface("report_ingestion_cache_events", "report-ingestion/cache-events.jsonl", "ledger", "report_ingestion", "runtime", True, "append_fsync", True),
    StateSurface("reports_daily", "reports/daily/*.md", "artifact", "reports", "runtime", True, "rewrite_fsync", True),
    StateSurface("burn_in_reports", "burn-in/**/*.json", "artifact", "autonomy", "runtime", True, "rewrite_fsync", True),
    StateSurface("plan_convergence_events", "plans/*.jsonl", "ledger", "planning", "runtime", True, "append_fsync", True),
    StateSurface("mission_events", "missions/mission-events.jsonl", "ledger", "missions", "runtime", True, "append_fsync", True),
    StateSurface("mission_index", "missions/mission-index.json", "index", "missions", "runtime", True, "rewrite_fsync", True),
    StateSurface("cost_budget", "budget/*.jsonl", "ledger", "budget", "runtime", True, "append_fsync", True),
    StateSurface("quarantine", "quarantine/*.jsonl", "ledger", "quarantine", "runtime", True, "append_fsync", True),
    StateSurface("agent_genesis_requests", "agent-genesis/requests.jsonl", "ledger", "genesis", "runtime", True, "append_fsync", True),
    StateSurface("agent_genesis_drafts", "agent-genesis/drafts.jsonl", "ledger", "genesis", "runtime", True, "append_fsync", True),
    StateSurface("agent_genesis_pr_lanes", "agent-genesis/pr-lanes.jsonl", "ledger", "genesis", "runtime", True, "append_fsync", True),
    StateSurface("agent_genesis_materializations", "agent-genesis/materializations.jsonl", "ledger", "genesis", "runtime", True, "append_fsync", True),
    StateSurface("agent_genesis_extension_decisions", "agent-genesis/extension-decisions.jsonl", "ledger", "genesis", "runtime", True, "append_fsync", True),
    StateSurface("agent_genesis_draft_intents", "agent-genesis/drafts/*.intent.json", "artifact", "genesis", "runtime", True, "rewrite_fsync", False, profile_surface="agent_genesis", observe_class="action"),
    StateSurface("genesis_sandbox_runs", "genesis-sandbox/runs.jsonl", "ledger", "genesis", "runtime", True, "append_fsync", True),
    StateSurface("skill_genesis_requests", "skill-genesis/requests.jsonl", "ledger", "genesis", "runtime", True, "append_fsync", True),
    StateSurface("skill_genesis_drafts", "skill-genesis/drafts.jsonl", "ledger", "genesis", "runtime", True, "append_fsync", True),
    StateSurface("skill_genesis_sandbox", "skill-genesis/sandbox.jsonl", "ledger", "genesis", "runtime", True, "append_fsync", True),
    StateSurface("skill_genesis_materializations", "skill-genesis/materializations.jsonl", "ledger", "genesis", "runtime", True, "append_fsync", True),
    StateSurface("genesis_lifecycle_events", "genesis-lifecycle/events.jsonl", "ledger", "genesis", "runtime", True, "append_fsync", True),
    StateSurface("operator_provenance", "operator-provenance/events.jsonl", "ledger", "genesis", "runtime", True, "append_fsync", True),
    StateSurface("enterprise_readiness_claims", "enterprise/readiness-claims.jsonl", "ledger", "readiness", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_remote_cas_proofs", "enterprise/remote-cas-proofs.jsonl", "ledger", "readiness", "runtime", True, "append_fsync", True, profile_surface="remote_cas_lease", observe_class="action"),
    StateSurface("enterprise_waivers", "enterprise/waivers.jsonl", "ledger", "readiness", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_rollback_proofs", "enterprise/rollback-proofs.jsonl", "ledger", "readiness", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_branch_protection_proofs", "enterprise/branch-protection-proofs.jsonl", "ledger", "readiness", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_workflow_run_proofs", "enterprise/workflow-run-proofs.jsonl", "ledger", "readiness", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_artifact_proofs", "enterprise/artifact-proofs.jsonl", "ledger", "readiness", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_retention_proofs", "enterprise/retention-proofs.jsonl", "ledger", "readiness", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_dlp_proofs", "enterprise/dlp-proofs.jsonl", "ledger", "readiness", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_token_proofs", "enterprise/token-proofs.jsonl", "ledger", "readiness", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_risk_decisions", "enterprise/risk-decisions.jsonl", "ledger", "enterprise_policy", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_autonomy_unlock_events", "enterprise/autonomy-unlock-events.jsonl", "ledger", "enterprise_policy", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_policy_approvals", "enterprise/policy-approvals.jsonl", "ledger", "enterprise_policy", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_rollback_bundles", "enterprise/rollback-bundles.jsonl", "ledger", "readiness", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_rollback_simulations", "enterprise/rollback-simulations.jsonl", "ledger", "readiness", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_incidents", "enterprise/incidents.jsonl", "ledger", "enterprise_policy", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_acceptance_events", "enterprise/acceptance-events.jsonl", "ledger", "enterprise_policy", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("enterprise_runner_attestations", "enterprise/runner-attestations.jsonl", "ledger", "readiness", "runtime", True, "append_fsync", True, profile_surface="pr_merge", observe_class="action"),
    StateSurface("capability_resolution_decisions", "capability-resolution/decisions.jsonl", "ledger", "genesis", "runtime", True, "append_fsync", True, profile_surface="agent_genesis", observe_class="action"),
    StateSurface("workspace_memory_unknowns", "aria-memory/unknowns.jsonl", "ledger", "memory", "workspace", True, "append_fsync", True, "workspace"),
    StateSurface("workspace_memory_missed_signals", "aria-memory/missed_signals.jsonl", "ledger", "memory", "workspace", True, "append_fsync", True, "workspace"),
    StateSurface("workspace_memory_external_feedback", "aria-memory/external_feedback.jsonl", "ledger", "memory", "workspace", True, "append_fsync", True, "workspace"),
    StateSurface("workspace_memory_pressure", "aria-memory/pressure.jsonl", "ledger", "pressure", "workspace", True, "append_fsync", True, "workspace"),
    StateSurface("workspace_memory_pressure_state", "aria-memory/pressure_state.jsonl", "ledger", "pressure", "workspace", True, "append_fsync", True, "workspace"),
    StateSurface("workspace_memory_vocabulary_rejections", "aria-memory/vocabulary_rejections.jsonl", "ledger", "memory", "workspace", True, "append_fsync", True, "workspace"),
    StateSurface("workspace_memory_since_migration_events", "aria-memory/since_migration_events.jsonl", "ledger", "memory", "workspace", True, "append_fsync", True, "workspace"),
    StateSurface("workspace_memory_governance", "aria-memory/governance.jsonl", "ledger", "governance", "workspace", True, "append_fsync", True, "workspace"),
    StateSurface("workspace_integrity_index", "aria-state/integrity_index.json", "index", "memory", "workspace", True, "rewrite_fsync", True, "workspace"),
    StateSurface("workspace_ingested_findings_snapshot", "aria-state/ingested_findings.json", "index", "report_ingestion", "workspace", True, "rewrite_fsync", False, "workspace"),
    StateSurface("repo_finding_events", "aria-findings/finding-events.jsonl", "ledger", "findings", "repo", True, "append_fsync", True, "repo"),
    StateSurface("repo_finding_docs", "aria-findings/F-*.json", "artifact", "findings", "repo", True, "rewrite_fsync", False, "repo"),
    StateSurface("repo_finding_index", "aria-findings/_index.json", "index", "findings", "repo", True, "rewrite_fsync", False, "repo"),
    StateSurface("repo_debt_events", "aria-debts/debt-events.jsonl", "ledger", "debts", "repo", True, "append_fsync", True, "repo"),
    StateSurface("repo_debt_docs", "aria-debts/DEBT-*.json", "artifact", "debts", "repo", True, "rewrite_fsync", False, "repo"),
    StateSurface("repo_debt_index", "aria-debts/_index.json", "index", "debts", "repo", True, "rewrite_fsync", False, "repo"),
)


def iter_surfaces() -> tuple[StateSurface, ...]:
    return STATE_SURFACES


def surface_key_name(key: str) -> str:
    """Manifest surface NAME behind a coverage/snapshot key.

    Glob surfaces fan out to one key per file, spelled ``name:relative/path``
    (the ``covered_tool_ledgers`` vocabulary, mirrored by the snapshot
    builder). Everything that receives such a key and needs the SURFACE — a
    declared-surface assertion, a manifest lookup — must strip the fan-out
    part here, in the module that owns the vocabulary. ORPHAN-HIGH-555 is
    what a private ``split(":")`` at one callsite and none at another looks
    like: the replay staged suffix files at ``f"{key}.jsonl"`` (a PATH once
    the key carries ``/``) and asserted ``expected_surface=<key>``, so every
    contention or recovery involving a glob ledger refused.
    """
    return key.split(":", 1)[0]


def surface_by_name(name: str) -> StateSurface:
    for surface in STATE_SURFACES:
        if surface.name == name:
            return surface
    raise KeyError(f"unknown ARIA state surface: {name}")


def surfaces_for_lock_group(lock_group: str) -> tuple[StateSurface, ...]:
    return tuple(surface for surface in STATE_SURFACES if surface.lock_group == lock_group)


def _surface_resolution_order() -> tuple[StateSurface, ...]:
    """Resolve exact path surfaces before wildcard surfaces."""
    ordered = sorted(
        enumerate(STATE_SURFACES),
        key=lambda item: (
            "*" in item[1].path_pattern,
            item[1].path_pattern.count("*"),
            item[0],
        ),
    )
    return tuple(surface for _idx, surface in ordered)


def surface_for_relative_path(relative_path: str | Path) -> StateSurface | None:
    rel = Path(relative_path).as_posix().lstrip("/")
    for surface in _surface_resolution_order():
        if fnmatch(rel, surface.path_pattern):
            return surface
    return None


def surface_for_path(path: str | Path) -> tuple[StateSurface, Path] | None:
    """Return ``(surface, base_dir)`` for a concrete path when declared.

    ``base_dir`` is the prefix before the manifest's relative pattern.
    Pattern surfaces (for example ``dispatch/*.jsonl``) return the path
    prefix before the wildcard's first concrete component.
    """
    concrete = Path(path).resolve()
    parts = concrete.parts
    for surface in _surface_resolution_order():
        pattern_parts = Path(surface.path_pattern).parts
        fixed_parts: list[str] = []
        for part in pattern_parts:
            if "*" in part:
                break
            fixed_parts.append(part)
        if not fixed_parts or len(parts) < len(fixed_parts):
            continue
        for idx in range(0, len(parts) - len(fixed_parts) + 1):
            if list(parts[idx:idx + len(fixed_parts)]) != fixed_parts:
                continue
            rel = Path(*parts[idx:]).as_posix()
            if fnmatch(rel, surface.path_pattern):
                base = Path(*parts[:idx]) if idx > 0 else Path(concrete.anchor)
                if not _base_matches_root_kind(surface.root_kind, base):
                    continue
                return surface, base
    return None


def _base_matches_root_kind(root_kind: RootKind, base: Path) -> bool:
    """Return whether a manifest match is rooted in the expected authority.

    Pattern matching alone is too weak for enterprise SSoT: an arbitrary
    ``/tmp/rogue/aria-tools/registry.json`` must not resolve as canonical
    state merely because its basename looks familiar. Tools roots are
    accepted only when they carry the repo identity binding created by
    ``ensure_tools_dir``. Workspace/repo roots stay fixture-friendly but must
    at least exist.
    """
    resolved = base.resolve()
    if root_kind == "tools":
        return _has_valid_tools_identity(resolved)
    if root_kind in {"workspace", "repo"}:
        return resolved.exists()
    return False


def _has_valid_tools_identity(root: Path) -> bool:
    identity_path = root / "repo_identity.json"
    if not identity_path.is_file():
        return False
    try:
        import json

        payload = json.loads(identity_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(payload, dict):
        return False
    return (
        payload.get("schema_version") in {1, 2, 3}
        and "aria_tools_contract_version" in payload
    )


def profile_surfaces(*, include_diagnostic: bool = False) -> frozenset[str]:
    surfaces: set[str] = set()
    for surface in STATE_SURFACES:
        if not surface.enterprise_required or not surface.profile_surface:
            continue
        if surface.observe_class == "diagnostic" and not include_diagnostic:
            continue
        surfaces.add(surface.profile_surface)
    return frozenset(surfaces)


def observe_permitted_profile_surfaces() -> frozenset[str]:
    return frozenset(
        surface.profile_surface
        for surface in STATE_SURFACES
        if (
            surface.enterprise_required
            and surface.profile_surface
            and surface.observe_class == "observation"
        )
    )


def observe_disallowed_tool_surfaces() -> tuple[StateSurface, ...]:
    return tuple(
        surface
        for surface in STATE_SURFACES
        if (
            surface.root_kind == "tools"
            and surface.write_driving
            and surface.enterprise_required
            and surface.observe_class != "observation"
        )
    )


def resolve_surface_path(base_dir: str | Path, surface: StateSurface) -> Path:
    if "*" in surface.path_pattern:
        raise ValueError(f"surface {surface.name} is a pattern, not a single path")
    return Path(base_dir) / surface.path_pattern


__all__ = [
    "STATE_SURFACES",
    "StateSurface",
    "RootKind",
    "ObserveClass",
    "iter_surfaces",
    "observe_disallowed_tool_surfaces",
    "observe_permitted_profile_surfaces",
    "profile_surfaces",
    "resolve_surface_path",
    "surface_by_name",
    "surface_for_path",
    "surface_key_name",
    "surface_for_relative_path",
    "surfaces_for_lock_group",
]
