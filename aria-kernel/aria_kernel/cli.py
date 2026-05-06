from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aria_kernel.cycle import run_cycle
from aria_kernel.agent_invocations import (
    create_agent_invocation_request,
    list_agent_invocation_requests,
    submit_agent_invocation_result,
)
from aria_kernel.agent_genesis import (
    draft_agent_from_gap,
    evaluate_genesis_sandbox,
    list_agent_drafts,
    list_agent_materializations,
    materialize_agent_draft,
)
from aria_kernel.agent_network import agent_network_index
from aria_kernel.capability_gap import detect_capability_gaps
from aria_kernel.discovery import run_discovery
from aria_kernel.feedback import add_feedback, build_feedback_event, import_feedback, list_feedback
from aria_kernel.integrity import verify_integrity
from aria_kernel.migration import (
    migrate_tools_v1_to_v2,
    migrate_workspace_v1_to_v2,
    rollback_tools_v2_to_v1,
    rollback_workspace_v2_to_v1,
)
from aria_kernel.memory import withdraw_belief
from aria_kernel.plan_convergence import (
    evaluate_plan,
    force_plan_human_required,
    plan_status,
    record_cross_review,
    record_revision,
    request_cross_review,
    request_cross_review_retry,
    start_plan,
    submit_challenger_plan,
)
from aria_kernel.pressure import curate_workspace_pressures, explain_pressure, explain_workspace_pressure, list_workspace_pressures
from aria_kernel.quarantine import quarantine_tool
from aria_kernel.report_ingestion import (
    import_finding_file,
    list_ingested_findings,
    report_ingestion_scan,
)
from aria_kernel.skill_genesis import (
    draft_skill,
    list_skill_genesis,
    materialize_skill,
    request_skill_genesis,
    sandbox_skill,
)
from aria_kernel.reverify import reverify_pressures
from aria_kernel.telemetry import export_telemetry
from aria_kernel.tool_registry import GovernanceError, list_tools, register_tool
from aria_kernel.tool_runner import run_tool
from aria_kernel.triage import (
    explain_triage,
    list_triage_decisions,
    triage_policy_apply,
)
from aria_kernel.verification_gate import submit_worker_result, verify_worker_result
from aria_kernel.worker_dispatch import (
    auto_batch_dispatch,
    cancel_dispatch_request,
    create_dispatch_request,
    list_dispatch_requests,
    mark_dispatch_picked_up,
    prune_worktrees,
)
from aria_kernel.workspace import ensure_workspace, require_workspace_v2, workspace_paths


ERROR_EXIT_CODES = {
    "tools_migration_required": 10,
    "ambiguous_tools_root": 11,
    "workspace_migration_required": 12,
    "binding_mismatch": 13,
    "repo_resolution_failed": 14,
}


def add_workspace_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace-root", default=".", help="Repository root to bind to ARIA workspace")
    parser.add_argument("--workspace-base", default=None, help="Override ~/.aria/workspaces for tests or sandboxes")


def add_tools_arg(parser: argparse.ArgumentParser, *, required: bool = False) -> None:
    kwargs: dict[str, object] = {"required": required, "help": "Override ARIA tools directory"}
    if not required:
        kwargs["default"] = argparse.SUPPRESS
    parser.add_argument("--tools-dir", **kwargs)


def resolve_paths(args: argparse.Namespace):
    paths = workspace_paths(
        Path(args.workspace_root),
        Path(args.workspace_base) if args.workspace_base else None,
    )
    ensure_workspace(paths)
    return paths


def _parse_days(value: str) -> int:
    raw = value.strip().lower()
    if raw.endswith("d"):
        raw = raw[:-1]
    days = int(raw)
    if days < 0:
        raise ValueError("days must be non-negative")
    return days


