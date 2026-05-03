from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .cycle import run_cycle
from .cycle_diff import run_cycle_diff
from .db_snapshot import write_schema_snapshot
from .discovery import run_discovery
from .feedback_store import list_findings, record_operator_feedback
from .fixture_runner import run_fixture_suite
from .integrity import verify_integrity
from .memory import list_memory, update_memory
from .pressure import run_pressure
from .proposal import list_proposals, record_proposal
from .promotion import promote_tool
from .quarantine import quarantine_tool
from .reflection import run_reflection
from .research import list_research_sources, record_research_source
from .tool_health import evaluate_health, record_run
from .tool_registry import GovernanceError, ensure_tools_dir, list_tools, register_tool
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

    pressure = subparsers.add_parser("pressure")
    pressure_subparsers = pressure.add_subparsers(dest="command", required=True)
    pressure_run = pressure_subparsers.add_parser("run")
    pressure_run.add_argument("--cycle-id", required=True)
    pressure_run.set_defaults(func=cmd_pressure_run)

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
    proposal_list = proposal_subparsers.add_parser("list")
    proposal_list.add_argument("--kind", default=None)
    proposal_list.set_defaults(func=cmd_proposal_list)

    research = subparsers.add_parser("research")
    research_subparsers = research.add_subparsers(dest="command", required=True)
    research_source = research_subparsers.add_parser("record-source")
    research_source.add_argument("--url", required=True)
    research_source.add_argument("--source-tier", required=True)
    research_source.add_argument("--content-hash", required=True)
    research_source.add_argument("--title", default="")
    research_source.set_defaults(func=cmd_research_record_source)
    research_list = research_subparsers.add_parser("list-sources")
    research_list.set_defaults(func=cmd_research_list_sources)

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


def cmd_bootstrap_init(args: argparse.Namespace) -> dict[str, Any]:
    root = ensure_tools_dir(args.tools_dir)
    for relative in (
        "discovery",
        "memory",
        "pressure",
        "reports/daily",
        "research",
        "proposals",
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


def cmd_pressure_run(args: argparse.Namespace) -> dict[str, Any]:
    return run_pressure(cycle_id=args.cycle_id, base_dir=args.tools_dir)


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


def cmd_proposal_list(args: argparse.Namespace) -> dict[str, Any]:
    return {"proposals": list_proposals(base_dir=args.tools_dir, kind=args.kind)}


def cmd_research_record_source(args: argparse.Namespace) -> dict[str, Any]:
    return record_research_source(
        url=args.url,
        source_tier=args.source_tier,
        content_hash=args.content_hash,
        title=args.title,
        base_dir=args.tools_dir,
    )


def cmd_research_list_sources(args: argparse.Namespace) -> dict[str, Any]:
    return {"sources": list_research_sources(base_dir=args.tools_dir)}


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
