from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aria_kernel.cycle import run_cycle
from aria_kernel.feedback import add_feedback, build_feedback_event, import_feedback, list_feedback
from aria_kernel.workspace import ensure_workspace, workspace_paths


def add_workspace_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace-root", default=".", help="Repository root to bind to ARIA workspace")
    parser.add_argument("--workspace-base", default=None, help="Override ~/.aria/workspaces for tests or sandboxes")


def resolve_paths(args: argparse.Namespace):
    paths = workspace_paths(
        Path(args.workspace_root),
        Path(args.workspace_base) if args.workspace_base else None,
    )
    ensure_workspace(paths)
    return paths


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aria-kernel")
    sub = parser.add_subparsers(dest="command", required=True)

    cycle_parser = sub.add_parser("cycle")
    add_workspace_args(cycle_parser)

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

    import_parser = feedback_sub.add_parser("import")
    add_workspace_args(import_parser)
    import_parser.add_argument("--file", required=True)

    list_parser = feedback_sub.add_parser("list")
    add_workspace_args(list_parser)
    list_parser.add_argument("--kind", default=None)

    args = parser.parse_args(argv)
    paths = resolve_paths(args)

    if args.command == "cycle":
        print(json.dumps(run_cycle(paths), indent=2, sort_keys=True))
        return 0

    if args.command == "feedback" and args.feedback_command == "add":
        event = build_feedback_event(args)
        emitted = add_feedback(paths, event)
        print(json.dumps({"event": event, "pressure_emitted": emitted}, indent=2, sort_keys=True))
        return 0

    if args.command == "feedback" and args.feedback_command == "import":
        count = import_feedback(paths, Path(args.file))
        print(json.dumps({"imported": count}, indent=2, sort_keys=True))
        return 0

    if args.command == "feedback" and args.feedback_command == "list":
        print(json.dumps(list_feedback(paths, args.kind), indent=2, sort_keys=True))
        return 0

    parser.error("unreachable command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
