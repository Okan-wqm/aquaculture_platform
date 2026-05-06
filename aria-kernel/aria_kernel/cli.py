from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aria_kernel.cycle import run_cycle
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
from aria_kernel.pressure import curate_workspace_pressures, explain_pressure, explain_workspace_pressure, list_workspace_pressures
from aria_kernel.quarantine import quarantine_tool
from aria_kernel.tool_registry import GovernanceError, list_tools, register_tool
from aria_kernel.tool_runner import run_tool
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
        if hasattr(args, "workspace_root") and args.command in {"feedback", "pressure", "curate"} and not legacy_pressure_explain
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
