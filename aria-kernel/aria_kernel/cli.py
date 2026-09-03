from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _full_git_sha(value: str) -> str:
    if len(value) != 40 or any(character not in "0123456789abcdef" for character in value):
        raise argparse.ArgumentTypeError("target SHA must be 40 lowercase hexadecimal characters")
    return value

from aria_kernel.cycle import run_cycle
from aria_kernel.agent_invocations import (
    DEFAULT_HEARTBEAT_EXTEND_SECONDS,
    DEFAULT_LEASE_SECONDS,
    claim_request,
    create_agent_invocation_request,
    heartbeat_claim,
    list_agent_invocation_requests,
    next_pending_request,
    reap_stale_claims,
    release_claim,
    submit_claim_result,
)
from aria_kernel.agent_genesis import (
    approve_agent_pr,
    draft_agent_from_gap,
    evaluate_genesis_sandbox,
    list_agent_drafts,
    list_agent_materializations,
    materialize_agent_draft,
    prepare_agent_pr_lane,
)
from aria_kernel.agent_network import agent_network_index
from aria_kernel.burn_in import run_observe_burn_in
from aria_kernel.capability_gap import detect_capability_gaps
from aria_kernel.discovery import run_discovery
from aria_kernel.feedback import add_feedback, build_feedback_event, import_feedback, list_feedback
from aria_kernel.integrity import verify_integrity
from aria_kernel.tools_binding import bind_tools_root
from aria_kernel.migration import (
    migrate_tools_bootstrap,
    migrate_tools_v1_to_v2,
    migrate_tools_v2_to_v3,
    rollback_tools_v3_to_v2,
    migrate_workspace_v1_to_v2,
    rollback_tools_v2_to_v1,
    rollback_workspace_v2_to_v1,
)
from aria_kernel.memory import rebuild_fates, reset_memory, withdraw_belief
from aria_kernel.mission import (
    assert_cycle_closure,
    bind_mission,
    fold_mission,
    list_open_missions,
    open_mission,
    rebuild_mission_index,
    set_closure_contract,
    transition_mission,
)
from aria_kernel.plan_round_controller import advance_plan_rounds
from aria_kernel.promotion_controller import promote_converged_plan_to_dispatch
from aria_kernel.state_store import STATE_BRANCH
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
from aria_kernel.registry_compiler import compile_registry
from aria_kernel.skill_genesis import (
    approve_skill_pr,
    draft_skill,
    list_skill_genesis,
    materialize_skill,
    request_skill_genesis,
    sandbox_skill,
)
from aria_kernel.reverify import reverify_pressures
from aria_kernel.telemetry import export_telemetry
from aria_kernel.context_budget_gate import (
    audit_dispatch_context,
    enforce_context_budget,
    list_context_audits,
)
from aria_kernel.agent_compliance import (
    list_compliance_grades,
    record_compliance_grade,
)
from aria_kernel.validation_matrix_gate import (
    detect_risk_types_for_change,
    enforce_validation_matrix,
    list_required_tests,
)
from aria_kernel.agent_eval import (
    add_fixture as eval_add_fixture,
    aggregate_eval_metrics,
    list_eval_runs,
    list_fixtures as eval_list_fixtures_fn,
    run_agent_eval,
)
from aria_kernel.handoff_ledger import (
    list_handoffs,
    read_handoff,
    take_handoff_snapshot,
)
from aria_kernel.runtime_artifacts import (
    ARTIFACT_BEARING,
    SUMMARY_STDOUT_MAX_BYTES,
    approve_runtime_v2_promotion,
    autonomy_exit_code,
    autonomy_output_summary,
    classify_cycle_evidence,
    restore_artifact,
    retention_apply,
    retention_dry_run,
    rollback_retention,
    verify_artifacts,
    verify_runtime_artifacts,
)
from aria_kernel.runtime_profile import (
    PROFILES,
    get_profile,
    get_scheduler_profile_ceiling,
    list_profile_history,
    set_profile,
)
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
from aria_kernel.worktree import preflight as worktree_preflight


ERROR_EXIT_CODES = {
    "tools_migration_required": 10,
    "ambiguous_tools_root": 11,
    "workspace_migration_required": 12,
    "binding_mismatch": 13,
    "repo_resolution_failed": 14,
}


# Plan 024 v3 §B-7 — closed enum mapping run_tool envelope status to
# CLI exit code. Operator scripts pattern-match on exit code for
# failure detection; pre-fix the CLI returned 0 unconditionally even
# when the runner crashed / parsed invalid output / hit budget caps.
# The mapping shares vocabulary with spine_orchestrator's whitelist
# (H-6); a future status addition in tool_runner must update both.
_TOOL_RUN_EXIT_CODES: dict[str, int] = {
    "ok": 0,
    "crash": 1,
    "schema_error": 1,
    "output_unparseable": 1,
    "budget_exceeded": 2,
    "tool_unhealthy": 3,
    "environment_unavailable": 1,
}


def add_workspace_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace-root", default=".", help="Repository root to bind to ARIA workspace")
    parser.add_argument("--workspace-base", default=None, help="Override ~/.aria/workspaces for tests or sandboxes")


# Plan 024 v3 followup F (ORPHAN-MEDIUM-058) — single architectural
# point for --tools-dir across every subcommand at every nesting
# level. The parents=[_TOOLS_DIR_PARENT] mechanism makes a future
# subcommand author STRUCTURALLY UNABLE to register a parser
# without --tools-dir; the add_subparser factory funnels every
# add_parser call through the parent. The invariant test
# test_cli_tools_dir_no_raw_add_parser pins this barrier.
_TOOLS_DIR_PARENT = argparse.ArgumentParser(add_help=False)
_TOOLS_DIR_PARENT.add_argument(
    "--tools-dir",
    default=argparse.SUPPRESS,
    help="Override ARIA tools directory (also accepts ARIA_TOOLS_DIR env var).",
)


def add_subparser(
    sub_action: argparse._SubParsersAction,
    name: str,
    **kwargs: Any,
) -> argparse.ArgumentParser:
    """Plan 024 §F — single funnel for every subparser registration.

    Forces parents=[_TOOLS_DIR_PARENT] so --tools-dir is available on
    every subcommand at every nesting level (operator can type the
    flag BEFORE the subcommand, AFTER it, or at any nesting in
    between). A future author CANNOT register a subcommand by any
    path that omits the flag — there is no second registration
    mechanism. Enforced by tests/test_cli_tools_dir_invariant.py.
    """
    parents = list(kwargs.pop("parents", []))
    if _TOOLS_DIR_PARENT not in parents:
        parents.append(_TOOLS_DIR_PARENT)
    return sub_action.add_parser(name, parents=parents, **kwargs)


# Plan 024 §F — post-parse table of commands that genuinely require an
# operator-supplied --tools-dir (no env-var or default fallback). Both
# entries are destructive integrity migrations where the operator MUST
# name the directory explicitly. All other 168 subparsers accept the
# flag but treat it as optional (env-var fallback or downstream None).
_TOOLS_DIR_REQUIRED_COMMANDS: frozenset[tuple[str, ...]] = frozenset({
    ("autonomy", "burn-in", "observe"),
    ("autonomy", "burn-in", "accept"),
    ("autonomy", "unlock", "status"),
    ("policy-approval", "record"),
    ("policy-approval", "verify"),
    ("integrity", "migrate-tools-v1-to-v2"),
    ("integrity", "rollback-tools-v2-to-v1"),
    # Plan ARIA-V3.3 §2a — bootstrap-class commands MUST name the
    # target tools dir explicitly because no walk-up can succeed
    # before bootstrap has ever run. The CLI rejects a bare
    # ``migrate-tools-bootstrap`` invocation BEFORE
    # tool_registry.tools_dir is consulted, so operators get a clear
    # ``--tools-dir is required`` error instead of the downstream
    # ``tools_root_unresolvable`` GovernanceError.
    ("integrity", "migrate-tools-bootstrap"),
    ("integrity", "bind-tools-root"),
    ("integrity", "migrate-tools-v2-to-v3"),
    ("integrity", "rollback-tools-v3-to-v2"),
    ("runtime", "promotion", "approve-v2"),
    ("runtime", "retention", "apply"),
    ("runtime", "restore-artifact"),
    ("runtime", "rollback-retention"),
})


def _command_path(args: argparse.Namespace) -> tuple[str, ...]:
    """Build the (command, sub_command, ...) tuple for table lookup.

    Walks the known sub-command attribute names (one per top-level
    command). New nesting hierarchies append their dest attribute
    here so the required-validation table can reach them.
    """
    path: list[str] = [args.command]
    for attr in (
        "integrity_command",
        "feedback_command",
        "discovery_command",
        "tool_command",
        "validation_matrix_command",
        "agent_compliance_command",
        "agent_eval_command",
        "handoff_command",
        "context_command",
        "profile_command",
        "runtime_command",
        "runtime_promotion_command",
        "runtime_retention_command",
        "memory_command",
        "pressure_command",
        "telemetry_command",
        "worker_command",
        "scheduler_command",
        "planner_dispatch_command",
        "worker_dispatch_command",
        "worktree_command",
        "ack_command",
        "report_command",
        "agent_report_command",
        "triage_command",
        "agent_network_command",
        "capability_gap_command",
        "plan_command",
        "agent_invocation_command",
        "agent_command",
        "budget_command",
        "adapter_portfolio_command",
        "review_command",
        "architecture_command",
        "research_command",
        "critical_observation_command",
        "convergent_plan_command",
        "impact_command",
        "apply_command",
        "pr_command",
        "spine_command",
        "change_command",
        "metrics_command",
        "cycle_guard_command",
        "human_required_command",
        "consensus_command",
        "agent_genesis_command",
        "skill_genesis_command",
        "autonomy_command",
        "burn_in_command",
        "unlock_command",
        "policy_approval_command",
        "worker_result_command",
        "verification_command",
        "cycle_command",
        "readiness_command",
    ):
        sub = getattr(args, attr, None)
        if sub:
            path.append(sub)
    return tuple(path)


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


# Plan ARIA-V2 §Phase 1 AUDITTRAIL-HIGH-005a + Rec C — every
# operator-supplied ``--reason`` is now validated for:
#   * non-whitespace length >= 10 chars (rejects "" / "   " / "short")
#   * absence of PII tokens (email / phone / SSN-shaped strings)
# Applied as an argparse ``type=`` validator so failures fire at parse
# time with ArgumentTypeError, producing a clean CLI exit and an
# auditable error message rather than reaching the audit row.
_REASON_MIN_NON_WHITESPACE_CHARS = 10
import re as _aria_re
_REASON_PII_PATTERNS = (
    # email
    _aria_re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
    # north-american phone (xxx-xxx-xxxx, (xxx) xxx-xxxx, xxx.xxx.xxxx)
    _aria_re.compile(r"\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}"),
    # SSN (xxx-xx-xxxx)
    _aria_re.compile(r"\d{3}-\d{2}-\d{4}"),
)


def _validate_reason(text: str) -> str:
    """Plan ARIA-V2 AUDITTRAIL-HIGH-005a — ``--reason`` content validator.

    Used as ``argparse.add_argument(..., type=_validate_reason)`` so the
    CLI rejects empty / whitespace-only / too-short reasons + reasons
    containing common PII shapes (email / phone / SSN). Returns the
    stripped text so the downstream handler receives a clean string.

    Rationale: audit rows carry ``reason`` as a free-text justification.
    Without this validator, ``--reason ""`` and ``--reason " "`` are
    accepted as legal CLI input but reduce the audit row's
    ``justification`` field to mandatory-shape compliance theater.
    Mirroring ``libs/backend-common/src/audit/audited-operation.decorator.ts``
    discipline at the kernel CLI surface.
    """
    stripped = (text or "").strip()
    non_whitespace = "".join(stripped.split())
    if len(non_whitespace) < _REASON_MIN_NON_WHITESPACE_CHARS:
        raise argparse.ArgumentTypeError(
            f"--reason must contain at least {_REASON_MIN_NON_WHITESPACE_CHARS} "
            f"non-whitespace characters (got {len(non_whitespace)!r}). "
            "Audit rows require operator justification — empty or trivial "
            "reasons reduce the audit trail to shape-only compliance."
        )
    for pattern in _REASON_PII_PATTERNS:
        if pattern.search(stripped):
            raise argparse.ArgumentTypeError(
                "--reason must not contain PII tokens (email / phone / SSN). "
                "Audit rows are operator-private but operator-only-visibility "
                "is data-minimization-preserving; PII in justification text "
                "expands the disclosure surface unnecessarily."
            )
    return stripped


