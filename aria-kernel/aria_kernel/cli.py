from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .db_snapshot import write_schema_snapshot
from .feedback_store import list_findings, record_operator_feedback
from .fixture_runner import run_fixture_suite
from .promotion import promote_tool
from .quarantine import quarantine_tool
from .tool_health import evaluate_health, record_run
from .tool_registry import GovernanceError, list_tools, register_tool
from .tool_runner import run_tool


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
    feedback_record.set_defaults(func=cmd_feedback_record)

    db = subparsers.add_parser("db")
    db_subparsers = db.add_subparsers(dest="command", required=True)
    snapshot = db_subparsers.add_parser("snapshot")
    snapshot.add_argument("--service", required=True)
    snapshot.add_argument("--output", required=True)
    snapshot.add_argument("--database-url", default=None)
    snapshot.set_defaults(func=cmd_db_snapshot)
    return parser


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
    return record_operator_feedback(
        tool_id=args.tool_id,
        run_id=args.run_id,
        finding_id=args.finding_id,
        verdict=args.verdict,
        severity=args.severity,
        note=args.note,
        base_dir=args.tools_dir,
    )


def cmd_db_snapshot(args: argparse.Namespace) -> dict[str, Any]:
    return write_schema_snapshot(
        service=args.service,
        output=args.output,
        database_url=args.database_url,
    )


def read_json(path: str) -> Any:
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)