def main(argv: list[str] | None = None) -> int:
    try:
        return _main(argv)
    except (GovernanceError, RuntimeError) as exc:
        message = str(exc)
        if message in ERROR_EXIT_CODES:
            print(message, file=sys.stderr)
            return ERROR_EXIT_CODES[message]
        raise


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aria-kernel")
    parser.add_argument("--tools-dir", default=None, help="Override ARIA tools directory")
    sub = parser.add_subparsers(dest="command", required=True)

    cycle_parser = sub.add_parser("cycle")
    cycle_sub = cycle_parser.add_subparsers(dest="cycle_command")
    cycle_run = cycle_sub.add_parser("run")
    add_workspace_args(cycle_run)
    cycle_run.add_argument("--cycle-id", required=True)
    cycle_run.add_argument("--discovery-only", action="store_true")
    cycle_run.add_argument("--shadow-only", action="store_true")
    cycle_legacy = cycle_parser
    add_workspace_args(cycle_legacy)
    cycle_legacy.add_argument("--cycle-id", default=None)

    feedback_parser = sub.add_parser("feedback")
    feedback_sub = feedback_parser.add_subparsers(dest="feedback_command", required=True)

    add_parser = feedback_sub.add_parser("add")
    add_workspace_args(add_parser)
    add_parser.add_argument("--kind", required=True)
    add_parser.add_argument("--summary", required=True)
    add_parser.add_argument("--ref", required=True)
    add_parser.add_argument("--concept", required=True)
    add_parser.add_argument("--source", default="operator")
    add_parser.add_argument("--surface", default=None)
    add_parser.add_argument("--failure-mode", default=None)
    add_parser.add_argument("--parser-kind", default=None)
    add_parser.add_argument("--capability-gap-key", default=None)
    add_parser.add_argument("--cycle-id", default=None)
    add_parser.add_argument("--evidence-ref", action="append", default=[])
    add_parser.add_argument("--evidence-chain", action="append", default=[])

    import_parser = feedback_sub.add_parser("import")
    add_workspace_args(import_parser)
    import_parser.add_argument("--file", required=True)
    import_parser.add_argument("--cycle-id", default=None)

    list_parser = feedback_sub.add_parser("list")
    add_workspace_args(list_parser)
    list_parser.add_argument("--kind", default=None)

    migrate_parser = feedback_sub.add_parser("migrate-v1-to-v2")
    add_workspace_args(migrate_parser)
    migrate_parser.add_argument("--acknowledge", action="store_true")
    migrate_parser.add_argument("--reason", required=True)

    rollback_parser = feedback_sub.add_parser("rollback-v2-to-v1")
    add_workspace_args(rollback_parser)
    rollback_parser.add_argument("--from-backup", required=True)
    rollback_parser.add_argument("--acknowledge", action="store_true")
    rollback_parser.add_argument("--reason", required=True)
    rollback_parser.add_argument("--force-discard-since-migration", action="store_true")

    discovery_parser = sub.add_parser("discovery")
    discovery_sub = discovery_parser.add_subparsers(dest="discovery_command", required=True)
    discovery_run = discovery_sub.add_parser("run")
    add_workspace_args(discovery_run)
    add_tools_arg(discovery_run)
    discovery_run.add_argument("--cycle-id", required=True)
    discovery_run.add_argument("--snapshot-mode", default="committed", choices=["committed", "working_tree", "working-tree"])

    integrity_parser = sub.add_parser("integrity")
    integrity_sub = integrity_parser.add_subparsers(dest="integrity_command", required=True)
    verify_parser = integrity_sub.add_parser("verify")
    verify_parser.add_argument("--workspace-root", default=None)
    verify_parser.add_argument("--workspace-base", default=None)
    add_tools_arg(verify_parser)
    migrate_tools = integrity_sub.add_parser("migrate-tools-v1-to-v2")
    migrate_tools.add_argument("--tools-dir", required=True)
    migrate_tools.add_argument("--workspace-root", required=True)
    migrate_tools.add_argument("--acknowledge", action="store_true")
    migrate_tools.add_argument("--reason", required=True)
    rollback_tools = integrity_sub.add_parser("rollback-tools-v2-to-v1")
    rollback_tools.add_argument("--tools-dir", required=True)
    rollback_tools.add_argument("--from-backup", required=True)
    rollback_tools.add_argument("--acknowledge", action="store_true")
    rollback_tools.add_argument("--reason", required=True)
    rollback_tools.add_argument("--force-discard-since-migration", action="store_true")

    tool_parser = sub.add_parser("tool")
    tool_sub = tool_parser.add_subparsers(dest="tool_command", required=True)
    tool_register = tool_sub.add_parser("register")
    tool_register.add_argument("--file", required=True)
    tool_list = tool_sub.add_parser("list")
    tool_list.add_argument("--status", default=None)
    tool_quarantine = tool_sub.add_parser("quarantine")
    tool_quarantine.add_argument("--tool-id", required=True)
    tool_quarantine.add_argument("--reason", required=True)
    tool_run = tool_sub.add_parser("run")
    tool_run.add_argument("--tool-id", required=True)
    tool_run.add_argument("--input", default="{}")
    tool_run.add_argument("--cycle-id", required=True)
    tool_run.add_argument("--workspace-root", default=".")

    memory_parser = sub.add_parser("memory")
    memory_sub = memory_parser.add_subparsers(dest="memory_command", required=True)
    memory_withdraw = memory_sub.add_parser("withdraw")
    memory_withdraw.add_argument("--belief-id", required=True)
    memory_withdraw.add_argument("--reason", required=True)

    pressure_parser = sub.add_parser("pressure")
    pressure_sub = pressure_parser.add_subparsers(dest="pressure_command", required=True)
    pressure_list = pressure_sub.add_parser("list")
    add_workspace_args(pressure_list)
    pressure_list.add_argument("--age-buckets", action="store_true")
    pressure_list.add_argument("--json", action="store_true")
    pressure_list.add_argument("--include-faded", action="store_true")
    pressure_list.add_argument("--include-sleeping", action="store_true")
    pressure_list.add_argument("--include-archived", action="store_true")
    pressure_list.add_argument("--include-closed", action="store_true")
    pressure_list.add_argument("--include-satisfied", action="store_true")
    pressure_explain = pressure_sub.add_parser("explain")
    add_workspace_args(pressure_explain)
    pressure_explain.add_argument("pressure_event_id", nargs="?")
    pressure_explain.add_argument("--cycle-id", default=None)
    pressure_explain.add_argument("--pressure-id", default=None)
    pressure_reverify = pressure_sub.add_parser("reverify")
    add_workspace_args(pressure_reverify)
    pressure_reverify.add_argument("--sample-rate", type=float, default=0.10)
    pressure_reverify.add_argument("--dry-run", action="store_true")
    pressure_reverify.add_argument("--apply", action="store_true")
    pressure_reverify.add_argument("--acknowledge", action="store_true")
    pressure_reverify.add_argument("--reason", default=None)
    pressure_reverify.add_argument("--reset-cursor", action="store_true")

    telemetry_parser = sub.add_parser("telemetry")
    telemetry_sub = telemetry_parser.add_subparsers(dest="telemetry_command", required=True)
    telemetry_export = telemetry_sub.add_parser("export")
    add_workspace_args(telemetry_export)
    telemetry_export.add_argument("--format", choices=["prometheus", "otel"], required=True)
    telemetry_export.add_argument("--output", default=None)

    worker_parser = sub.add_parser("worker")
    worker_sub = worker_parser.add_subparsers(dest="worker_command", required=True)
    worker_dispatch = worker_sub.add_parser("dispatch")
    add_workspace_args(worker_dispatch)
    add_tools_arg(worker_dispatch)
    worker_dispatch.add_argument("--pressure-event-id", default=None)
    worker_dispatch.add_argument("--target-agent", default=None)
    worker_dispatch.add_argument("--prepare-worktree", action="store_true")
    worker_dispatch.add_argument("--acknowledge", action="store_true")
    worker_dispatch.add_argument("--auto-batch", action="store_true")
    worker_dispatch.add_argument("--limit", type=int, default=10)
    worker_list = worker_sub.add_parser("list")
    add_tools_arg(worker_list, required=True)
    worker_list.add_argument("--state", default=None)
    worker_list.add_argument("--target-agent", default=None)
    worker_list.add_argument("--pressure-event-id", default=None)
    worker_list.add_argument("--json", action="store_true")
    worker_mark = worker_sub.add_parser("mark-picked-up")
    add_tools_arg(worker_mark, required=True)
    worker_mark.add_argument("pressure_event_id")
    worker_mark.add_argument("--by", required=True)
    worker_cancel = worker_sub.add_parser("cancel")
    add_tools_arg(worker_cancel, required=True)
    worker_cancel.add_argument("pressure_event_id")
    worker_cancel.add_argument("--reason", required=True)

    worktree_prune_parser = sub.add_parser("worktree-prune")
    add_workspace_args(worktree_prune_parser)
    add_tools_arg(worktree_prune_parser, required=True)
    worktree_prune_parser.add_argument("--acknowledge", action="store_true")
    worktree_prune_parser.add_argument("--ttl-days", type=int, default=7)

    agent_report_parser = sub.add_parser("agent-report")
    agent_report_sub = agent_report_parser.add_subparsers(dest="agent_report_command", required=True)
    ar_scan = agent_report_sub.add_parser("scan-registry")
    add_workspace_args(ar_scan)
    add_tools_arg(ar_scan)
    ar_scan.add_argument("--cycle-id", required=True)
    ar_scan.add_argument("--backfill-open", action="store_true")
    ar_scan.add_argument("--limit", type=int, default=100)
    ar_scan.add_argument("--confirm-large-backfill", action="store_true")
    ar_scan.add_argument("--acknowledge", action="store_true")
    ar_import = agent_report_sub.add_parser("import")
    add_workspace_args(ar_import)
    ar_import.add_argument("--file", required=True)
    ar_import.add_argument("--cycle-id", default=None)
    ar_list = agent_report_sub.add_parser("list")
    add_workspace_args(ar_list)
    ar_list.add_argument("--json", action="store_true")

    triage_parser = sub.add_parser("triage")
    triage_sub = triage_parser.add_subparsers(dest="triage_command", required=True)
    triage_run = triage_sub.add_parser("run")
    add_workspace_args(triage_run)
    add_tools_arg(triage_run, required=True)
    triage_run.add_argument("--cycle-id", required=True)
    triage_list = triage_sub.add_parser("list")
    add_tools_arg(triage_list, required=True)
    triage_list.add_argument("--tier", default=None)
    triage_list.add_argument("--target-agent", default=None)
    triage_list.add_argument("--cycle-id", default=None)
    triage_list.add_argument("--json", action="store_true")
    triage_explain = triage_sub.add_parser("explain")
    add_tools_arg(triage_explain, required=True)
    triage_explain.add_argument("triage_id")

    agent_network_parser = sub.add_parser("agent-network")
    agent_network_sub = agent_network_parser.add_subparsers(dest="agent_network_command", required=True)
    agent_network_build = agent_network_sub.add_parser("index")
    add_workspace_args(agent_network_build)
    add_tools_arg(agent_network_build, required=True)
    agent_network_build.add_argument("--cycle-id", default=None)

    capability_gap_parser = sub.add_parser("capability-gap")
    capability_gap_sub = capability_gap_parser.add_subparsers(dest="capability_gap_command", required=True)
    capability_gap_detect = capability_gap_sub.add_parser("detect")
    add_workspace_args(capability_gap_detect)
    add_tools_arg(capability_gap_detect, required=True)
    capability_gap_detect.add_argument("--cycle-id", required=True)

    plan_parser = sub.add_parser("plan")
    plan_sub = plan_parser.add_subparsers(dest="plan_command", required=True)
    plan_start = plan_sub.add_parser("start")
    add_tools_arg(plan_start, required=True)
    plan_start.add_argument("--plan-id", required=True)
    plan_start.add_argument("--initial-revision-id", required=True)
    plan_start.add_argument("--plan-file", required=True)
    plan_challenger = plan_sub.add_parser("submit-challenger")
    add_tools_arg(plan_challenger, required=True)
    plan_challenger.add_argument("--plan-id", required=True)
    plan_challenger.add_argument("--challenger-file", required=True)
    plan_cross_request = plan_sub.add_parser("request-cross-review")
    add_tools_arg(plan_cross_request, required=True)
    plan_cross_request.add_argument("--plan-id", required=True)
    plan_cross_request.add_argument("--request-file", required=True)
    plan_cross_retry = plan_sub.add_parser("request-cross-review-retry")
    add_tools_arg(plan_cross_retry, required=True)
    plan_cross_retry.add_argument("--plan-id", required=True)
    plan_cross_retry.add_argument("--request-file", required=True)
    plan_cross_record = plan_sub.add_parser("record-cross-review")
    add_workspace_args(plan_cross_record)
    add_tools_arg(plan_cross_record, required=True)
    plan_cross_record.add_argument("--plan-id", required=True)
    plan_cross_record.add_argument("--review-file", required=True)
    plan_revision = plan_sub.add_parser("record-revision")
    add_tools_arg(plan_revision, required=True)
    plan_revision.add_argument("--plan-id", required=True)
    plan_revision.add_argument("--revision-file", required=True)
    plan_advance = plan_sub.add_parser("advance")
    add_tools_arg(plan_advance, required=True)
    plan_advance.add_argument("--plan-id", required=True)
    plan_advance.add_argument("--round-number", type=int, required=True)
    plan_advance.add_argument("--max-rounds", type=int, default=5)
    plan_promote = plan_sub.add_parser("promote-to-dispatch")
    add_workspace_args(plan_promote)
    add_tools_arg(plan_promote, required=True)
    plan_promote.add_argument("--plan-id", required=True)
    plan_promote.add_argument("--pressure-event-id", required=True)
    plan_promote.add_argument("--target-agent", default=None)
    plan_promote.add_argument("--prepare-worktree", action="store_true")
    plan_promote.add_argument("--acknowledge", action="store_true")
    plan_force = plan_sub.add_parser("force-human-required")
    add_tools_arg(plan_force, required=True)
    plan_force.add_argument("--plan-id", required=True)
    plan_force.add_argument("--round-number", type=int, required=True)
    plan_force.add_argument("--reason-code", action="append", required=True)
    plan_status_parser = plan_sub.add_parser("status")
    add_tools_arg(plan_status_parser, required=True)
    plan_status_parser.add_argument("--plan-id", required=True)

    inv_parser = sub.add_parser("agent-invocations")
    inv_sub = inv_parser.add_subparsers(dest="agent_invocation_command", required=True)
    inv_request = inv_sub.add_parser("request")
    add_tools_arg(inv_request, required=True)
    inv_request.add_argument("--target-agent", required=True)
    inv_request.add_argument("--role", required=True)
    inv_request.add_argument("--prompt-file", required=True)
    inv_request.add_argument("--convergence-id", default=None)
    inv_request.add_argument("--pressure-event-id", default=None)
    inv_request.add_argument("--round-number", type=int, default=None)
    inv_request.add_argument("--expected-output-path", default=None)
    inv_submit = inv_sub.add_parser("submit-result")
    add_tools_arg(inv_submit, required=True)
    inv_submit.add_argument("--request-id", required=True)
    inv_submit.add_argument("--output-path", required=True)
    inv_submit.add_argument("--status", choices=["completed", "rejected", "partial"], default="completed")
    inv_submit.add_argument("--by", default=None)
    inv_submit.add_argument("--rejection-reason", default=None)
    inv_list = inv_sub.add_parser("list")
    add_tools_arg(inv_list, required=True)
    inv_list.add_argument("--state", default=None)
    inv_list.add_argument("--convergence-id", default=None)
    inv_list.add_argument("--target-agent", default=None)
    inv_list.add_argument("--request-id", default=None)
    inv_list.add_argument("--role", default=None)

    agent_genesis_parser = sub.add_parser("agent-genesis")
    agent_genesis_sub = agent_genesis_parser.add_subparsers(dest="agent_genesis_command", required=True)
    ag_draft = agent_genesis_sub.add_parser("draft")
    add_tools_arg(ag_draft, required=True)
    ag_draft.add_argument("--gap-id", required=True)
    ag_sandbox = agent_genesis_sub.add_parser("sandbox")
    add_tools_arg(ag_sandbox, required=True)
    ag_sandbox.add_argument("--draft-id", required=True)
    ag_sandbox.add_argument("--fixture-results-file", required=True)
    ag_materialize = agent_genesis_sub.add_parser("materialize")
    add_workspace_args(ag_materialize)
    add_tools_arg(ag_materialize, required=True)
    ag_materialize.add_argument("--draft-id", required=True)
    ag_materialize.add_argument("--assignment-id", required=True)
    ag_materialize.add_argument("--acknowledge", action="store_true")
    ag_materialize.add_argument("--run-invariants", action="store_true")
    ag_list = agent_genesis_sub.add_parser("list")
    add_tools_arg(ag_list, required=True)
    ag_list.add_argument("--materializations", action="store_true")

    skill_genesis_parser = sub.add_parser("skill-genesis")
    skill_genesis_sub = skill_genesis_parser.add_subparsers(dest="skill_genesis_command", required=True)
    sg_request = skill_genesis_sub.add_parser("request")
    add_tools_arg(sg_request, required=True)
    sg_request.add_argument("--capability-gap-key", required=True)
    sg_request.add_argument("--title", required=True)
    sg_draft = skill_genesis_sub.add_parser("draft")
    add_tools_arg(sg_draft, required=True)
    sg_draft.add_argument("--request-id", required=True)
    sg_draft.add_argument("--name", required=True)
    sg_draft.add_argument("--description", required=True)
    sg_draft.add_argument("--owner", action="append", required=True)
    sg_draft.add_argument("--handoff-agent", action="append", required=True)
    sg_sandbox = skill_genesis_sub.add_parser("sandbox")
    add_tools_arg(sg_sandbox, required=True)
    sg_sandbox.add_argument("--draft-id", required=True)
    sg_sandbox_input = sg_sandbox.add_mutually_exclusive_group(required=True)
    sg_sandbox_input.add_argument("--markdown-file", default=None,
                                  help="Skill markdown source — parsed for ## Fixture: <id> blocks (preferred).")
    sg_sandbox_input.add_argument("--checklist-results-file", default=None,
                                  help="Explicit JSON checklist results array (deprecated; use --markdown-file).")
    sg_materialize = skill_genesis_sub.add_parser("materialize")
    add_workspace_args(sg_materialize)
    add_tools_arg(sg_materialize, required=True)
    sg_materialize.add_argument("--draft-id", required=True)
    sg_materialize.add_argument("--assignment-id", required=True)
    sg_materialize.add_argument("--acknowledge", action="store_true")
    sg_materialize.add_argument("--run-invariants", action="store_true")
    sg_list = skill_genesis_sub.add_parser("list")
    add_tools_arg(sg_list, required=True)
    sg_list.add_argument("--kind", choices=["requests", "drafts", "sandbox", "materializations"], default="drafts")

    worker_result = sub.add_parser("worker-result")
    worker_result_sub = worker_result.add_subparsers(dest="worker_result_command", required=True)
    worker_result_submit = worker_result_sub.add_parser("submit")
    add_tools_arg(worker_result_submit)
    worker_result_submit.add_argument("--assignment-id", default=None)
    worker_result_submit.add_argument("--from-worktree", required=True)
    worker_result_submit.add_argument("--validation-command", action="append", default=[])

    verification_parser = sub.add_parser("verification")
    verification_sub = verification_parser.add_subparsers(dest="verification_command", required=True)
    verification_verify = verification_sub.add_parser("verify")
    add_tools_arg(verification_verify)
    verification_verify.add_argument("--assignment-id", required=True)
    verification_verify.add_argument("--auto-merge-eligible", action="store_true")

    curate_parser = sub.add_parser("curate")
    add_workspace_args(curate_parser)
    curate_parser.add_argument("--since", default="90d")
    curate_parser.add_argument("--apply", action="store_true")
    curate_parser.add_argument("--acknowledge", action="store_true")
    curate_parser.add_argument("--reason", default=None)
    curate_parser.add_argument("--cycle-id", default=None)

    args = parser.parse_args(argv)
    legacy_pressure_explain = (
        args.command == "pressure"
        and args.pressure_command == "explain"
        and bool(args.cycle_id)
        and bool(args.pressure_id)
    )
    paths = (
        resolve_paths(args)
        if hasattr(args, "workspace_root")
        and args.command in {"feedback", "pressure", "curate", "telemetry", "worker", "agent-report", "triage", "worktree-prune", "agent-network", "capability-gap", "plan", "agent-genesis", "skill-genesis"}
        and not legacy_pressure_explain
        else None
    )

    if args.command == "cycle":
        if getattr(args, "cycle_command", None) == "run":
            print(
                json.dumps(
                    run_cycle(
                        workspace_root=args.workspace_root,
                        workspace_base=args.workspace_base,
                        cycle_id=args.cycle_id,
                        base_dir=args.tools_dir,
                        discovery_only=args.discovery_only,
                        shadow_only=args.shadow_only,
                    ),
                    indent=2,
                    sort_keys=True,
                ),
            )
        else:
            legacy_paths = resolve_paths(args)
            require_workspace_v2(legacy_paths)
            print(json.dumps(run_cycle(legacy_paths), indent=2, sort_keys=True))
        return 0

    if args.command == "feedback" and args.feedback_command == "add":
        require_workspace_v2(paths)
        event = build_feedback_event(args, cycle_id=args.cycle_id, paths=paths)
        emitted = add_feedback(paths, event)
        print(json.dumps({"event": event, "pressure_emitted": emitted}, indent=2, sort_keys=True))
        return 0

    if args.command == "feedback" and args.feedback_command == "import":
        require_workspace_v2(paths)
        count = import_feedback(paths, Path(args.file), cycle_id=args.cycle_id)
        print(json.dumps({"imported": count}, indent=2, sort_keys=True))
        return 0

    if args.command == "feedback" and args.feedback_command == "list":
        print(json.dumps(list_feedback(paths, args.kind), indent=2, sort_keys=True))
        return 0

    if args.command == "feedback" and args.feedback_command == "migrate-v1-to-v2":
        result = migrate_workspace_v1_to_v2(
            workspace_root=args.workspace_root,
            workspace_base=args.workspace_base,
            acknowledge=args.acknowledge,
            reason=args.reason,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "feedback" and args.feedback_command == "rollback-v2-to-v1":
        result = rollback_workspace_v2_to_v1(
            workspace_root=args.workspace_root,
            workspace_base=args.workspace_base,
            from_backup=args.from_backup,
            acknowledge=args.acknowledge,
            reason=args.reason,
            force_discard_since_migration=args.force_discard_since_migration,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "discovery" and args.discovery_command == "run":
        result = run_discovery(
            workspace_root=args.workspace_root,
            cycle_id=args.cycle_id,
            base_dir=args.tools_dir,
            snapshot_mode=args.snapshot_mode,
        )
        print(
            json.dumps(
                {key: value for key, value in result.items() if key not in {"fates", "snapshot"}},
                indent=2,
                sort_keys=True,
            ),
        )
        return 0

    if args.command == "integrity" and args.integrity_command == "verify":
        result = verify_integrity(
            workspace_root=args.workspace_root,
            workspace_base=args.workspace_base,
            tools_dir=args.tools_dir,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("status") == "ok" else 1

    if args.command == "integrity" and args.integrity_command == "migrate-tools-v1-to-v2":
        result = migrate_tools_v1_to_v2(
            tools_dir=args.tools_dir,
            workspace_root=args.workspace_root,
            acknowledge=args.acknowledge,
            reason=args.reason,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "tool" and args.tool_command == "register":
        payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
        print(json.dumps(register_tool(payload, base_dir=args.tools_dir), indent=2, sort_keys=True))
        return 0

    if args.command == "tool" and args.tool_command == "list":
        print(json.dumps(list_tools(status=args.status, base_dir=args.tools_dir), indent=2, sort_keys=True))
        return 0

    if args.command == "tool" and args.tool_command == "quarantine":
        print(json.dumps(quarantine_tool(args.tool_id, args.reason, base_dir=args.tools_dir), indent=2, sort_keys=True))
        return 0

    if args.command == "tool" and args.tool_command == "run":
        payload = json.loads(args.input)
        print(
            json.dumps(
                run_tool(args.tool_id, payload, args.cycle_id, workspace_root=args.workspace_root, base_dir=args.tools_dir),
                indent=2,
                sort_keys=True,
            ),
        )
        return 0

    if args.command == "memory" and args.memory_command == "withdraw":
        print(json.dumps(withdraw_belief(belief_id=args.belief_id, reason=args.reason, base_dir=args.tools_dir), indent=2, sort_keys=True))
        return 0

    if args.command == "pressure" and args.pressure_command == "explain":
        if args.cycle_id and args.pressure_id:
            print(json.dumps(explain_pressure(cycle_id=args.cycle_id, pressure_id=args.pressure_id, base_dir=args.tools_dir), indent=2, sort_keys=True))
            return 0
        pressure_event_id = args.pressure_event_id or args.pressure_id
        if not pressure_event_id:
            raise ValueError("pressure explain requires a pressure id")
        print(json.dumps(explain_workspace_pressure(paths, pressure_event_id), indent=2, sort_keys=True))
        return 0

    if args.command == "pressure" and args.pressure_command == "list":
        include_states = {"active"}
        if args.include_faded:
            include_states.add("faded")
        if args.include_sleeping:
            include_states.add("sleeping")
        if args.include_archived:
            include_states.add("archived")
        if args.include_closed:
            include_states.add("closed")
        if args.include_satisfied:
            include_states.add("satisfied")
        rows = list_workspace_pressures(paths, include_states=include_states)
        if args.age_buckets:
            buckets = {state: sum(1 for row in rows if row.get("effective_state") == state) for state in sorted(include_states)}
            payload = {"schema_version": 1, "count": len(rows), "age_buckets": buckets, "pressures": rows}
        else:
            payload = rows
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0

    if args.command == "pressure" and args.pressure_command == "reverify":
        result = reverify_pressures(
            paths,
            sample_rate=args.sample_rate,
            dry_run=args.dry_run or not args.apply,
            apply=args.apply,
            acknowledge=args.acknowledge,
            reason=args.reason,
            reset_cursor=args.reset_cursor,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "curate":
        result = curate_workspace_pressures(
            paths,
            since_days=_parse_days(args.since),
            apply=args.apply,
            acknowledge=args.acknowledge,
            reason=args.reason,
            cycle_id=args.cycle_id,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "telemetry" and args.telemetry_command == "export":
        payload = export_telemetry(paths, format=args.format, tools_root=args.tools_dir)
        if args.output:
            Path(args.output).write_text(payload, encoding="utf-8")
        else:
            print(payload, end="")
        return 0

    if args.command == "worker" and args.worker_command == "dispatch":
        if args.auto_batch:
            result = auto_batch_dispatch(
                paths,
                tools_root=args.tools_dir,
                limit=args.limit,
                prepare_worktree=args.prepare_worktree,
                acknowledge=args.acknowledge,
            )
        else:
            if not args.pressure_event_id:
                parser.error("worker dispatch requires --pressure-event-id or --auto-batch")
            result = create_dispatch_request(
                paths,
                pressure_event_id=args.pressure_event_id,
                tools_root=args.tools_dir,
                target_agent=args.target_agent,
                prepare_worktree=args.prepare_worktree,
                acknowledge=args.acknowledge,
            )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "worker" and args.worker_command == "list":
        rows = list_dispatch_requests(
            args.tools_dir,
            state=args.state,
            target_agent=args.target_agent,
            pressure_event_id=args.pressure_event_id,
        )
        print(json.dumps(rows, indent=2, sort_keys=True))
        return 0

    if args.command == "worker" and args.worker_command == "mark-picked-up":
        result = mark_dispatch_picked_up(
            args.tools_dir,
            pressure_event_id=args.pressure_event_id,
            actor=args.by,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("status") in {"marked"} else 1

    if args.command == "worker" and args.worker_command == "cancel":
        result = cancel_dispatch_request(
            args.tools_dir,
            pressure_event_id=args.pressure_event_id,
            reason=args.reason,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("status") in {"cancelled", "already_cancelled"} else 1

    if args.command == "worktree-prune":
        result = prune_worktrees(
            paths.repo_root if paths is not None else Path(args.workspace_root).resolve(),
            args.tools_dir,
            acknowledge=args.acknowledge,
            ttl_days=args.ttl_days,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("status") == "ok" else 1

    if args.command == "agent-report" and args.agent_report_command == "scan-registry":
        require_workspace_v2(paths)
        result = report_ingestion_scan(
            paths,
            cycle_id=args.cycle_id,
            tools_root=args.tools_dir,
            backfill_limit=args.limit,
            confirm_large_backfill=args.confirm_large_backfill,
            acknowledge=args.acknowledge,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "agent-report" and args.agent_report_command == "import":
        require_workspace_v2(paths)
        result = import_finding_file(paths, Path(args.file), cycle_id=args.cycle_id)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "agent-report" and args.agent_report_command == "list":
        result = list_ingested_findings(paths)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "triage" and args.triage_command == "run":
        require_workspace_v2(paths)
        result = triage_policy_apply(
            paths,
            cycle_id=args.cycle_id,
            tools_root=args.tools_dir,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "triage" and args.triage_command == "list":
        rows = list_triage_decisions(
            args.tools_dir,
            tier=args.tier,
            target_agent=args.target_agent,
            cycle_id=args.cycle_id,
        )
        print(json.dumps(rows, indent=2, sort_keys=True))
        return 0

    if args.command == "triage" and args.triage_command == "explain":
        result = explain_triage(args.tools_dir, args.triage_id)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("status") == "found" else 1

    if args.command == "agent-network" and args.agent_network_command == "index":
        result = agent_network_index(workspace_root=args.workspace_root, base_dir=args.tools_dir, cycle_id=args.cycle_id)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "capability-gap" and args.capability_gap_command == "detect":
        result = detect_capability_gaps(cycle_id=args.cycle_id, paths=paths, base_dir=args.tools_dir)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "plan":
        if args.plan_command == "start":
            payload = json.loads(Path(args.plan_file).read_text(encoding="utf-8"))
            result = start_plan(plan_id=args.plan_id, initial_revision_id=args.initial_revision_id, plan_content=payload, base_dir=args.tools_dir)
        elif args.plan_command == "submit-challenger":
            result = submit_challenger_plan(plan_id=args.plan_id, challenger=json.loads(Path(args.challenger_file).read_text(encoding="utf-8")), base_dir=args.tools_dir)
        elif args.plan_command == "request-cross-review":
            result = request_cross_review(plan_id=args.plan_id, request=json.loads(Path(args.request_file).read_text(encoding="utf-8")), base_dir=args.tools_dir)
        elif args.plan_command == "request-cross-review-retry":
            result = request_cross_review_retry(plan_id=args.plan_id, request=json.loads(Path(args.request_file).read_text(encoding="utf-8")), base_dir=args.tools_dir)
        elif args.plan_command == "record-cross-review":
            review_path = Path(args.review_file)
            review_bytes = review_path.read_bytes()
            review_payload = json.loads(review_bytes.decode("utf-8"))
            file_hash = "sha256:" + hashlib.sha256(review_bytes).hexdigest()
            explicit_hash = review_payload.get("review_content_hash")
            if explicit_hash and explicit_hash != file_hash:
                # Operator passed an explicit review_content_hash that disagrees
                # with the actual file bytes — refuse before record_cross_review
                # so the governance reject signal points to the source mismatch.
                raise GovernanceError(
                    f"review_file_content_hash_mismatch: explicit={explicit_hash} file_bytes={file_hash}"
                )
            review_payload["review_content_hash"] = file_hash
            result = record_cross_review(
                plan_id=args.plan_id,
                review=review_payload,
                workspace_root=args.workspace_root,
                base_dir=args.tools_dir,
            )
        elif args.plan_command == "record-revision":
            result = record_revision(plan_id=args.plan_id, revision=json.loads(Path(args.revision_file).read_text(encoding="utf-8")), base_dir=args.tools_dir)
        elif args.plan_command == "advance":
            result = evaluate_plan(plan_id=args.plan_id, round_number=args.round_number, max_rounds=args.max_rounds, base_dir=args.tools_dir)
        elif args.plan_command == "promote-to-dispatch":
            state = plan_status(plan_id=args.plan_id, base_dir=args.tools_dir)
            if state.get("state") != "CONVERGED":
                raise GovernanceError("plan must be CONVERGED before promote-to-dispatch")
            result = create_dispatch_request(
                paths,
                pressure_event_id=args.pressure_event_id,
                tools_root=args.tools_dir,
                target_agent=args.target_agent,
                prepare_worktree=args.prepare_worktree,
                acknowledge=args.acknowledge,
            )
        elif args.plan_command == "force-human-required":
            result = force_plan_human_required(plan_id=args.plan_id, round_number=args.round_number, reason_codes=args.reason_code, base_dir=args.tools_dir)
        elif args.plan_command == "status":
            result = plan_status(plan_id=args.plan_id, base_dir=args.tools_dir)
        else:
            parser.error("unknown plan command")
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("status") != "rejected" else 1

    if args.command == "agent-invocations":
        if args.agent_invocation_command == "request":
            result = create_agent_invocation_request(
                target_agent=args.target_agent,
                role=args.role,
                suggested_prompt=Path(args.prompt_file).read_text(encoding="utf-8"),
                convergence_id=args.convergence_id,
                pressure_event_id=args.pressure_event_id,
                round_number=args.round_number,
                expected_output_path=args.expected_output_path,
                base_dir=args.tools_dir,
            )
        elif args.agent_invocation_command == "submit-result":
            result = submit_agent_invocation_result(
                request_id=args.request_id,
                output_path=args.output_path,
                status=args.status,
                by=args.by,
                rejection_reason=args.rejection_reason,
                base_dir=args.tools_dir,
            )
        elif args.agent_invocation_command == "list":
            result = list_agent_invocation_requests(
                base_dir=args.tools_dir,
                state=args.state,
                convergence_id=args.convergence_id,
                target_agent=args.target_agent,
                request_id=args.request_id,
                role=args.role,
            )
        else:
            parser.error("unknown agent-invocations command")
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if not isinstance(result, dict) or result.get("status") != "rejected" else 1

    if args.command == "agent-genesis":
        if args.agent_genesis_command == "draft":
            result = draft_agent_from_gap(gap_id=args.gap_id, base_dir=args.tools_dir)
        elif args.agent_genesis_command == "sandbox":
            result = evaluate_genesis_sandbox(
                draft_id=args.draft_id,
                fixture_results=json.loads(Path(args.fixture_results_file).read_text(encoding="utf-8")),
                base_dir=args.tools_dir,
            )
        elif args.agent_genesis_command == "materialize":
            result = materialize_agent_draft(
                draft_id=args.draft_id,
                assignment_id=args.assignment_id,
                workspace_root=args.workspace_root,
                base_dir=args.tools_dir,
                acknowledge=args.acknowledge,
                run_invariants=args.run_invariants,
            )
        elif args.agent_genesis_command == "list":
            result = list_agent_materializations(base_dir=args.tools_dir) if args.materializations else list_agent_drafts(base_dir=args.tools_dir)
        else:
            parser.error("unknown agent-genesis command")
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if not isinstance(result, dict) or result.get("status") != "rejected" else 1

    if args.command == "skill-genesis":
        if args.skill_genesis_command == "request":
            result = request_skill_genesis(capability_gap_key=args.capability_gap_key, title=args.title, base_dir=args.tools_dir)
        elif args.skill_genesis_command == "draft":
            result = draft_skill(
                request_id=args.request_id,
                name=args.name,
                description=args.description,
                owners=args.owner,
                handoff_agents=args.handoff_agent,
                base_dir=args.tools_dir,
            )
        elif args.skill_genesis_command == "sandbox":
            if args.markdown_file is not None:
                result = sandbox_skill(
                    draft_id=args.draft_id,
                    markdown_path=args.markdown_file,
                    base_dir=args.tools_dir,
                )
            else:
                result = sandbox_skill(
                    draft_id=args.draft_id,
                    checklist_results=json.loads(Path(args.checklist_results_file).read_text(encoding="utf-8")),
                    base_dir=args.tools_dir,
                )
        elif args.skill_genesis_command == "materialize":
            result = materialize_skill(
                draft_id=args.draft_id,
                assignment_id=args.assignment_id,
                workspace_root=args.workspace_root,
                base_dir=args.tools_dir,
                acknowledge=args.acknowledge,
                run_invariants=args.run_invariants,
            )
        elif args.skill_genesis_command == "list":
            result = list_skill_genesis(base_dir=args.tools_dir, kind=args.kind)
        else:
            parser.error("unknown skill-genesis command")
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if not isinstance(result, dict) or result.get("status") != "rejected" else 1

    if args.command == "worker-result" and args.worker_result_command == "submit":
        result = submit_worker_result(
            from_worktree=args.from_worktree,
            assignment_id=args.assignment_id,
            validation_commands=args.validation_command,
            tools_root=args.tools_dir,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "verification" and args.verification_command == "verify":
        result = verify_worker_result(
            assignment_id=args.assignment_id,
            tools_root=args.tools_dir,
            auto_merge_eligible=args.auto_merge_eligible,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("status") == "passed" else 1

    if args.command == "integrity" and args.integrity_command == "rollback-tools-v2-to-v1":
        result = rollback_tools_v2_to_v1(
            tools_dir=args.tools_dir,
            from_backup=args.from_backup,
            acknowledge=args.acknowledge,
            reason=args.reason,
            force_discard_since_migration=args.force_discard_since_migration,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    parser.error("unreachable command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
