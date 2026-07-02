"""Deterministic plan-coverage computation (the kernel side of the gate).

WHY this module exists: convergence measures AGREEMENT, not COVERAGE — the
primary and challenger planners can share a blind spot and happily converge
on it. The planner prompts demand recursive impact tracing, but a prompt is
a wish; nothing verified it. This module turns the obligation into machine
truth: it invokes the repo's plan-coverage witness (a deterministic TypeScript
gate that computes the impact closure of a plan's ``affected_surfaces`` from
the Nx dependency graph, the NATS event-contract topology, and the
entity->migration coupling), diffs the closure against what the plan claims
or waives, and shapes the result into the ``coverage_computed`` event payload
that ``plan_convergence.record_coverage`` validates and persists.

Fail-closed discipline: this function NEVER raises for environmental
problems. A missing node toolchain, a witness crash, a timeout, or garbage
stdout all produce a ``verdict="environment_unable"`` payload — the evaluator
escalates that to HUMAN_REQUIRED. An empty closure can never masquerade as
"covered" because the witness itself distinguishes exit 0/1 (computed) from
exit 2 (environment), and anything unparseable lands on the environment side.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any, Callable

from .tool_registry import ensure_tools_dir, utc_now

WITNESS_RELPATH = "tools/gates/plan-coverage-witness.ts"
WITNESS_TSCONFIG = "tools/gates/tsconfig.json"
DEFAULT_TIMEOUT_SECONDS = 180
COVERAGE_DIR = "coverage"
# Severity is "material" (not "blocking"): a coverage gap must block
# convergence via the material gate AND remain addressable through the
# normal revision loop (addresses_review_risk_ids), exactly like a
# reviewer-raised material risk.
SYNTHETIC_RISK_SEVERITY = "material"
SYNTHETIC_RISK_CATEGORY = "coverage_gap"

Runner = Callable[[list[str], str, int], "subprocess.CompletedProcess[str]"]


def _default_runner(cmd: list[str], cwd: str, timeout_seconds: int) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(  # noqa: S603 — fixed argv, no shell
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )


def build_synthetic_risk(node: dict[str, Any], *, round_number: int, closure_manifest_path: str) -> dict[str, Any]:
    """Shape one uncovered closure node as a CROSS_REVIEW_RISK-schema risk.

    The risk_id is ROUND-SCOPED (``COV-R{N}-<hash>``): resolved_review_risk_ids
    accumulates globally across rounds, so a stable id would let round N's
    "addressed" claim mask the SAME still-uncovered node re-detected in round
    N+1. A fresh id per round keeps machine verification authoritative.
    """
    node_id = str(node.get("node_id"))
    digest = hashlib.sha256(node_id.encode("utf-8")).hexdigest()[:8]
    return {
        "risk_id": f"COV-R{round_number}-{digest}",
        "risk_category": SYNTHETIC_RISK_CATEGORY,
        "severity": SYNTHETIC_RISK_SEVERITY,
        "summary": (
            f"Impact-closure node {node_id} ({node.get('kind')}) is not addressed by "
            f"affected_surfaces and not waived: {node.get('why')}"
        ),
        "recommendation": (
            "Widen affected_surfaces to address the node, or add a coverage.waivers "
            "entry {node, reason} the completeness critic can adjudicate"
        ),
        "affected_files": [closure_manifest_path],
        "evidence_refs": [f"{closure_manifest_path}:1"],
    }


def environment_unable_payload(
    *,
    round_number: int,
    target_revision_id: str,
    target_plan_content_hash: str,
    manifest_relpath: str,
    manifest_hash: str,
    computed_at_sha: str,
    witness: dict[str, Any],
) -> dict[str, Any]:
    return {
        "round_number": round_number,
        "target_revision_id": target_revision_id,
        "target_plan_content_hash": target_plan_content_hash,
        "verdict": "environment_unable",
        "closure_manifest_path": manifest_relpath,
        "closure_manifest_hash": manifest_hash,
        "closure_summary": {},
        "uncovered": [],
        "waived": [],
        "synthetic_risks": [],
        "computed_at_sha": computed_at_sha,
        "witness": witness,
    }


def compute_plan_coverage(
    *,
    plan_content: dict[str, Any],
    plan_id: str,
    round_number: int,
    target_revision_id: str,
    target_plan_content_hash: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    runner: Runner | None = None,
) -> dict[str, Any]:
    """Compute the impact-closure verdict for one plan revision.

    Returns a payload ready for ``plan_convergence.record_coverage``. The
    closure manifest (full witness output) is written as an artifact file
    under ``<tools>/coverage/`` and referenced by path+hash from the event —
    events stay small, the audit trail stays complete.
    """
    run = runner or _default_runner
    workspace = Path(workspace_root)
    root = ensure_tools_dir(base_dir)
    coverage_dir = root / COVERAGE_DIR
    coverage_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = coverage_dir / f"{plan_id}-r{round_number}.json"
    tools_root_name = root.name if root.is_absolute() else str(root)
    manifest_relpath = f"{tools_root_name}/{COVERAGE_DIR}/{manifest_path.name}"

    computed_at_sha = "unknown"
    try:
        sha_proc = run(["git", "rev-parse", "HEAD"], str(workspace), 30)
        if sha_proc.returncode == 0:
            computed_at_sha = sha_proc.stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        pass

    affected = plan_content.get("affected_surfaces") or {}
    paths = affected.get("paths") if isinstance(affected, dict) else affected
    waivers = (plan_content.get("coverage") or {}).get("waivers", [])
    witness_input = {
        "schema_version": 1,
        "affected_paths": [str(p) for p in (paths or [])],
        "waivers": [
            {"node": str(w.get("node")), "reason": str(w.get("reason"))}
            for w in waivers
            if isinstance(w, dict)
        ],
    }
    input_path = coverage_dir / f"{plan_id}-r{round_number}-input.json"
    input_path.write_text(json.dumps(witness_input, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    cmd = [
        "npx",
        "ts-node",
        "--project",
        WITNESS_TSCONFIG,
        WITNESS_RELPATH,
        "--input",
        str(input_path),
    ]
    started_at = utc_now()
    try:
        proc = run(cmd, str(workspace), timeout_seconds)
        exit_code = proc.returncode
        stdout = proc.stdout
        stderr_tail = (proc.stderr or "")[-2000:]
    except FileNotFoundError as exc:
        return environment_unable_payload(
            round_number=round_number,
            target_revision_id=target_revision_id,
            target_plan_content_hash=target_plan_content_hash,
            manifest_relpath=manifest_relpath,
            manifest_hash="sha256:" + hashlib.sha256(b"").hexdigest(),
            computed_at_sha=computed_at_sha,
            witness={"tool": WITNESS_RELPATH, "error": f"toolchain_missing: {exc}", "started_at": started_at},
        )
    except subprocess.TimeoutExpired:
        return environment_unable_payload(
            round_number=round_number,
            target_revision_id=target_revision_id,
            target_plan_content_hash=target_plan_content_hash,
            manifest_relpath=manifest_relpath,
            manifest_hash="sha256:" + hashlib.sha256(b"").hexdigest(),
            computed_at_sha=computed_at_sha,
            witness={"tool": WITNESS_RELPATH, "error": f"timeout_after_{timeout_seconds}s", "started_at": started_at},
        )

    witness_meta: dict[str, Any] = {
        "tool": WITNESS_RELPATH,
        "exit_code": exit_code,
        "started_at": started_at,
        "finished_at": utc_now(),
    }
    if exit_code not in (0, 1):
        witness_meta["error"] = f"witness_environment_exit_{exit_code}"
        witness_meta["stderr_tail"] = stderr_tail
        return environment_unable_payload(
            round_number=round_number,
            target_revision_id=target_revision_id,
            target_plan_content_hash=target_plan_content_hash,
            manifest_relpath=manifest_relpath,
            manifest_hash="sha256:" + hashlib.sha256(b"").hexdigest(),
            computed_at_sha=computed_at_sha,
            witness=witness_meta,
        )
    try:
        report = json.loads(stdout)
        if not isinstance(report, dict):
            raise ValueError("witness output is not an object")
    except (json.JSONDecodeError, ValueError) as exc:
        witness_meta["error"] = f"witness_output_unparseable: {exc}"
        witness_meta["stderr_tail"] = stderr_tail
        return environment_unable_payload(
            round_number=round_number,
            target_revision_id=target_revision_id,
            target_plan_content_hash=target_plan_content_hash,
            manifest_relpath=manifest_relpath,
            manifest_hash="sha256:" + hashlib.sha256(b"").hexdigest(),
            computed_at_sha=computed_at_sha,
            witness=witness_meta,
        )

    manifest_bytes = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode("utf-8")
    manifest_path.write_bytes(manifest_bytes)
    manifest_hash = "sha256:" + hashlib.sha256(manifest_bytes).hexdigest()

    uncovered = [
        {
            "node_id": str(node.get("node_id")),
            "kind": str(node.get("kind")),
            "why": str(node.get("why")),
        }
        for node in report.get("uncovered", [])
        if isinstance(node, dict)
    ]
    waived = [
        {"node_id": str(node.get("node_id")), "reason": str(node.get("reason"))}
        for node in report.get("waived", [])
        if isinstance(node, dict)
    ]
    closure = report.get("closure") or {}
    closure_summary = {
        "projects": len(closure.get("projects", [])),
        "event_consumers": len(closure.get("event_consumers", [])),
        "migration_couplings": len(closure.get("migration_couplings", [])),
        "unmapped_paths": len(report.get("unmapped_paths", [])),
        "waived": len(waived),
    }
    if uncovered:
        verdict = "gaps"
        synthetic_risks = [
            build_synthetic_risk(node, round_number=round_number, closure_manifest_path=manifest_relpath)
            for node in uncovered
        ]
    else:
        verdict = "covered_with_waivers" if waived else "covered"
        synthetic_risks = []
    return {
        "round_number": round_number,
        "target_revision_id": target_revision_id,
        "target_plan_content_hash": target_plan_content_hash,
        "verdict": verdict,
        "closure_manifest_path": manifest_relpath,
        "closure_manifest_hash": manifest_hash,
        "closure_summary": closure_summary,
        "uncovered": uncovered,
        "waived": waived,
        "synthetic_risks": synthetic_risks,
        "computed_at_sha": computed_at_sha,
        "witness": witness_meta,
    }