def _handle_state_command(args: argparse.Namespace) -> int:
    """Wave 1 §2.2 — operator entry to the state-snapshot primitives.

    Imported lazily so the CLI's import cost does not grow for every
    other subcommand, matching how the heavier integrity surfaces are
    already wired.
    """
    from .ledger import canonical_json
    from .state_snapshot import (
        build_snapshot,
        sign_snapshot,
        snapshot_continuity,
        verify_snapshot_signature,
    )
    from .tool_registry import tools_dir

    if args.state_command == "acknowledge-surface-reset":
        from .memory_gap import record_surface_reset

        row = record_surface_reset(
            surface=args.surface,
            archived_sha256=args.archived_sha256,
            reason=args.reason,
            operator_approval_ref=args.operator_approval_ref,
            base_dir=args.tools_dir,
        )
        print(json.dumps(row, indent=2, sort_keys=True))
        return 0

    if args.state_command == "snapshot":
        roots: dict[str, Path] = {"tools": tools_dir(args.tools_dir)}
        if args.workspace_base:
            roots["workspace"] = Path(args.workspace_base)
        if args.repo_root:
            roots["repo"] = Path(args.repo_root)
        previous = None
        if args.previous:
            previous = json.loads(Path(args.previous).read_text(encoding="utf-8"))
        manifest = build_snapshot(
            snapshot_id=args.snapshot_id,
            cycle_id=args.cycle_id,
            # Derived from the entry point, never from an argument.
            lane="operator",
            roots=roots,
            parent_commit=args.parent_commit,
            previous=previous,
        )
        result: dict[str, Any] = {
            "snapshot_id": manifest["snapshot_id"],
            "manifest_root": manifest["manifest_root"],
            "surface_count": len(manifest["surfaces"]),
            "artifact_only_count": len(manifest["artifact_only_surfaces"]),
            "continuity": snapshot_continuity(manifest, previous),
        }
        if args.sign_with and not args.out_dir:
            raise GovernanceError("state_snapshot_sign_requires_out_dir")
        if args.out_dir:
            out_dir = Path(args.out_dir)
            if args.sign_with:
                private = Path(args.sign_with)
                signed = sign_snapshot(
                    manifest,
                    out_dir=out_dir,
                    private_key_path=private,
                    public_key_path=private.with_suffix(".pub"),
                    signer_fingerprint=args.cycle_id,
                )
                result["signed"] = True
                result["signature_path"] = signed.signature_path.as_posix()
                result["manifest_path"] = signed.manifest_path.as_posix()
            else:
                out_dir.mkdir(parents=True, exist_ok=True)
                path = out_dir / "snapshot.json"
                path.write_text(canonical_json(manifest) + "\n", encoding="utf-8")
                result["signed"] = False
                result["manifest_path"] = path.as_posix()
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["continuity"]["status"] in {"ok", "genesis"} else 1

    if args.state_command in {"checkout", "publish", "verify-store"}:
        return _handle_state_store_command(args)

    report = verify_snapshot_signature(
        manifest_path=Path(args.snapshot),
        signature_path=Path(args.signature),
        public_key_path=Path(args.public_key),
        trust_store=Path(args.trust_store),
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["valid"] else 1


def _handle_state_store_command(args: argparse.Namespace) -> int:
    """Wave 1 §2.3 — operator entry to the ``aria/state`` store.

    Both the store's lanes and this command reach the branch through
    ``state_store.publish_state``, so the ancestry proof that closes
    ORPHAN-CRITICAL-484/513 is not something a caller can be written
    without: there is no second way in for it to be missing from.
    """
    from .workspace import canonical_identity
    from .state_store import (
        StateStoreRefusal,
        _read_commit_ref,
        build_publishable_snapshot,
        checkout_state_store,
        findings_root,
        open_state_store,
        publish_state,
        store_environment,
        read_published_snapshot,
        read_snapshot_at_worktree_head,
        tools_root,
        verify_state_store,
        workspace_root,
    )

    # ORPHAN-HIGH-798 compact half — shrink bloated ledgers in-place.
    if getattr(args, "state_command", None) == "compact":
        from .state_compact import compact_state
        result = compact_state(
            base_dir=getattr(args, "tools_dir", None) or os.environ.get("ARIA_TOOLS_DIR"),
            retain_days=getattr(args, "retain_days", 7),
            dry_run=getattr(args, "dry_run", False),
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    # Every refusal in this command is a VERDICT, not a crash — an
    # unacknowledged bootstrap and an unproven ancestry both mean "the
    # state does not permit this write". Reported as structured output on
    # exit code 3 so a lane can distinguish it from a transport failure
    # (exit 1) and decline to retry a refusal into a success.
    repo_hash = args.repo_hash or canonical_identity(Path(args.repo_root))

    try:
        if args.state_command == "checkout":
            # Establishes the store at the remote tip. Refuses over
            # uncommitted writes, which is why it is a SEPARATE command
            # from publish rather than publish's first step.
            store = checkout_state_store(
                args.repo_root,
                branch=args.branch,
                remote=args.remote,
                store_dir=args.store_dir,
            )
            published = read_published_snapshot(store)
            print(json.dumps({
                "store_root": store.root.as_posix(),
                "branch": store.branch,
                "bootstrapped": store.bootstrapped,
                "published_snapshot_id": (published or {}).get("snapshot_id"),
                "published_manifest_root": (published or {}).get("manifest_root"),
                "tools_root": tools_root(store).as_posix(),
                "workspace_root": workspace_root(store, repo_hash).as_posix(),
                "repo_hash": repo_hash,
                "findings_root": findings_root(store).as_posix(),
                # The binding a lane must adopt, emitted so the workflow
                # reads it rather than restating the path convention —
                # a second copy of that convention is how two roots drift.
                "environment": store_environment(store, repo_hash),
            }, indent=2, sort_keys=True))
            return 0

        store = open_state_store(
            args.repo_root,
            branch=args.branch,
            remote=args.remote,
            store_dir=args.store_dir,
        )

        if args.state_command == "verify-store":
            verdict = verify_state_store(store, repo_hash=repo_hash)
            print(json.dumps(verdict, indent=2, sort_keys=True))
            return 0 if verdict["valid"] else 1

        base_head = _read_commit_ref(store.root, "HEAD")
        if base_head is None:
            raise StateStoreRefusal(
                "state_publish_base_head_unavailable: operator publish HEAD is "
                "not an exact commit"
            )
        base = read_snapshot_at_worktree_head(
            store,
            expected_head=base_head,
        )
        snapshot = build_publishable_snapshot(
            store,
            snapshot_id=args.snapshot_id,
            cycle_id=args.cycle_id,
            # Derived from the entry point, never from an argument — the
            # same rule the snapshot command follows (Plan ARIA-V3 §2c).
            lane="operator",
            repo_hash=repo_hash,
            parent_commit=args.parent_commit,
            previous=base,
        )
        result = publish_state(
            store,
            snapshot=snapshot,
            cycle_id=args.cycle_id,
            repo_hash=repo_hash,
            expected_base_head=base_head,
        )
    except StateStoreRefusal as exc:
        print(json.dumps({"published": False, "refusal": str(exc)}, indent=2, sort_keys=True))
        return 3
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def _record_launch_failure(argv: list[str] | None) -> None:
    """ORPHAN-HIGH-780 — an argv the CLI rejects kills the night BEFORE any
    cycle row exists, so the death never enters the burn-in denominator:
    the ledger gap between cyc-20260819T022108Z and cyc-20260821T024646Z
    is two ORPHAN-754 nights that consumed calendar time as if they never
    happened. Recording the launch failure in the bound store makes every
    stop a recorded stop — the mission's own rule.

    Tools root comes from the ARIA_TOOLS_DIR lane binding, not from argv:
    when argparse refuses the argv there is no parsed --tools-dir to read,
    and the walk-up default would bind to whatever tree is on the ancestor
    chain. Unbound (operator shell) stays unrecorded — there is no store
    to be honest to.

    Best-effort BY DESIGN: the recorder must not become a second failure
    mode on a night that is already dying. A refusal (e.g. the frozen
    profile's no-write containment) or an unwritable store is printed to
    stderr and swallowed; governance events are observation-class, so
    observe and standard nights — the lanes that feed burn-in — record.
    """
    tools_dir = os.environ.get("ARIA_TOOLS_DIR")
    if not tools_dir:
        return
    try:
        from .tool_registry import append_tools_governance

        append_tools_governance(
            tools_dir,
            "cycle_launch_failed",
            {
                "argv": list(argv) if argv is not None else sys.argv[1:],
                "exit_code": 2,
                "recorded_via": "cli.main",
            },
        )
    except Exception as exc:  # noqa: BLE001 — post-mortem telemetry, see docstring
        print(f"cycle_launch_failed could not be recorded: {exc}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    try:
        return _main(argv)
    except SystemExit as exc:
        # argparse exits 2 on a usage error — a caller/callee disagreement
        # that killed the night before the kernel could record anything.
        if exc.code == 2:
            _record_launch_failure(argv)
        raise
    except (GovernanceError, RuntimeError) as exc:
        message = str(exc)
        if message in ERROR_EXIT_CODES:
            print(message, file=sys.stderr)
            return ERROR_EXIT_CODES[message]
        raise


def build_parser() -> argparse.ArgumentParser:
    """Construct the full CLI parser without executing anything.

    Extracted from _main so callers can verify an argv against the real
    contract. tests/test_workflow_kernel_cli_contract.py uses it to prove
    every `python3 -m aria_kernel ...` line in .github/workflows/ parses;
    the lane cutover shipped `state publish` without --snapshot-id and
    nothing could catch it while the parser was unreachable.
    """
    parser = argparse.ArgumentParser(prog="aria-kernel", parents=[_TOOLS_DIR_PARENT])
    sub = parser.add_subparsers(dest="command", required=True)

    cycle_parser = add_subparser(sub, "cycle")
    cycle_sub = cycle_parser.add_subparsers(dest="cycle_command")
    cycle_run = add_subparser(cycle_sub, "run")
    add_workspace_args(cycle_run)
    cycle_run.add_argument("--cycle-id", required=True)
    cycle_run.add_argument("--discovery-only", action="store_true")
    cycle_run.add_argument("--shadow-only", action="store_true")
    cycle_run.add_argument(
        "--progress",
        action="store_true",
        help="Stream live per-phase progress to stderr as the cycle runs "
        "(stdout still carries only the final JSON). Equivalent to "
        "ARIA_CYCLE_PROGRESS=1.",
    )
    cycle_legacy = cycle_parser
    add_workspace_args(cycle_legacy)
    cycle_legacy.add_argument("--cycle-id", default=None)

    feedback_parser = add_subparser(sub, "feedback")
    feedback_sub = feedback_parser.add_subparsers(dest="feedback_command", required=True)

    # The verbs the kernel has been PRINTING into every judgment sample's
    # operator instructions since Plan 016 — and never implemented. The
    # sample said `aria-kernel feedback record …`; the parser knew only
    # add/import/list/migrate. The documented label channel was a phantom,
    # and judge calibration's human ground truth stayed empty partly for it.
    fb_record = add_subparser(feedback_sub, "record")
    fb_record.add_argument("--tool-id", required=True)
    fb_record.add_argument("--run-id", required=True)
    fb_record.add_argument("--finding-id", required=True)
    fb_record.add_argument("--verdict", required=True, choices=["true_positive", "false_positive"])
    fb_record.add_argument("--severity", default="medium", choices=["low", "medium", "high", "critical"])
    fb_record.add_argument("--note", required=True)
    fb_record.add_argument("--finding-fingerprint", default=None)
    fb_batch = add_subparser(feedback_sub, "record-batch")
    fb_batch.add_argument("--sample-id", required=True)
    fb_batch.add_argument("--file", required=True)

    add_parser = add_subparser(feedback_sub, "add")
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

    import_parser = add_subparser(feedback_sub, "import")
    add_workspace_args(import_parser)
    import_parser.add_argument("--file", required=True)
    import_parser.add_argument("--cycle-id", default=None)

    list_parser = add_subparser(feedback_sub, "list")
    add_workspace_args(list_parser)
    list_parser.add_argument("--kind", default=None)

    migrate_parser = add_subparser(feedback_sub, "migrate-v1-to-v2")
    add_workspace_args(migrate_parser)
    migrate_parser.add_argument("--acknowledge", action="store_true")
    migrate_parser.add_argument("--reason", required=True, type=_validate_reason)

    rollback_parser = add_subparser(feedback_sub, "rollback-v2-to-v1")
    add_workspace_args(rollback_parser)
    rollback_parser.add_argument("--from-backup", required=True)
    rollback_parser.add_argument("--acknowledge", action="store_true")
    rollback_parser.add_argument("--reason", required=True, type=_validate_reason)
    rollback_parser.add_argument("--force-discard-since-migration", action="store_true")

    discovery_parser = add_subparser(sub, "discovery")
    discovery_sub = discovery_parser.add_subparsers(dest="discovery_command", required=True)
    discovery_run = add_subparser(discovery_sub, "run")
    add_workspace_args(discovery_run)
    discovery_run.add_argument("--cycle-id", required=True)
    discovery_run.add_argument("--snapshot-mode", default="committed", choices=["committed", "working_tree", "working-tree"])

    # Wave 1 §2.2 — state snapshots: the tree-level continuity root.
    # Under `integrity` rather than a new top-level command because a
    # snapshot IS an integrity artefact; the operator verb set stays one
    # tree instead of two that each know half the story.
    state_parser = add_subparser(sub, "state")
    state_sub = state_parser.add_subparsers(dest="state_command", required=True)
    state_compact = add_subparser(
        state_sub, "compact",
        help="Shrink bloated state ledgers (runs, raw-findings, beliefs, learning-events).",
    )
    state_compact.add_argument("--retain-days", type=int, default=7,
                               help="Keep rows newer than this many days (default 7).")
    state_compact.add_argument("--dry-run", action="store_true",
                               help="Report what would be compacted without writing.")
    state_snapshot = add_subparser(
        state_sub, "snapshot",
        help="Build (and optionally sign) a state snapshot manifest.",
    )
    state_snapshot.add_argument("--snapshot-id", required=True)
    state_snapshot.add_argument("--cycle-id", required=True)
    # No --lane flag: Plan ARIA-V3 §2c locks the lane as kernel-derived,
    # and this entry point IS the operator lane — a caller-supplied value
    # would let an operator label their own run as a scheduled one.
    state_snapshot.add_argument("--workspace-base", default=None,
                                help="Workspace root holding aria-memory/ + aria-state/.")
    state_snapshot.add_argument("--repo-root", default=None,
                                help="Repo root holding aria-findings/ + aria-debts/.")
    state_snapshot.add_argument("--out-dir", default=None,
                                help="Write snapshot.json here; omit to print only.")
    state_snapshot.add_argument("--previous", default=None,
                                help="Path to the predecessor snapshot.json (chains the manifest).")
    state_snapshot.add_argument("--sign-with", default=None,
                                help="Private key path; requires --out-dir. Refuses if ssh-keygen is absent.")
    state_snapshot.add_argument("--parent-commit", default=None)
    state_verify = add_subparser(
        state_sub, "verify-snapshot",
        help="Verify a snapshot's signature AND that its manifest_root still matches.",
    )
    state_verify.add_argument("--snapshot", required=True)
    state_verify.add_argument("--signature", required=True)
    state_verify.add_argument("--public-key", required=True)
    state_verify.add_argument(
        "--trust-store", required=True,
        help="Operator-pinned allowlist (identity keytype blob lines). The key "
             "carried by the snapshot is a claim, not trust.",
    )
    # Plan 032 Faz 032a — a write-driving ledger that restarts from empty
    # (the 2026-08-31 plan-ledger loss) is a governance event with the
    # archived surface's hash and an operator approval, never a silent gap.
    state_reset_ack = add_subparser(
        state_sub, "acknowledge-surface-reset",
        help="Record that a write-driving ledger restarts from empty: archived "
             "surface hash + operator approval, on the governance ledger.",
    )
    state_reset_ack.add_argument("--surface", required=True,
                                 help="Manifest surface name (e.g. plan_convergence_events).")
    state_reset_ack.add_argument("--archived-sha256", required=True,
                                 help="sha256 of the surface as last published (git blob or file hash).")
    state_reset_ack.add_argument("--reason", required=True)
    state_reset_ack.add_argument("--operator-approval-ref", required=True,
                                 help="gov:<event_id> | review:<path>#<id> | ack-env:<VAR>")

    # Wave 1 §2.3 — the aria/state store. `publish` refuses unless the
    # snapshot it builds names the published tip as its parent; there is
    # no flag to skip that, because a skippable ancestry proof is what
    # ORPHAN-CRITICAL-484/513 already cost once.
    for name, helptext in (
        ("checkout", "Materialise the state branch as a worktree at the remote tip."),
        ("publish", "Build a snapshot from the state store and fast-forward-publish it."),
        ("verify-store", "Re-derive the store's surfaces and compare against its snapshot."),
    ):
        store_parser = add_subparser(state_sub, name, help=helptext)
        store_parser.add_argument("--repo-root", required=True)
        # Derived from the repository by default. An operator computing
        # this by hand can compute it WRONG, and a wrong value silently
        # writes workspace state into a sibling subtree that no later
        # snapshot mentions — loss that looks exactly like a clean run.
        store_parser.add_argument("--repo-hash", default=None,
                                  help="Workspace subtree key; defaults to the repo's canonical identity.")
        store_parser.add_argument("--branch", default=STATE_BRANCH)
        store_parser.add_argument("--remote", default="origin")
        store_parser.add_argument("--store-dir", default=None,
                                  help="Store worktree path; defaults to <repo-root>/.aria-state-store.")
        if name == "publish":
            store_parser.add_argument("--snapshot-id", required=True)
            store_parser.add_argument("--cycle-id", required=True)
            store_parser.add_argument("--parent-commit", default=None)
            # No --no-push. A "rehearsal" that commits without pushing
            # manufactures the exact state the re-checkout guard exists to
            # refuse — a local commit the remote does not have — and it had
            # no caller. Publishing is one indivisible act here.

    # Wave 3 Twin-lite — the repository map (twin.py). `context` is the
    # operator/agent consumer: a compact slice read INSTEAD of a repo walk.
    twin_parser = add_subparser(sub, "twin")
    twin_sub = twin_parser.add_subparsers(dest="twin_command", required=True)
    for name, helptext in (
        ("build", "Full build of the twin map at HEAD."),
        ("refresh", "Incremental refresh since the map's indexed_sha."),
        ("status", "Freshness + layer stats for the stored map."),
        ("context", "Compact context slice for --files, read from the map."),
    ):
        twin_cmd = add_subparser(twin_sub, name, help=helptext)
        twin_cmd.add_argument("--workspace-root", default=".")
        if name in ("build", "refresh"):
            twin_cmd.add_argument("--nx-graph-file", default=None)
        if name == "context":
            twin_cmd.add_argument("--files", nargs="+", required=True)

    integrity_parser = add_subparser(sub, "integrity")
    integrity_sub = integrity_parser.add_subparsers(dest="integrity_command", required=True)
    verify_parser = add_subparser(integrity_sub, "verify")
    verify_parser.add_argument("--workspace-root", default=None)
    verify_parser.add_argument("--workspace-base", default=None)
    migrate_tools = add_subparser(integrity_sub, "migrate-tools-v1-to-v2")
    migrate_tools.add_argument("--workspace-root", required=True)
    migrate_tools.add_argument("--acknowledge", action="store_true")
    migrate_tools.add_argument("--reason", required=True, type=_validate_reason)
    rollback_tools = add_subparser(integrity_sub, "rollback-tools-v2-to-v1")
    rollback_tools.add_argument("--from-backup", required=True)
    rollback_tools.add_argument("--acknowledge", action="store_true")
    rollback_tools.add_argument("--reason", required=True, type=_validate_reason)
    rollback_tools.add_argument("--force-discard-since-migration", action="store_true")

    # Plan ARIA-V2 §3.8 — v2→v3 migration + idempotent umbrella bootstrap
    # + reverse rollback. ``migrate-tools-bootstrap`` is the recommended
    # operator entry point — it detects current contract version and
    # chains the necessary steps to reach v3.
    migrate_tools_v3 = add_subparser(integrity_sub, "migrate-tools-v2-to-v3")
    migrate_tools_v3.add_argument("--workspace-root", required=True)
    migrate_tools_v3.add_argument("--acknowledge", action="store_true")
    migrate_tools_v3.add_argument("--reason", required=True, type=_validate_reason)
    migrate_tools_boot = add_subparser(integrity_sub, "migrate-tools-bootstrap")
    migrate_tools_boot.add_argument("--workspace-root", required=True)
    migrate_tools_boot.add_argument("--acknowledge", action="store_true")
    migrate_tools_boot.add_argument("--reason", required=True, type=_validate_reason)
    # ORPHAN-HIGH-556 — binding a restored tree is NOT a migration, and the
    # restore lane now says which one it wants. No `--acknowledge`: this runs
    # unattended every night, and a flag nobody is present to set is not an
    # acknowledgement. The delegated migration still requires one.
    bind_tools = add_subparser(integrity_sub, "bind-tools-root")
    bind_tools.add_argument("--workspace-root", required=True)
    bind_tools.add_argument("--reason", required=True, type=_validate_reason)
    rollback_tools_v3 = add_subparser(integrity_sub, "rollback-tools-v3-to-v2")
    rollback_tools_v3.add_argument("--acknowledge", action="store_true")
    rollback_tools_v3.add_argument("--reason", required=True, type=_validate_reason)

    # ORPHAN-CRITICAL-420 S4 — the failure circuit breaker's operator surface.
    #
    # circuit_breaker.py has defined evaluate_breaker/current_state/reset_breaker
    # since Plan ARIA-V3 §B2, and `grep -n breaker cli.py` returned NOTHING: no
    # status, no reset, no command group at all. The breaker's own ledger lives
    # under aria-tools/, which .gitignore excludes, so a tripped breaker could
    # only be cleared by hand-deleting an untracked artifact on whichever runner
    # happened to write it.
    #
    # That is why this lands WITH the producer and not after it. Wiring a
    # producer first would convert a transient failure into an unrecoverable
    # halt — trading a fail-open breaker for a fail-closed one nobody can reopen,
    # which is not an improvement.
    #
    # `reset` deliberately mirrors the migration commands' operator contract
    # (--acknowledge + --reason, validated by _validate_reason) because it is the
    # same class of action: a human overriding a governance stop. The underlying
    # reset_breaker() truncates the 24h window, so the reason string is the only
    # durable record of why the window was discarded.
    # ORPHAN-HIGH-466 — the B0 cost breaker's operator surface, the exact
    # counterpart to `breaker` below. cost_budget.reset_breaker has existed
    # since Plan ARIA-V3 §B0 with no CLI, so a tripped cost breaker had the
    # same unrecoverable shape the failure breaker had before ORPHAN-HIGH-465:
    # clearable only by hand-editing a gitignored artifact. It lands with the
    # counter fix rather than after it, for the same reason.
    # Named `cost-breaker`, not `budget`: `budget` is already the Plan 016
    # D6 check/record/list group for a different ledger. Parallel to the
    # `breaker` group below, which owns the B2 failure breaker.
    cost_parser = add_subparser(sub, "cost-breaker")
    cost_sub = cost_parser.add_subparsers(dest="cost_breaker_command", required=True)
    add_subparser(cost_sub, "status")
    cost_reset = add_subparser(cost_sub, "reset")
    cost_reset.add_argument("--acknowledge", action="store_true")
    cost_reset.add_argument("--reason", required=True, type=_validate_reason)
    cost_reset.add_argument("--operator-approval-ref", required=True)

    breaker_parser = add_subparser(sub, "breaker")
    breaker_sub = breaker_parser.add_subparsers(dest="breaker_command", required=True)
    add_subparser(breaker_sub, "status")
    breaker_reset = add_subparser(breaker_sub, "reset")
    breaker_reset.add_argument("--acknowledge", action="store_true")
    breaker_reset.add_argument("--reason", required=True, type=_validate_reason)
    breaker_reset.add_argument("--operator-approval-ref", required=True)
    # RC-6 — `quarantine` is a DIFFERENT verb from `reset`, not a flag on it,
    # because the guarantees differ: reset discards the whole window and clears
    # the state, quarantine preserves every decodable row and clears nothing.
    # Collapsing them into one command with a flag is how an operator reaching
    # for "make the breaker evaluable" would end up discarding the evidence.
    # It gets a CLI at all because ORPHAN-HIGH-465 was exactly this: an
    # operator-recovery function that existed with no command surface.
    breaker_quarantine = add_subparser(breaker_sub, "quarantine")
    breaker_quarantine.add_argument("--acknowledge", action="store_true")
    breaker_quarantine.add_argument("--reason", required=True, type=_validate_reason)
    breaker_quarantine.add_argument("--operator-approval-ref", required=True)

    tool_parser = add_subparser(sub, "tool")
    tool_sub = tool_parser.add_subparsers(dest="tool_command", required=True)
    tool_register = add_subparser(tool_sub, "register")
    tool_register.add_argument("--file", required=True)
    tool_list = add_subparser(tool_sub, "list")
    tool_list.add_argument("--status", default=None)
    tool_quarantine = add_subparser(tool_sub, "quarantine")
    tool_quarantine.add_argument("--tool-id", required=True)
    tool_quarantine.add_argument("--reason", required=True, type=_validate_reason)
    # The audited way back. unquarantine_tool has existed since Plan 022 and
    # was API-only — so when six adapters were quarantined by an environment
    # fault, there was no operator-reachable path to lift it. Mechanism
    # without a caller, CLI edition.
    tool_unquarantine = add_subparser(tool_sub, "unquarantine")
    tool_unquarantine.add_argument("--tool-id", required=True)
    tool_unquarantine.add_argument("--reason", required=True, type=_validate_reason)
    tool_unquarantine.add_argument("--operator-approval-ref", required=True)
    tool_unquarantine.add_argument("--root-cause-note", required=True)
    tool_unquarantine.add_argument("--fixture-update-ref", required=True)
    tool_run = add_subparser(tool_sub, "run")
    tool_run.add_argument("--tool-id", required=True)
    tool_run.add_argument("--input", default="{}")
    tool_run.add_argument("--cycle-id", required=True)
    tool_run.add_argument("--workspace-root", default=".")
    # C1 (E4) — the promotion verb the registry never had. promote_tool has
    # existed with every gate (fixture pass, readiness, operator approval)
    # and ZERO command surface, so no adapter could ever leave SHADOW and
    # every finding was suppressed (687 produced, 0 operator-facing).
    # Mechanism without a caller, promotion edition — the same class as
    # unquarantine above. CALIBRATE->SHADOW needs no approval ref (fixture
    # pass suffices); SHADOW->ACTIVE requires it (promotion.py enforces).
    tool_promote = add_subparser(tool_sub, "promote")
    tool_promote.add_argument("--tool-id", required=True)
    tool_promote.add_argument("--target-status", required=True, choices=("SHADOW", "ACTIVE"))
    tool_promote.add_argument("--reason", required=True, type=_validate_reason)
    tool_promote.add_argument("--operator-approval-ref", default=None)
    # JJ-2b (ORPHAN-HIGH-732) — the panel authority's command surface. The
    # ref is a RESOLVED human-required adjudication id, and the kernel
    # RESOLVES it (promotion_veto.resolve_panel_approval): a ref that names
    # no panel-resolved tool_promotion record for this tool refuses here
    # exactly as it refuses inside the cycle, so the CLI is not a softer
    # door into the same authority. promote_tool arms a 24h operator veto
    # window instead of transitioning.
    tool_promote.add_argument(
        "--panel-approval-ref", default=None,
        help="request_id of a RESOLVED agent-panel tool_promotion adjudication",
    )

    # JJ-2b — the operator's one move, and only if he disagrees. Silence for
    # 24h activates the promotion; this verb is how that silence is broken.
    tool_veto = add_subparser(tool_sub, "veto-promotion")
    tool_veto.add_argument("--tool-id", required=True)
    tool_veto.add_argument("--reason", required=True, type=_validate_reason)
    tool_veto.add_argument("--operator-ref", default=None)

    # FAZ 5a — the merge gate's attestation ledger finally gets a producer
    # verb. verify_runner_attestation was MANDATORY at merge and NOTHING
    # wrote a row; mechanism without a caller, ledger edition.
    attestation_parser = add_subparser(sub, "runner-attestation")
    attestation_sub = attestation_parser.add_subparsers(
        dest="attestation_command", required=True
    )
    attestation_probe = add_subparser(attestation_sub, "probe")
    attestation_probe.add_argument("--repo", required=True)
    attestation_probe.add_argument("--target-ref", required=True)

    registry_parser = add_subparser(sub, "registry")
    registry_sub = registry_parser.add_subparsers(dest="registry_command", required=True)
    registry_compile = add_subparser(registry_sub, "compile")
    registry_compile.add_argument("--adapters-dir", default="tools/aria-adapters")
    registry_compile.add_argument("--output", default="aria-tools/registry.json")
    registry_compile.add_argument("--check", action="store_true")

    # Plan 020 Phase 8.C — validation matrix CLI.
    matrix_parser = add_subparser(sub, "validation-matrix")
    matrix_sub = matrix_parser.add_subparsers(dest="validation_matrix_command", required=True)
    matrix_check = add_subparser(matrix_sub, "check")
    matrix_check.add_argument("--change-id", required=True)
    matrix_check.add_argument("--repo-root", default=".")
    # ORPHAN-696 — the hand-written evidence flag is GONE (twin of the
    # pattern ORPHAN-675 removed): refs now derive from the validation-runs
    # ledger itself, so a ref claiming a command that never ran cannot be
    # typed into existence.
    matrix_check.add_argument("--validation-mode", choices=["enforced", "historical_attestation"],
        default="enforced")
    matrix_required = add_subparser(matrix_sub, "list-required")
    matrix_required.add_argument("--risk-type", action="append", required=True,
        choices=["auth_change", "tenant_change", "schema_change", "event_change"])

    # Plan 020 Phase 7.C — agent compliance harness CLI.
    compliance_parser = add_subparser(sub, "agent-compliance")
    compliance_sub = compliance_parser.add_subparsers(dest="agent_compliance_command", required=True)
    comp_grade = add_subparser(compliance_sub, "grade")
    comp_grade.add_argument("--claim-id", required=True)
    comp_grade.add_argument("--request-file", required=True)
    comp_grade.add_argument("--response-file", required=True)
    comp_grade.add_argument("--response-path", default=None,
        help="Where the agent claims it wrote the response (output_path_match check).")
    comp_grade.add_argument("--workspace-root", default=".")
    comp_list = add_subparser(compliance_sub, "list")
    comp_list.add_argument("--claim-id", default=None)
    comp_list.add_argument("--rejected-only", action="store_true")
    comp_list.add_argument("--limit", type=int, default=None)

    # Plan 020 Phase 6.C — agent eval harness CLI.
    eval_parser = add_subparser(sub, "agent-eval")
    eval_sub = eval_parser.add_subparsers(dest="agent_eval_command", required=True)
    eval_add = add_subparser(eval_sub, "add-fixture")
    eval_add.add_argument("--fixture-file", required=True,
        help="Path to JSON fixture file conforming to aria/agent-eval-fixture/v1.")
    eval_run = add_subparser(eval_sub, "run")
    eval_run.add_argument("--fixture-id", required=True)
    eval_run.add_argument("--mock-mode", action="store_true", default=True,
        help="Run mock-mode (default; produces deterministic envelope).")
    eval_run.add_argument("--real-envelope-file", default=None,
        help="JSON file with real_response_envelope (required when --mock-mode is unset).")
    eval_run.add_argument("--no-mock-mode", action="store_true",
        help="Disable mock mode; requires --real-envelope-file.")
    eval_run.add_argument("--invocation-id", default=None,
        help="Required in real mode: upstream invocation/lease id.")
    eval_run.add_argument("--transcript-hash", default=None,
        help="Required in real mode: sha256:<hex> transcript hash.")
    eval_run.add_argument("--operator-approval-ref", default=None,
        help="Optional operator provenance label recorded on real eval rows.")
    eval_run.add_argument("--request-ledger-ref", default=None,
        help="Real mode: SourceLedgerRef JSON or JSON file for request row.")
    eval_run.add_argument("--claim-ledger-ref", default=None,
        help="Real mode: SourceLedgerRef JSON or JSON file for claim row.")
    eval_run.add_argument("--result-ledger-ref", default=None,
        help="Real mode: SourceLedgerRef JSON or JSON file for result row.")
    eval_run.add_argument("--fixture-ledger-ref", default=None,
        help="Real mode: fixture SourceLedgerRef JSON or JSON file.")
    eval_run.add_argument("--transcript-ledger-ref", default=None,
        help="Real mode: SourceLedgerRef JSON or JSON file for transcript row.")
    eval_run.add_argument("--operator-approval-ledger-ref", default=None,
        help="Real mode: SourceLedgerRef JSON or JSON file for operator approval row.")
    eval_run.add_argument("--context-ledger-ref", default=None,
        help="Optional real mode: SourceLedgerRef JSON or JSON file for context row.")
    eval_run.add_argument("--prompt-ledger-ref", default=None,
        help="Optional real mode: SourceLedgerRef JSON or JSON file for prompt row.")
    eval_aggregate = add_subparser(eval_sub, "aggregate")
    eval_aggregate.add_argument("--target-agent", required=True)
    eval_aggregate.add_argument("--window-days", type=int, default=30)
    eval_aggregate.add_argument("--mock-mode", choices=["true", "false", "all"], default="all")
    # F4.3 — the comparison the program's success test needs: window N+1
    # against window N, with a verdict that refuses to speak on thin data.
    eval_delta = add_subparser(eval_sub, "delta")
    eval_delta.add_argument("--target-agent", required=True)
    eval_delta.add_argument("--window-days", type=int, default=30)
    eval_delta.add_argument("--mock-mode", choices=["true", "false", "all"], default="all")
    eval_delta.add_argument("--min-runs", type=int, default=None,
        help="Runs required in BOTH windows before a verdict is given.")
    eval_list = add_subparser(eval_sub, "list")
    eval_list.add_argument("--target-agent", default=None)
    eval_list.add_argument("--fixture-id", default=None)
    eval_list.add_argument("--mock-mode", choices=["true", "false", "all"], default="all")
    eval_list.add_argument("--limit", type=int, default=None)
    eval_list_fixtures = add_subparser(eval_sub, "list-fixtures")

    # Plan 023 v3 §D-1 — shadow-sample CLI parser entry. Plan 022 §H-5
    # added the sample_shadow_raw_findings Python function but no CLI
    # subparser; operators could only call via Python REPL. Post-fix:
    # `aria-kernel agent-eval shadow-sample [--threshold N]` runs the
    # function and emits JSON output.
    eval_shadow_sample = add_subparser(eval_sub, 
        "shadow-sample",
        help="Sample SHADOW raw findings from the last 24h (Plan 022 §H-5).",
    )
    eval_shadow_sample.add_argument(
        "--threshold", type=int, default=None,
        help="Optional override for the 24h raw-findings threshold "
             "(default: SHADOW_SAMPLE_THRESHOLD_24H).",
    )

    # Plan 020 Phase 3.B — handoff snapshot sub-command.
    # WHY a CLI surface: session_start + session_stop GHA workflow steps
    # invoke this entry point. Operators use the same surface for manual
    # handoff between session boundaries.
    handoff_parser = add_subparser(sub, "handoff")
    handoff_sub = handoff_parser.add_subparsers(dest="handoff_command", required=True)
    handoff_snapshot = add_subparser(handoff_sub, "snapshot")
    handoff_snapshot.add_argument("--session-id", required=True)
    handoff_snapshot.add_argument("--trigger", required=True,
        choices=["manual", "session_start", "pre_compact", "session_stop"])
    handoff_snapshot.add_argument("--repo-root", default=".")
    handoff_snapshot.add_argument("--operator-note", default=None)
    handoff_list = add_subparser(handoff_sub, "list")
    handoff_list.add_argument("--session-id", default=None)
    handoff_list.add_argument("--trigger", default=None)
    handoff_list.add_argument("--limit", type=int, default=None)
    handoff_read = add_subparser(handoff_sub, "read")
    handoff_read.add_argument("--session-id", required=True)

    # Plan 020 Phase 2.C — context budget audit / enforce sub-command.
    # WHY a CLI surface: operators inspecting why a planner packet got
    # rejected need a one-shot audit ('aria-kernel context audit
    # --target-agent X --role Y --request-file ...') that mirrors the
    # in-pipeline gate. The list sub-command surfaces audit history.
    context_parser = add_subparser(sub, "context")
    context_sub = context_parser.add_subparsers(dest="context_command", required=True)
    context_audit = add_subparser(context_sub, "audit")
    context_audit.add_argument("--target-agent", required=True)
    context_audit.add_argument("--role", required=True)
    context_audit.add_argument("--request-file", default=None,
        help="Path to JSON file with the request envelope (defaults to empty).")
    context_audit.add_argument("--repo-root", default=".")
    context_audit.add_argument("--context-window-tokens", type=int, default=None)
    context_audit.add_argument("--enforce", action="store_true",
        help="Raise GovernanceError on cap breach (vs read-only audit).")
    context_list = add_subparser(context_sub, "list")
    context_list.add_argument("--target-agent", default=None)
    context_list.add_argument("--limit", type=int, default=None)

    # Plan 020 Phase 1.C — runtime profile sub-command (set/get/history).
    # WHY a dedicated sub-command exists: every profile transition is a
    # control-plane operation that bypasses enforce_profile_for_write so
    # operators can THAW a frozen surface. The CLI surface keeps the
    # operator_approval_ref REQUIRED at parse time so a forgotten flag
    # is not silently swapped for an empty string at the kernel boundary.
    profile_parser = add_subparser(sub, "profile")
    profile_sub = profile_parser.add_subparsers(dest="profile_command", required=True)
    profile_set = add_subparser(profile_sub, "set")
    profile_set.add_argument("--profile", required=True, choices=list(PROFILES))
    profile_set.add_argument("--operator-approval-ref", required=True)
    profile_set.add_argument("--set-by", default="operator")
    # ORPHAN-HIGH-728 — the operator gesture ADR-033/ADR-041 reserve for a
    # human, given a verb. Omitted means "leave the grant where it is": a
    # flag that silently reset the ceiling on every profile change would make
    # the grant a thing operators have to re-assert instead of a thing they
    # recorded once.
    profile_set.add_argument(
        "--scheduler-ceiling", default=None, choices=list(PROFILES),
        help=(
            "maximum profile an UNATTENDED lane may resolve for itself "
            "(default standard; omit to leave the recorded ceiling unchanged)"
        ),
    )
    profile_get = add_subparser(profile_sub, "get")
    profile_history = add_subparser(profile_sub, "history")

    runtime_parser = add_subparser(sub, "runtime")
    runtime_sub = runtime_parser.add_subparsers(dest="runtime_command", required=True)
    runtime_verify = add_subparser(runtime_sub, "verify-artifacts")
    runtime_verify.add_argument("--cycle-id", default=None)
    runtime_verify.add_argument("--workspace-root", default=None)
    runtime_verify.add_argument("--require-artifact-bearing", action="store_true")
    runtime_promotion = add_subparser(runtime_sub, "promotion")
    runtime_promotion_sub = runtime_promotion.add_subparsers(dest="runtime_promotion_command", required=True)
    runtime_approve_v2 = add_subparser(runtime_promotion_sub, "approve-v2")
    runtime_approve_v2.add_argument("--evidence-bundle", required=True)
    runtime_approve_v2.add_argument("--workspace-root", required=True)
    runtime_approve_v2.add_argument("--operator-approval-ref", required=True)
    runtime_retention = add_subparser(runtime_sub, "retention")
    runtime_retention_sub = runtime_retention.add_subparsers(dest="runtime_retention_command", required=True)
    runtime_retention_dry = add_subparser(runtime_retention_sub, "dry-run")
    runtime_retention_dry.add_argument("--retain-hot-cycles", type=int, default=20)
    runtime_retention_apply = add_subparser(runtime_retention_sub, "apply")
    runtime_retention_apply.add_argument("--retain-hot-cycles", type=int, default=20)
    runtime_retention_apply.add_argument("--workspace-root", required=True)
    runtime_retention_apply.add_argument("--reason", required=True, type=_validate_reason)
    runtime_retention_apply.add_argument("--operator-approval-ref", required=True)
    runtime_retention_apply.add_argument("--acknowledge", action="store_true")
    runtime_signal = add_subparser(runtime_sub, "signal")
    runtime_signal_sub = runtime_signal.add_subparsers(dest="runtime_signal_command", required=True)
    rs_ingest = add_subparser(runtime_signal_sub, "ingest")
    rs_ingest.add_argument("--source", required=True)
    rs_ingest.add_argument("--service", required=True)
    rs_ingest.add_argument("--summary", required=True)
    rs_ingest.add_argument("--code-ref", action="append", required=True, dest="code_refs")
    rs_ingest.add_argument("--severity", default="high")
    rs_resolve = add_subparser(runtime_signal_sub, "resolve")
    rs_resolve.add_argument("--signal-id", required=True)
    rs_resolve.add_argument("--resolution-note", required=True)
    rs_list = add_subparser(runtime_signal_sub, "list")

    # F4.2 of the ARIA intelligence program: the gold corpus ceremony. The
    # proposal side is machine work (count labelled feedback), so the cycle
    # mints proposals on its own; PROMOTION is an operator act and stays a
    # named-curator verb here, never automatic.
    goldset_parser = add_subparser(sub, "goldset")
    goldset_sub = goldset_parser.add_subparsers(dest="goldset_command", required=True)
    gs_propose = add_subparser(goldset_sub, "propose")
    gs_propose.add_argument("--tool-id", required=True)
    gs_propose.add_argument("--cycle-id")
    gs_propose.add_argument("--target-true-positives", type=int, default=None)
    gs_propose.add_argument("--target-known-false-positives", type=int, default=None)
    gs_list = add_subparser(goldset_sub, "list")
    gs_list.add_argument("--tool-id")
    gs_promote = add_subparser(goldset_sub, "promote")
    gs_promote.add_argument("--tool-id", required=True)
    gs_promote.add_argument("--curator", required=True)
    gs_show = add_subparser(goldset_sub, "show")
    gs_show.add_argument("--tool-id", required=True)

    runtime_restore = add_subparser(runtime_sub, "restore-artifact")
    runtime_restore.add_argument("--artifact-ref", required=True)
    runtime_restore.add_argument("--workspace-root", required=True)
    runtime_restore.add_argument("--reason", required=True, type=_validate_reason)
    runtime_restore.add_argument("--operator-approval-ref", required=True)
    runtime_rollback = add_subparser(runtime_sub, "rollback-retention")
    runtime_rollback.add_argument("--manifest-id", required=True)
    runtime_rollback.add_argument("--workspace-root", required=True)
    runtime_rollback.add_argument("--reason", required=True, type=_validate_reason)
    runtime_rollback.add_argument("--operator-approval-ref", required=True)

    memory_parser = add_subparser(sub, "memory")
    memory_sub = memory_parser.add_subparsers(dest="memory_command", required=True)
    memory_withdraw = add_subparser(memory_sub, "withdraw")
    memory_withdraw.add_argument("--belief-id", required=True)
    memory_withdraw.add_argument("--reason", required=True, type=_validate_reason)

    # Plan ARIA-V2 §3.3 — operator-grade audited recovery surface.
    # ``memory rebuild-fates`` re-hashes every FATES.files entry from
    # current disk state and rewrites FATES.json with the new hashes;
    # ``memory reset`` moves the entire memory dir to a backup path
    # and re-bootstraps empty memory state. Both emit governance
    # events with operator actor + reason; both gated by frozen-
    # profile guard via the standard tool_governance surface.
    memory_rebuild = add_subparser(memory_sub, "rebuild-fates")
    add_workspace_args(memory_rebuild)
    memory_rebuild.add_argument("--cycle-id", required=True)
    memory_rebuild.add_argument("--reason", required=True, type=_validate_reason)
    memory_rebuild.add_argument("--acknowledge", action="store_true")

    memory_reset = add_subparser(memory_sub, "reset")
    add_workspace_args(memory_reset)
    memory_reset.add_argument("--reason", required=True, type=_validate_reason)
    memory_reset.add_argument("--acknowledge", action="store_true")
    memory_reset.add_argument("--backup-to", required=True,
        help="Plan ARIA-V2 §3.3 — destination directory for the "
             "pre-reset memory state. Must be operator-supplied; "
             "no default to prevent accidental data loss.")

    pressure_parser = add_subparser(sub, "pressure")
    pressure_sub = pressure_parser.add_subparsers(dest="pressure_command", required=True)
    pressure_list = add_subparser(pressure_sub, "list")
    add_workspace_args(pressure_list)
    pressure_list.add_argument("--age-buckets", action="store_true")
    pressure_list.add_argument("--json", action="store_true")
    pressure_list.add_argument("--include-faded", action="store_true")
    pressure_list.add_argument("--include-sleeping", action="store_true")
    pressure_list.add_argument("--include-archived", action="store_true")
    pressure_list.add_argument("--include-closed", action="store_true")
    pressure_list.add_argument("--include-satisfied", action="store_true")
    pressure_weights_cmd = add_subparser(pressure_sub, "weights")
    add_workspace_args(pressure_weights_cmd)
    pressure_override = add_subparser(pressure_sub, "weight-override")
    add_workspace_args(pressure_override)
    pressure_override.add_argument("--source", required=True)
    pressure_override.add_argument("--weight", required=True, type=int)
    pressure_override.add_argument("--acknowledge", action="store_true", required=True)
    pressure_override.add_argument("--reason", required=True)
    pressure_override.add_argument("--operator-approval-ref", required=True)
    pressure_explain = add_subparser(pressure_sub, "explain")
    add_workspace_args(pressure_explain)
    pressure_explain.add_argument("pressure_event_id", nargs="?")
    pressure_explain.add_argument("--cycle-id", default=None)
    pressure_explain.add_argument("--pressure-id", default=None)
    pressure_reverify = add_subparser(pressure_sub, "reverify")
    add_workspace_args(pressure_reverify)
    pressure_reverify.add_argument("--sample-rate", type=float, default=0.10)
    pressure_reverify.add_argument("--dry-run", action="store_true")
    pressure_reverify.add_argument("--apply", action="store_true")
    pressure_reverify.add_argument("--acknowledge", action="store_true")
    pressure_reverify.add_argument("--reason", default=None)
    pressure_reverify.add_argument("--reset-cursor", action="store_true")

    telemetry_parser = add_subparser(sub, "telemetry")
    telemetry_sub = telemetry_parser.add_subparsers(dest="telemetry_command", required=True)
    telemetry_export = add_subparser(telemetry_sub, "export")
    add_workspace_args(telemetry_export)
    telemetry_export.add_argument("--format", choices=["prometheus", "otel"], required=True)
    telemetry_export.add_argument("--output", default=None)

    worker_parser = add_subparser(sub, "worker")
    worker_sub = worker_parser.add_subparsers(dest="worker_command", required=True)
    worker_dispatch = add_subparser(worker_sub, "dispatch")
    add_workspace_args(worker_dispatch)
    worker_dispatch.add_argument("--pressure-event-id", default=None)
    worker_dispatch.add_argument("--target-agent", default=None)
    worker_dispatch.add_argument("--prepare-worktree", action="store_true")
    worker_dispatch.add_argument("--acknowledge", action="store_true")
    worker_dispatch.add_argument("--auto-batch", action="store_true")
    worker_dispatch.add_argument("--limit", type=int, default=10)
    worker_list = add_subparser(worker_sub, "list")
    worker_list.add_argument("--state", default=None)
    worker_list.add_argument("--target-agent", default=None)
    worker_list.add_argument("--pressure-event-id", default=None)
    worker_list.add_argument("--json", action="store_true")
    worker_mark = add_subparser(worker_sub, "mark-picked-up")
    worker_mark.add_argument("pressure_event_id")
    worker_mark.add_argument("--by", required=True)
    worker_cancel = add_subparser(worker_sub, "cancel")
    worker_cancel.add_argument("pressure_event_id")
    worker_cancel.add_argument("--reason", required=True, type=_validate_reason)

    # Plan 025 §D — autonomous scheduler family. ``planner-dispatch``
    # runs the in-kernel daemon that polls next_pending_request and
    # routes claimed requests to ci_executor.py. The subparser shape
    # mirrors ``worker`` (line 548) and inherits --tools-dir via the
    # add_subparser factory.
    scheduler_parser = add_subparser(sub, "scheduler")
    scheduler_sub = scheduler_parser.add_subparsers(
        dest="scheduler_command", required=True,
    )
    planner_dispatch_parser = add_subparser(scheduler_sub, "planner-dispatch")
    pd_sub = planner_dispatch_parser.add_subparsers(
        dest="planner_dispatch_command", required=True,
    )
    pd_run = add_subparser(pd_sub, "run")
    add_workspace_args(pd_run)
    pd_run.add_argument("--max-iterations", type=int, default=None)
    pd_run.add_argument(
        "--poll-interval-seconds", type=float, default=30.0,
    )
    pd_run.add_argument("--daemon-id", default="planner-dispatch")
    pd_run.add_argument(
        "--roles", default="primary_plan,challenger_plan",
        help="Comma-separated planner roles to poll, in priority order.",
    )
    pd_run.add_argument("--lease-seconds", type=int, default=1800)

    # Plan 025 §E — autonomous worker scheduler daemon. Mirror of
    # planner-dispatch shape (lock, ARIA_STOP, profile gate,
    # max_iterations, exit_reason taxonomy); per-tick hook is
    # worker_dispatch_hook.dispatch_one_pending_worker_assignment.
    worker_dispatch_parser = add_subparser(scheduler_sub, "worker-dispatch")
    wd_sub = worker_dispatch_parser.add_subparsers(
        dest="worker_dispatch_command", required=True,
    )
    wd_run = add_subparser(wd_sub, "run")
    add_workspace_args(wd_run)
    wd_run.add_argument("--max-iterations", type=int, default=None)
    wd_run.add_argument(
        "--poll-interval-seconds", type=float, default=30.0,
    )
    wd_run.add_argument("--daemon-id", default="worker-scheduler")
    wd_run.add_argument("--max-workers", type=int, default=1)
    wd_run.add_argument("--lease-seconds", type=int, default=1800)

    # V10.5 Phase 1 (per ADR-0002) — ARIA-Watchdog read-only observer daemon.
    # Mirror of planner-dispatch/worker-dispatch shape (fcntl lock, ARIA_STOP,
    # max_iterations, exit_reason taxonomy). Per-tick: read governance.jsonl +
    # autonomy_state.jsonl, run 2 MVP detectors (stall + bridge_warning_repeat),
    # emit sanitized findings via finding.emit_finding through the
    # ORIGINATING_SKILL_ALLOWLIST gate. NO state mutation.
    watchdog_parser = add_subparser(scheduler_sub, "watchdog")
    watch_sub = watchdog_parser.add_subparsers(
        dest="watchdog_command", required=True,
    )
    watch_run = add_subparser(watch_sub, "run")
    add_workspace_args(watch_run)
    watch_run.add_argument("--max-iterations", type=int, default=None)
    watch_run.add_argument(
        "--poll-interval-seconds", type=float, default=60.0,
    )
    watch_run.add_argument("--daemon-id", default="aria-watchdog")

    worktree_prune_parser = add_subparser(sub, "worktree-prune")
    add_workspace_args(worktree_prune_parser)
    worktree_prune_parser.add_argument("--acknowledge", action="store_true")
    worktree_prune_parser.add_argument("--ttl-days", type=int, default=7)

    worktree_parser = add_subparser(sub, 
        "worktree",
        help="Worktree-level operations (Plan 016 Faz 0 stable naming).",
    )
    worktree_sub = worktree_parser.add_subparsers(dest="worktree_command", required=True)
    worktree_preflight_parser = add_subparser(worktree_sub, 
        "preflight",
        help="Record a hash-chained worktree_preflight governance event.",
    )
    add_workspace_args(worktree_preflight_parser)
    worktree_preflight_parser.add_argument(
        "--expected-branch",
        default="main",
        help="Branch the worktree must be checked out to (default: main).",
    )
    worktree_preflight_parser.add_argument(
        "--no-fetch",
        action="store_true",
        help="Skip the best-effort origin fetch (offline mode).",
    )

    # Plan ARIA-V2 §3.9 + I-26 — daily report anchor CLI. Replaces the
    # heredoc stub in aria-daily-report.yml with an audit-trust anchor
    # that records governance.jsonl tail hash, sealed cycle IDs, and
    # integrity_index_chain_root for the day. Committed daily anchor
    # files become the audit-trust source after Phase 5 gitignored
    # per-clone runtime ledgers.
    report_parser = add_subparser(sub, "report",
        help="Plan ARIA-V2 §3.9 — daily chain-tip anchor + audit reports.")
    report_sub = report_parser.add_subparsers(dest="report_command", required=True)
    rep_daily = add_subparser(report_sub, "daily",
        help="Generate the daily chain-tip anchor and write it to a markdown file.")
    rep_daily.add_argument("--emit-anchor", action="store_true",
                            help="Write the YAML-frontmatter anchor to --output-path.")
    rep_daily.add_argument("--date", required=True,
                            help="YYYY-MM-DD (UTC) — date the anchor covers.")
    rep_daily.add_argument("--output-path", required=True,
                            help="Target markdown path under aria-tools/reports/daily/.")
    rep_daily.add_argument("--workspace-root", default=".")
    # ``--tools-dir`` is inherited from _TOOLS_DIR_PARENT (Plan 024 §F);
    # ``add_subparser`` funnels every subcommand through that parent so
    # an explicit add_argument here would collide. The handler reads
    # ``args.tools_dir`` directly.

    agent_report_parser = add_subparser(sub, "agent-report")
    agent_report_sub = agent_report_parser.add_subparsers(dest="agent_report_command", required=True)
    ar_scan = add_subparser(agent_report_sub, "scan-registry")
    add_workspace_args(ar_scan)
    ar_scan.add_argument("--cycle-id", required=True)
    ar_scan.add_argument("--backfill-open", action="store_true")
    ar_scan.add_argument("--limit", type=int, default=100)
    ar_scan.add_argument("--confirm-large-backfill", action="store_true")
    ar_scan.add_argument("--acknowledge", action="store_true")
    ar_import = add_subparser(agent_report_sub, "import")
    add_workspace_args(ar_import)
    ar_import.add_argument("--file", required=True)
    ar_import.add_argument("--cycle-id", default=None)
    ar_list = add_subparser(agent_report_sub, "list")
    add_workspace_args(ar_list)
    ar_list.add_argument("--json", action="store_true")

    triage_parser = add_subparser(sub, "triage")
    triage_sub = triage_parser.add_subparsers(dest="triage_command", required=True)
    triage_run = add_subparser(triage_sub, "run")
    add_workspace_args(triage_run)
    triage_run.add_argument("--cycle-id", required=True)
    triage_list = add_subparser(triage_sub, "list")
    triage_list.add_argument("--tier", default=None)
    triage_list.add_argument("--target-agent", default=None)
    triage_list.add_argument("--cycle-id", default=None)
    triage_list.add_argument("--json", action="store_true")
    triage_explain = add_subparser(triage_sub, "explain")
    triage_explain.add_argument("triage_id")

    agent_network_parser = add_subparser(sub, "agent-network")
    agent_network_sub = agent_network_parser.add_subparsers(dest="agent_network_command", required=True)
    agent_network_build = add_subparser(agent_network_sub, "index")
    add_workspace_args(agent_network_build)
    agent_network_build.add_argument("--cycle-id", default=None)

    capability_gap_parser = add_subparser(sub, "capability-gap")
    capability_gap_sub = capability_gap_parser.add_subparsers(dest="capability_gap_command", required=True)
    capability_gap_detect = add_subparser(capability_gap_sub, "detect")
    add_workspace_args(capability_gap_detect)
    capability_gap_detect.add_argument("--cycle-id", required=True)

    plan_parser = add_subparser(sub, "plan")
    plan_sub = plan_parser.add_subparsers(dest="plan_command", required=True)
    plan_start = add_subparser(plan_sub, "start")
    plan_start.add_argument("--plan-id", required=True)
    plan_start.add_argument("--initial-revision-id", required=True)
    plan_start.add_argument("--plan-file", required=True)
    plan_challenger = add_subparser(plan_sub, "submit-challenger")
    plan_challenger.add_argument("--plan-id", required=True)
    plan_challenger.add_argument("--challenger-file", required=True)
    plan_cross_request = add_subparser(plan_sub, "request-cross-review")
    plan_cross_request.add_argument("--plan-id", required=True)
    plan_cross_request.add_argument("--request-file", required=True)
    plan_cross_retry = add_subparser(plan_sub, "request-cross-review-retry")
    plan_cross_retry.add_argument("--plan-id", required=True)
    plan_cross_retry.add_argument("--request-file", required=True)
    plan_cross_record = add_subparser(plan_sub, "record-cross-review")
    add_workspace_args(plan_cross_record)
    plan_cross_record.add_argument("--plan-id", required=True)
    plan_cross_record.add_argument("--review-file", required=True)
    plan_revision = add_subparser(plan_sub, "record-revision")
    plan_revision.add_argument("--plan-id", required=True)
    plan_revision.add_argument("--revision-file", required=True)
    plan_advance = add_subparser(plan_sub, "advance")
    plan_advance.add_argument("--plan-id", required=True)
    plan_advance.add_argument("--round-number", type=int, required=True)
    plan_advance.add_argument("--max-rounds", type=int, default=5)
    plan_advance_rounds = add_subparser(plan_sub, "advance-rounds")
    plan_advance_rounds.add_argument("--plan-id", required=True)
    plan_advance_rounds.add_argument("--max-rounds", type=int, default=5)
    plan_promote = add_subparser(plan_sub, "promote-to-dispatch")
    add_workspace_args(plan_promote)
    plan_promote.add_argument("--plan-id", required=True)
    plan_promote.add_argument("--cycle-id", required=True)
    plan_promote.add_argument("--pressure-event-id", default=None)
    plan_promote.add_argument("--base-sha", default=None)
    plan_promote.add_argument("--impact-ref", required=True)
    plan_promote.add_argument("--validation-ref", required=True)
    plan_promote.add_argument("--target-agent", default=None)
    # PLAN Wave 2 PR 1.5 — bind this dispatch to the mission that owns the
    # work. Optional so promotions predating the mission layer keep working;
    # an id naming no open mission is refused rather than written through.
    plan_promote.add_argument("--mission-id", default=None)
    plan_promote.add_argument("--acknowledge", action="store_true")
    plan_force = add_subparser(plan_sub, "force-human-required")
    plan_force.add_argument("--plan-id", required=True)
    plan_force.add_argument("--round-number", type=int, required=True)
    plan_force.add_argument("--reason-code", action="append", required=True)
    plan_status_parser = add_subparser(plan_sub, "status")
    plan_status_parser.add_argument("--plan-id", required=True)

    mission_parser = add_subparser(sub, "mission")
    mission_sub = mission_parser.add_subparsers(dest="mission_command", required=True)
    mission_open = add_subparser(mission_sub, "open")
    mission_open.add_argument("--source-kind", required=True)
    mission_open.add_argument("--source-id", required=True)
    mission_open.add_argument("--repo-hash", required=True)
    mission_open.add_argument("--title", required=True)
    # ORPHAN-MEDIUM-730 — REQUIRED, exactly as at every other producer: the
    # operator mints under the same closure contract the seeder does, so the
    # CLI cannot be the one door that still admits a mission nothing can move.
    mission_open.add_argument("--next-action", required=True)
    mission_open.add_argument(
        "--wake-file",
        required=True,
        help="Path to a JSON wake_condition object ({kind, key, not_before?}).",
    )
    mission_open.add_argument("--capability", default=None)
    mission_open.add_argument("--priority", type=int, default=None)
    mission_contract = add_subparser(
        mission_sub, "set-contract",
        help="Install next_action + wake_condition on a mission opened before the mint required them.",
    )
    mission_contract.add_argument("--mission-id", required=True)
    mission_contract.add_argument("--next-action", required=True)
    mission_contract.add_argument("--step-id", required=True)
    mission_contract.add_argument(
        "--wake-file",
        required=True,
        help="Path to a JSON wake_condition object ({kind, key, not_before?}).",
    )
    mission_transition = add_subparser(mission_sub, "transition")
    mission_transition.add_argument("--mission-id", required=True)
    mission_transition.add_argument("--to-state", required=True)
    mission_transition.add_argument("--reason-code", required=True)
    mission_transition.add_argument("--step-id", required=True)
    mission_transition.add_argument("--target-sha", default="")
    mission_transition.add_argument("--retry-rung", default=None)
    # ORPHAN-MEDIUM-730 — these two stay argparse-OPTIONAL because their
    # requirement depends on the destination: a non-terminal move must carry
    # both, a terminal move must carry neither (a finished mission owes no
    # next action). argparse cannot express "required unless --to-state is
    # terminal", and re-deriving the terminal set here would put a second
    # copy of `mission.TERMINAL_STATES` in the CLI — the exact split that
    # lets two doors disagree. `transition_mission` refuses both wrong
    # shapes, so the operator gets the refusal from the module that owns the
    # rule; the CLI cannot open a door the kernel closed.
    mission_transition.add_argument(
        "--next-action",
        default=None,
        help="Required for a non-terminal --to-state; refused for a terminal one.",
    )
    mission_transition.add_argument(
        "--wake-file",
        default=None,
        help=(
            "Path to a JSON wake_condition object ({kind, key, not_before?}). "
            "Required for a non-terminal --to-state; refused for a terminal one."
        ),
    )
    mission_transition.add_argument("--evidence-ref", action="append", default=None)
    # Wave 2 PR 1.6 — the scheduler. `--dry-run` reads the decision WITHOUT
    # recording it, because an operator asking "what would you pick?" must not
    # thereby write a decision into the governance ledger.
    mission_next = add_subparser(
        mission_sub, "next",
        help="Select the mission that gets the WIP slot, and say why the others did not.",
    )
    mission_next.add_argument("--dry-run", action="store_true")
    mission_bind = add_subparser(mission_sub, "bind")
    mission_bind.add_argument("--mission-id", required=True)
    mission_bind.add_argument("--step-id", required=True)
    mission_bind.add_argument(
        "--bindings-file",
        required=True,
        help="Path to a JSON object keyed by the closed binding vocabulary.",
    )
    mission_show = add_subparser(mission_sub, "show")
    mission_show.add_argument("--mission-id", required=True)
    add_subparser(mission_sub, "list")
    add_subparser(mission_sub, "rebuild-index")
    add_subparser(mission_sub, "closure")

    # F5-a — first production entry point into the enterprise readiness
    # proof chain. WHY a dedicated family: no readiness-adjacent verb
    # family existed (record_workflow_run_proof had zero production
    # callers), and burying proof production under `ci` would hide the
    # readiness-claim ownership of these ledgers.
    readiness_parser = add_subparser(sub, "readiness")
    readiness_sub = readiness_parser.add_subparsers(dest="readiness_command", required=True)
    readiness_produce = add_subparser(
        readiness_sub,
        "produce-workflow-proofs",
        help="Record enterprise workflow-run proofs for a PR head's successful ci/workflow-runs.jsonl rows.",
    )
    readiness_produce.add_argument("--pr-number", type=int, required=True)
    readiness_produce.add_argument("--repo", required=True)
    readiness_produce.add_argument("--target-ref", required=True)
    readiness_produce.add_argument("--head-ref", required=True)
    readiness_produce.add_argument("--head-sha", required=True)
    readiness_produce.add_argument(
        "--readiness-claim-id",
        default=None,
        help="Optional claim binding; omit when proofs are produced before the claim row is minted.",
    )
    # F5-b (ORPHAN-694) — measured branch-protection proof.
    readiness_bp = add_subparser(
        readiness_sub,
        "produce-branch-protection-proof",
        help="Probe gh-api branch protection, snapshot it, and record a measured proof row.",
    )
    readiness_bp.add_argument("--pr-number", type=int, required=True)
    readiness_bp.add_argument("--repo", required=True)
    readiness_bp.add_argument("--target-ref", required=True)
    readiness_bp.add_argument("--head-ref", required=True)
    readiness_bp.add_argument("--head-sha", required=True)
    readiness_bp.add_argument("--readiness-claim-id", default=None)
    # ORPHAN-HIGH-763 — the two lane-side verbs the claim chain was missing.
    # `produce-claim` had NO command entry at all (half of why the F5-g
    # assembler had zero production callers), and `record-ci-report` exposes
    # the existing ci.py ingestion so a lane can record its OWN completed run
    # as the ci_workflow_run evidence row the claim guard demands — recorded
    # post-completion from the GitHub API payload, never self-declared
    # mid-run.
    readiness_ci = add_subparser(
        readiness_sub,
        "record-ci-report",
        help="Ingest a completed run + PR payload as ci/ ledger rows (workflow-runs, failures, report).",
    )
    readiness_ci.add_argument(
        "--github-file", required=True,
        help="JSON file with the completed run payload under workflow_runs (GitHub Actions API shape).",
    )
    readiness_ci.add_argument(
        "--pr-file", required=True,
        help="JSON file with the PR payload (number, head_sha/headRefOid, base/head refs).",
    )
    readiness_ci.add_argument("--cycle-id", default=None)
    readiness_claim = add_subparser(
        readiness_sub,
        "produce-claim",
        help="Assemble and record the enterprise readiness claim for one PR head.",
    )
    readiness_claim.add_argument("--pr-number", type=int, required=True)
    readiness_claim.add_argument("--repo", required=True)
    readiness_claim.add_argument("--target-ref", required=True)
    readiness_claim.add_argument("--head-ref", required=True)
    readiness_claim.add_argument("--head-sha", required=True)
    readiness_claim.add_argument("--workflow-id", required=True)
    readiness_claim.add_argument("--job-id", required=True)
    readiness_claim.add_argument("--workflow-run-id", required=True)
    readiness_claim.add_argument("--cycle-id", required=True)
    readiness_claim.add_argument(
        "--artifact-file", required=True,
        help="JSON file: {artifact_id, uri, sha256, content_type} of the lane's uploaded evidence artifact.",
    )
    readiness_claim.add_argument(
        "--surfaces-file", required=True,
        help="JSON file: DLP surface name -> list of file paths (diff/prompt/transcript/logs/artifacts).",
    )
    readiness_claim.add_argument("--workspace-root", required=True)
    readiness_claim.add_argument("--owner", default=None)
    # ORPHAN-HIGH-766 — closure-reachability gate (ratcheted). --write pins
    # or shrinks the baseline; without it the command is check-only and
    # exits nonzero on NEW unreachable closures.
    closure_reach = add_subparser(
        sub,
        "closure-reachability",
        help="Verify that findings closed by adding a producer added a REACHED producer.",
    )
    closure_reach.add_argument("--write", action="store_true")
    closure_reach.add_argument("--owner", default="operator")
    closure_reach.add_argument("--reason", default="ratchet update")

    inv_parser = add_subparser(sub, "agent-invocations")
    inv_sub = inv_parser.add_subparsers(dest="agent_invocation_command", required=True)
    inv_request = add_subparser(inv_sub, "request")
    inv_request.add_argument("--target-agent", required=True)
    inv_request.add_argument("--role", required=True)
    inv_request.add_argument("--prompt-file", required=True)
    inv_request.add_argument("--convergence-id", default=None)
    inv_request.add_argument("--pressure-event-id", default=None)
    inv_request.add_argument("--round-number", type=int, default=None)
    inv_request.add_argument("--expected-output-path", default=None)
    # Plan 024 §B-2 — strict fields persisted on the request row.
    # --must-satisfy-file: path to JSON file containing list[dict] of
    #   satisfaction criteria.
    # --allowed-scope: comma-separated glob list (e.g. 'aria-kernel/**,
    #   apps/farm-service/**').
    # --evidence-refs-file: path to JSON file containing list[str] of
    #   pre-attached evidence path refs.
    # --legacy-strict-fields-optional: explicit operator opt-out;
    #   emits legacy_request_creation_without_strict_fields governance
    #   event when set.
    inv_request.add_argument("--must-satisfy-file", default=None)
    inv_request.add_argument("--allowed-scope", default=None,
        help="Comma-separated glob list, e.g. aria-kernel/**,apps/farm-service/**")
    inv_request.add_argument("--evidence-refs-file", default=None)
    inv_request.add_argument(
        "--legacy-strict-fields-optional",
        action="store_true",
        help="Operator opt-out from must_satisfy + allowed_scope strict "
             "enforcement; emits legacy_request_creation_without_strict_fields.",
    )
    # Plan 024 §B-1 — legacy `agent-invocations submit-result` subparser
    # removed. The strict, lease-bound submission path is the only public
    # surface now (`agent submit-result`, line ~656). The underlying
    # legacy function is renamed to
    # `_submit_legacy_invocation_result_internal` and gated behind an
    # operator_migration_approval_ref. `request` and `list` subparsers
    # below are intentionally preserved.
    inv_list = add_subparser(inv_sub, "list")
    inv_list.add_argument("--state", default=None)
    inv_list.add_argument("--convergence-id", default=None)
    inv_list.add_argument("--target-agent", default=None)
    inv_list.add_argument("--request-id", default=None)
    inv_list.add_argument("--role", default=None)

    # Plan 016 Faz C2 stable hierarchical CLI: `agent <action>`. The legacy
    # `agent-invocations ...` sub-command stays for backward compatibility
    # but is no longer advertised in v3 documentation.
    agent_parser = add_subparser(sub, 
        "agent",
        help="Plan 016 bound-agent execution (next-pending / claim / heartbeat / submit-result / release / reap-stale).",
    )
    agent_sub = agent_parser.add_subparsers(dest="agent_command", required=True)

    a_next = add_subparser(agent_sub, 
        "next-pending",
        help="Return the oldest unclaimed pending request matching role/target.",
    )
    a_next.add_argument("--role", default=None)
    a_next.add_argument("--target-agent", default=None)
    # E3/F10 — repeatable exclusion so a drain can step past a request it
    # already attempted tonight instead of head-of-lining the queue.
    a_next.add_argument("--exclude", action="append", default=None,
                        help="Request id to skip (repeatable).")

    a_claim = add_subparser(agent_sub, 
        "claim",
        help="Issue a lease on a pending request. Raw lease_token is returned once.",
    )
    a_claim.add_argument("--request-id", required=True)
    a_claim.add_argument("--agent-id", required=True)
    a_claim.add_argument("--lease-seconds", type=int, default=None)

    a_heartbeat = add_subparser(agent_sub, 
        "heartbeat",
        help="Extend an active lease. Requires the raw lease_token from claim.",
    )
    a_heartbeat.add_argument("--claim-id", required=True)
    a_heartbeat.add_argument("--agent-id", required=True)
    a_heartbeat.add_argument("--lease-token", required=True)
    a_heartbeat.add_argument("--extend-seconds", type=int, default=None)

    a_release = add_subparser(agent_sub,
        "release",
        help="Release a claim before submission. Triggers requeue or HUMAN_REQUIRED.",
    )
    a_release.add_argument("--claim-id", required=True)
    a_release.add_argument("--agent-id", required=True)
    a_release.add_argument("--reason", required=True, type=_validate_reason)
    # Plan 026R §B.1 — lease-bound release. The raw lease_token must
    # arrive via an environment variable (NEVER argv — argv is logged in
    # most CI/journald setups and would leak the token). Mirrors the
    # heartbeat / submit-result lease handling.
    a_release.add_argument(
        "--lease-token",
        required=False,
        default=None,
        help=(
            "Raw lease_token (DISCOURAGED — argv may be logged). "
            "Prefer --lease-token-from-env."
        ),
    )
    a_release.add_argument(
        "--lease-token-from-env",
        required=False,
        default=None,
        metavar="ENV_VAR_NAME",
        help=(
            "Name of an environment variable that holds the lease_token. "
            "Required unless --lease-token is provided."
        ),
    )

    a_submit = add_subparser(agent_sub, 
        "submit-result",
        help="Submit a claim result. Validates response schema, satisfaction matrix, and evidence refs.",
    )
    add_workspace_args(a_submit)
    a_submit.add_argument("--claim-id", required=True)
    a_submit.add_argument("--agent-id", required=True)
    a_submit.add_argument("--lease-token", required=False, default=None)
    a_submit.add_argument(
        "--lease-token-from-env",
        required=False,
        default=None,
        metavar="ENV_VAR_NAME",
        help="Name of an environment variable that holds the lease_token.",
    )
    a_submit.add_argument("--output-path", required=True)
    a_submit.add_argument("--context-hash", required=True)
    a_submit.add_argument("--prompt-hash", required=True)
    a_submit.add_argument("--transcript-hash", required=True)
    a_submit.add_argument("--transcript-artifact-ref", required=True)
    a_submit.add_argument(
        "--evidence-target-sha",
        required=False,
        default=None,
        help=(
            "Ground evidence verification at the AGENT's committed HEAD instead of "
            "the request's base (ARIA-HIGH-022): implementer agents cite post-fix "
            "lines, which can never match the pre-edit blob. Must descend from the "
            "request base; verified fail-closed."
        ),
    )

    a_reap = add_subparser(agent_sub, 
        "reap-stale",
        help="Mark expired leases stale and emit requeue / human_required follow-ups.",
    )
    budget_parser = add_subparser(sub, 
        "budget",
        help="Plan 016 Faz D6 — LLM budget check / record / list.",
    )
    budget_sub = budget_parser.add_subparsers(dest="budget_command", required=True)
    b_check = add_subparser(budget_sub, "check")
    b_check.add_argument("--estimated-usd", type=float, required=True)
    b_check.add_argument("--action", required=True)
    b_record = add_subparser(budget_sub, "record")
    b_record.add_argument("--actual-usd", type=float, required=True)
    b_record.add_argument("--action", required=True)
    b_record.add_argument("--note", default="")
    b_list = add_subparser(budget_sub, "list")
    adapter_parser = add_subparser(sub,
        "adapter-portfolio",
        # E13-C11 — the backfill-window-metadata subcommand is gone: freshness
        # metadata is manifest-owned and derived by validate_tool_definition,
        # so there is nothing left to patch at runtime.
        help="Plan 016 Faz F1 — MVP adapter registration + status.",
    )
    adapter_sub = adapter_parser.add_subparsers(dest="adapter_portfolio_command", required=True)
    ap_register = add_subparser(adapter_sub, "register-mvp")
    ap_status = add_subparser(adapter_sub, "status")
    review_parser = add_subparser(sub, 
        "review",
        help="Plan 017 Phase 6.1 — operator review record ledger.",
    )
    review_sub = review_parser.add_subparsers(dest="review_command", required=True)
    rv_record = add_subparser(review_sub, "record")
    rv_record.add_argument("--scope", required=True)
    rv_record.add_argument("--summary", required=True)
    rv_record.add_argument("--reviewer", required=True)
    rv_record.add_argument("--finding", action="append", default=None,
                            help="Repeatable: F-NNN finding referenced by the review.")
    rv_record.add_argument("--debt", action="append", default=None,
                            help="Repeatable: DEBT-YYYY-MM-DD-NNN referenced by the review.")
    rv_list = add_subparser(review_sub, "list")
    rv_list.add_argument("--scope-substring", default=None)
    rv_list.add_argument("--reviewer", default=None)

    arch_parser = add_subparser(sub, 
        "architecture",
        help="Plan 016 Faz E1 — architecture-first review (fix_in_place / replace_with_adr / etc.).",
    )
    arch_sub = arch_parser.add_subparsers(dest="architecture_command", required=True)
    arch_review = add_subparser(arch_sub, "review")
    arch_review.add_argument("--technology", required=True)
    arch_review.add_argument("--proposed-action", required=True)
    arch_review.add_argument("--root-cause", required=True)
    arch_review.add_argument("--evidence-ref", action="append", required=True)
    arch_review.add_argument("--authoritative-ref", action="append", default=None)
    arch_review.add_argument("--repo-prior-ref", action="append", default=None)
    arch_review.add_argument("--replacement-ground", action="append", default=None)
    arch_review.add_argument("--migration-plan", default="")
    arch_review.add_argument("--rollback-plan", default="")
    arch_review.add_argument("--cycle-id", default=None)
    # E14-b (ORPHAN-697) — the ADR renderer gains its operator verb; the
    # option-set/evidence-pack producers run nightly (service threshold),
    # the DRAFT stays a deliberate act.
    arch_draft = add_subparser(arch_sub, "draft-adr")
    arch_draft.add_argument("--option-set-ref", required=True)
    arch_draft.add_argument("--evidence-pack-ref", required=True)
    arch_draft.add_argument("--cycle-id", default=None)
    arch_list_packs = add_subparser(arch_sub, "list-packs")
    arch_list = add_subparser(arch_sub, "list")
    research_parser = add_subparser(sub, 
        "research",
        help="Plan 016 Faz E2 — sanitized research fetch + source / policy ledger.",
    )
    research_sub = research_parser.add_subparsers(dest="research_command", required=True)
    rs_fetch = add_subparser(research_sub, "fetch")
    rs_fetch.add_argument("--url", required=True)
    rs_fetch.add_argument("--source-tier", required=True)
    rs_fetch.add_argument("--title", default="")
    rs_fetch.add_argument("--allowed-domain", action="append", default=None)
    rs_fetch.add_argument("--content-file", default=None,
                           help="Optional: read fetch payload from a file (avoids real HTTP in tests).")
    rs_list = add_subparser(research_sub, "list")
    rs_policy = add_subparser(research_sub, "set-policy")
    rs_policy.add_argument("--allowed-domain", action="append", required=True)

    # M15/E12-c (ORPHAN-677) — operator-SIGNED anti-pattern mint. The
    # writer existed with zero callers and kernel auto-write is FORBIDDEN
    # (arb HIGH-008: an avoid-rule SKIPS work, so only a signed operator
    # may mint one). This verb is the missing human-gated producer.
    ap_parser = add_subparser(sub,
        "anti-pattern",
        help="M15 — operator-signed avoid-rule mint into the knowledge graph.",
    )
    ap_sub = ap_parser.add_subparsers(dest="anti_pattern_command", required=True)
    ap_record = add_subparser(ap_sub, "record")
    ap_record.add_argument("--pattern-id", required=True)
    ap_record.add_argument("--reason-class", required=True,
                           choices=["architecture_class", "scope_decision", "tool_design"])
    ap_record.add_argument("--evidence-ref", action="append", required=True)
    ap_record.add_argument("--cycle-id", required=True)
    ap_record.add_argument("--operator-signature", required=True)
    ap_record.add_argument("--workspace-root", default=".")

    # C4-a (ORPHAN-674) — operator-approval mint for the genesis proof
    # chain (verify_shadow_eval_proof resolves refs against this ledger).
    opprov_parser = add_subparser(sub,
        "operator-provenance",
        help="C4-a — mint/list operator-approval rows for genesis shadow-eval proofs.",
    )
    opprov_sub = opprov_parser.add_subparsers(dest="operator_provenance_command", required=True)
    opprov_record = add_subparser(opprov_sub, "record")
    opprov_record.add_argument("--ref", required=True,
                               help="The exact operator_provenance_ref the shadow-eval proof will carry.")
    opprov_record.add_argument("--expires-at", required=True,
                               help="ISO-8601 expiry; must be in the future at mint.")
    opprov_record.add_argument("--target-agent", default=None)
    opprov_record.add_argument("--note", default="")
    opprov_list = add_subparser(opprov_sub, "list")

    # E21-c (ORPHAN-693) — the Deney Masası's operator surface: declare a
    # finding-bound experiment, run it, and promote its observations into
    # finding events (reproduction / fix-verification / status change).
    # `experiment run` is run_experiment's FIRST production caller — the
    # E21-a residue "no scheduled/CLI caller" closes here; the nightly
    # phase (E21-d) joins as the second.
    exp_parser = add_subparser(sub,
        "experiment",
        help="E21 Deney Masası — register/run experiments and fold results into findings.",
    )
    exp_sub = exp_parser.add_subparsers(dest="experiment_command", required=True)
    exp_register = add_subparser(exp_sub, "register")
    exp_register.add_argument("--experiment-id", required=True)
    exp_register.add_argument("--hypothesis", required=True)
    exp_register.add_argument("--recipe-ref", required=True)
    exp_register.add_argument("--contract-json", required=True,
                              help='Observation contract, e.g. {"comparator":"status_equals","expected":"failed"}')
    exp_register.add_argument("--finding-ref", default=None,
                              help="Bind to a finding (F-xxx) so reproduce/verify-fix can promote it.")
    exp_register.add_argument("--cycle-id", default=None)
    exp_run = add_subparser(exp_sub, "run")
    add_workspace_args(exp_run)
    exp_run.add_argument("--experiment-id", required=True)
    exp_run.add_argument("--change-id", required=True)
    exp_run.add_argument("--commit-sha", required=True)
    exp_run.add_argument("--runner-identity", required=True)
    exp_run.add_argument("--cycle-id", default=None)
    exp_reproduce = add_subparser(exp_sub, "reproduce")
    add_workspace_args(exp_reproduce)
    exp_reproduce.add_argument("--finding-id", required=True)
    exp_reproduce.add_argument("--validation-run-id", required=True)
    exp_verify = add_subparser(exp_sub, "verify-fix")
    add_workspace_args(exp_verify)
    exp_verify.add_argument("--finding-id", required=True)
    exp_verify.add_argument("--validation-run-id", required=True)
    exp_status = add_subparser(exp_sub, "finding-status")
    add_workspace_args(exp_status)
    exp_status.add_argument("--finding-id", required=True)
    exp_status.add_argument("--to-status", required=True)
    exp_status.add_argument("--reason", required=True)
    exp_status.add_argument("--actor", required=True)
    exp_bindings = add_subparser(exp_sub, "regression-bindings")
    add_workspace_args(exp_bindings)

    co_parser = add_subparser(sub,
        "critical-observation",
        help="Plan 016 Faz E3 — critical observation persistence + escalation surface.",
    )
    co_sub = co_parser.add_subparsers(dest="critical_observation_command", required=True)
    co_record = add_subparser(co_sub, "record")
    co_record.add_argument("--severity", required=True, choices=["CRITICAL", "HIGH", "MEDIUM"])
    co_record.add_argument("--category", required=True,
                            choices=["security", "data_integrity", "regulatory", "production_affecting", "plc_safety"])
    co_record.add_argument("--summary", required=True)
    co_record.add_argument("--evidence-ref", required=True)
    co_record.add_argument("--detail", default="")
    co_record.add_argument("--cycle-id", default=None)
    co_list = add_subparser(co_sub, "list")
    co_list.add_argument("--include-resolved", action="store_true")
    co_ack = add_subparser(co_sub, "acknowledge")
    co_ack.add_argument("--observation-id", required=True)
    co_ack.add_argument("--acknowledged-by", required=True)
    co_resolve = add_subparser(co_sub, "resolve")
    co_resolve.add_argument("--observation-id", required=True)
    co_resolve.add_argument("--resolved-by", required=True)
    co_resolve.add_argument("--resolution-note", required=True)

    cp_parser = add_subparser(sub, 
        "convergent-plan",
        help="Plan 016 Faz D2 — convergent planning loop with envelope wiring.",
    )
    cp_sub = cp_parser.add_subparsers(dest="convergent_plan_command", required=True)
    cp_start = add_subparser(cp_sub, "start")
    cp_start.add_argument("--plan-id", required=True)
    cp_start.add_argument("--initial-revision-id", required=True)
    cp_start.add_argument("--plan-content-file", required=True)
    cp_start.add_argument("--must-satisfy-file", required=True)
    cp_start.add_argument("--evidence-ref", action="append", required=True)
    cp_start.add_argument("--allowed-scope", action="append", required=True)
    cp_challenger = add_subparser(cp_sub, "issue-challenger")
    cp_challenger.add_argument("--plan-id", required=True)
    cp_challenger.add_argument("--round-number", type=int, required=True)
    # Plan 026R §C.3 — ACTIVE TypeError fix. issue_challenger_envelope's
    # signature requires must_satisfy + evidence_refs + allowed_scope
    # (Plan 024 §B-2 strict-fields invariant — challenger inherits the
    # same bounding box as the primary planner). Pre-§C.3 the parser
    # registered only --plan-id + --round-number, so any operator who
    # ran ``aria-kernel convergent-plan issue-challenger ...`` hit a
    # raw TypeError at :2187 before the CLI even reached the kernel
    # primitive. The parser now mirrors the ``start`` subcommand
    # surface for the three boundary args.
    cp_challenger.add_argument("--must-satisfy-file", required=True)
    cp_challenger.add_argument("--evidence-ref", action="append", required=True)
    cp_challenger.add_argument("--allowed-scope", action="append", required=True)

    impact_parser = add_subparser(sub, 
        "impact",
        help="Plan 016 Faz D1 — recursive impact graph (six-source).",
    )
    impact_sub = impact_parser.add_subparsers(dest="impact_command", required=True)
    i_compute = add_subparser(impact_sub, "compute")
    add_workspace_args(i_compute)
    i_compute.add_argument(
        "--intended-file",
        action="append",
        required=True,
        help="Repeatable: paths the change intends to modify.",
    )
    i_compute.add_argument("--max-depth", type=int, default=None)

    i_order = add_subparser(impact_sub, "service-order")
    add_workspace_args(i_order)
    i_order.add_argument("--cycle-id", default=None)
    i_order.add_argument(
        "--nx-graph",
        default=None,
        help="Path to an `nx graph --file` JSON for a fast, authoritative dependency graph "
        "(falls back to a local import scan when omitted).",
    )
    i_order.add_argument(
        "--changed-file",
        action="append",
        default=None,
        help="Repeatable: changed paths to annotate per-service (and surface the downstream ripple).",
    )

    apply_parser = add_subparser(sub,
        "apply",
        help="Plan 016 Faz D5 — apply gate utilities (suppression scan, etc.).",
    )
    apply_sub = apply_parser.add_subparsers(dest="apply_command", required=True)
    a_scan = add_subparser(apply_sub, 
        "scan-diff",
        help="Run the suppression-scanner against a unified-diff file.",
    )
    a_scan.add_argument("--diff-file", required=True)
    # ORPHAN-CRITICAL-727 — the reachable apply gate. `pr create` refuses an
    # action that is not ready_for_pr with a validation_gate_ref, and the only
    # promoter (apply_engine.gate_apply_action) had no command surface at all,
    # so the implementer lane could be told to open a PR and had no way to
    # earn one. Bound into the implementer's Bash allowlist next to the
    # `pr create` row (implementation_safety.ALLOWED_BASH_COMMANDS).
    a_gate = add_subparser(apply_sub,
        "gate",
        help=(
            "Run the candidate validation for a staged proposal, compare it "
            "against the staged baseline, and promote the apply action to "
            "ready_for_pr (exit 1 when the gate blocks)."
        ),
    )
    a_gate.add_argument("--proposal-id", required=True)
    a_gate.add_argument(
        "--change-id",
        required=True,
        help=(
            "The change_id the staging opened for this proposal; the gate "
            "refuses a change_id the staged action does not name."
        ),
    )
    a_gate.add_argument(
        "--runner-identity",
        default=None,
        help=(
            "Who executed the validation. Defaults to the GitHub run "
            "(ci-executor:gha-<run_id>) on the executor lane, else a "
            "kernel-scoped identity."
        ),
    )
    a_gate.add_argument("--cycle-id", default=None)
    a_gate.add_argument(
        "--workspace-root",
        default=None,
        help=(
            "Where the implementation branch is checked out. Defaults to the "
            "path the staging recorded; its sibling `pr create` has always "
            "taken one, and without it the gate could only run on the machine "
            "staging ran on (ORPHAN-CRITICAL-728)."
        ),
    )

    # Plan 019 Phase 3 — pr sub-command surface delegating to pr_manager.
    # Why argparser-only: pr_manager.py already carries the load-bearing
    # logic (12 e2e tests, ARIA_PR_BASE constant, Plan 018 explicit base
    # guard). The CLI binding lets operators reach those functions
    # without writing Python; no new kernel work is added beyond argv
    # parsing + delegation.
    pr_parser = add_subparser(sub, 
        "pr",
        help="Plan 016 §Snowball + Plan 019 Phase 3 — PR pipeline CLI (delegates to pr_manager).",
    )
    pr_sub = pr_parser.add_subparsers(dest="pr_command", required=True)
    pr_prepare = add_subparser(pr_sub, "prepare", help="Prepare an aria/* branch for the proposal.")
    pr_prepare.add_argument("--proposal-id", required=True)
    pr_prepare.add_argument("--workspace-root", required=True)
    pr_prepare.add_argument("--no-dry-run", action="store_true",
                            help="Default is --dry-run (record only). Pass --no-dry-run to run real git checkout.")
    pr_commit = add_subparser(pr_sub, "commit", help="Commit the prepared branch.")
    pr_commit.add_argument("--proposal-id", required=True)
    pr_commit.add_argument("--workspace-root", required=True)
    pr_commit.add_argument("--message", default=None)
    pr_commit.add_argument("--no-dry-run", action="store_true")
    pr_push = add_subparser(pr_sub, "push", help="Push the prepared branch to remote.")
    pr_push.add_argument("--proposal-id", required=True)
    pr_push.add_argument("--workspace-root", required=True)
    pr_push.add_argument("--remote", default="origin")
    pr_push.add_argument("--no-dry-run", action="store_true")
    pr_create = add_subparser(pr_sub, "create", help="Open a PR for the proposal (gh pr create wrap).")
    pr_create.add_argument("--proposal-id", required=True)
    pr_create.add_argument("--workspace-root", required=True)
    # Plan 026R §D.3 — change_id anchor for the §D.4 auto-merge triple-
    # gate. Required for non-dry-run PR creation; the kernel raises
    # ``open_pr_change_id_required`` when --no-dry-run is set without
    # --change-id.
    pr_create.add_argument(
        "--change-id",
        required=False,
        default=None,
        help=(
            "Change-ledger change_id bound to the PR; required when "
            "--no-dry-run is set so the §D.4 auto-merge triple-gate "
            "(head_sha == change.commit_sha + change_validated row + "
            "validation_runs verified) can fire."
        ),
    )
    pr_create.add_argument("--base", default="main",
                           help="ARIA invariant: base MUST be main; any other value rejected at function entry (Plan 018 Phase 6.2).")
    pr_create.add_argument("--no-dry-run", action="store_true")
    pr_status = add_subparser(pr_sub, "list-actions", help="List recorded pr lifecycle actions (prepare/commit/push).")
    pr_lifecycle = add_subparser(pr_sub, "lifecycle-plan",
                                     help="Plan stale/close recommendations for open PRs (read-only).")
    pr_lifecycle.add_argument("--open-prs-file", required=True,
                              help="JSON file with [{number, updated_at, title, proposal_id}, ...].")
    pr_lifecycle.add_argument("--cycle-id", default=None)
    pr_lifecycle.add_argument("--stale-after-days", type=int, default=7)
    pr_lifecycle.add_argument("--close-after-days", type=int, default=30)
    pr_split = add_subparser(pr_sub, "split-plan",
                                 help="Plan a PR split when changed_files exceed max_files_per_pr.")
    pr_split.add_argument("--proposal-id", required=True)
    pr_split.add_argument("--changed-file", action="append", required=True,
                          help="Repeatable: each changed file path.")
    pr_split.add_argument("--cycle-id", default=None)
    pr_split.add_argument("--max-files-per-pr", type=int, default=12)

    # Plan 019 Phase 5.5 — Architecture Spine Gate CLI surface.
    # Operator runs `aria-kernel spine baseline` before a remediation
    # round, then `aria-kernel spine postcheck` after. The kernel's
    # 5-round HUMAN_REQUIRED escalation is automatic per call.
    spine_parser = add_subparser(sub, 
        "spine",
        help="Plan 019 Phase 5.5 — Architecture Spine Gate baseline / postcheck / status.",
    )
    spine_sub = spine_parser.add_subparsers(dest="spine_command", required=True)
    sp_baseline = add_subparser(spine_sub, "baseline",
                                       help="Snapshot the 4 architectural invariants for plan_id.")
    sp_baseline.add_argument("--plan-id", required=True)
    sp_baseline.add_argument("--cycle-id", required=True)
    sp_baseline.add_argument("--workspace-root", default=None)
    sp_postcheck = add_subparser(spine_sub, "postcheck",
                                        help="Re-snapshot + diff vs latest baseline; emit regression event if drift detected.")
    sp_postcheck.add_argument("--plan-id", required=True)
    sp_postcheck.add_argument("--cycle-id", required=True)
    sp_postcheck.add_argument("--workspace-root", default=None)
    sp_postcheck.add_argument("--max-regression-rounds", type=int, default=5)
    sp_status = add_subparser(spine_sub, "status",
                                     help="List baseline / postcheck / regression events.")
    sp_status.add_argument("--plan-id", default=None)

    # Plan 026R §F.1 + §F.3 — autonomy orchestrator CLI surface.
    # `aria-kernel autonomy run` executes the unified state machine
    # (cycle + planner-dispatch drain + bridge drain + worker-dispatch
    # drain + optional auto-merge). `aria-kernel autonomy status`
    # routes through AutonomyStateReducer.derive_current so manual
    # operator queries and the orchestrator's own transitions share
    # one canonical state surface.
    policy_approval_parser = add_subparser(
        sub, "policy-approval",
        help="L3 two-stage human policy approval (risk_owner + exception_owner, "
        "separation of duties) gating ARIA merge of an L3-risk change.",
    )
    pa_sub = policy_approval_parser.add_subparsers(dest="policy_approval_command", required=True)
    pa_record = add_subparser(pa_sub, "record", help="Record one approval stage for a PR.")
    pa_record.add_argument("--approval-id", required=True)
    pa_record.add_argument("--stage", required=True, choices=["risk_owner", "exception_owner"])
    pa_record.add_argument("--actor", required=True)
    pa_record.add_argument("--pr-number", type=int, required=True)
    pa_record.add_argument("--head-sha", required=True)
    pa_record.add_argument("--policy-hash", required=True)
    pa_record.add_argument("--expires-at", required=True)
    pa_verify = add_subparser(pa_sub, "verify", help="Verify both stages are approved by distinct actors.")
    pa_verify.add_argument("--pr-number", type=int, required=True)
    pa_verify.add_argument("--head-sha", required=True)
    pa_verify.add_argument("--policy-hash", required=True)

    autonomy_parser = add_subparser(
        sub, "autonomy",
        help="Plan 026R §F — unified autonomy orchestrator (LOAD-BEARING).",
    )
    autonomy_sub = autonomy_parser.add_subparsers(
        dest="autonomy_command", required=True,
    )
    auto_run = add_subparser(
        autonomy_sub, "run",
        help="Run one or more autonomy cycles (cycle + planner + bridge + worker drains).",
    )
    auto_run.add_argument("--workspace-root", default=None)
    auto_run.add_argument(
        "--max-cycles", type=int, default=1,
        help="Number of cycles to run before clean exit (default 1).",
    )
    auto_run.add_argument(
        "--max-iterations-per-phase", type=int, default=10,
        help="Bound for planner/worker dispatch drain loops per cycle (default 10).",
    )
    auto_run.add_argument(
        "--daemon-id", default="autonomy",
        help="fcntl single-instance lock id (default: autonomy).",
    )
    # Plan ARIA-V7 §3 V7.7 — cycle deadline watchdog CLI flag.
    auto_run.add_argument(
        "--phase-filter", default=None,
        help="Only run phases whose name contains this substring (e.g. --phase-filter judge "
             "runs only judge phases). Skipped phases are recorded, not silent. Use for "
             "splitting a long cycle across multiple shorter workflow runs.",
    )
    auto_run.add_argument(
        "--cycle-deadline-seconds", type=float, default=1800.0,
        help="Per-cycle wall-clock deadline (default 1800s = 30 min). "
             "When exceeded, orchestrator emits cycle_deadline_exceeded "
             "phase + writes ARIA_STOP to halt the autonomy loop cleanly. "
             "Set lower (e.g. 60) to verify the V7 phase progression "
             "quickly without polling for Gate A/B/C consumer envelopes.",
    )
    # Plan ARIA-V8 §4 Phase 8.0 (B-V2-13) — challenger-timeout + max-rounds
    # + max-budget-usd-per-run exposed for operator tuning. Default
    # numerics come from convergence_drainer.run_convergence_drainer
    # signature + budget.DEFAULT_MAX_BUDGET_USD_PER_RUN.
    auto_run.add_argument(
        "--challenger-timeout-seconds", type=float, default=300.0,
        help="Per-poll budget for state-machine waits inside "
             "convergence_drainer (default 300s). Used by round-1 "
             "challenger + cross_review polls and round-2+ revision "
             "polls. Lower for fast smoke; raise for slow LLMs.",
    )
    auto_run.add_argument(
        "--max-rounds", type=int, default=2,
        help="Max convergence rounds per plan (default 2 for "
             "autonomous cycles). Reduced from V5.1 default 4 because "
             "V8 P+C+CR multiplies LLM cost per round.",
    )
    auto_run.add_argument(
        "--max-budget-usd-per-run", type=float, default=20.00,
        help="Per-run LLM budget cap in USD (default $20.00 — V8 era; "
             "V9 v3 plan acceptance gate raises to $45 for 20-cycle "
             "endurance because V9 implementer call adds ~$0.40/cycle "
             "to V8's ~$0.70 baseline). convergence_drainer reserves "
             "per-cycle estimate before minting envelopes; "
             "ci_executor reconciles actual cost from response "
             "usage block. Cap exhausted mid-cycle emits "
             "budget_exhausted arbiter_verdict.",
    )
    # Plan ARIA-V9.7 — per-cycle hard cap kill-switch (ai HIGH-013).
    # Per-cycle reservation; cycle that would exceed kills at next
    # turn boundary, not after the turn completes (so refund/reserve
    # discipline holds). $3.00 default = the K4 re-baseline for
    # fable-tier decision nodes at 2x opus pricing; preserves the
    # original 20-cycle-target headroom ratio.
    auto_run.add_argument(
        "--max-budget-usd-per-cycle", type=float, default=3.00,
        help="Per-cycle LLM hard cap kill-switch in USD (default "
             "$3.00). Cycle that would exceed: kernel emits "
             "cycle_budget_exhausted refusal at next turn boundary. "
             "Combined with --max-budget-usd-per-run, the two caps "
             "bound both a single runaway cycle AND a slowly-creeping "
             "run that accumulates over many small cycles. Closes "
             "ai-safety HIGH-013 + perf CRIT-001.",
    )
    # Plan ARIA-V9.7 + V3.1-E — autonomous-profile precondition gate
    # (ai MED-016 + 6-validator audit C-2 SOC2). All 5 PROFILES are
    # available as choices; the CLI delegates the actual SOC2 audit
    # row to `set_profile()` so every `--profile` override that
    # differs from the persisted active profile produces a
    # `runtime_profile_changed` governance event.
    #
    # default=None routes to the persisted profile resolved via
    # `get_profile(base_dir=args.tools_dir)`. The CLI sets profile
    # explicitly only when the operator passes the flag — this
    # preserves V8 behavior (no flag → respect persisted state)
    # while keeping the V3.1-E SSoT semantics (the orchestrator
    # body receives a non-None value either way).
    auto_run.add_argument(
        "--profile", choices=list(PROFILES),
        default=None,
        help="Autonomy profile (default: strict). 'autonomous' "
             "REQUIRES `--operator-approval-ref <ref>` and triggers "
             "preflight.verify_preflight fail-fast on any failure "
             "class. 'strict' soft-warns on preflight failure. "
             "'standard'/'observe'/'frozen' skip preflight + run the "
             "cycle under the profile's action-permission set. The "
             "CLI flag itself overrides the persisted profile via "
             "set_profile() so the runtime-profile-history.jsonl "
             "audit row records the operator gesture (closes "
             "6-validator audit C-2 SOC2 gap). Operator runbook "
             "docs/runbooks/aria-github-app-setup.md documents Mode A "
             "setup for the autonomous profile.",
    )
    # Plan ARIA-V3.1-E (E1) — required operator-approval-ref when the
    # CLI override transitions TO `autonomous`. argparse rejects
    # `--profile autonomous` without this flag.
    auto_run.add_argument(
        "--operator-approval-ref", default=None,
        help="Operator approval reference recorded in runtime-profile-"
             "history.jsonl when the CLI flag overrides the persisted "
             "profile. REQUIRED when `--profile autonomous` is "
             "specified — argparse fails fast on omission. For other "
             "profiles, defaults to `cli-flag:<runid>` so every CLI "
             "transition still produces an audit row (closes C-2 "
             "SOC2 gap; matches set_profile() control-plane contract).",
    )
    # K6 (ORPHAN-CRITICAL-727) — the `--implementer-poll-seconds` budget that
    # stood here is gone with the poll it bounded. The V9 implementation phase
    # mints its envelope and returns; the executor lane delivers in a later
    # run, so there is no wall-clock window for this lane to bound.
    auto_run.add_argument(
        "--output", choices=["summary", "full"], default="summary",
        help="Print bounded v2 summary by default; full requires --artifact.",
    )
    auto_run.add_argument(
        "--artifact", default=None,
        help="Path to write full autonomy output when --output full is selected.",
    )
    burn_in_parser = add_subparser(
        autonomy_sub,
        "burn-in",
        help="Enterprise autonomy burn-in commands that do not dispatch agents.",
    )
    burn_in_sub = burn_in_parser.add_subparsers(dest="burn_in_command", required=True)
    burn_in_observe = add_subparser(
        burn_in_sub,
        "observe",
        help="Run discovery/memory/pressure/triage observe cycles with no agent/tool/PR actions.",
    )
    burn_in_observe.add_argument("--workspace-root", required=True)
    burn_in_observe.add_argument("--workspace-base", required=True)
    burn_in_observe.add_argument("--target-ref", required=True)
    burn_in_observe.add_argument("--cycles", type=int, default=30)
    burn_in_observe.add_argument("--min-valid-cycles", type=int, default=20)
    burn_in_observe.add_argument("--output-dir", required=True)
    burn_in_accept = add_subparser(
        burn_in_sub,
        "accept",
        help="Record a PASSED observe burn-in report into the autonomy unlock ladder "
        "(operator step; fail-closed + idempotent; never grants autonomous merge).",
    )
    burn_in_accept.add_argument("--report", required=True, help="Path to autonomy-burn-in-report.json")
    burn_in_accept.add_argument("--mode", choices=["real", "mock"], default="real")
    unlock_parser = add_subparser(
        autonomy_sub, "unlock",
        help="Inspect the autonomy unlock ladder (acceptance-event thresholds, read-only).",
    )
    unlock_sub = unlock_parser.add_subparsers(dest="unlock_command", required=True)
    # No --lane flag: lane is kernel-derived (Plan ARIA-V3 §2c, invariant
    # I-V3-00b/29b). `status` reports the whole ladder (L1/L2/L3) read-only.
    add_subparser(unlock_sub, "status")
    auto_status = add_subparser(
        autonomy_sub, "status",
        help="Print the canonical AutonomyState derived from autonomy_state.jsonl.",
    )
    auto_status.add_argument(
        "--evidence",
        action="store_true",
        help="Derive immutable target-bound autonomy evidence status.",
    )
    auto_status.add_argument(
        "--target-sha",
        type=_full_git_sha,
        default=None,
        help="Full target commit SHA (valid only with --evidence; defaults to HEAD).",
    )
    auto_project_queue = add_subparser(autonomy_sub, "project-queue")
    auto_project_queue.add_argument("--limit", type=int, default=None)
    # No additional args — reducer reads from the bound tools dir.

    # Plan 020 Phase 4.C — fresh adapter orchestrator manual invocation.
    sp_refresh = add_subparser(spine_sub, "refresh",
                                      help="Plan 020 Phase 4 — re-run any spine adapter whose latest run is stale.")
    sp_refresh.add_argument("--workspace-root", default=".")
    sp_refresh.add_argument("--cycle-id", default=None)
    sp_refresh.add_argument("--freshness-max-age-seconds", type=int, default=600)
    sp_refresh.add_argument("--max-workers", type=int, default=1)

    # Plan 019 Phase 7 — Change Ledger CLI surface.
    change_parser = add_subparser(sub, 
        "change",
        help="Plan 019 Phase 7 — append-only change-ledger (planned/committed/validated chain).",
    )
    change_sub = change_parser.add_subparsers(dest="change_command", required=True)
    ch_plan = add_subparser(change_sub, "plan", help="Open a change chain (change_planned event).")
    ch_plan.add_argument("--plan-id", required=True)
    ch_plan.add_argument("--finding-id", required=True)
    ch_plan.add_argument("--intended-file", action="append", required=True,
                         help="Repeatable: each intended affected file.")
    ch_plan.add_argument("--intended-validation-ref", action="append", default=None,
                         help="Repeatable: validation refs the change will run.")
    ch_plan.add_argument("--rollback-ref", default=None)
    ch_plan.add_argument("--architectural-tier", type=int, required=True, choices=[1, 2, 3, 4])
    ch_plan.add_argument("--intended-request-id", default=None)
    ch_commit = add_subparser(change_sub, "commit", help="Record commit landing for a planned change.")
    ch_commit.add_argument("--change-id", required=True)
    ch_commit.add_argument("--commit-sha", required=True)
    ch_commit.add_argument("--actual-file", action="append", required=True)
    ch_commit.add_argument("--claim-id", default=None)
    # ORPHAN-721 — repeatable `path=reason`: the declared disposition for
    # every intended file the diff did not touch. The emitter refuses an
    # undeclared shortfall, so a partial implementation must say so here.
    ch_commit.add_argument(
        "--uncovered-disposition", action="append", default=[],
        metavar="PATH=REASON",
        help="Intended-but-untouched file with why it needs no change (repeatable).",
    )
    ch_validate = add_subparser(change_sub, "validate", help="Close a change chain with validation refs.")
    ch_validate.add_argument("--change-id", required=True)
    ch_validate.add_argument("--validation-ref", action="append", required=True)
    ch_validate.add_argument("--baseline-comparison-ref", default=None)
    ch_validate.add_argument("--invariants-file", default=None,
                             help="Optional JSON file with post_remediation_invariants dict.")
    ch_show = add_subparser(change_sub, "show", help="Get the {planned,committed,validated} blocks for a change_id.")
    ch_show.add_argument("--change-id", required=True)
    ch_list = add_subparser(change_sub, "list", help="List change chains, optionally filtered.")
    ch_list.add_argument("--plan-id", default=None)
    ch_list.add_argument("--finding-id", default=None)
    ch_find = add_subparser(change_sub, "find", help="Find chains that touched a specific file.")
    ch_find.add_argument("--file", required=True)

    metrics_parser = add_subparser(sub, 
        "metrics",
        help="Plan 016 Faz D7 — nine-counter metric set + dashboard writer.",
    )
    metrics_sub = metrics_parser.add_subparsers(dest="metrics_command", required=True)
    m_compute = add_subparser(metrics_sub, "plan-016")
    m_dashboard = add_subparser(metrics_sub, "dashboard")
    m_dashboard.add_argument("--workspace-root", default=None)
    m_dashboard.add_argument("--out", default=None)

    cycle_guard_parser = add_subparser(sub, 
        "cycle-guard",
        help="Plan 016 Faz D8 — empty-cycle guard advisor.",
    )
    cg_sub = cycle_guard_parser.add_subparsers(dest="cycle_guard_command", required=True)
    cg_eval = add_subparser(cg_sub, "evaluate")
    cg_eval.add_argument("--cycle-id", required=True)
    cg_eval.add_argument("--pressure-threshold", type=float, default=None)
    cg_eval.add_argument("--workspace-root", default=None)

    hr_parser = add_subparser(sub, 
        "human-required",
        help="Plan 016 Faz D9 — operator triage queue for HUMAN_REQUIRED escalations.",
    )
    hr_sub = hr_parser.add_subparsers(dest="human_required_command", required=True)
    hr_record = add_subparser(hr_sub, "record")
    hr_record.add_argument("--request-id", required=True)
    hr_record.add_argument("--severity", default=None)
    hr_record.add_argument("--reason", required=True, type=_validate_reason)
    hr_list = add_subparser(hr_sub, "list")
    hr_list.add_argument("--include-resolved", action="store_true")
    hr_resolve = add_subparser(hr_sub, "resolve")
    hr_resolve.add_argument("--request-id", required=True)
    hr_resolve.add_argument("--resolution-note", required=True)
    # The ONE wired human-verdict path into calibration ground truth
    # (Plan 024 §B fan-out in resolve_human_required) — and the CLI never
    # exposed the parameter, so the fan-out was dead from every keyboard.
    hr_resolve.add_argument("--verdict", default=None, choices=["true_positive", "false_positive"])
    hr_sweep = add_subparser(hr_sub, "sweep")
    consensus_parser = add_subparser(sub, 
        "consensus",
        help="Plan 016 Faz C5/C6 — compute consensus over recorded ai_judge verdicts.",
    )
    consensus_sub = consensus_parser.add_subparsers(dest="consensus_command", required=True)
    c_run = add_subparser(consensus_sub, 
        "run",
        help="Compute consensus for a tool_id (and optional cycle_id) over the existing feedback ledger.",
    )
    c_run.add_argument("--tool-id", required=True)
    c_run.add_argument("--cycle-id", default=None)
    c_run.add_argument("--min-confidence", type=float, default=None)

    # Plan ARIA-V3 §A5 — ack ledger CLI surface. ``ack init`` + ``ack
    # mint`` + ``ack rotate-key`` + ``ack revoke-key`` + ``ack verify``
    # + ``ack list-keys``. The HMAC key custody runbook lives at
    # docs/runbooks/aria-ack-key-rotation.md (Phase A0 deliverable).
    ack_parser = add_subparser(sub, "ack")
    ack_sub = ack_parser.add_subparsers(dest="ack_command", required=True)
    ack_init = add_subparser(ack_sub, "init",
        help="Mint the first HMAC key (Plan ARIA-V3 §A5).")
    ack_init.add_argument("--reason", required=True, type=_validate_reason)
    ack_init.add_argument("--operator-approval-ref", required=True)
    ack_init.add_argument("--force", action="store_true",
        help="DR-regenerate over an existing key (see runbook §4).")
    ack_mint = add_subparser(ack_sub, "mint",
        help="Operator-mint an ack token for a materialize.")
    ack_mint.add_argument("--draft-id", required=True)
    ack_mint.add_argument("--intent-id", required=True)
    ack_mint.add_argument("--target-path", required=True)
    ack_mint.add_argument("--kind", required=True, choices=["agent", "skill"])
    ack_mint.add_argument("--reason", required=True, type=_validate_reason)
    ack_mint.add_argument("--operator-approval-ref", required=True)
    ack_mint.add_argument("--operator-user-id", required=True)
    ack_mint.add_argument("--profile-state", default="standard")
    ack_mint.add_argument("--commit-sha", default="HEAD")
    ack_mint.add_argument("--parent-observation-id", default=None)
    ack_rotate = add_subparser(ack_sub, "rotate-key",
        help="Append a new HMAC key, retire the previous head.")
    ack_rotate.add_argument("--reason", required=True, type=_validate_reason)
    ack_rotate.add_argument("--operator-approval-ref", required=True)
    ack_rotate.add_argument("--emergency", action="store_true",
        help="Mark as emergency rotation (separate audit event).")
    ack_verify = add_subparser(ack_sub, "verify",
        help="Recompute HMAC over the rolling key list for last N rows.")
    ack_verify.add_argument("--range", default="last-50",
        help="``last-N`` or ``full``.")
    ack_list_keys = add_subparser(ack_sub, "list-keys",
        help="Print the rolling key list (secrets redacted).")

    # Plan ARIA-V4 §2e — inter-agent question envelope CLI surface.
    # ``aria-kernel question ask`` / ``answer`` / ``list``.
    question_parser = add_subparser(sub, "question")
    question_sub = question_parser.add_subparsers(
        dest="question_command", required=True,
    )
    q_ask = add_subparser(question_sub, "ask",
        help="Emit aria/agent-question/v1 row (Plan ARIA-V4 §2e).")
    q_ask.add_argument("--asker-agent-id", required=True)
    q_ask.add_argument("--target-agent-id", required=True)
    q_ask.add_argument(
        "--question-kind", required=True,
        choices=["tier_classification", "extrapolation_check", "invariant_grounding"],
    )
    q_ask.add_argument("--rule-text", required=True, type=_validate_reason)
    q_ask.add_argument(
        "--hypothesised-tier", required=True, type=int,
        choices=[1, 2, 3],
    )
    q_ask.add_argument(
        "--evidence-ref", required=True, action="append",
        help="file:line OR SPEC.md§X.Y — pass multiple times.",
    )
    q_ask.add_argument("--cycle-id", required=True)
    q_answer = add_subparser(question_sub, "answer",
        help="Emit aria/agent-question-response/v1 row.")
    q_answer.add_argument("--question-id", required=True)
    q_answer.add_argument("--answerer-agent-id", required=True)
    q_answer.add_argument(
        "--verdict", required=True,
        choices=["agreed", "disagreed", "refused"],
    )
    q_answer.add_argument(
        "--answered-tier", type=int, choices=[1, 2, 3], default=None,
        help="Required when verdict in {agreed, disagreed}.",
    )
    q_answer.add_argument(
        "--rationale", default="",
        type=lambda s: _validate_reason(s) if s else "",
    )
    q_answer.add_argument(
        "--counter-evidence-ref", action="append", default=[],
    )
    q_answer.add_argument(
        "--refusal-reason", default=None,
        choices=["scope", "evidence", "envelope", "operator_required"],
    )
    q_answer.add_argument("--cycle-id", required=True)
    q_list = add_subparser(question_sub, "list",
        help="List questions with optional filters.")
    q_list.add_argument("--cycle-id", default=None)
    q_list.add_argument("--asker-agent-id", default=None)
    q_list.add_argument("--target-agent-id", default=None)

    agent_genesis_parser = add_subparser(sub, "agent-genesis")
    agent_genesis_sub = agent_genesis_parser.add_subparsers(dest="agent_genesis_command", required=True)
    ag_draft = add_subparser(agent_genesis_sub, "draft")
    ag_draft.add_argument("--gap-id", required=True)
    ag_draft.add_argument("--operator-approval-ref", default=None,
                          help="C4-c: operator-provenance ref; with it the draft records its lifecycle chain (PRESSURE→…→DRAFT).")
    ag_sandbox = add_subparser(agent_genesis_sub, "sandbox")
    ag_sandbox.add_argument("--draft-id", required=True)
    # C4-b (ORPHAN-675) — exactly one evidence source: a ledger-derived
    # suite (preferred; assembler) or the legacy operator JSON file.
    ag_sandbox_src = ag_sandbox.add_mutually_exclusive_group(required=True)
    ag_sandbox_src.add_argument("--fixture-results-file")
    ag_sandbox_src.add_argument("--from-suite", metavar="EXECUTION_RUN_ID",
                                help="Assemble fixture_results from the fixture-runs.jsonl suite row.")
    ag_approve = add_subparser(agent_genesis_sub, "approve")
    ag_approve.add_argument("--draft-id", required=True)
    ag_approve.add_argument("--operator-approval-ref", required=True)
    ag_approve.add_argument("--operator-synthetic-override", action="store_true")
    ag_prepare = add_subparser(agent_genesis_sub, "prepare-pr-lane")
    add_workspace_args(ag_prepare)
    ag_prepare.add_argument("--draft-id", required=True)
    ag_prepare.add_argument("--cycle-id", default=None)
    ag_materialize = add_subparser(agent_genesis_sub, "materialize")
    add_workspace_args(ag_materialize)
    ag_materialize.add_argument("--draft-id", required=True)
    ag_materialize.add_argument("--assignment-id", required=True)
    # Plan ARIA-V3 §A4 + §2k — pre-V3 ``--acknowledge`` flag REMOVED.
    # Operators MUST first mint an ack token via
    # ``aria-kernel ack mint --draft-id ... --reason ...`` then pass
    # the returned ``ack_id`` via ``--ack-token``.
    ag_materialize.add_argument(
        "--ack-token", required=True,
        help="ack_id minted via `aria-kernel ack mint` (Plan ARIA-V3 §A5).",
    )
    ag_materialize.add_argument("--operator-synthetic-override", action="store_true")
    ag_materialize.add_argument("--run-invariants", action="store_true")
    # C4-d — real-mode bridge: one completed invocation → real eval →
    # DRAFT→REAL_SANDBOX→SHADOW with the verify_shadow_eval_proof chain.
    ag_shadow_bridge = add_subparser(agent_genesis_sub, "shadow-bridge")
    ag_shadow_bridge.add_argument("--invocation-id", required=True)
    ag_shadow_bridge.add_argument("--fixture-id", required=True)
    ag_shadow_bridge.add_argument("--fixture-run-id", required=True)
    ag_shadow_bridge.add_argument("--operator-approval-ref", required=True)
    ag_shadow_bridge.add_argument("--repo-root", default=None)
    ag_list = add_subparser(agent_genesis_sub, "list")
    ag_list.add_argument("--materializations", action="store_true")

    # Plan ARIA-V6 §3 V6.5 (C5) — specialist-review dry-run for CI
    # validation of the Lane-A inventory + role mapping.
    specialist_review_parser = add_subparser(sub, "specialist-review")
    specialist_review_sub = specialist_review_parser.add_subparsers(
        dest="specialist_review_command", required=True,
    )
    sr_dry = add_subparser(specialist_review_sub, "dry-run")
    sr_dry.add_argument(
        "--agents-dir", default=".claude/agents",
        help="Path to the .claude/agents directory (default: relative)",
    )
    sr_dry.add_argument(
        "--strict", action="store_true",
        help="Exit non-zero on inventory drift. C5 ships warn-mode "
             "by default (--strict flip is a separate commit once "
             "the Lane-A inventory is fully populated).",
    )

    skill_genesis_parser = add_subparser(sub, "skill-genesis")
    skill_genesis_sub = skill_genesis_parser.add_subparsers(dest="skill_genesis_command", required=True)
    sg_request = add_subparser(skill_genesis_sub, "request")
    sg_request.add_argument("--capability-gap-key", required=True)
    sg_request.add_argument("--title", required=True)
    # Plan ARIA-V6 §2d v2 — convergent authoring opt-in.
    sg_request.add_argument(
        "--convergent", action="store_true",
        help="Route through convergent_skill_authoring loop (V6.2). "
             "Requires --seed-file with the F-012-adapter-seeds.jsonl "
             "row contents.",
    )
    sg_request.add_argument(
        "--seed-file", default=None,
        help="Path to a JSON file containing the seed dict "
             "(declared_scope, claim_types, must_satisfy, "
             "calibration_corpus_path, adapter_lang). Required with "
             "--convergent.",
    )
    # Plan ARIA-V6 §2d v2 C3 — batch-mint convergent requests.
    sg_seed = add_subparser(skill_genesis_sub, "seed")
    sg_seed.add_argument("--from", dest="seeds_path", required=True,
                         help="Path to F-012-adapter-seeds.jsonl")
    sg_seed.add_argument(
        "--convergent", action="store_true",
        help="Mint each seed row as a convergent request. Required "
             "for V6.2 routing.",
    )
    sg_draft = add_subparser(skill_genesis_sub, "draft")
    sg_draft.add_argument("--request-id", required=True)
    sg_draft.add_argument("--name", required=True)
    sg_draft.add_argument("--description", required=True)
    sg_draft.add_argument("--owner", action="append", required=True)
    sg_draft.add_argument("--handoff-agent", action="append", required=True)
    sg_sandbox = add_subparser(skill_genesis_sub, "sandbox")
    sg_sandbox.add_argument("--draft-id", required=True)
    sg_sandbox_input = sg_sandbox.add_mutually_exclusive_group(required=True)
    sg_sandbox_input.add_argument("--markdown-file", default=None,
                                  help="Skill markdown source — parsed for ## Fixture: <id> blocks (preferred).")
    sg_sandbox_input.add_argument("--checklist-results-file", default=None,
                                  help="Explicit JSON checklist results array (deprecated; use --markdown-file).")
    sg_sandbox.add_argument("--synthetic-test-mode", action="store_true")
    sg_sandbox.add_argument("--operator-approval-ref", default=None)
    sg_approve = add_subparser(skill_genesis_sub, "approve")
    sg_approve.add_argument("--draft-id", required=True)
    sg_approve.add_argument("--operator-approval-ref", required=True)
    sg_approve.add_argument("--operator-synthetic-override", action="store_true")
    sg_materialize = add_subparser(skill_genesis_sub, "materialize")
    add_workspace_args(sg_materialize)
    sg_materialize.add_argument("--draft-id", required=True)
    sg_materialize.add_argument("--assignment-id", required=True)
    # Plan ARIA-V3 §A4 + §2k — pre-V3 ``--acknowledge`` flag REMOVED.
    sg_materialize.add_argument(
        "--ack-token", required=True,
        help="ack_id minted via `aria-kernel ack mint` (Plan ARIA-V3 §A5).",
    )
    sg_materialize.add_argument("--operator-synthetic-override", action="store_true")
    sg_materialize.add_argument("--run-invariants", action="store_true")
    sg_list = add_subparser(skill_genesis_sub, "list")
    sg_list.add_argument("--kind", choices=["requests", "drafts", "sandbox", "materializations"], default="drafts")

    worker_result = add_subparser(sub, "worker-result")
    worker_result_sub = worker_result.add_subparsers(dest="worker_result_command", required=True)
    worker_result_submit = add_subparser(worker_result_sub, "submit")
    worker_result_submit.add_argument("--assignment-id", default=None)
    worker_result_submit.add_argument("--from-worktree", required=True)
    worker_result_submit.add_argument("--validation-command", action="append", default=[])
    worker_result_submit.add_argument("--lease-token-from-env", default=None, metavar="ENV_VAR_NAME",
                                      help="Name of an environment variable that holds the worker lease_token.")
    worker_result_submit.add_argument("--lease-token", default=None)
    worker_result_submit.add_argument("--allow-legacy-no-token", action="store_true")

    verification_parser = add_subparser(sub, "verification")
    verification_sub = verification_parser.add_subparsers(dest="verification_command", required=True)
    verification_verify = add_subparser(verification_sub, "verify")
    verification_verify.add_argument("--assignment-id", required=True)
    verification_verify.add_argument("--auto-merge-eligible", action="store_true")

    curate_parser = add_subparser(sub, "curate")
    add_workspace_args(curate_parser)
    curate_parser.add_argument("--since", default="90d")
    curate_parser.add_argument("--apply", action="store_true")
    curate_parser.add_argument("--acknowledge", action="store_true")
    curate_parser.add_argument("--reason", default=None)
    curate_parser.add_argument("--cycle-id", default=None)

    # Plan 032 Faz 032a — one readout of ARIA's own health (read-only).
    doctor_parser = add_subparser(sub, "doctor")
    add_workspace_args(doctor_parser)
    doctor_parser.add_argument(
        "--json", action="store_true",
        help="Print the full report as JSON instead of the one-line-per-check text.",
    )

    # Plan 032 Faz 032b-2 — the Claude Code hook entry points. The CLI reads
    # the hook payload on stdin and prints the protocol's decision JSON.
    hook_parser = add_subparser(sub, "hook")
    hook_sub = hook_parser.add_subparsers(dest="hook_command", required=True)
    for verb in ("pre-tool", "post-tool", "session"):
        hook_verb = add_subparser(hook_sub, verb)
        hook_verb.add_argument("--workspace-root", required=True)
        hook_verb.add_argument("--request-id", required=True)

    # Plan 032 Faz 032c — checkpoints, sessions, recovery, search.
    checkpoint_parser = add_subparser(sub, "checkpoint")
    checkpoint_sub = checkpoint_parser.add_subparsers(dest="checkpoint_command", required=True)
    for verb in ("list", "diff", "restore", "take", "prune"):
        cp_verb = add_subparser(checkpoint_sub, verb)
        cp_verb.add_argument("--workspace-root", default=".")
        if verb != "prune":
            cp_verb.add_argument("--request-id", required=True)
        if verb in ("diff", "restore"):
            cp_verb.add_argument("--seq", type=int, default=None)
        if verb == "restore":
            cp_verb.add_argument("--file", action="append", default=None, dest="files")
            cp_verb.add_argument("--all-files", action="store_true", help="Restore every file the checkpoint holds (hand edits NOT preserved).")
        if verb == "take":
            cp_verb.add_argument("--reason", default="operator")
    session_parser = add_subparser(sub, "session")
    session_sub = session_parser.add_subparsers(dest="session_command", required=True)
    session_list = add_subparser(session_sub, "list")
    session_list.add_argument("--request-id", required=True)
    recovery_parser = add_subparser(sub, "recovery")
    recovery_sub = recovery_parser.add_subparsers(dest="recovery_command", required=True)
    recovery_classify = add_subparser(recovery_sub, "classify")
    recovery_classify.add_argument("--request-id", required=True)
    recovery_classify.add_argument("--workspace-root", default=".")
    recovery_classify.add_argument("--fingerprint", default=None)
    recovery_classify.add_argument("--offline", action="store_true", help="Do not ask GitHub; unresolved intents stay unresolved.")
    search_parser = add_subparser(sub, "search")
    search_parser.add_argument("query")
    search_parser.add_argument("--workspace-root", default=".")
    search_parser.add_argument("--kind", action="append", default=None, dest="kinds")
    search_parser.add_argument("--rebuild", action="store_true")
    search_parser.add_argument("--limit", type=int, default=20)

    # Plan 032 Faz 032d — delivery closure: what each implementation request
    # actually delivered, derived from effect ledgers.
    delivery_parser = add_subparser(sub, "delivery")
    delivery_sub = delivery_parser.add_subparsers(dest="delivery_command", required=True)
    delivery_status = add_subparser(delivery_sub, "status")
    delivery_status.add_argument("--json", action="store_true")

    # Plan 032 Faz 032e — operator control plane, notifications, live progress.
    control_parser = add_subparser(sub, "control")
    control_sub = control_parser.add_subparsers(dest="control_command", required=True)
    for verb in ("pause", "resume", "cancel"):
        verb_parser = add_subparser(control_sub, verb)
        verb_parser.add_argument("--request-id", default=None, required=(verb == "cancel"))
        verb_parser.add_argument("--reason", default="")
        verb_parser.add_argument("--operator-ref", default=None)
    add_subparser(control_sub, "status")
    notify_parser = add_subparser(sub, "notify")
    notify_sub = notify_parser.add_subparsers(dest="notify_command", required=True)
    notify_send = add_subparser(notify_sub, "send")
    notify_send.add_argument("--kind", required=True)
    notify_send.add_argument("--title", required=True)
    notify_send.add_argument("--body", default="")
    notify_send.add_argument("--key", default=None)
    notify_send.add_argument("--channel", action="append", default=None, dest="channels")
    notify_send.add_argument("--dry-run", action="store_true")
    add_subparser(notify_sub, "channels")
    tail_parser = add_subparser(sub, "tail")
    tail_parser.add_argument("request_id")
    tail_parser.add_argument("-n", "--last", type=int, default=20)
    tail_parser.add_argument("--follow", action="store_true")
    tail_parser.add_argument("--json", action="store_true")
    tail_parser.add_argument("--max-wait-seconds", type=float, default=None)

    # Plan 032 Faz 032f — event gateway, schedule table, offline event ingest.
    gateway_parser = add_subparser(sub, "gateway")
    gateway_sub = gateway_parser.add_subparsers(dest="gateway_command", required=True)
    gateway_serve = add_subparser(gateway_sub, "serve")
    gateway_serve.add_argument("--workspace-root", default=".")
    gateway_serve.add_argument("--host", default="127.0.0.1")
    gateway_serve.add_argument("--port", type=int, default=8787)
    gateway_serve.add_argument("--poll-interval-seconds", type=float, default=60.0)
    gateway_serve.add_argument("--max-iterations", type=int, default=None)
    gateway_serve.add_argument("--no-http", action="store_true", help="scheduler ticks only (no webhook listener)")
    add_subparser(gateway_sub, "status")
    schedule_parser = add_subparser(sub, "schedule")
    schedule_sub = schedule_parser.add_subparsers(dest="schedule_command", required=True)
    schedule_add = add_subparser(schedule_sub, "add")
    schedule_add.add_argument("--name", required=True)
    schedule_add.add_argument("--action", required=True)
    schedule_add.add_argument("--cron", required=True)
    schedule_add.add_argument("--operator-ref", default=None)
    for verb in ("pause", "resume", "remove"):
        verb_parser = add_subparser(schedule_sub, verb)
        verb_parser.add_argument("--name", required=True)
        verb_parser.add_argument("--operator-ref", default=None)
    add_subparser(schedule_sub, "list")
    schedule_run = add_subparser(schedule_sub, "run")
    schedule_run.add_argument("--action", required=True)
    schedule_run.add_argument("--workspace-root", default=".")
    event_parser = add_subparser(sub, "event")
    event_sub = event_parser.add_subparsers(dest="event_command", required=True)
    event_ingest = add_subparser(event_sub, "ingest")
    event_ingest.add_argument("--source", choices=["github", "alertmanager", "operator"], required=True)
    event_ingest.add_argument("--payload-file", required=True)
    event_ingest.add_argument("--github-event", default=None, help="X-GitHub-Event value for --source github")
    event_ingest.add_argument("--delivery-id", default=None)
    event_ingest.add_argument("--actor", default=None)
    event_ingest.add_argument("--route", action="store_true", help="route immediately instead of leaving it for the daemon")
    event_ingest.add_argument("--workspace-root", default=".")
    event_route = add_subparser(event_sub, "route")
    event_route.add_argument("--workspace-root", default=".")

    # Plan 032 Faz 032g — MCP: the kernel's own server + registry/health/config views.
    mcp_parser = add_subparser(sub, "mcp")
    mcp_sub = mcp_parser.add_subparsers(dest="mcp_command", required=True)
    mcp_serve = add_subparser(mcp_sub, "serve")
    mcp_serve.add_argument("--workspace-root", default=".")
    mcp_serve.add_argument("--allow-writes", action="store_true", help="operator only: expose human_required_resolve / runtime_signal_ingest")
    add_subparser(mcp_sub, "registry")
    mcp_health = add_subparser(mcp_sub, "health")
    mcp_health.add_argument("--server", default=None)
    mcp_release = add_subparser(mcp_sub, "release")
    mcp_release.add_argument("--server", required=True)
    mcp_release.add_argument("--operator-ref", required=True)
    mcp_config = add_subparser(mcp_sub, "config")
    mcp_config.add_argument("--profile", required=True)

    # Plan 032 Faz 032h — skill curation (proposals only), rollback, shadow compare; parity table.
    skill_parser = add_subparser(sub, "skill")
    skill_sub = skill_parser.add_subparsers(dest="skill_command", required=True)
    skill_curate = add_subparser(skill_sub, "curate")
    skill_curate.add_argument("--workspace-root", default=".")
    skill_curate.add_argument("--similarity", type=float, default=None)
    skill_curate.add_argument("--unused-days", type=int, default=None)
    skill_proposals = add_subparser(skill_sub, "proposals")
    skill_proposals.add_argument("--open", action="store_true")
    skill_decide = add_subparser(skill_sub, "decide")
    skill_decide.add_argument("--proposal-id", required=True)
    skill_decide.add_argument("--decision", choices=["accepted", "rejected"], required=True)
    skill_decide.add_argument("--operator-approval-ref", required=True)
    skill_decide.add_argument("--note", default="")
    skill_rollback = add_subparser(skill_sub, "rollback")
    skill_rollback.add_argument("--draft-id", required=True)
    skill_rollback.add_argument("--operator-approval-ref", required=True)
    skill_rollback.add_argument("--workspace-root", default=None)
    skill_shadow = add_subparser(skill_sub, "shadow-compare")
    skill_shadow.add_argument("--draft-id", required=True)
    skill_shadow.add_argument("--workspace-root", default=".")
    parity_parser = add_subparser(sub, "parity")
    parity_sub = parity_parser.add_subparsers(dest="parity_command", required=True)
    parity_generate = add_subparser(parity_sub, "generate")
    parity_generate.add_argument("--workspace-root", default=".")
    parity_generate.add_argument("--output", default="docs/aria/generated/harness-parity.md")
    parity_check = add_subparser(parity_sub, "check")
    parity_check.add_argument("--workspace-root", default=".")

    # Plan 032 Faz 032i — decision memory, token economy, self-improvement lane.
    context_compile = add_subparser(context_sub, "compile")
    context_compile.add_argument("--request-id", default=None)
    context_compile.add_argument("--query", default=None)
    context_compile.add_argument("--budget-tokens", type=int, default=None)
    economy_parser = add_subparser(sub, "economy")
    economy_sub = economy_parser.add_subparsers(dest="economy_command", required=True)
    economy_stats = add_subparser(economy_sub, "stats")
    economy_stats.add_argument("--window-days", type=int, default=None)
    economy_recommend = add_subparser(economy_sub, "recommend")
    economy_recommend.add_argument("--window-days", type=int, default=None)
    economy_recommend.add_argument("--threshold-tokens", type=float, default=None)
    economy_recommend.add_argument("--dry-run", action="store_true")
    self_parser = add_subparser(sub, "self-improve")
    self_sub = self_parser.add_subparsers(dest="self_command", required=True)
    self_scan = add_subparser(self_sub, "scan")
    self_scan.add_argument("--workspace-root", default=".")
    self_open = add_subparser(self_sub, "open")
    self_open.add_argument("--workspace-root", default=".")
    self_open.add_argument("--max-new", type=int, default=3)
    self_propose = add_subparser(self_sub, "propose")
    self_propose.add_argument("--workspace-root", default=".")
    self_propose.add_argument("--mission-id", required=True)
    self_propose.add_argument("--evidence", action="append", required=True, dest="evidence_paths")
    self_propose.add_argument("--problem", required=True)
    self_propose.add_argument("--proposed-change", required=True)
    self_propose.add_argument("--validation-command", default=None)

    # Plan 033 — Autonomous Security Engineering (kernel-internal). Grows per phase;
    # 033a ships the fail-closed prerequisite gate.
    security_parser = add_subparser(sub, "security")
    security_sub = security_parser.add_subparsers(dest="security_command", required=True)
    security_prereq = add_subparser(security_sub, "prerequisites")
    security_prereq.add_argument("--json", action="store_true")
    security_profile_p = add_subparser(security_sub, "profile")
    security_profile_sub = security_profile_p.add_subparsers(dest="security_profile_command", required=True)
    sp_compile = add_subparser(security_profile_sub, "compile")
    sp_compile.add_argument("--workspace-root", default=".")
    sp_compile.add_argument("--repo-sha", default=None)
    sp_compile.add_argument("--record", action="store_true")
    sp_compile.add_argument("--json", action="store_true")
    add_subparser(security_profile_sub, "show")

    return parser


def _main(argv: list[str] | None = None) -> int:
    # Plan 024 §F — root parser inherits --tools-dir via parents=[_TOOLS_DIR_PARENT].
    # The previous explicit add_argument("--tools-dir", default=None) was a
    # second registration site that drifted the help text and required
    # operators to type the flag BEFORE the subcommand. The parents-based
    # approach delivers a single SSoT and accepts the flag at every nesting
    # level. Required-validation moves to _TOOLS_DIR_REQUIRED_COMMANDS.
    parser = build_parser()
    args = parser.parse_args(argv)

    # Plan 024 §F + Plan ARIA-V3.3 §2a — post-parse path resolution +
    # required-validation. Resolution order at CLI entry:
    #   1. --tools-dir flag (already parsed by argparse if passed)
    #   2. ARIA_TOOLS_DIR env var
    #   3. Walk-up from cwd to <ancestor>/aria-tools/repo_identity.json
    # The required-commands check uses ONLY paths (1)+(2). Destructive
    # integrity migrations refuse to accept a walk-up-discovered tools
    # dir because the operator MUST name the target explicitly — a
    # walk-up resolution would silently rollback whatever tools dir
    # happened to be on the ancestor chain. Walk-up is a soft default
    # for normal commands, not a substitute for explicit operator
    # intent on destructive paths.
    # Pre-V3.3, downstream ``tools_dir(None)`` silently fell back to
    # ``Path("aria-tools")`` (CWD-relative), creating shadow
    # ``aria-kernel/aria-tools/`` trees when the kernel was invoked
    # from inside the aria-kernel subdir. V3.3 adds step (3) at the
    # CLI boundary so args.tools_dir is either an absolute path or
    # None, never a relative literal. If args.tools_dir remains None
    # and the command needs a tools root, downstream
    # tool_registry.tools_dir() raises ``tools_root_unresolvable``
    # with the bootstrap remediation pointer.
    cmd_path = _command_path(args)
    explicit_tools_dir = getattr(args, "tools_dir", None)
    if cmd_path in _TOOLS_DIR_REQUIRED_COMMANDS and not explicit_tools_dir:
        parser.error(
            f"--tools-dir is required explicitly for command {' '.join(cmd_path)}"
        )

    if getattr(args, "tools_dir", None):
        args.tools_dir = str(Path(args.tools_dir).resolve())
    elif os.environ.get("ARIA_TOOLS_DIR"):
        args.tools_dir = str(Path(os.environ["ARIA_TOOLS_DIR"]).resolve())
    else:
        from .tool_registry import _walk_up_to_bound_identity
        discovered = _walk_up_to_bound_identity(Path.cwd())
        args.tools_dir = str(discovered) if discovered is not None else None

    legacy_pressure_explain = (
        args.command == "pressure"
        and args.pressure_command == "explain"
        and bool(args.cycle_id)
        and bool(args.pressure_id)
    )
    paths = (
        resolve_paths(args)
        if hasattr(args, "workspace_root")
        # Plan 026R §F.1 — autonomy is NOT in this list: workspace_root
        # is optional for `autonomy run` (orchestrator handles None
        # internally — cycle.run_enterprise_cycle is the surface that
        # actually requires workspace_root, and operator-controlled
        # cycles supply it explicitly via --workspace-root).
        and args.command in {"feedback", "pressure", "curate", "telemetry", "worker", "agent-report", "triage", "worktree-prune", "worktree", "agent", "impact", "agent-network", "capability-gap", "plan", "agent-genesis", "skill-genesis"}
        and not legacy_pressure_explain
        else None
    )

    if args.command == "cycle":
        if getattr(args, "cycle_command", None) == "run":
            if getattr(args, "progress", False):
                # The cycle's env-gated progress emitter reads this; --progress
                # is just the operator-facing front door for ARIA_CYCLE_PROGRESS.
                os.environ["ARIA_CYCLE_PROGRESS"] = "1"
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

    if args.command == "feedback" and args.feedback_command == "record":
        from aria_kernel.feedback_store import record_operator_feedback
        print(json.dumps(record_operator_feedback(
            tool_id=args.tool_id,
            run_id=args.run_id,
            finding_id=args.finding_id,
            verdict=args.verdict,
            severity=args.severity,
            note=args.note,
            finding_fingerprint=args.finding_fingerprint,
            base_dir=args.tools_dir,
        ), indent=2, sort_keys=True))
        return 0

    if args.command == "feedback" and args.feedback_command == "record-batch":
        from aria_kernel.feedback_store import record_operator_feedback_batch
        payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
        print(json.dumps(record_operator_feedback_batch(
            sample_id=args.sample_id,
            verdict_payload=payload,
            base_dir=args.tools_dir,
        ), indent=2, sort_keys=True))
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

    if args.command == "cost-breaker" and args.cost_breaker_command == "status":
        # Spend is DERIVED from the cost-attribution ledger, so status cannot
        # disagree with what the gate enforces — both call derived_usage.
        from aria_kernel.cost_budget import (
            _load_caps,
            current_state as _cost_current_state,
            derived_usage,
        )

        daily_usd, monthly_usd = derived_usage(args.tools_dir)
        caps = _load_caps(args.tools_dir)
        state = _cost_current_state(args.tools_dir)
        print(
            json.dumps(
                {
                    "state": state,
                    "daily_usd": round(daily_usd, 6),
                    "monthly_usd": round(monthly_usd, 6),
                    "caps": caps,
                },
                indent=2,
                sort_keys=True,
            ),
        )
        return 0 if state == "ok" else 1

    if args.command == "cost-breaker" and args.cost_breaker_command == "reset":
        from aria_kernel.cost_budget import reset_breaker as _cost_reset

        if not args.acknowledge:
            print(
                "cost-breaker reset requires --acknowledge: it clears a cost "
                "stop without changing the caps that produced it",
            )
            return 2
        result = _cost_reset(
            base_dir=args.tools_dir,
            operator_approval_ref=args.operator_approval_ref,
            reason=args.reason,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "breaker" and args.breaker_command == "status":
        # ORPHAN-CRITICAL-420 S4 — evaluate_breaker returns the verdict rather
        # than current_state's bare string, because an operator deciding whether
        # to reset needs the failure rows and the threshold that produced the
        # verdict, not just "tripped".
        from aria_kernel.circuit_breaker import evaluate_breaker

        verdict = evaluate_breaker(args.tools_dir)
        print(
            json.dumps(
                {
                    "state": verdict.state,
                    "reason": verdict.reason,
                    "sliding_count": verdict.sliding_count,
                    "threshold": verdict.threshold,
                    "window_hours": verdict.window_hours,
                },
                indent=2,
                sort_keys=True,
            ),
        )
        # Exit 1 on tripped so a shell caller can gate on it without parsing
        # JSON; a tripped breaker is a non-zero condition by construction.
        return 0 if verdict.state == "ok" else 1

    if args.command == "breaker" and args.breaker_command == "reset":
        from aria_kernel.circuit_breaker import reset_breaker

        if not args.acknowledge:
            print(
                "breaker reset requires --acknowledge: it truncates the 24h "
                "failure window, discarding the evidence that tripped it",
            )
            return 2
        result = reset_breaker(
            base_dir=args.tools_dir,
            operator_approval_ref=args.operator_approval_ref,
            reason=args.reason,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "breaker" and args.breaker_command == "quarantine":
        from aria_kernel.circuit_breaker import quarantine_breaker_evidence

        if not args.acknowledge:
            print(
                "breaker quarantine requires --acknowledge: it moves undecodable "
                "ledger rows to a sidecar. Every decodable row is KEPT and the "
                "breaker is NOT cleared — it re-derives from the survivors and "
                "stays tripped if they still exceed the threshold.",
            )
            return 2
        result = quarantine_breaker_evidence(
            base_dir=args.tools_dir,
            operator_approval_ref=args.operator_approval_ref,
            reason=args.reason,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        # A no-op is not a failure, but a still-tripped breaker must not exit 0
        # as though recovery finished: the operator has more to do.
        if result.get("breaker_state_after") == "tripped":
            return 1
        return 0

    if args.command == "mission" and args.mission_command == "next":
        from .mission_scheduler import select_next_mission

        decision = select_next_mission(base_dir=args.tools_dir, record=not args.dry_run)
        print(json.dumps(decision.as_event(), indent=2, sort_keys=True))
        return 0

    if args.command == "readiness" and args.readiness_command == "produce-workflow-proofs":
        from .readiness_proofs import produce_workflow_run_proofs

        result = produce_workflow_run_proofs(
            pr_number=args.pr_number,
            repo=args.repo,
            target_ref=args.target_ref,
            head_ref=args.head_ref,
            head_sha=args.head_sha,
            readiness_claim_id=args.readiness_claim_id,
            base_dir=args.tools_dir,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "readiness" and args.readiness_command == "produce-branch-protection-proof":
        from .readiness_proofs import produce_branch_protection_proof

        result = produce_branch_protection_proof(
            pr_number=args.pr_number,
            repo=args.repo,
            target_ref=args.target_ref,
            head_ref=args.head_ref,
            head_sha=args.head_sha,
            readiness_claim_id=args.readiness_claim_id,
            base_dir=args.tools_dir,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "readiness" and args.readiness_command == "record-ci-report":
        from .ci import record_ci_report

        github = json.loads(Path(args.github_file).read_text(encoding="utf-8"))
        pr = json.loads(Path(args.pr_file).read_text(encoding="utf-8"))
        result = record_ci_report(
            pr=pr, github=github, cycle_id=args.cycle_id, base_dir=args.tools_dir,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "readiness" and args.readiness_command == "produce-claim":
        from .readiness_proofs import produce_readiness_claim

        artifact = json.loads(Path(args.artifact_file).read_text(encoding="utf-8"))
        surfaces = json.loads(Path(args.surfaces_file).read_text(encoding="utf-8"))
        result = produce_readiness_claim(
            pr_number=args.pr_number,
            repo=args.repo,
            target_ref=args.target_ref,
            head_ref=args.head_ref,
            head_sha=args.head_sha,
            workflow_id=args.workflow_id,
            job_id=args.job_id,
            workflow_run_id=args.workflow_run_id,
            cycle_id=args.cycle_id,
            artifact=artifact,
            surface_paths=surfaces,
            workspace_root=args.workspace_root,
            owner=args.owner,
            base_dir=args.tools_dir,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "closure-reachability":
        from .closure_reachability import scan_closure_reachability, write_baseline

        if args.write:
            payload = write_baseline(".", owner=args.owner, reason=args.reason)
            print(json.dumps(payload, indent=2, sort_keys=True))
            return 0
        report = scan_closure_reachability(".")
        print(json.dumps(report.as_dict(), indent=2, sort_keys=True))
        # A pinned baseline entry that became reachable is good news, not a
        # failure — the shrink lands with the next --write.
        return 1 if report.violations else 0

    if args.command == "state":
        return _handle_state_command(args)

    if args.command == "twin":
        from .twin import build_twin_map, read_twin_map, refresh_twin_map, twin_context_for_files, twin_status

        if args.twin_command == "build":
            result = build_twin_map(
                workspace_root=args.workspace_root,
                base_dir=args.tools_dir,
                nx_graph_file=args.nx_graph_file,
            )
            print(json.dumps({"indexed_sha": result["indexed_sha"], "stats": result["stats"]}, indent=2, sort_keys=True))
            return 0
        if args.twin_command == "refresh":
            result = refresh_twin_map(
                workspace_root=args.workspace_root,
                base_dir=args.tools_dir,
                nx_graph_file=args.nx_graph_file,
            )
            print(json.dumps({"indexed_sha": result["indexed_sha"], "refresh": result.get("refresh"), "stats": result["stats"]}, indent=2, sort_keys=True))
            return 0
        if args.twin_command == "status":
            print(json.dumps(twin_status(workspace_root=args.workspace_root, base_dir=args.tools_dir), indent=2, sort_keys=True))
            return 0
        if args.twin_command == "context":
            twin = read_twin_map(base_dir=args.tools_dir)
            if twin is None:
                print(json.dumps({"error": "twin_map_absent", "hint": "run `twin build` first"}, sort_keys=True))
                return 1
            print(json.dumps(twin_context_for_files(twin, list(args.files)), indent=2, sort_keys=True))
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

    if args.command == "integrity" and args.integrity_command == "migrate-tools-v2-to-v3":
        result = migrate_tools_v2_to_v3(
            tools_dir=args.tools_dir,
            workspace_root=args.workspace_root,
            acknowledge=args.acknowledge,
            reason=args.reason,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "integrity" and args.integrity_command == "migrate-tools-bootstrap":
        result = migrate_tools_bootstrap(
            tools_dir=args.tools_dir,
            workspace_root=args.workspace_root,
            acknowledge=args.acknowledge,
            reason=args.reason,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "integrity" and args.integrity_command == "bind-tools-root":
        result = bind_tools_root(
            tools_dir=args.tools_dir,
            workspace_root=args.workspace_root,
            reason=args.reason,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "integrity" and args.integrity_command == "rollback-tools-v3-to-v2":
        result = rollback_tools_v3_to_v2(
            tools_dir=args.tools_dir,
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

    if args.command == "tool" and args.tool_command == "unquarantine":
        from aria_kernel.tool_registry import unquarantine_tool
        print(json.dumps(unquarantine_tool(
            args.tool_id,
            operator_approval_ref=args.operator_approval_ref,
            reason=args.reason,
            root_cause_note=args.root_cause_note,
            fixture_update_ref=args.fixture_update_ref,
            base_dir=args.tools_dir,
        ), indent=2, sort_keys=True))
        return 0

    if args.command == "tool" and args.tool_command == "promote":
        from aria_kernel.promotion import promote_tool
        print(json.dumps(promote_tool(
            args.tool_id,
            args.target_status,
            reason=args.reason,
            operator_approval_ref=args.operator_approval_ref,
            panel_approval_ref=args.panel_approval_ref,
            base_dir=args.tools_dir,
        ), indent=2, sort_keys=True))
        return 0

    if args.command == "tool" and args.tool_command == "veto-promotion":
        from aria_kernel.promotion_veto import veto_promotion
        print(json.dumps(veto_promotion(
            tool_id=args.tool_id,
            reason=args.reason,
            operator_ref=args.operator_ref,
            base_dir=args.tools_dir,
        ), indent=2, sort_keys=True))
        return 0

    if args.command == "tool" and args.tool_command == "run":
        payload = json.loads(args.input)
        result = run_tool(
            args.tool_id, payload, args.cycle_id,
            workspace_root=args.workspace_root, base_dir=args.tools_dir,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        # Plan 024 v3 §B-7 — exit code reflects envelope status (the
        # canonical ok|crash|schema_error|... vocabulary), NOT the
        # registry status (ACTIVE|SHADOW|QUARANTINED). Operator scripts
        # can pattern-match exit code for failure detection.
        envelope_status = (result.get("envelope") or {}).get("status", "ok")
        return _TOOL_RUN_EXIT_CODES.get(envelope_status, 1)

    if args.command == "runner-attestation" and args.attestation_command == "probe":
        # FAZ 5a — lane-start producer: one probed attestation row per
        # recorded readiness claim, keyed exactly as the merge gate reads.
        from aria_kernel.runner_attestation import (
            probe_runner_attestations_for_claims,
        )
        result = probe_runner_attestations_for_claims(
            base_dir=args.tools_dir,
            repo=args.repo,
            target_ref=args.target_ref,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "registry" and args.registry_command == "compile":
        try:
            result = compile_registry(
                adapters_dir=args.adapters_dir,
                output=args.output,
                check=args.check,
            )
        except GovernanceError as exc:
            print(json.dumps({"status": "failed", "error": str(exc)}, indent=2, sort_keys=True))
            return 1
        print(json.dumps({
            "status": "ok",
            "tool_count": len(result.get("tools", [])),
            "output": args.output,
            "check": bool(args.check),
        }, indent=2, sort_keys=True))
        return 0

    # Plan 020 Phase 8.C — validation matrix CLI dispatch.
    if args.command == "validation-matrix" and args.validation_matrix_command == "check":
        # ORPHAN-696 — candidate refs come from the LEDGER, never a file an
        # operator typed. Only rows the single writer stamped `ok` qualify
        # as pass evidence; the gate still decides whether the required
        # commands are among them.
        from aria_kernel.validation_runs_ledger import list_validation_runs_for_change

        candidate_refs = [
            {
                "cmd": row.get("cmd"),
                "exit_code": row.get("exit_code"),
                "log_path": row.get("log_path"),
                "ran_at": row.get("recorded_at"),
            }
            for row in list_validation_runs_for_change(args.change_id, base_dir=args.tools_dir)
            if row.get("status") == "ok"
        ]
        try:
            result = enforce_validation_matrix(
                change_id=args.change_id,
                base_dir=args.tools_dir,
                repo_root=args.repo_root,
                candidate_refs=candidate_refs,
                validation_mode=args.validation_mode,
            )
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        except GovernanceError as exc:
            # Surface the matrix detail for operator triage; CI fails-closed.
            print(json.dumps({"blocked": True, "error": str(exc)}, indent=2, sort_keys=True))
            return 1
    if args.command == "validation-matrix" and args.validation_matrix_command == "list-required":
        rows = list_required_tests(args.risk_type)
        print(json.dumps(rows, indent=2, sort_keys=True))
        return 0

    # Plan 020 Phase 7.C — agent compliance CLI dispatch.
    if args.command == "agent-compliance" and args.agent_compliance_command == "grade":
        request = json.loads(Path(args.request_file).read_text(encoding="utf-8"))
        response = json.loads(Path(args.response_file).read_text(encoding="utf-8"))
        response_path = Path(args.response_path) if args.response_path else None
        result = record_compliance_grade(
            claim_id=args.claim_id,
            request=request,
            response=response,
            response_path=response_path,
            workspace_root=Path(args.workspace_root).resolve(),
            base_dir=args.tools_dir,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    if args.command == "agent-compliance" and args.agent_compliance_command == "list":
        rows = list_compliance_grades(
            base_dir=args.tools_dir,
            claim_id=args.claim_id,
            rejected_only=args.rejected_only,
            limit=args.limit,
        )
        print(json.dumps(rows, indent=2, sort_keys=True))
        return 0

    # Plan 020 Phase 6.C — agent eval CLI dispatch.
    if args.command == "agent-eval" and args.agent_eval_command == "add-fixture":
        fixture = json.loads(Path(args.fixture_file).read_text(encoding="utf-8"))
        result = eval_add_fixture(fixture=fixture, base_dir=args.tools_dir)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    if args.command == "agent-eval" and args.agent_eval_command == "run":
        mock_mode = not args.no_mock_mode
        envelope = None
        if not mock_mode:
            if not args.real_envelope_file:
                parser.error("--no-mock-mode requires --real-envelope-file")
            envelope = json.loads(Path(args.real_envelope_file).read_text(encoding="utf-8"))

        def _source_ref_arg(value: str | None) -> dict[str, Any] | None:
            if value is None:
                return None
            candidate = Path(value)
            if candidate.exists():
                return json.loads(candidate.read_text(encoding="utf-8"))
            return json.loads(value)

        run = run_agent_eval(
            fixture_id=args.fixture_id,
            base_dir=args.tools_dir,
            mock_mode=mock_mode,
            real_response_envelope=envelope,
            invocation_id=args.invocation_id,
            transcript_hash=args.transcript_hash,
            operator_approval_ref=args.operator_approval_ref,
            request_ledger_ref=_source_ref_arg(args.request_ledger_ref),
            claim_ledger_ref=_source_ref_arg(args.claim_ledger_ref),
            result_ledger_ref=_source_ref_arg(args.result_ledger_ref),
            fixture_ledger_ref=_source_ref_arg(args.fixture_ledger_ref),
            transcript_ledger_ref=_source_ref_arg(args.transcript_ledger_ref),
            operator_approval_ledger_ref=_source_ref_arg(args.operator_approval_ledger_ref),
            context_ledger_ref=_source_ref_arg(args.context_ledger_ref),
            prompt_ledger_ref=_source_ref_arg(args.prompt_ledger_ref),
        )
        print(json.dumps(run, indent=2, sort_keys=True))
        return 0
    if args.command == "agent-eval" and args.agent_eval_command == "aggregate":
        mock_filter: Any = None
        if args.mock_mode == "true":
            mock_filter = True
        elif args.mock_mode == "false":
            mock_filter = False
        result = aggregate_eval_metrics(
            target_agent=args.target_agent,
            base_dir=args.tools_dir,
            window_days=args.window_days,
            mock_mode=mock_filter,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    if args.command == "agent-eval" and args.agent_eval_command == "delta":
        from .agent_eval import MIN_RUNS_FOR_TREND, compare_eval_windows
        delta_mock: Any = None
        if args.mock_mode == "true":
            delta_mock = True
        elif args.mock_mode == "false":
            delta_mock = False
        result = compare_eval_windows(
            target_agent=args.target_agent,
            base_dir=args.tools_dir,
            window_days=args.window_days,
            mock_mode=delta_mock,
            min_runs=args.min_runs if args.min_runs is not None else MIN_RUNS_FOR_TREND,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        # A regression is not a crash, but it must not read as success to a
        # workflow that only checks the exit code.
        return 1 if result["verdict"] == "regressed" else 0

    if args.command == "agent-eval" and args.agent_eval_command == "list":
        mock_filter = None
        if args.mock_mode == "true":
            mock_filter = True
        elif args.mock_mode == "false":
            mock_filter = False
        rows = list_eval_runs(
            base_dir=args.tools_dir,
            target_agent=args.target_agent,
            fixture_id=args.fixture_id,
            mock_mode=mock_filter,
            limit=args.limit,
        )
        print(json.dumps(rows, indent=2, sort_keys=True))
        return 0
    if args.command == "agent-eval" and args.agent_eval_command == "list-fixtures":
        rows = eval_list_fixtures_fn(base_dir=args.tools_dir)
        print(json.dumps(rows, indent=2, sort_keys=True))
        return 0
    # Plan 023 v3 §D-1 — shadow-sample CLI dispatch.
    if args.command == "agent-eval" and args.agent_eval_command == "shadow-sample":
        from .agent_eval import sample_shadow_raw_findings, SHADOW_SAMPLE_THRESHOLD_24H
        threshold = args.threshold if args.threshold is not None else SHADOW_SAMPLE_THRESHOLD_24H
        result = sample_shadow_raw_findings(
            base_dir=args.tools_dir, threshold_24h=threshold,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    # Plan 020 Phase 3.B — handoff CLI dispatch.
    if args.command == "handoff" and args.handoff_command == "snapshot":
        snap = take_handoff_snapshot(
            session_id=args.session_id,
            trigger=args.trigger,
            base_dir=args.tools_dir,
            repo_root=args.repo_root,
            operator_note=args.operator_note,
        )
        print(json.dumps(snap, indent=2, sort_keys=True))
        return 0
    if args.command == "handoff" and args.handoff_command == "list":
        rows = list_handoffs(
            base_dir=args.tools_dir,
            session_id=args.session_id,
            trigger=args.trigger,
            limit=args.limit,
        )
        print(json.dumps(rows, indent=2, sort_keys=True))
        return 0
    if args.command == "handoff" and args.handoff_command == "read":
        snap = read_handoff(session_id=args.session_id, base_dir=args.tools_dir)
        print(json.dumps(snap, indent=2, sort_keys=True))
        return 0

    # Plan 020 Phase 2.C — context budget CLI dispatch.
    if args.command == "context" and args.context_command == "audit":
        request_payload: Any = {}
        if args.request_file:
            request_payload = json.loads(Path(args.request_file).read_text(encoding="utf-8"))
        runner = enforce_context_budget if args.enforce else audit_dispatch_context
        result = runner(
            request=request_payload,
            target_agent=args.target_agent,
            role=args.role,
            base_dir=args.tools_dir,
            repo_root=args.repo_root,
            context_window_tokens_override=args.context_window_tokens,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    if args.command == "context" and args.context_command == "list":
        rows = list_context_audits(
            base_dir=args.tools_dir,
            target_agent=args.target_agent,
            limit=args.limit,
        )
        print(json.dumps(rows, indent=2, sort_keys=True))
        return 0

    # Plan 020 Phase 1.C — runtime profile CLI dispatch.
    if args.command == "profile" and args.profile_command == "set":
        result = set_profile(
            args.profile,
            operator_approval_ref=args.operator_approval_ref,
            base_dir=args.tools_dir,
            set_by=args.set_by,
            scheduler_ceiling=args.scheduler_ceiling,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    if args.command == "profile" and args.profile_command == "get":
        # ORPHAN-HIGH-728 — the ceiling is reported beside the active profile
        # because they are one answer to "how much may ARIA do": an operator
        # reading only `active_profile` cannot tell whether tonight's lane is
        # standard because the ladder is short or because they capped it.
        print(json.dumps({
            "active_profile": get_profile(base_dir=args.tools_dir),
            "scheduler_profile_ceiling": get_scheduler_profile_ceiling(
                base_dir=args.tools_dir,
            ),
        }, indent=2, sort_keys=True))
        return 0
    if args.command == "profile" and args.profile_command == "history":
        print(json.dumps(list_profile_history(base_dir=args.tools_dir), indent=2, sort_keys=True))
        return 0

    if args.command == "runtime" and args.runtime_command == "signal":
        # W-A of the dataflow-integrity watchdog: the bridge existed since
        # Plan 029 but had NO CLI, so no probe or workflow could feed it
        # without importing the kernel. These verbs are the missing mouth.
        from .runtime_signal_bridge import (
            ingest_runtime_signal,
            load_open_runtime_signals,
            resolve_runtime_signal,
        )
        if args.runtime_signal_command == "ingest":
            row = ingest_runtime_signal(
                source=args.source, service=args.service,
                summary=args.summary, code_refs=args.code_refs,
                severity=args.severity, base_dir=args.tools_dir,
            )
        elif args.runtime_signal_command == "resolve":
            row = resolve_runtime_signal(
                signal_id=args.signal_id,
                resolution_note=args.resolution_note,
                base_dir=args.tools_dir,
            )
        else:
            row = load_open_runtime_signals(base_dir=args.tools_dir)
        print(json.dumps(row, indent=2, sort_keys=True, default=str))
        return 0

    if args.command == "goldset":
        from .goldset import (
            DEFAULT_TARGET_KNOWN_FALSE_POSITIVES,
            DEFAULT_TARGET_TRUE_POSITIVES,
            list_goldset_proposals,
            load_active_goldset,
            promote_goldset_proposal,
            propose_goldset,
        )
        if args.goldset_command == "propose":
            result = propose_goldset(
                tool_id=args.tool_id,
                cycle_id=args.cycle_id,
                target_true_positives=(
                    args.target_true_positives
                    if args.target_true_positives is not None
                    else DEFAULT_TARGET_TRUE_POSITIVES
                ),
                target_known_false_positives=(
                    args.target_known_false_positives
                    if args.target_known_false_positives is not None
                    else DEFAULT_TARGET_KNOWN_FALSE_POSITIVES
                ),
                base_dir=args.tools_dir,
            )
        elif args.goldset_command == "list":
            rows = list_goldset_proposals(base_dir=args.tools_dir)
            result = [r for r in rows if args.tool_id is None or r.get("tool_id") == args.tool_id]
        elif args.goldset_command == "promote":
            result = promote_goldset_proposal(
                tool_id=args.tool_id, curator=args.curator, base_dir=args.tools_dir,
            )
        else:
            result = load_active_goldset(tool_id=args.tool_id, base_dir=args.tools_dir)
        print(json.dumps(result, indent=2, sort_keys=True, default=str))
        return 0

    if args.command == "runtime" and args.runtime_command == "verify-artifacts":
        result = verify_runtime_artifacts(
            base_dir=args.tools_dir,
            workspace_root=args.workspace_root,
            cycle_id=args.cycle_id,
        )
        if args.require_artifact_bearing:
            if not args.cycle_id:
                result = {
                    **result,
                    "status": "failed",
                    "valid": False,
                    "issues": list(result.get("issues", [])) + [
                        {"code": "require_artifact_bearing_needs_cycle_id"},
                    ],
                }
            else:
                evidence = classify_cycle_evidence(
                    base_dir=args.tools_dir, cycle_id=args.cycle_id,
                )
                result["cycle_evidence"] = evidence
                if evidence.get("cycle_evidence_class") != ARTIFACT_BEARING:
                    result["status"] = "failed"
                    result["valid"] = False
                    result["issues"] = list(result.get("issues", [])) + [
                        {
                            "code": "cycle_not_artifact_bearing",
                            "cycle_evidence_class": evidence.get("cycle_evidence_class"),
                        },
                    ]
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("status") == "ok" else 4
    if args.command == "runtime" and args.runtime_command == "promotion":
        if args.runtime_promotion_command == "approve-v2":
            result = approve_runtime_v2_promotion(
                evidence_bundle=args.evidence_bundle,
                operator_approval_ref=args.operator_approval_ref,
                workspace_root=args.workspace_root,
                base_dir=args.tools_dir,
            )
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        parser.error("unknown runtime promotion command")
    if args.command == "runtime" and args.runtime_command == "retention":
        if args.runtime_retention_command == "dry-run":
            result = retention_dry_run(base_dir=args.tools_dir, retain_hot_cycles=args.retain_hot_cycles)
        else:
            result = retention_apply(
                base_dir=args.tools_dir,
                retain_hot_cycles=args.retain_hot_cycles,
                acknowledge=args.acknowledge,
                workspace_root=args.workspace_root,
                reason=args.reason,
                operator_approval_ref=args.operator_approval_ref,
            )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    if args.command == "runtime" and args.runtime_command == "restore-artifact":
        result = restore_artifact(
            base_dir=args.tools_dir,
            artifact_ref=args.artifact_ref,
            workspace_root=args.workspace_root,
            reason=args.reason,
            operator_approval_ref=args.operator_approval_ref,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    if args.command == "runtime" and args.runtime_command == "rollback-retention":
        result = rollback_retention(
            base_dir=args.tools_dir,
            manifest_id=args.manifest_id,
            workspace_root=args.workspace_root,
            reason=args.reason,
            operator_approval_ref=args.operator_approval_ref,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "memory" and args.memory_command == "withdraw":
        print(json.dumps(withdraw_belief(belief_id=args.belief_id, reason=args.reason, base_dir=args.tools_dir), indent=2, sort_keys=True))
        return 0

    if args.command == "memory" and args.memory_command == "rebuild-fates":
        result = rebuild_fates(
            cycle_id=args.cycle_id,
            workspace_root=args.workspace_root,
            workspace_base=args.workspace_base,
            base_dir=args.tools_dir,
            reason=args.reason,
            acknowledge=args.acknowledge,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "memory" and args.memory_command == "reset":
        result = reset_memory(
            workspace_root=args.workspace_root,
            workspace_base=args.workspace_base,
            backup_to=args.backup_to,
            base_dir=args.tools_dir,
            reason=args.reason,
            acknowledge=args.acknowledge,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "pressure" and args.pressure_command == "weights":
        from .pressure import SOURCE_WEIGHTS, effective_source_weights, load_weight_overrides
        eff = effective_source_weights(args.tools_dir)
        ov = load_weight_overrides(args.tools_dir)
        print(json.dumps({
            "effective": eff,
            "overridden_sources": sorted(ov),
            "base": SOURCE_WEIGHTS,
        }, indent=2, sort_keys=True))
        return 0

    if args.command == "pressure" and args.pressure_command == "weight-override":
        from .pressure import record_weight_override
        row = record_weight_override(
            source=args.source,
            weight=args.weight,
            reason=args.reason,
            operator_approval_ref=args.operator_approval_ref,
            base_dir=args.tools_dir,
        )
        print(json.dumps(row, indent=2, sort_keys=True))
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

    if (
        args.command == "scheduler"
        and args.scheduler_command == "planner-dispatch"
        and args.planner_dispatch_command == "run"
    ):
        # Plan 025 §D — autonomous planner dispatcher daemon entry.
        # workspace_root falls back to paths.repo_root when paths is
        # bound (worktree-aware); otherwise to the explicit argv path.
        from .autonomous_planner_dispatcher import run_planner_dispatch_daemon
        workspace = (
            paths.repo_root if paths is not None
            else Path(args.workspace_root).resolve()
        )
        roles = tuple(
            r.strip() for r in args.roles.split(",") if r.strip()
        )
        if not roles:
            parser.error("--roles must contain at least one planner role")
        result = run_planner_dispatch_daemon(
            base_dir=args.tools_dir,
            workspace_root=workspace,
            max_iterations=args.max_iterations,
            poll_interval_seconds=args.poll_interval_seconds,
            daemon_id=args.daemon_id,
            roles=roles,
            lease_seconds=args.lease_seconds,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("exits_clean") else 1

    if (
        args.command == "scheduler"
        and args.scheduler_command == "worker-dispatch"
        and args.worker_dispatch_command == "run"
    ):
        # Plan 025 §E — autonomous worker scheduler daemon entry.
        # Mirrors the planner-dispatch wiring above.
        # Plan ARIA-V3 §A2 — github_adapter is REQUIRED. Factory
        # derives Recording (observe/standard/frozen) vs GhCli
        # (strict/autonomous) from the runtime profile.
        from .autonomous_worker_scheduler import run_worker_scheduler_daemon
        from .github_adapters import select_github_adapter
        # Plan ARIA-V3.1 §2a — ``get_profile`` is imported at module
        # level (line 105). A nested re-import here previously made
        # ``get_profile`` LOCAL to ``_main`` for the WHOLE function
        # body (Python scoping rule), which silently broke earlier
        # callsites at line 1841/1850/1853 with UnboundLocalError.
        workspace = (
            paths.repo_root if paths is not None
            else Path(args.workspace_root).resolve()
        )
        profile = get_profile(base_dir=args.tools_dir)
        github_adapter = select_github_adapter(
            profile=profile, base_dir=args.tools_dir, cwd=str(workspace),
        )
        result = run_worker_scheduler_daemon(
            base_dir=args.tools_dir,
            github_adapter=github_adapter,
            workspace_root=workspace,
            max_iterations=args.max_iterations,
            poll_interval_seconds=args.poll_interval_seconds,
            daemon_id=args.daemon_id,
            max_workers=args.max_workers,
            lease_seconds=args.lease_seconds,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("exits_clean") else 1

    if (
        args.command == "scheduler"
        and args.scheduler_command == "watchdog"
        and args.watchdog_command == "run"
    ):
        # V10.5 Phase 1 (per ADR-0002) — ARIA-Watchdog read-only observer
        # daemon entry. Mirror of planner-dispatch/worker-dispatch shape
        # (fcntl lock, ARIA_STOP, max_iterations, exit_reason taxonomy).
        # Per-tick: read governance.jsonl + autonomy_state.jsonl, run
        # 2 MVP detectors (stall + bridge_warning_repeat), emit sanitized
        # findings via finding.emit_finding through ORIGINATING_SKILL_ALLOWLIST
        # gate. NO state mutation; observer-only.
        from .aria_watchdog import run_aria_watchdog_daemon
        workspace = (
            paths.repo_root if paths is not None
            else Path(args.workspace_root).resolve()
        )
        result = run_aria_watchdog_daemon(
            workspace_root=workspace,
            tools_dir=args.tools_dir,
            max_iterations=args.max_iterations,
            poll_interval_seconds=args.poll_interval_seconds,
            daemon_id=args.daemon_id,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("exits_clean") else 1

    if args.command == "worktree-prune":
        result = prune_worktrees(
            paths.repo_root if paths is not None else Path(args.workspace_root).resolve(),
            args.tools_dir,
            acknowledge=args.acknowledge,
            ttl_days=args.ttl_days,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("status") == "ok" else 1

    if args.command == "worktree" and args.worktree_command == "preflight":
        repo_root = paths.repo_root if paths is not None else Path(args.workspace_root).resolve()
        result = worktree_preflight(
            workspace_root=repo_root,
            base_dir=args.tools_dir,
            expected_branch=args.expected_branch,
            skip_fetch=args.no_fetch,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("gate_pass") else 1

    # Plan ARIA-V2 §3.9 + I-26 — daily report anchor handler.
    if args.command == "report" and args.report_command == "daily":
        if not args.emit_anchor:
            raise SystemExit(
                "aria-kernel report daily currently requires --emit-anchor "
                "(future flags will add --diff and --aggregate variants)."
            )
        from aria_kernel.report import emit_anchor_to_path
        workspace_root = Path(args.workspace_root).resolve()
        if args.tools_dir:
            tools_root = Path(args.tools_dir).resolve()
        else:
            tools_root = workspace_root / "aria-tools"
        # Derived, not flagged: when the state store is checked out its
        # published manifest_root belongs in the anchor, and when it is
        # not there is nothing to pin. An operator deciding this per run
        # is an operator who can forget, and the anchor is the record
        # that stands in for git history.
        from aria_kernel.state_store import SNAPSHOT_FILENAME, STORE_DIRNAME
        store_snapshot = workspace_root / STORE_DIRNAME / SNAPSHOT_FILENAME
        result = emit_anchor_to_path(
            date=args.date,
            workspace_root=workspace_root,
            tools_root=tools_root,
            output_path=Path(args.output_path).resolve(),
            state_snapshot_path=store_snapshot if store_snapshot.is_file() else None,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

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
        elif args.plan_command == "advance-rounds":
            result = advance_plan_rounds(plan_id=args.plan_id, max_rounds=args.max_rounds, base_dir=args.tools_dir, workspace_root=args.workspace_root)
        elif args.plan_command == "promote-to-dispatch":
            result = promote_converged_plan_to_dispatch(
                paths,
                plan_id=args.plan_id,
                cycle_id=args.cycle_id,
                pressure_event_id=args.pressure_event_id,
                tools_root=args.tools_dir,
                target_agent=args.target_agent,
                base_sha=args.base_sha,
                impact_ref=args.impact_ref,
                validation_ref=args.validation_ref,
                acknowledge=args.acknowledge,
                mission_id=args.mission_id,
            )
        elif args.plan_command == "force-human-required":
            result = force_plan_human_required(plan_id=args.plan_id, round_number=args.round_number, reason_codes=args.reason_code, base_dir=args.tools_dir)
        elif args.plan_command == "status":
            result = plan_status(plan_id=args.plan_id, base_dir=args.tools_dir)
        else:
            parser.error("unknown plan command")
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("status") != "rejected" else 1

    if args.command == "mission":
        if args.mission_command == "open":
            result = open_mission(
                source_kind=args.source_kind,
                source_id=args.source_id,
                repo_hash=args.repo_hash,
                title=args.title,
                next_action=args.next_action,
                wake_condition=json.loads(
                    Path(args.wake_file).read_text(encoding="utf-8")
                ),
                capability=args.capability,
                priority=args.priority,
                base_dir=args.tools_dir,
            )
        elif args.mission_command == "set-contract":
            result = set_closure_contract(
                mission_id=args.mission_id,
                next_action=args.next_action,
                wake_condition=json.loads(
                    Path(args.wake_file).read_text(encoding="utf-8")
                ),
                step_id=args.step_id,
                base_dir=args.tools_dir,
            )
        elif args.mission_command == "transition":
            wake = (
                json.loads(Path(args.wake_file).read_text(encoding="utf-8"))
                if args.wake_file
                else None
            )
            result = transition_mission(
                mission_id=args.mission_id,
                to_state=args.to_state,
                reason_code=args.reason_code,
                step_id=args.step_id,
                target_sha=args.target_sha,
                retry_rung=args.retry_rung,
                next_action=args.next_action,
                wake_condition=wake,
                evidence_refs=args.evidence_ref,
                base_dir=args.tools_dir,
            )
        elif args.mission_command == "bind":
            result = bind_mission(
                mission_id=args.mission_id,
                bindings=json.loads(Path(args.bindings_file).read_text(encoding="utf-8")),
                step_id=args.step_id,
                base_dir=args.tools_dir,
            )
        elif args.mission_command == "show":
            result = fold_mission(mission_id=args.mission_id, base_dir=args.tools_dir)
        elif args.mission_command == "list":
            result = {
                "schema_version": 1,
                "missions": list_open_missions(base_dir=args.tools_dir),
            }
        elif args.mission_command == "rebuild-index":
            result = rebuild_mission_index(base_dir=args.tools_dir)
        elif args.mission_command == "closure":
            result = assert_cycle_closure(base_dir=args.tools_dir)
        else:
            parser.error("unknown mission command")
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "agent-invocations":
        if args.agent_invocation_command == "request":
            # Plan 024 §B-2 — read strict fields from the new CLI args.
            must_satisfy = None
            if args.must_satisfy_file:
                must_satisfy = json.loads(
                    Path(args.must_satisfy_file).read_text(encoding="utf-8"))
            allowed_scope = None
            if args.allowed_scope:
                allowed_scope = [
                    g.strip() for g in args.allowed_scope.split(",") if g.strip()
                ]
            evidence_refs = None
            if args.evidence_refs_file:
                evidence_refs = json.loads(
                    Path(args.evidence_refs_file).read_text(encoding="utf-8"))
            result = create_agent_invocation_request(
                target_agent=args.target_agent,
                role=args.role,
                suggested_prompt=Path(args.prompt_file).read_text(encoding="utf-8"),
                must_satisfy=must_satisfy,
                allowed_scope=allowed_scope,
                evidence_refs=evidence_refs,
                legacy_strict_fields_optional=args.legacy_strict_fields_optional,
                convergence_id=args.convergence_id,
                pressure_event_id=args.pressure_event_id,
                round_number=args.round_number,
                expected_output_path=args.expected_output_path,
                base_dir=args.tools_dir,
            )
        # Plan 024 §B-1 — `submit-result` dispatch removed alongside the
        # subparser. Operators use `agent submit-result` (strict path) or,
        # for ad-hoc migration scripts, the kernel-private
        # `_submit_legacy_invocation_result_internal` helper guarded by
        # `operator_migration_approval_ref`.
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

    if args.command == "agent":
        if args.agent_command == "next-pending":
            row = next_pending_request(
                role=args.role,
                target_agent=args.target_agent,
                base_dir=args.tools_dir,
                exclude_request_ids=set(args.exclude or []) or None,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0 if row is not None else 0
        if args.agent_command == "claim":
            lease_seconds = args.lease_seconds if args.lease_seconds is not None else DEFAULT_LEASE_SECONDS
            row = claim_request(
                request_id=args.request_id,
                agent_id=args.agent_id,
                base_dir=args.tools_dir,
                lease_seconds=lease_seconds,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.agent_command == "heartbeat":
            extend = args.extend_seconds if args.extend_seconds is not None else DEFAULT_HEARTBEAT_EXTEND_SECONDS
            row = heartbeat_claim(
                claim_id=args.claim_id,
                agent_id=args.agent_id,
                lease_token=args.lease_token,
                base_dir=args.tools_dir,
                extend_seconds=extend,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.agent_command == "release":
            # Plan 026R §B.1 — resolve lease_token from --lease-token or
            # from --lease-token-from-env. Exactly one MUST be set.
            lease_token = args.lease_token
            if args.lease_token_from_env:
                env_value = os.environ.get(args.lease_token_from_env)
                if not env_value:
                    print(
                        f"lease-token-from-env: env var "
                        f"{args.lease_token_from_env!r} is empty or unset",
                        file=sys.stderr,
                    )
                    return 2
                if lease_token is not None:
                    print(
                        "--lease-token and --lease-token-from-env are "
                        "mutually exclusive",
                        file=sys.stderr,
                    )
                    return 2
                lease_token = env_value
            if not lease_token:
                print(
                    "release requires --lease-token or "
                    "--lease-token-from-env",
                    file=sys.stderr,
                )
                return 2
            row = release_claim(
                claim_id=args.claim_id,
                agent_id=args.agent_id,
                lease_token=lease_token,
                reason=args.reason,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.agent_command == "reap-stale":
            result = reap_stale_claims(base_dir=args.tools_dir)
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        if args.agent_command == "submit-result":
            workspace = paths.repo_root if paths is not None else Path(args.workspace_root).resolve()
            lease_token = args.lease_token
            if args.lease_token_from_env:
                env_value = os.environ.get(args.lease_token_from_env)
                if not env_value:
                    print(
                        f"lease-token-from-env: env var {args.lease_token_from_env!r} is not set",
                        file=sys.stderr,
                    )
                    return 2
                if lease_token is not None:
                    print(
                        "--lease-token and --lease-token-from-env are mutually exclusive",
                        file=sys.stderr,
                    )
                    return 2
                lease_token = env_value
            if not lease_token:
                print(
                    "submit-result requires --lease-token or --lease-token-from-env",
                    file=sys.stderr,
                )
                return 2
            _evidence_target = args.evidence_target_sha
            if _evidence_target == "auto":
                # ARIA-HIGH-022 — resolve the AGENT worktree's HEAD here; the
                # kernel-side descent proof in submit_claim_result decides
                # whether it is a valid stronger anchor. Unresolvable or
                # malformed output degrades to the legacy base-anchored check
                # (fail-closed, never fail-open).
                _head_proc = subprocess.run(
                    ["git", "-C", str(workspace), "rev-parse", "HEAD"],
                    capture_output=True, text=True, check=False,
                )
                _head = _head_proc.stdout.strip()
                _evidence_target = _head if len(_head) == 40 and all(c in "0123456789abcdef" for c in _head) else None
            result = submit_claim_result(
                claim_id=args.claim_id,
                agent_id=args.agent_id,
                lease_token=lease_token,
                output_path=args.output_path,
                workspace_root=workspace,
                base_dir=args.tools_dir,
                context_hash=args.context_hash,
                prompt_hash=args.prompt_hash,
                transcript_hash=args.transcript_hash,
                transcript_artifact_ref=args.transcript_artifact_ref,
                evidence_target_sha=_evidence_target,
            )
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0 if result.get("status") == "accepted" else 1
        parser.error("unknown agent command")

    if args.command == "budget":
        from aria_kernel.budget import check_budget, list_budget_usage, record_budget_usage

        if args.budget_command == "check":
            row = check_budget(
                estimated_usd=args.estimated_usd, action=args.action, base_dir=args.tools_dir
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0 if row.get("status") == "ok" else 1
        if args.budget_command == "record":
            row = record_budget_usage(
                actual_usd=args.actual_usd,
                action=args.action,
                note=args.note,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.budget_command == "list":
            rows = list_budget_usage(base_dir=args.tools_dir)
            print(json.dumps(rows, indent=2, sort_keys=True))
            return 0
        parser.error("unknown budget command")

    if args.command == "adapter-portfolio":
        from aria_kernel.adapter_portfolio import (
            list_mvp_status,
            register_mvp_adapters,
        )

        if args.adapter_portfolio_command == "register-mvp":
            result = register_mvp_adapters(base_dir=args.tools_dir)
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        if args.adapter_portfolio_command == "status":
            result = list_mvp_status(base_dir=args.tools_dir)
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0 if not result["missing"] else 2
        parser.error("unknown adapter-portfolio command")

    if args.command == "review":
        from aria_kernel.review_record import list_reviews, record_review

        if args.review_command == "record":
            row = record_review(
                scope=args.scope,
                summary=args.summary,
                reviewer=args.reviewer,
                findings_referenced=args.finding,
                debts_referenced=args.debt,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.review_command == "list":
            rows = list_reviews(
                base_dir=args.tools_dir,
                scope_substring=args.scope_substring,
                reviewer=args.reviewer,
            )
            print(json.dumps(rows, indent=2, sort_keys=True))
            return 0
        parser.error("unknown review command")

    if args.command == "architecture":
        from aria_kernel.architecture import (
            list_architecture_reviews,
            review_architecture_decision,
        )

        if args.architecture_command == "review":
            row = review_architecture_decision(
                technology=args.technology,
                proposed_action=args.proposed_action,
                evidence_refs=args.evidence_ref,
                root_cause=args.root_cause,
                authoritative_refs=args.authoritative_ref,
                repo_prior_refs=args.repo_prior_ref,
                replacement_grounds=args.replacement_ground,
                migration_plan=args.migration_plan,
                rollback_plan=args.rollback_plan,
                cycle_id=args.cycle_id,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.architecture_command == "list":
            print(json.dumps(list_architecture_reviews(base_dir=args.tools_dir), indent=2, sort_keys=True))
            return 0
        if args.architecture_command == "draft-adr":
            from aria_kernel.architecture import draft_architecture_adr

            row = draft_architecture_adr(
                option_set_ref=args.option_set_ref,
                evidence_pack_ref=args.evidence_pack_ref,
                cycle_id=args.cycle_id,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.architecture_command == "list-packs":
            from aria_kernel.architecture import (
                list_architecture_evidence_packs,
                list_architecture_option_sets,
            )

            print(json.dumps({
                "option_sets": list_architecture_option_sets(base_dir=args.tools_dir),
                "evidence_packs": list_architecture_evidence_packs(base_dir=args.tools_dir),
            }, indent=2, sort_keys=True))
            return 0
        parser.error("unknown architecture command")

    if args.command == "anti-pattern":
        from aria_kernel.knowledge_graph import Pattern, record_anti_pattern
        from aria_kernel.tool_registry import utc_now as _utc_now

        if args.anti_pattern_command == "record":
            pattern = Pattern(
                pattern_id=args.pattern_id,
                pattern_type="anti_pattern",
                confidence=1.0,
                evidence_refs=tuple(args.evidence_ref),
                discovered_by_cycle_id=args.cycle_id,
                observed_at=_utc_now(),
            )
            path = record_anti_pattern(
                pattern,
                workspace_root=args.workspace_root,
                reason_class=args.reason_class,
                operator_signature=args.operator_signature,
            )
            print(json.dumps({"written": str(path), "pattern_id": args.pattern_id}, indent=2))
            return 0

    if args.command == "operator-provenance":
        from aria_kernel.operator_provenance import (
            list_operator_approvals,
            record_operator_approval,
        )

        if args.operator_provenance_command == "record":
            row = record_operator_approval(
                ref=args.ref,
                expires_at=args.expires_at,
                target_agent=args.target_agent,
                note=args.note,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.operator_provenance_command == "list":
            print(json.dumps(list_operator_approvals(base_dir=args.tools_dir), indent=2, sort_keys=True))
            return 0

    if args.command == "experiment":
        from aria_kernel.experiment import register_experiment, run_experiment
        from aria_kernel.finding import (
            list_fix_verified_bindings,
            record_finding_fix_verification,
            record_finding_reproduction,
            record_finding_status_change,
        )

        if args.experiment_command == "register":
            row = register_experiment(
                experiment_id=args.experiment_id,
                hypothesis=args.hypothesis,
                recipe_ref=args.recipe_ref,
                observation_contract=json.loads(args.contract_json),
                finding_ref=args.finding_ref,
                cycle_id=args.cycle_id,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.experiment_command == "run":
            row = run_experiment(
                experiment_id=args.experiment_id,
                workspace_root=Path(args.workspace_root).resolve(),
                change_id=args.change_id,
                commit_sha=args.commit_sha,
                runner_identity=args.runner_identity,
                cycle_id=args.cycle_id,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.experiment_command == "reproduce":
            row = record_finding_reproduction(
                Path(args.workspace_root).resolve(),
                finding_id=args.finding_id,
                validation_run_id=args.validation_run_id,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.experiment_command == "verify-fix":
            row = record_finding_fix_verification(
                Path(args.workspace_root).resolve(),
                finding_id=args.finding_id,
                validation_run_id=args.validation_run_id,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.experiment_command == "finding-status":
            row = record_finding_status_change(
                Path(args.workspace_root).resolve(),
                finding_id=args.finding_id,
                to_status=args.to_status,
                reason=args.reason,
                actor=args.actor,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.experiment_command == "regression-bindings":
            print(json.dumps(
                list_fix_verified_bindings(Path(args.workspace_root).resolve()),
                indent=2, sort_keys=True,
            ))
            return 0

    if args.command == "research":
        from aria_kernel.research import (
            fetch_research_source,
            list_research_fetches,
            record_research_policy,
        )

        if args.research_command == "fetch":
            content_override = None
            if args.content_file:
                content_override = Path(args.content_file).read_text(encoding="utf-8")
            row = fetch_research_source(
                url=args.url,
                source_tier=args.source_tier,
                title=args.title,
                allowed_domains=args.allowed_domain,
                content_override=content_override,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.research_command == "list":
            print(json.dumps(list_research_fetches(base_dir=args.tools_dir), indent=2, sort_keys=True))
            return 0
        if args.research_command == "set-policy":
            row = record_research_policy(
                allowed_domains=args.allowed_domain, base_dir=args.tools_dir
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        parser.error("unknown research command")

    if args.command == "critical-observation":
        from aria_kernel.critical_observation import (
            acknowledge_critical_observation,
            list_critical_observations,
            record_critical_observation,
            resolve_critical_observation,
        )

        if args.critical_observation_command == "record":
            row = record_critical_observation(
                severity=args.severity,
                category=args.category,
                summary=args.summary,
                evidence_ref=args.evidence_ref,
                detail=args.detail,
                cycle_id=args.cycle_id,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.critical_observation_command == "list":
            rows = list_critical_observations(
                base_dir=args.tools_dir, include_resolved=args.include_resolved
            )
            print(json.dumps(rows, indent=2, sort_keys=True))
            return 0
        if args.critical_observation_command == "acknowledge":
            row = acknowledge_critical_observation(
                observation_id=args.observation_id,
                acknowledged_by=args.acknowledged_by,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.critical_observation_command == "resolve":
            row = resolve_critical_observation(
                observation_id=args.observation_id,
                resolved_by=args.resolved_by,
                resolution_note=args.resolution_note,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        parser.error("unknown critical-observation command")

    if args.command == "convergent-plan":
        from aria_kernel.convergent_planning_bridge import (
            issue_challenger_envelope,
            start_convergent_plan_with_envelope,
        )

        if args.convergent_plan_command == "start":
            content = json.loads(Path(args.plan_content_file).read_text(encoding="utf-8"))
            must_satisfy = json.loads(Path(args.must_satisfy_file).read_text(encoding="utf-8"))
            result = start_convergent_plan_with_envelope(
                plan_id=args.plan_id,
                plan_content=content,
                initial_revision_id=args.initial_revision_id,
                must_satisfy=must_satisfy,
                evidence_refs=args.evidence_ref,
                allowed_scope=args.allowed_scope,
                base_dir=args.tools_dir,
            )
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        if args.convergent_plan_command == "issue-challenger":
            # Plan 026R §C.3 — pass through the three bounding-box args
            # the kernel primitive requires. Pre-§C.3 the call site
            # omitted them entirely and the function raised TypeError
            # before any kernel work happened.
            must_satisfy = json.loads(
                Path(args.must_satisfy_file).read_text(encoding="utf-8"),
            )
            row = issue_challenger_envelope(
                plan_id=args.plan_id,
                round_number=args.round_number,
                must_satisfy=must_satisfy,
                evidence_refs=args.evidence_ref,
                allowed_scope=args.allowed_scope,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        parser.error("unknown convergent-plan command")

    if args.command == "impact" and args.impact_command == "compute":
        from aria_kernel.recursive_impact import DEFAULT_MAX_DEPTH, compute_recursive_impact

        depth = args.max_depth if args.max_depth is not None else DEFAULT_MAX_DEPTH
        workspace = paths.repo_root if paths is not None else Path(args.workspace_root).resolve()
        result = compute_recursive_impact(
            intended_files=args.intended_file,
            workspace_root=workspace,
            base_dir=args.tools_dir,
            max_depth=depth,
        )
        print(json.dumps({
            "fingerprint": result["intended_fingerprint"],
            "summary": result["summary"],
        }, indent=2, sort_keys=True))
        return 0 if result["summary"]["by_status"].get("unknown", 0) == 0 else 2

    if args.command == "impact" and args.impact_command == "service-order":
        from aria_kernel.impact_graph import plan_service_analysis_order

        workspace = paths.repo_root if paths is not None else Path(args.workspace_root).resolve()
        plan = plan_service_analysis_order(
            workspace_root=workspace,
            cycle_id=args.cycle_id,
            nx_graph_file=args.nx_graph,
            changed_files=args.changed_file,
        )
        print(json.dumps(plan, indent=2, sort_keys=True))
        return 0

    if args.command == "apply" and args.apply_command == "gate":
        from aria_kernel.apply_engine import run_apply_gate

        row = run_apply_gate(
            proposal_id=args.proposal_id,
            change_id=args.change_id,
            base_dir=args.tools_dir,
            runner_identity=args.runner_identity,
            cycle_id=args.cycle_id,
            workspace_root=args.workspace_root,
        )
        print(json.dumps(row, indent=2, sort_keys=True))
        # Exit code carries the verdict, like `apply scan-diff` above: the
        # implementer runs this from Bash and must not proceed to `pr create`
        # on a blocked gate.
        return 0 if row.get("status") == "ready_for_pr" else 1

    if args.command == "apply" and args.apply_command == "scan-diff":
        from aria_kernel.suppression_scanner import scan_unified_diff_text

        diff_text = Path(args.diff_file).read_text(encoding="utf-8")
        matches = scan_unified_diff_text(diff_text)
        result = {
            "match_count": len(matches),
            "matches": [
                {"category": m.category, "detector": m.detector, "file": m.file, "line": m.line, "text": m.text}
                for m in matches
            ],
            "blocked": len(matches) > 0,
        }
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["match_count"] == 0 else 1

    # Plan 019 Phase 3 — pr command dispatch (delegates to pr_manager).
    if args.command == "pr":
        from aria_kernel.pr_manager import (
            ARIA_PR_BASE,
            commit_prepared_branch,
            list_pr_actions,
            open_pr_for_action,
            plan_pr_lifecycle,
            plan_pr_split,
            prepare_branch,
            push_prepared_branch,
        )

        # CLI default is dry-run; --no-dry-run flips it.
        dry_run = not args.no_dry_run if hasattr(args, "no_dry_run") else True

        if args.pr_command == "prepare":
            row = prepare_branch(
                proposal_id=args.proposal_id,
                workspace_root=args.workspace_root,
                base_dir=args.tools_dir,
                dry_run=dry_run,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.pr_command == "commit":
            row = commit_prepared_branch(
                proposal_id=args.proposal_id,
                workspace_root=args.workspace_root,
                message=args.message,
                base_dir=args.tools_dir,
                dry_run=dry_run,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.pr_command == "push":
            row = push_prepared_branch(
                proposal_id=args.proposal_id,
                workspace_root=args.workspace_root,
                remote=args.remote,
                base_dir=args.tools_dir,
                dry_run=dry_run,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.pr_command == "create":
            # Plan 018 Phase 6.2 — explicit base guard fires inside
            # open_pr_for_action; we forward the operator's --base value
            # verbatim so the kernel can fail-closed on base != main.
            row = open_pr_for_action(
                proposal_id=args.proposal_id,
                workspace_root=args.workspace_root,
                base_dir=args.tools_dir,
                dry_run=dry_run,
                base=args.base,
                change_id=args.change_id,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.pr_command == "list-actions":
            print(json.dumps(list_pr_actions(base_dir=args.tools_dir), indent=2, sort_keys=True))
            return 0
        if args.pr_command == "lifecycle-plan":
            open_prs = json.loads(Path(args.open_prs_file).read_text(encoding="utf-8"))
            row = plan_pr_lifecycle(
                open_prs=open_prs,
                base_dir=args.tools_dir,
                cycle_id=args.cycle_id,
                stale_after_days=args.stale_after_days,
                close_after_days=args.close_after_days,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.pr_command == "split-plan":
            row = plan_pr_split(
                proposal_id=args.proposal_id,
                changed_files=args.changed_file,
                base_dir=args.tools_dir,
                cycle_id=args.cycle_id,
                max_files_per_pr=args.max_files_per_pr,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        parser.error("unknown pr command")

    # Plan 019 Phase 7 — Change Ledger dispatch.
    if args.command == "change":
        from aria_kernel.change_ledger import (
            emit_change_committed,
            emit_change_planned,
            emit_change_validated,
            find_changes_by_file,
            get_change_chain,
            list_change_chains,
        )
        if args.change_command == "plan":
            row = emit_change_planned(
                plan_id=args.plan_id,
                finding_id=args.finding_id,
                intended_affected_files=args.intended_file,
                intended_validation_refs=args.intended_validation_ref or [],
                rollback_ref=args.rollback_ref,
                architectural_tier=args.architectural_tier,
                intended_request_id=args.intended_request_id,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.change_command == "commit":
            dispositions: dict[str, str] = {}
            for pair in args.uncovered_disposition:
                path_part, sep, reason = str(pair).partition("=")
                if not sep or not path_part.strip() or not reason.strip():
                    parser.error(
                        f"--uncovered-disposition must be PATH=REASON, got {pair!r}"
                    )
                dispositions[path_part.strip()] = reason.strip()
            row = emit_change_committed(
                change_id=args.change_id,
                commit_sha=args.commit_sha,
                actual_affected_files=args.actual_file,
                claim_id=args.claim_id,
                uncovered_intended_dispositions=dispositions or None,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.change_command == "validate":
            invariants = (
                json.loads(Path(args.invariants_file).read_text(encoding="utf-8"))
                if args.invariants_file else None
            )
            row = emit_change_validated(
                change_id=args.change_id,
                validation_run_refs=args.validation_ref,
                baseline_comparison_ref=args.baseline_comparison_ref,
                post_remediation_invariants=invariants,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.change_command == "show":
            chain = get_change_chain(change_id=args.change_id, base_dir=args.tools_dir)
            print(json.dumps(chain, indent=2, sort_keys=True))
            return 0
        if args.change_command == "list":
            chains = list_change_chains(
                plan_id=args.plan_id,
                finding_id=args.finding_id,
                base_dir=args.tools_dir,
            )
            print(json.dumps(chains, indent=2, sort_keys=True))
            return 0
        if args.change_command == "find":
            chains = find_changes_by_file(file_path=args.file, base_dir=args.tools_dir)
            print(json.dumps(chains, indent=2, sort_keys=True))
            return 0
        parser.error("unknown change command")

    # Plan 019 Phase 5.5 — Architecture Spine Gate dispatch.
    if args.command == "spine":
        from aria_kernel.architecture_spine_gate import (
            list_spine_events,
            take_baseline,
            take_postcheck,
        )

        workspace = args.workspace_root if hasattr(args, "workspace_root") and args.workspace_root else "."
        if args.spine_command == "baseline":
            row = take_baseline(
                plan_id=args.plan_id,
                cycle_id=args.cycle_id,
                workspace_root=workspace,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.spine_command == "postcheck":
            row = take_postcheck(
                plan_id=args.plan_id,
                cycle_id=args.cycle_id,
                workspace_root=workspace,
                base_dir=args.tools_dir,
                max_regression_rounds=args.max_regression_rounds,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            # Exit 1 on regression so CI can fail-closed.
            return 1 if row.get("regression_count", 0) > 0 else 0
        if args.spine_command == "status":
            events = list_spine_events(plan_id=args.plan_id, base_dir=args.tools_dir)
            print(json.dumps(events, indent=2, sort_keys=True))
            return 0
        if args.spine_command == "refresh":
            from aria_kernel.spine_orchestrator import refresh_spine_adapters
            summary = refresh_spine_adapters(
                base_dir=args.tools_dir,
                workspace_root=workspace,
                freshness_max_age_seconds=args.freshness_max_age_seconds,
                cycle_id=args.cycle_id,
                max_workers=args.max_workers,
            )
            print(json.dumps(summary, indent=2, sort_keys=True))
            return 0
        parser.error("unknown spine command")

    if args.command == "metrics":
        from aria_kernel.plan_016_metrics import compute_plan_016_metrics, write_dashboard

        if args.metrics_command == "plan-016":
            print(json.dumps(compute_plan_016_metrics(base_dir=args.tools_dir), indent=2, sort_keys=True))
            return 0
        if args.metrics_command == "dashboard":
            target = write_dashboard(
                base_dir=args.tools_dir,
                repo_root=args.workspace_root,
                out_path=args.out,
            )
            print(json.dumps({"path": str(target)}, indent=2, sort_keys=True))
            return 0
        parser.error("unknown metrics command")

    if args.command == "cycle-guard" and args.cycle_guard_command == "evaluate":
        from aria_kernel.cycle_guard import DEFAULT_PRESSURE_THRESHOLD, evaluate_cycle_emptiness
        from dataclasses import asdict

        threshold = args.pressure_threshold if args.pressure_threshold is not None else DEFAULT_PRESSURE_THRESHOLD
        verdict = evaluate_cycle_emptiness(
            cycle_id=args.cycle_id,
            base_dir=args.tools_dir,
            pressure_threshold=threshold,
            repo_root_override=args.workspace_root,
        )
        print(json.dumps(asdict(verdict), indent=2, sort_keys=True))
        # Exit 0 when non-empty (work to do); 2 when empty (caller may skip).
        return 0 if not verdict.is_empty else 2

    if args.command == "human-required":
        from aria_kernel.human_required import (
            list_human_required,
            record_human_required,
            resolve_human_required,
            sweep_lease_lifecycle_for_human_required,
        )

        if args.human_required_command == "record":
            row = record_human_required(
                request_id=args.request_id,
                severity=args.severity,
                reason=args.reason,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.human_required_command == "list":
            rows = list_human_required(base_dir=args.tools_dir, include_resolved=args.include_resolved)
            print(json.dumps(rows, indent=2, sort_keys=True))
            return 0
        if args.human_required_command == "resolve":
            row = resolve_human_required(
                request_id=args.request_id,
                resolution_note=args.resolution_note,
                verdict=args.verdict,
                base_dir=args.tools_dir,
            )
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.human_required_command == "sweep":
            result = sweep_lease_lifecycle_for_human_required(base_dir=args.tools_dir)
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        parser.error("unknown human-required command")

    if args.command == "consensus" and args.consensus_command == "run":
        from aria_kernel.feedback_store import CONSENSUS_MIN_CONFIDENCE
        from aria_kernel.judgment_bridge import run_consensus

        result = run_consensus(
            tool_id=args.tool_id,
            cycle_id=args.cycle_id,
            min_confidence=args.min_confidence if args.min_confidence is not None else CONSENSUS_MIN_CONFIDENCE,
            base_dir=args.tools_dir,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    # Plan ARIA-V3 §A5 — ack ledger dispatch.
    if args.command == "ack":
        from .ack_ledger import (
            init_ack_ledger,
            list_keys,
            mint_operator_ack,
            rotate_key,
            verify_range,
        )
        if args.ack_command == "init":
            result = init_ack_ledger(
                base_dir=args.tools_dir,
                reason=args.reason,
                operator_approval_ref=args.operator_approval_ref,
                force=args.force,
            )
        elif args.ack_command == "mint":
            row = mint_operator_ack(
                base_dir=args.tools_dir,
                draft_id=args.draft_id,
                intent_id=args.intent_id,
                target_path=args.target_path,
                kind=args.kind,
                reason=args.reason,
                operator_user_id=args.operator_user_id,
                profile_name=args.profile_state,
                profile_state_at_mint=args.profile_state,
                commit_sha_at_mint=args.commit_sha,
                parent_observation_id=args.parent_observation_id,
            )
            result = row.to_dict()
        elif args.ack_command == "rotate-key":
            result = rotate_key(
                base_dir=args.tools_dir,
                reason=args.reason,
                operator_approval_ref=args.operator_approval_ref,
                emergency=args.emergency,
            )
        elif args.ack_command == "verify":
            raw_range = (args.range or "").strip()
            last_n: int | None
            if raw_range == "full":
                last_n = None
            elif raw_range.startswith("last-"):
                try:
                    last_n = int(raw_range[len("last-"):])
                except ValueError:
                    parser.error(
                        f"--range must be 'full' or 'last-N'; got {raw_range!r}"
                    )
                    return 2
            else:
                parser.error(
                    f"--range must be 'full' or 'last-N'; got {raw_range!r}"
                )
                return 2
            result = verify_range(base_dir=args.tools_dir, last_n=last_n)
        elif args.ack_command == "list-keys":
            result = {"keys": list_keys(base_dir=args.tools_dir)}
        else:
            parser.error("unknown ack command")
            return 2
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    # Plan ARIA-V4 §2e — inter-agent question envelope dispatch.
    if args.command == "question":
        from .agent_question import (
            answer as question_answer,
            ask as question_ask,
            list_questions,
        )
        if args.question_command == "ask":
            question = question_ask(
                base_dir=args.tools_dir,
                asker_agent_id=args.asker_agent_id,
                target_agent_id=args.target_agent_id,
                question_kind=args.question_kind,
                rule_text=args.rule_text,
                hypothesised_tier=args.hypothesised_tier,
                evidence_refs=args.evidence_ref,
                cycle_id=args.cycle_id,
            )
            result = question.to_dict()
        elif args.question_command == "answer":
            response = question_answer(
                base_dir=args.tools_dir,
                question_id=args.question_id,
                answerer_agent_id=args.answerer_agent_id,
                answered_tier=args.answered_tier,
                rationale=args.rationale,
                counter_evidence_refs=args.counter_evidence_ref,
                verdict=args.verdict,
                refusal_reason=args.refusal_reason,
                cycle_id=args.cycle_id,
            )
            result = response.to_dict()
        elif args.question_command == "list":
            result = {
                "questions": list_questions(
                    base_dir=args.tools_dir,
                    cycle_id=args.cycle_id,
                    asker_agent_id=args.asker_agent_id,
                    target_agent_id=args.target_agent_id,
                ),
            }
        else:
            parser.error("unknown question command")
            return 2
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "agent-genesis":
        if args.agent_genesis_command == "draft":
            result = draft_agent_from_gap(
                gap_id=args.gap_id,
                operator_approval_ref=args.operator_approval_ref,
                base_dir=args.tools_dir,
            )
        elif args.agent_genesis_command == "sandbox":
            if args.from_suite:
                from aria_kernel.agent_genesis import assemble_fixture_results_from_suite

                fixture_results = assemble_fixture_results_from_suite(
                    execution_run_id=args.from_suite, base_dir=args.tools_dir
                )
            else:
                fixture_results = json.loads(Path(args.fixture_results_file).read_text(encoding="utf-8"))
            result = evaluate_genesis_sandbox(
                draft_id=args.draft_id,
                fixture_results=fixture_results,
                base_dir=args.tools_dir,
            )
        elif args.agent_genesis_command == "approve":
            result = approve_agent_pr(
                draft_id=args.draft_id,
                operator_approval_ref=args.operator_approval_ref,
                base_dir=args.tools_dir,
                operator_synthetic_override=args.operator_synthetic_override,
            )
        elif args.agent_genesis_command == "prepare-pr-lane":
            result = prepare_agent_pr_lane(
                draft_id=args.draft_id,
                workspace_root=args.workspace_root,
                base_dir=args.tools_dir,
                cycle_id=args.cycle_id,
            )
        elif args.agent_genesis_command == "materialize":
            # Plan ARIA-V3 §A4 — construct AutoActionGate from the
            # current runtime profile + lane + classifier; consume
            # the operator-minted ack token via the gate's unified
            # path.
            #
            # Plan ARIA-V3.1 §2a — ``get_profile`` is module-level
            # imported at line 105; the previous nested re-import
            # of ``get_profile`` was redundant AND shadowed the
            # module-level binding for the entire ``_main`` body,
            # silently breaking earlier callsites at lines 1841 /
            # 1850 / 1853 with UnboundLocalError.
            from .auto_action_gate import (
                ClassifierDecision,
                gate_from_policy,
            )
            current_profile = get_profile(base_dir=args.tools_dir)
            v3_gate = gate_from_policy(
                base_dir=args.tools_dir,
                profile=current_profile,
                lane=None,
                classifier=ClassifierDecision(passed=True),
            )
            result = materialize_agent_draft(
                draft_id=args.draft_id,
                assignment_id=args.assignment_id,
                workspace_root=args.workspace_root,
                gate=v3_gate,
                base_dir=args.tools_dir,
                run_invariants=args.run_invariants,
                ack_id=args.ack_token,
                operator_synthetic_override=args.operator_synthetic_override,
            )
        elif args.agent_genesis_command == "shadow-bridge":
            from aria_kernel.shadow_eval_bridge import bridge_shadow_eval_from_invocation

            result = bridge_shadow_eval_from_invocation(
                invocation_id=args.invocation_id,
                fixture_id=args.fixture_id,
                fixture_run_id=args.fixture_run_id,
                operator_approval_ref=args.operator_approval_ref,
                base_dir=args.tools_dir,
                repo_root=args.repo_root,
            )
        elif args.agent_genesis_command == "list":
            result = list_agent_materializations(base_dir=args.tools_dir) if args.materializations else list_agent_drafts(base_dir=args.tools_dir)
        else:
            parser.error("unknown agent-genesis command")
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if not isinstance(result, dict) or result.get("status") != "rejected" else 1

    if args.command == "specialist-review":
        if args.specialist_review_command == "dry-run":
            from .specialist_review_runner import (
                _CROSS_CUTTING_SPECIALISTS,
                _DOMAIN_TOUCH_MAP,
                _TIER_1_SPECIALISTS,
            )
            from .agent_invocations import ROLES
            agents_dir = Path(args.agents_dir).resolve()
            inventory_findings: list[dict[str, Any]] = []
            # Verify every specialist named in the touch-map exists as
            # an agent .md file under .claude/agents.
            all_specialists: set[str] = set(_CROSS_CUTTING_SPECIALISTS)
            for agents in _DOMAIN_TOUCH_MAP.values():
                all_specialists.update(agents)
            all_specialists.update(_TIER_1_SPECIALISTS)
            for agent_name in sorted(all_specialists):
                if ":" in agent_name:
                    # Plugin-namespaced agents (e.g. "frontend-mobile-
                    # development:mobile-developer") live under a
                    # different discovery path; skip filesystem check
                    # for them at C5 warn-mode.
                    continue
                md_path = agents_dir / f"{agent_name}.md"
                if not md_path.exists():
                    inventory_findings.append({
                        "severity": "WARN",
                        "missing_agent": agent_name,
                        "expected_path": str(md_path),
                    })
            role_present = "specialist_domain_review" in ROLES
            if not role_present:
                inventory_findings.append({
                    "severity": "ERROR",
                    "role_missing": "specialist_domain_review",
                    "hint": "agent_invocations.ROLES must include the V6.1 role",
                })
            result = {
                "schema_version": 1,
                "agents_dir": str(agents_dir),
                "specialists_inventoried": len(all_specialists),
                "findings": inventory_findings,
                "role_specialist_domain_review_present": role_present,
                "status": "ok" if not inventory_findings else (
                    "drift_detected" if args.strict else "warn_only"
                ),
            }
            print(json.dumps(result, indent=2, sort_keys=True))
            if args.strict and inventory_findings:
                return 1
            return 0
        parser.error("unknown specialist-review command")
        return 1

    if args.command == "skill-genesis":
        if args.skill_genesis_command == "request":
            seed_dict = None
            if args.convergent:
                if not args.seed_file:
                    parser.error(
                        "skill-genesis request --convergent requires "
                        "--seed-file (Plan ARIA-V6 §2d v2)"
                    )
                seed_dict = json.loads(
                    Path(args.seed_file).read_text(encoding="utf-8")
                )
            result = request_skill_genesis(
                capability_gap_key=args.capability_gap_key,
                title=args.title,
                convergent=args.convergent,
                seed=seed_dict,
                base_dir=args.tools_dir,
            )
        elif args.skill_genesis_command == "seed":
            from .skill_genesis import seed_adapter_requests
            if not args.convergent:
                parser.error(
                    "skill-genesis seed currently requires --convergent "
                    "(Plan ARIA-V6 §2d v2 C3)"
                )
            result = seed_adapter_requests(
                seeds_path=args.seeds_path,
                base_dir=args.tools_dir,
            )
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
                    synthetic_test_mode=args.synthetic_test_mode,
                    operator_approval_ref=args.operator_approval_ref,
                )
            else:
                result = sandbox_skill(
                    draft_id=args.draft_id,
                    checklist_results=json.loads(Path(args.checklist_results_file).read_text(encoding="utf-8")),
                    base_dir=args.tools_dir,
                    synthetic_test_mode=args.synthetic_test_mode,
                    operator_approval_ref=args.operator_approval_ref,
                )
        elif args.skill_genesis_command == "approve":
            result = approve_skill_pr(
                draft_id=args.draft_id,
                operator_approval_ref=args.operator_approval_ref,
                base_dir=args.tools_dir,
                operator_synthetic_override=args.operator_synthetic_override,
            )
        elif args.skill_genesis_command == "materialize":
            # Plan ARIA-V3 §A4 — gate-driven materialize. Same factory
            # path as agent-genesis materialize.
            #
            # Plan ARIA-V3.1 §2a — ``get_profile`` is module-level
            # imported at line 105; nested re-import removed.
            from .auto_action_gate import (
                ClassifierDecision,
                gate_from_policy,
            )
            current_profile = get_profile(base_dir=args.tools_dir)
            v3_gate = gate_from_policy(
                base_dir=args.tools_dir,
                profile=current_profile,
                lane=None,
                classifier=ClassifierDecision(passed=True),
            )
            result = materialize_skill(
                draft_id=args.draft_id,
                assignment_id=args.assignment_id,
                workspace_root=args.workspace_root,
                gate=v3_gate,
                base_dir=args.tools_dir,
                run_invariants=args.run_invariants,
                ack_id=args.ack_token,
                operator_synthetic_override=args.operator_synthetic_override,
            )
        elif args.skill_genesis_command == "list":
            result = list_skill_genesis(base_dir=args.tools_dir, kind=args.kind)
        else:
            parser.error("unknown skill-genesis command")
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if not isinstance(result, dict) or result.get("status") != "rejected" else 1

    if args.command == "worker-result" and args.worker_result_command == "submit":
        lease_token = args.lease_token
        if args.lease_token_from_env:
            if lease_token:
                print(
                    "--lease-token and --lease-token-from-env are mutually exclusive",
                    file=sys.stderr,
                )
                return 2
            lease_token = os.environ.get(args.lease_token_from_env)
            if not lease_token:
                print(
                    f"lease-token-from-env: env var {args.lease_token_from_env!r} is not set",
                    file=sys.stderr,
                )
                return 2
        result = submit_worker_result(
            from_worktree=args.from_worktree,
            assignment_id=args.assignment_id,
            validation_commands=args.validation_command,
            tools_root=args.tools_dir,
            lease_token=lease_token,
            allow_legacy_no_token=args.allow_legacy_no_token,
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

    if args.command == "autonomy" and args.autonomy_command == "run":
        # Plan 026R §F.1 — unified orchestrator entry point.
        # Plan ARIA-V3 §A1 — auto_merge_runner is REQUIRED.
        # Plan ARIA-V3 §A2 — github_adapter is REQUIRED.
        # Plan ARIA-V5 §3c v2 — convergence_runner is REQUIRED (V5.1
        # Tier-1). All three factories key off the runtime profile so
        # the operator never passes any dependency explicitly.
        from .autonomy_orchestrator import run_autonomy_orchestrator
        from .auto_merge_runners import (
            enumerate_prs_with_readiness_claims,
            resolve_readiness_claim_id_from_claims,
            select_auto_merge_runner,
        )
        from .convergence_drainer import select_convergence_runner
        from .github_adapters import select_github_adapter
        from .review_runner import select_review_runner
        from .specialist_review_runner import select_specialist_review_runner
        # Plan ARIA-V7 §2i v2 Phase 7.1 — plan_synthesizer factory
        # wired into the autonomy CLI. The synthesizer is REQUIRED
        # on run_autonomy_orchestrator; without this wiring the
        # autonomous loop crashes with TypeError at signature binding.
        from .plan_synthesizer import select_plan_synthesizer
        # Plan ARIA-V7 §2h v2 Phase 7.4 — skill_genesis_drainer
        # factory. REQUIRED kwarg; consumes convergent=True requests
        # from skill-genesis/requests.jsonl + invokes V6.2
        # run_convergent_authoring per request.
        from .skill_genesis_drainer import select_skill_genesis_drainer
        # Plan ARIA-V3.1-D2 — factory wire for MemoryHook + CostTelemetryHook.
        # The orchestrator's optional kwargs default to NoOp (V3.1-0
        # scaffold); the CLI surface explicitly selects the production
        # variant per profile so standard/strict/autonomous get the
        # full V10 memory + cost-attribution pillar activation.
        from .cycle_phases import (
            select_cost_telemetry_hook,
            select_memory_hook,
            select_v9_implementation_runner,
        )
        # Plan ARIA-V3.1-E (E1+E2) — CLI flag is the SSoT for the
        # cycle's profile when the operator passes it. Otherwise
        # fall back to the persisted profile (V8 backward-compat).
        # When the flag differs from the persisted active profile,
        # route the transition through set_profile() so the SOC2
        # audit row lands in runtime-profile-history.jsonl (closes
        # 6-validator audit C-2). argparse already validated
        # --operator-approval-ref is present when --profile=autonomous.
        # `set_profile` + `get_profile` come from the module-level
        # import at line 104 — no nested re-import (closes the v3_1
        # nested-reimport-shadowing invariant).
        _persisted_profile = get_profile(base_dir=args.tools_dir)
        if args.profile == "autonomous" and not (args.operator_approval_ref or "").strip():
            print(
                "error: --profile autonomous requires --operator-approval-ref "
                "(signed-ref string identifying the operator gesture).",
                file=sys.stderr,
            )
            return 2
        if args.profile is None:
            # No explicit override — use persisted state as profile SSoT.
            profile = _persisted_profile
        else:
            # Explicit override — record the SOC2 audit row when it
            # differs from persisted, then use the operator-supplied
            # value as profile SSoT for the orchestrator body.
            if args.profile != _persisted_profile:
                _approval_ref = (
                    args.operator_approval_ref
                    or f"cli-flag:{args.daemon_id}:{int(time.time())}"
                )
                set_profile(
                    args.profile,
                    operator_approval_ref=_approval_ref,
                    base_dir=args.tools_dir,
                    set_by="autonomy-cli",
                )
            profile = args.profile
        github_adapter = select_github_adapter(
            profile=profile,
            base_dir=args.tools_dir,
            cwd=str(args.workspace_root),
        )
        auto_merge_runner = select_auto_merge_runner(
            profile=profile,
            adapter_factory=lambda: github_adapter,
            pr_enumerator=lambda adapter: enumerate_prs_with_readiness_claims(
                adapter,
                base_dir=args.tools_dir,
            ),
            readiness_claim_resolver=resolve_readiness_claim_id_from_claims,
        )
        # CL-1 (ORPHAN-725) — the B-V2-13 deadline floor is retired with
        # the waits it was sized for: the resumable step function never
        # blocks on challenger_timeout, so a cycle deadline no longer
        # needs to fit max_rounds × envelopes × timeout inside one run.
        # Plan ARIA-V8 §4 Phase 8.0 (B-V2-11) — surface the per-run
        # budget cap to the orchestrator environment so child ci_executor
        # subprocesses read it via MAX_BUDGET_USD_PER_RUN env var.
        os.environ["MAX_BUDGET_USD_PER_RUN"] = str(args.max_budget_usd_per_run)
        os.environ["MAX_BUDGET_USD_PER_CYCLE"] = str(args.max_budget_usd_per_cycle)
        convergence_runner = select_convergence_runner(profile=profile)
        review_runner = select_review_runner(profile=profile)
        specialist_review_runner = select_specialist_review_runner(profile=profile)
        plan_synthesizer = select_plan_synthesizer(profile=profile)
        # ORPHAN-312 — install the finding-driven plan source. Without this
        # the orchestrator's NoOp default returns None and the loop falls back
        # to the git_diff synthesizer, which ignores seeded findings entirely
        # and grounds the plan (and the challenger envelope) in arbitrary
        # changed files. The mining provider ranks ORPHAN>F_FINDING>GIT_DIFF,
        # converts the top candidate into a code-grounded plan, and soft-falls
        # to git_diff only when no finding converts (preserves prior behaviour
        # when there is no pending finding).
        from .cycle_phases.plan_source import V9PressureSourceProvider
        plan_content_provider = V9PressureSourceProvider()
        skill_genesis_drainer = select_skill_genesis_drainer(profile=profile)
        # ORPHAN-HIGH-082 fix: CLI flags --challenger-timeout-seconds and
        # --max-rounds are now plumbed all the way to the orchestrator
        # (and from there to convergence_runner). Previously the
        # arguments were parsed + validated above (line 3422-3434) but
        # never passed downstream, so the drainer silently fell back to
        # its 1800s + 4-rounds defaults regardless of operator input.
        # This was the root cause of cycle 1 polling for 30 min instead
        # of 5 min on the first observed run.
        # OOM incelemesi 2026-09-02: --cycle-deadline-seconds yalnızca
        # döngü-iterasyonları ARASINDA kontrol ediliyordu; tek bir faz sınırın
        # üzerinde takıldığında hiçbir şey kesmiyordu (90dk koşup OOM ile ölen
        # süreç). Sınır, mevcut faz-SIGALRM makinesine taşınır:
        # ARIA_JOB_DEADLINE_EPOCH, iş-epoch'u ile "şimdi + cycle-deadline"
        # arasındaki minimuma çekilir. Faz içinde kesilme =
        # PhaseDeadlineExceeded = temiz mühürleme; between-iteration kontrolü
        # (cycle_deadline_exceeded) yerinde kalır, bu onun kesen eşi.
        if getattr(args, "cycle_deadline_seconds", 0):
            _cap = time.time() + args.cycle_deadline_seconds
            _existing = os.environ.get("ARIA_JOB_DEADLINE_EPOCH")
            if _existing:
                try:
                    _cap = min(_cap, float(_existing))
                except ValueError:
                    pass
            os.environ["ARIA_JOB_DEADLINE_EPOCH"] = str(_cap)
        
        result = run_autonomy_orchestrator(
            base_dir=args.tools_dir,
            auto_merge_runner=auto_merge_runner,
            github_adapter=github_adapter,
            convergence_runner=convergence_runner,
            review_runner=review_runner,
            specialist_review_runner=specialist_review_runner,
            plan_synthesizer=plan_synthesizer,
            plan_content_provider=plan_content_provider,
            skill_genesis_drainer=skill_genesis_drainer,
            workspace_root=args.workspace_root,
            max_cycles=args.max_cycles,
            max_iterations_per_phase=args.max_iterations_per_phase,
            max_rounds=args.max_rounds,
            daemon_id=args.daemon_id,
            cycle_deadline_seconds=args.cycle_deadline_seconds,
            challenger_timeout_seconds=args.challenger_timeout_seconds,
            # Plan ARIA-V3.1-E — explicit profile threaded to the
            # orchestrator (the poll budget beside it died with K6's poll).
            profile=profile,
            # Plan ARIA-V3.1-D2 — production MemoryHook +
            # CostTelemetryHook factories. observe/frozen profiles
            # get NoOp variants; standard/strict/autonomous get the
            # V10 memory pillar + per-LLM cost-attribution activated.
            memory_hook=select_memory_hook(profile=profile),
            cost_telemetry_hook=select_cost_telemetry_hook(profile=profile),
            # Plan ARIA-V10.5 Phase 7 — F-027 closure. Wire the V9
            # implementation runner per profile so the orchestrator's
            # post-CONVERGED phase actually mints aria-implementer
            # subprocess. Pre-F-027 the CLI never installed this
            # factory's return value so the orchestrator always fell
            # back to NoOp; the V9 implementation phase was
            # structurally unreachable.
            #
            # ORPHAN-HIGH-728 — the mapping is no longer restated here.
            # The factory reads `runtime_profile.ACTION_PERMISSIONS`:
            # a profile holding `pr_create` (strict, autonomous) gets
            # AutonomousV9ImplementationRunner, everything else NoOp.
            # This comment used to enumerate a third `strict →
            # policy_strict_no_implementation` arm that contradicted the
            # profile table it was describing.
            v9_implementation_runner=select_v9_implementation_runner(profile=profile),
            max_budget_usd_per_cycle=args.max_budget_usd_per_cycle,
        )
        if args.output == "full" and not args.artifact:
            contract = {
                "schema_version": 2,
                "result_detail": "summary",
                "overall_status": "contract_error",
                "exit_code": 4,
                "error": "--output full requires --artifact",
            }
            print(json.dumps(contract, indent=2, sort_keys=True))
            return 4
        if args.output == "full":
            artifact_path = Path(args.artifact)
            artifact_path.parent.mkdir(parents=True, exist_ok=True)
            artifact_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        summary = autonomy_output_summary(result, result_detail=args.output)
        if args.output == "full":
            summary.pop("full_result", None)
            summary["full_result_artifact"] = str(Path(args.artifact))
        encoded = json.dumps(summary, indent=2, sort_keys=True)
        if len(encoded.encode("utf-8")) > SUMMARY_STDOUT_MAX_BYTES:
            print(json.dumps({
                "schema_version": 2,
                "result_detail": "summary",
                "overall_status": "contract_error",
                "exit_code": 4,
                "error": "summary_stdout_exceeds_32kb",
            }, indent=2, sort_keys=True))
            return 4
        print(encoded)
        return autonomy_exit_code(str(summary.get("overall_status") or "failed"))

    if (
        args.command == "autonomy"
        and args.autonomy_command == "burn-in"
        and args.burn_in_command == "observe"
    ):
        try:
            result = run_observe_burn_in(
                workspace_root=args.workspace_root,
                workspace_base=args.workspace_base,
                base_dir=args.tools_dir,
                target_ref=args.target_ref,
                cycles=args.cycles,
                min_valid_cycles=args.min_valid_cycles,
                output_dir=args.output_dir,
            )
        except GovernanceError as exc:
            print(json.dumps({
                "schema_version": "aria/autonomy-burn-in-report/v1",
                "acceptance_verdict": "failed",
                "error": str(exc),
            }, indent=2, sort_keys=True))
            return 4
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("acceptance_verdict") == "passed" else 1

    if (
        args.command == "autonomy"
        and args.autonomy_command == "burn-in"
        and args.burn_in_command == "accept"
    ):
        from .autonomy_ladder import record_burn_in_acceptance

        report = json.loads(Path(args.report).read_text(encoding="utf-8"))
        result = record_burn_in_acceptance(report=report, mode=args.mode, base_dir=args.tools_dir)
        print(json.dumps(result, indent=2, sort_keys=True))
        # fail-closed signal: non-zero when nothing could be recorded (verdict not passed)
        return 0 if result.get("verdict") == "passed" else 2

    if args.command == "autonomy" and args.autonomy_command == "unlock":
        if args.unlock_command == "status":
            from .autonomy_unlock import evaluate_autonomy_unlock

            lanes = {}
            for lane in ("L1", "L2", "L3"):
                verdict = evaluate_autonomy_unlock(lane=lane, base_dir=args.tools_dir)
                lanes[lane] = {
                    "unlocked": verdict.valid,
                    "counts": dict(verdict.counts),
                    "requirements": dict(verdict.requirements),
                    "reasons": list(verdict.reasons),
                }
            print(json.dumps({"lanes": lanes}, indent=2, sort_keys=True))
            return 0
        parser.error("unknown autonomy unlock command")

    if args.command == "policy-approval":
        if args.policy_approval_command == "record":
            from .policy_approval import record_policy_approval

            try:
                row = record_policy_approval({
                    "approval_id": args.approval_id,
                    "stage": args.stage,
                    "actor": args.actor,
                    "pr_number": args.pr_number,
                    "head_sha": args.head_sha,
                    "policy_hash": args.policy_hash,
                    "expires_at": args.expires_at,
                    "state": "approved",
                }, base_dir=args.tools_dir)
            except GovernanceError as exc:
                print(json.dumps({"recorded": False, "error": str(exc)}, indent=2, sort_keys=True))
                return 2
            print(json.dumps(row, indent=2, sort_keys=True))
            return 0
        if args.policy_approval_command == "verify":
            from .policy_approval import verify_policy_approval

            try:
                result = verify_policy_approval(
                    pr_number=args.pr_number,
                    head_sha=args.head_sha,
                    policy_hash=args.policy_hash,
                    base_dir=args.tools_dir,
                )
            except GovernanceError as exc:
                print(json.dumps({"valid": False, "error": str(exc)}, indent=2, sort_keys=True))
                return 2
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        parser.error("unknown policy-approval command")

    if args.command == "autonomy" and args.autonomy_command == "project-queue":
        from .next_cycle_queue import read_pending
        result = read_pending(args.tools_dir, limit=args.limit)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    if args.command == "autonomy" and args.autonomy_command == "status":
        if args.target_sha is not None and not args.evidence:
            parser.error("autonomy status --target-sha requires --evidence")
        if args.evidence:
            from .autonomy_evidence import derive_autonomy_evidence_status

            status = derive_autonomy_evidence_status(
                base_dir=args.tools_dir,
                repo_root=Path.cwd(),
                target_sha=args.target_sha,
            )
            print(json.dumps(status.to_dict(), indent=2, sort_keys=True))
            return 0
        # Plan 026R §F.3 — canonical state via the reducer.
        from .autonomy_state import AutonomyStateReducer
        state = AutonomyStateReducer.derive_current(args.tools_dir)
        print(json.dumps(state.to_dict(), indent=2, sort_keys=True))
        return 0

    if args.command == "hook":
        from .hooks import run_hook

        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except ValueError:
            payload = {}
        exit_code, stdout = run_hook(
            args.hook_command,
            payload if isinstance(payload, dict) else {},
            base_dir=args.tools_dir,
            workspace_root=args.workspace_root,
            request_id=args.request_id,
        )
        if stdout:
            print(stdout)
        return exit_code

    if args.command == "checkpoint":
        from . import checkpoint as _cp

        if args.checkpoint_command == "list":
            rows = [c.__dict__ for c in _cp.list_checkpoints(args.request_id, base_dir=args.tools_dir)]
            print(json.dumps(rows, indent=2, sort_keys=True))
            return 0
        if args.checkpoint_command == "take":
            taken = _cp.take_checkpoint(workspace_root=args.workspace_root, request_id=args.request_id,
                                        reason=args.reason, base_dir=args.tools_dir, min_interval_seconds=0)
            print(json.dumps(taken.__dict__ if taken else {"folded": True}, indent=2, sort_keys=True))
            return 0
        if args.checkpoint_command == "diff":
            print(_cp.diff_checkpoint(workspace_root=args.workspace_root, request_id=args.request_id, seq=args.seq, base_dir=args.tools_dir))
            return 0
        if args.checkpoint_command == "restore":
            result = _cp.restore_checkpoint(
                workspace_root=args.workspace_root, request_id=args.request_id, seq=args.seq,
                files=args.files, preserve_hand_edits=not args.all_files, base_dir=args.tools_dir,
            )
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        if args.checkpoint_command == "prune":
            print(json.dumps(_cp.prune_checkpoints(workspace_root=args.workspace_root, base_dir=args.tools_dir), indent=2, sort_keys=True))
            return 0

    if args.command == "context" and args.context_command == "compile":
        from .context_compiler import compile_context

        request: dict[str, Any] = {"request_id": args.request_id, "suggested_prompt": args.query or ""}
        if args.request_id:
            from .ledger import load_declared_jsonl
            from .tool_registry import ensure_tools_dir

            requests_path = ensure_tools_dir(args.tools_dir) / "agent-invocations" / "requests.jsonl"
            rows = load_declared_jsonl(requests_path, expected_surface="agent_invocation_requests") if requests_path.exists() else []
            request = next((r for r in rows if r.get("request_id") == args.request_id), request)
        kwargs = {"budget_tokens": args.budget_tokens} if args.budget_tokens else {}
        print(json.dumps(compile_context(request=request, base_dir=args.tools_dir, record=False, **kwargs).to_dict(), indent=2, sort_keys=True))
        return 0

    if args.command == "economy":
        from . import token_economy as te

        kwargs = {"window_days": args.window_days} if args.window_days else {}
        stats = te.usage_per_accepted_result(base_dir=args.tools_dir, **kwargs)
        if args.economy_command == "stats":
            print(json.dumps([s.to_dict() for s in stats], indent=2, sort_keys=True))
            return 0
        rec_kwargs = {"threshold_tokens": args.threshold_tokens} if args.threshold_tokens else {}
        rows = [*te.recommend_efforts(stats, **rec_kwargs), *te.calibrate_role_caps(stats)]
        if not args.dry_run:
            rows = te.record_recommendations(rows, base_dir=args.tools_dir)
        print(json.dumps(rows, indent=2, sort_keys=True))
        return 0

    if args.command == "self-improve":
        from . import self_improvement as si

        if args.self_command == "scan":
            print(json.dumps([s.__dict__ for s in si.scan_signals(base_dir=args.tools_dir, workspace_root=args.workspace_root)], indent=2, sort_keys=True))
            return 0
        if args.self_command == "open":
            print(json.dumps(si.open_self_improvement_missions(base_dir=args.tools_dir, workspace_root=args.workspace_root, max_new=args.max_new), indent=2, sort_keys=True))
            return 0
        kwargs = {"validation_command": args.validation_command} if args.validation_command else {}
        print(json.dumps(si.propose_self_change(mission_id=args.mission_id, base_dir=args.tools_dir, workspace_root=args.workspace_root,
                                                evidence_paths=args.evidence_paths, problem=args.problem, proposed_change=args.proposed_change, **kwargs),
                         indent=2, sort_keys=True, default=str))
        return 0

    if args.command == "skill":
        from . import skill_curator

        if args.skill_command == "curate":
            kwargs = {}
            if args.similarity is not None:
                kwargs["similarity_threshold"] = args.similarity
            if args.unused_days is not None:
                kwargs["unused_days"] = args.unused_days
            print(json.dumps(skill_curator.propose_curation(args.workspace_root, base_dir=args.tools_dir, **kwargs), indent=2, sort_keys=True))
            return 0
        if args.skill_command == "proposals":
            print(json.dumps(skill_curator.list_curation_proposals(base_dir=args.tools_dir, open_only=args.open), indent=2, sort_keys=True))
            return 0
        if args.skill_command == "decide":
            print(json.dumps(skill_curator.decide_curation(args.proposal_id, decision=args.decision, operator_approval_ref=args.operator_approval_ref,
                                                           base_dir=args.tools_dir, note=args.note), indent=2, sort_keys=True))
            return 0
        if args.skill_command == "rollback":
            print(json.dumps(skill_curator.rollback_skill_materialization(draft_id=args.draft_id, base_dir=args.tools_dir,
                                                                          operator_approval_ref=args.operator_approval_ref,
                                                                          workspace_root=args.workspace_root), indent=2, sort_keys=True))
            return 0
        print(json.dumps(skill_curator.shadow_compare(draft_id=args.draft_id, workspace_root=args.workspace_root, base_dir=args.tools_dir), indent=2, sort_keys=True))
        return 0

    if args.command == "parity":
        from .harness_parity import check_parity, render_parity_report

        if args.parity_command == "generate":
            text = render_parity_report(repo_root=args.workspace_root)
            out = Path(args.workspace_root) / args.output
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(text, encoding="utf-8")
            print(str(out))
            return 0
        records = check_parity(repo_root=args.workspace_root)
        problems = [r for r in records if r["problems"]]
        print(json.dumps({"rows": len(records), "problems": problems}, indent=2, sort_keys=True))
        return 0 if not problems else 1

    if args.command == "security":
        if args.security_command == "prerequisites":
            from .security.prerequisites import render_prerequisites_text, run_prerequisites

            report = run_prerequisites()
            print(json.dumps(report.to_dict(), indent=2, sort_keys=True) if args.json else render_prerequisites_text(report))
            return report.exit_code
        if args.security_command == "profile":
            from .security.profile import compile_profile, latest_profile, record_profile, render_profile_text

            if args.security_profile_command == "show":
                row = latest_profile(base_dir=args.tools_dir)
                print(json.dumps(row, indent=2, sort_keys=True) if row else "no profile compiled yet")
                return 0
            snap = compile_profile(workspace_root=args.workspace_root, repo_sha=args.repo_sha)
            if args.record:
                record_profile(snap, base_dir=args.tools_dir)
            print(json.dumps(snap.to_row(), indent=2, sort_keys=True) if args.json else render_profile_text(snap))
            return 0

    if args.command == "mcp":
        from . import mcp_client

        if args.mcp_command == "serve":
            from .mcp_server import AriaMcpServer

            return AriaMcpServer(base_dir=args.tools_dir, workspace_root=args.workspace_root, allow_writes=args.allow_writes).serve()
        if args.mcp_command == "registry":
            registry = mcp_client.load_mcp_registry()
            print(json.dumps({name: spec.__dict__ for name, spec in registry.servers.items()}, indent=2, sort_keys=True, default=list))
            return 0
        if args.mcp_command == "health":
            registry = mcp_client.load_mcp_registry()
            names = [args.server] if args.server else sorted(registry.servers)
            print(json.dumps([mcp_client.evaluate_mcp_health(n, base_dir=args.tools_dir) for n in names], indent=2, sort_keys=True))
            return 0
        if args.mcp_command == "release":
            print(json.dumps(mcp_client.release_quarantine(args.server, base_dir=args.tools_dir, operator_ref=args.operator_ref), indent=2, sort_keys=True))
            return 0
        from .runtime_profiles import profile_by_id

        print(json.dumps({"config": mcp_client.mcp_config_for_profile(profile_by_id(args.profile), base_dir=args.tools_dir),
                          "disallowed_tools": list(mcp_client.mcp_tool_rules(profile_by_id(args.profile)))}, indent=2, sort_keys=True))
        return 0

    if args.command == "gateway":
        if args.gateway_command == "status":
            from .gateway.inbox import inbox_summary
            from .gateway.scheduler import fold_schedules

            print(json.dumps({"inbox": inbox_summary(args.tools_dir),
                              "schedules": {n: s.__dict__ for n, s in fold_schedules(args.tools_dir).items()}}, indent=2, sort_keys=True))
            return 0
        from .gateway.daemon import run_gateway_daemon
        from .gateway.server import GatewayConfig

        result = run_gateway_daemon(
            base_dir=args.tools_dir, workspace_root=args.workspace_root,
            config=GatewayConfig(host=args.host, port=args.port), max_iterations=args.max_iterations,
            poll_interval_seconds=args.poll_interval_seconds, serve_http=not args.no_http,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result.get("exits_clean") else 1

    if args.command == "schedule":
        from .gateway import scheduler

        if args.schedule_command == "add":
            print(json.dumps(scheduler.add_schedule(name=args.name, action=args.action, cron=args.cron, base_dir=args.tools_dir,
                                                    operator_ref=args.operator_ref), indent=2, sort_keys=True))
            return 0
        if args.schedule_command in {"pause", "resume", "remove"}:
            print(json.dumps(scheduler.change_schedule(args.schedule_command, name=args.name, base_dir=args.tools_dir,
                                                       operator_ref=args.operator_ref), indent=2, sort_keys=True))
            return 0
        if args.schedule_command == "list":
            print(json.dumps({n: s.__dict__ for n, s in scheduler.fold_schedules(args.tools_dir).items()}, indent=2, sort_keys=True))
            return 0
        result = scheduler.run_action(args.action, base_dir=args.tools_dir, workspace_root=args.workspace_root)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["status"] != "failed" else 1

    if args.command == "event":
        from .gateway import inbox as gateway_inbox
        from .gateway import normalize as gateway_normalize
        from .gateway.router import drain_inbox, route_event

        if args.event_command == "route":
            print(json.dumps(drain_inbox(base_dir=args.tools_dir, workspace_root=args.workspace_root), indent=2, sort_keys=True))
            return 0
        payload = json.loads(Path(args.payload_file).read_text(encoding="utf-8"))
        delivery = args.delivery_id or f"cli:{gateway_normalize.payload_digest(payload)[7:31]}"
        if args.source == "github":
            if not args.github_event:
                raise SystemExit("--github-event is required for --source github")
            event = gateway_normalize.normalize_github(args.github_event, delivery, payload)
            events = [event] if event is not None else []
        elif args.source == "alertmanager":
            events = gateway_normalize.normalize_alertmanager(delivery, payload)
        else:
            events = [gateway_normalize.normalize_operator(delivery, payload, actor=args.actor or "cli")]
        out = []
        for event in events:
            row = gateway_inbox.record_event(event, base_dir=args.tools_dir)
            entry: dict[str, Any] = {"delivery_id": event.delivery_id, "kind": event.kind, "accepted": row is not None}
            if row is not None and args.route:
                outcome = route_event(event, base_dir=args.tools_dir, workspace_root=args.workspace_root)
                entry["action"], entry["refs"], entry["error"] = outcome.action, outcome.refs, outcome.error
            out.append(entry)
        print(json.dumps(out, indent=2, sort_keys=True))
        return 0

    if args.command == "control":
        from .control import effective_control, record_control

        if args.control_command == "status":
            print(json.dumps(effective_control(args.tools_dir).to_dict(), indent=2, sort_keys=True))
            return 0
        row = record_control(args.control_command, base_dir=args.tools_dir, request_id=args.request_id,
                             operator_ref=args.operator_ref, reason=args.reason)
        print(json.dumps({"command": row, "effective": effective_control(args.tools_dir).to_dict()}, indent=2, sort_keys=True))
        return 0

    if args.command == "notify":
        from .notify import CHANNEL_ENV_NAMES, configured_channels, notify

        if args.notify_command == "channels":
            print(json.dumps({"configured": list(configured_channels()), "env_names": CHANNEL_ENV_NAMES}, indent=2, sort_keys=True))
            return 0
        rows = notify(kind=args.kind, title=args.title, body=args.body, key=args.key, base_dir=args.tools_dir,
                      channels=args.channels, dry_run=args.dry_run)
        print(json.dumps(rows, indent=2, sort_keys=True))
        return 0 if all(r["status"] != "failed" for r in rows) else 1

    if args.command == "tail":
        from .progress import render_progress_row, tail_progress

        for row in tail_progress(args.request_id, base_dir=args.tools_dir, last=args.last, follow=args.follow,
                                 max_wait_seconds=args.max_wait_seconds):
            print(json.dumps(row, sort_keys=True) if args.json else render_progress_row(row), flush=True)
        return 0

    if args.command == "delivery" and args.delivery_command == "status":
        from .delivery_closure import compute_delivery_closure, render_delivery_text

        report = compute_delivery_closure(base_dir=args.tools_dir)
        print(json.dumps(report.to_dict(), indent=2, sort_keys=True) if args.json else render_delivery_text(report))
        return 0

    if args.command == "session" and args.session_command == "list":
        from .session_continuity import sessions_for

        print(json.dumps(sessions_for(args.request_id, base_dir=args.tools_dir), indent=2, sort_keys=True))
        return 0

    if args.command == "recovery" and args.recovery_command == "classify":
        from .recovery import classify_recovery, gh_remote_reader

        decision = classify_recovery(
            args.request_id, base_dir=args.tools_dir, fingerprint=args.fingerprint,
            remote_reader=None if args.offline else gh_remote_reader(args.workspace_root),
        )
        print(json.dumps(decision.to_dict(), indent=2, sort_keys=True))
        return 0 if decision.decision != "human_required" else 3

    if args.command == "search":
        from .search import rebuild_index, search

        if args.rebuild:
            counts = rebuild_index(workspace_root=args.workspace_root, base_dir=args.tools_dir)
            print(json.dumps({"rebuilt": counts}, sort_keys=True), file=sys.stderr)
        hits = search(args.query, workspace_root=args.workspace_root, kinds=args.kinds, limit=args.limit)
        print(json.dumps([h.__dict__ for h in hits], indent=2, sort_keys=True))
        return 0

    if args.command == "doctor":
        from .doctor import render_doctor_text, run_doctor

        report = run_doctor(
            base_dir=args.tools_dir,
            workspace_root=getattr(args, "workspace_root", None) or Path.cwd(),
        )
        if args.json:
            print(json.dumps(report.to_dict(), indent=2, sort_keys=True))
        else:
            print(render_doctor_text(report))
        return report.exit_code

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
