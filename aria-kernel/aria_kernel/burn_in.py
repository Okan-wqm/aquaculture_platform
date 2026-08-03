from __future__ import annotations

import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .cycle import _failed_event, run_enterprise_cycle
from .ledger import append_declared_jsonl, file_hash, load_declared_jsonl, load_jsonl
from .runtime_profile import set_profile
from .state_manifest import iter_surfaces, observe_disallowed_tool_surfaces
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_binding, utc_now
from .workspace import ensure_workspace, workspace_paths
from .worktree import is_runtime_path


BURN_IN_SCHEMA_VERSION = "aria/autonomy-burn-in-report/v1"
OBSERVE_BURN_IN_PROFILE = "observe"
REQUIRED_CYCLE_ATTEMPTS = 30
REQUIRED_MIN_VALID_CYCLES = 20

CYCLE_LEDGER_SUMMARY_ARTIFACT = "cycle-ledger-summary.json"
DISALLOWED_ACTIONS_ARTIFACT = "disallowed-actions.json"
MANIFEST_TAIL_HASHES_ARTIFACT = "manifest-tail-hashes.json"
CANDIDATE_DETECTION_ARTIFACT = "candidate-detection.json"
EVIDENCE_BUNDLE_ARTIFACT = "evidence-bundle.json"

DISALLOWED_OBSERVE_SURFACES: tuple[tuple[str, str], ...] = tuple(
    (surface.name, surface.path_pattern)
    for surface in observe_disallowed_tool_surfaces()
)


def run_observe_burn_in(
    *,
    workspace_root: str | Path,
    workspace_base: str | Path,
    base_dir: str | Path,
    target_ref: str,
    cycles: int,
    min_valid_cycles: int,
    output_dir: str | Path,
) -> dict[str, Any]:
    """Run a no-action observe burn-in for enterprise autonomy readiness.

    This is intentionally NOT a wrapper around ``autonomy run``. The
    autonomy orchestrator is allowed to mint agent claims under non-observe
    profiles; observe burn-in must stay in the discovery/memory/pressure/
    triage lane and prove that no claim, tool run, PR, merge, promotion, or
    materialization surface was touched.
    """

    repo = Path(workspace_root).resolve()
    workspace_base_path = _required_path("workspace_base", workspace_base).resolve()
    tools_root = _required_path("base_dir", base_dir).resolve()
    output_root = _required_path("output_dir", output_dir).resolve()
    _validate_args(
        repo=repo,
        workspace_base=workspace_base_path,
        tools_root=tools_root,
        output_root=output_root,
        target_ref=target_ref,
        cycles=cycles,
        min_valid_cycles=min_valid_cycles,
    )
    output_root.mkdir(parents=True, exist_ok=True)
    try:
        _require_clean_worktree(repo, "pre")
        current_head = _git(repo, "rev-parse", "HEAD")
        target_sha = _git(repo, "rev-parse", target_ref)
        if current_head != target_sha:
            raise GovernanceError(
                "observe_burn_in_target_ref_mismatch: "
                f"HEAD={current_head} target_ref={target_ref!r} target_sha={target_sha}"
            )
    except Exception as exc:
        _write_failure_report(
            output_root / "failure-report.json",
            phase="preflight",
            error=exc,
            cycle_id=None,
            repo=repo,
        )
        raise

    tools_root = ensure_tools_binding(tools_root, workspace_root=repo)
    set_profile(
        OBSERVE_BURN_IN_PROFILE,
        operator_approval_ref=f"observe-burn-in:{target_ref}:{current_head[:12]}",
        base_dir=tools_root,
        set_by="observe-burn-in",
    )
    paths = workspace_paths(repo, workspace_base_path)
    ensure_workspace(paths)

    started_at = utc_now()
    before_disallowed = _disallowed_snapshot(tools_root)
    before_manifest = _manifest_snapshot(tools_root)
    cycle_results: list[dict[str, Any]] = []
    for index in range(1, cycles + 1):
        cycle_id = _cycle_id(index)
        cycle_row = {
            "schema_version": 1,
            "cycle_id": cycle_id,
            "status": "started",
            "started_at": utc_now(),
        }
        try:
            # Pre-collapse this block was a THIRD hand-rolled cycle loop:
            # it appended its own started/terminal ledger rows and called
            # the five observe primitives directly, importing this
            # module's private event factories. The burn-in lane is now a
            # MODE of the one pipeline — `CYCLE_PHASES` rows carrying
            # ``burn_in`` are exactly the observe set (discovery,
            # cycle_diff, memory, pressure, triage, artifact_integrity),
            # so the no-action property is the table's mode column, and
            # the started/terminal ledger discipline has a single owner.
            state = run_enterprise_cycle(
                workspace_root=repo,
                cycle_id=cycle_id,
                workspace_base=workspace_base_path,
                base_dir=tools_root,
                snapshot_mode="committed",
                mode="burn_in",
            )
            if state.get("status") != "completed":
                raise GovernanceError(
                    f"observe_burn_in_cycle_not_completed: status={state.get('status')!r} "
                    f"failed_phases={[f.get('phase') for f in state.get('failed_phases') or []]}"
                )
            discovery = state.get("discovery") or {}
            diff = state.get("cycle_diff") or {}
            memory = state.get("memory") or {}
            pressure = state.get("pressure") or {}
            triage = state.get("triage") or {}
            cycle_row.update(
                {
                    "status": "completed",
                    "completed_at": utc_now(),
                    "discovery_complete": bool(discovery.get("completion_proof", {}).get("complete")),
                    "fated_file_count": int(discovery.get("completion_proof", {}).get("fated_file_count") or 0),
                    "diff_changed_count": int(diff.get("changed_count") or 0),
                    "memory_beliefs_written": int(memory.get("beliefs_written") or 0),
                    "memory_evidence": {
                        "observations_written": int(memory.get("observations_written") or 0),
                        "beliefs_written": int(memory.get("beliefs_written") or 0),
                        "no_op_proof": bool(memory.get("noop_proof")),
                    },
                    "pressure_count": len(pressure.get("pressures") or []),
                    "pressure_evidence": {
                        "evaluated": isinstance(pressure.get("pressures"), list),
                        "pressure_count": len(pressure.get("pressures") or []),
                    },
                    "triaged_count": int(triage.get("triaged_count") or 0),
                    "triage_evidence": {
                        "evaluated": "triaged_count" in triage,
                        "decision_count": len(triage.get("decisions") or []),
                        "no_op_proof": int(triage.get("triaged_count") or 0) == 0
                        and isinstance(triage.get("decisions"), list),
                    },
                }
            )
        except Exception as exc:  # pragma: no cover - exercised by caller-visible failure tests.
            # The pipeline owns the terminal ledger rows. Only close the
            # cycle here when the exception escaped BEFORE a terminal row
            # landed (a propagate-phase raise exits run_enterprise_cycle
            # between the started row and any terminal row); appending a
            # second terminal row after the pipeline's own would corrupt
            # the one-terminal-per-cycle lifecycle discipline.
            if not _cycle_has_terminal_row(tools_root, cycle_id):
                append_declared_jsonl(
                    tools_root / "cycles.jsonl",
                    _failed_event(cycle_id, git_head_sha_at_cycle=current_head, decision_count=0),
                    expected_surface="cycles",
                )
            _write_failure_report(
                output_root / "failures" / f"{cycle_id}.json",
                phase="cycle",
                error=exc,
                cycle_id=cycle_id,
                repo=repo,
            )
            cycle_row.update(
                {
                    "status": "failed",
                    "failed_at": utc_now(),
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
        cycle_results.append(cycle_row)

    postflight_errors: list[str] = []
    try:
        _require_clean_worktree(repo, "post")
    except Exception as exc:
        postflight_errors.append(str(exc))
        _write_failure_report(
            output_root / "failure-report.json",
            phase="postflight",
            error=exc,
            cycle_id=None,
            repo=repo,
        )
    after_disallowed = _disallowed_snapshot(tools_root)
    after_manifest = _manifest_snapshot(tools_root)
    disallowed = _diff_snapshots(before_disallowed, after_disallowed)
    summaries = _summaries(tools_root, cycle_results)
    cycle_ledger_summary = _cycle_ledger_summary(tools_root, cycle_results)
    cycle_validity = {
        str(row.get("cycle_id")): _cycle_validity(row, cycle_ledger_summary=cycle_ledger_summary)
        for row in cycle_results
    }
    for row in cycle_results:
        validity = cycle_validity[str(row.get("cycle_id"))]
        row["valid_cycle"] = validity["valid"]
        row["validity_reasons"] = validity["reasons"]
    valid_cycle_ids = [
        cycle_id
        for cycle_id, validity in cycle_validity.items()
        if validity["valid"]
    ]
    valid_cycles = len(valid_cycle_ids)
    cycle_ledger_summary["valid_cycle_ids"] = valid_cycle_ids
    cycle_ledger_summary["invalid_cycle_ids"] = [
        cycle_id
        for cycle_id, validity in cycle_validity.items()
        if not validity["valid"]
    ]
    candidate_detection = _candidate_detection(tools_root)
    disallowed_report = {
        "schema_version": "aria/disallowed-actions/v1",
        "generated_at": utc_now(),
        "before": before_disallowed,
        "after": after_disallowed,
        "deltas": disallowed,
    }
    manifest_tail_hashes = {
        "schema_version": "aria/manifest-tail-hashes/v1",
        "generated_at": utc_now(),
        "before": before_manifest,
        "after": after_manifest,
        "deltas": _diff_manifest_snapshots(before_manifest, after_manifest),
    }
    verdict = (
        "passed"
        if (
            cycles == REQUIRED_CYCLE_ATTEMPTS
            and min_valid_cycles == REQUIRED_MIN_VALID_CYCLES
            and valid_cycles >= min_valid_cycles
            and not disallowed
            and not postflight_errors
            and not cycle_ledger_summary["missing_terminal_rows"]
        )
        else "failed"
    )
    cycle_artifact_path = output_root / "cycles.json"
    _write_json(
        cycle_artifact_path,
        {
            "schema_version": "aria/autonomy-burn-in-cycles/v1",
            "cycles": cycle_results,
        },
    )
    _write_json(output_root / CYCLE_LEDGER_SUMMARY_ARTIFACT, cycle_ledger_summary)
    _write_json(output_root / DISALLOWED_ACTIONS_ARTIFACT, disallowed_report)
    _write_json(output_root / MANIFEST_TAIL_HASHES_ARTIFACT, manifest_tail_hashes)
    _write_json(output_root / CANDIDATE_DETECTION_ARTIFACT, candidate_detection)
    report = {
        "schema_version": BURN_IN_SCHEMA_VERSION,
        "generated_at": utc_now(),
        "started_at": started_at,
        "completed_at": utc_now(),
        "target_ref": target_ref,
        "base_commit_sha": current_head,
        "cycle_attempts": cycles,
        "valid_cycles": valid_cycles,
        "failed_cycles": len([row for row in cycle_results if row.get("status") == "failed"]),
        "min_valid_cycles": min_valid_cycles,
        "workspace_root": repo.as_posix(),
        "workspace_base": workspace_base_path.as_posix(),
        "tools_dir": tools_root.as_posix(),
        "profile": OBSERVE_BURN_IN_PROFILE,
        "discovery_summary": summaries["discovery_summary"],
        "memory_summary": summaries["memory_summary"],
        "pressure_summary": summaries["pressure_summary"],
        "finding_summary": summaries["finding_summary"],
        "triage_summary": summaries["triage_summary"],
        "skill_gap_candidates": candidate_detection["candidate_observations"]["skill_gap_candidates"],
        "agent_gap_candidates": candidate_detection["candidate_observations"]["agent_gap_candidates"],
        "candidate_observations": candidate_detection["candidate_observations"],
        "disallowed_actions_observed": disallowed,
        "cycles": cycle_results,
        "cycle_ledger_summary": CYCLE_LEDGER_SUMMARY_ARTIFACT,
        "disallowed_actions_report": DISALLOWED_ACTIONS_ARTIFACT,
        "manifest_tail_hashes": MANIFEST_TAIL_HASHES_ARTIFACT,
        "candidate_detection": CANDIDATE_DETECTION_ARTIFACT,
        "evidence_bundle": EVIDENCE_BUNDLE_ARTIFACT,
        "evidence_bundle_hash": None,
        "failure_reports": _failure_reports(output_root),
        "acceptance_conditions": {
            "required_cycle_attempts": REQUIRED_CYCLE_ATTEMPTS,
            "required_min_valid_cycles": REQUIRED_MIN_VALID_CYCLES,
            "actual_cycle_attempts": cycles,
            "actual_min_valid_cycles": min_valid_cycles,
            "valid_cycles": valid_cycles,
            "zero_disallowed_actions": not disallowed,
            "post_worktree_clean": not postflight_errors,
            "valid_cycle_evidence_verified": valid_cycles >= min_valid_cycles,
        },
        "artifact_hashes": {},
        "acceptance_verdict": verdict,
    }
    report_path = output_root / "autonomy-burn-in-report.json"
    bundle_path = output_root / EVIDENCE_BUNDLE_ARTIFACT
    evidence_bundle = _evidence_bundle(
        output_root,
        target_ref=target_ref,
        base_commit_sha=current_head,
    )
    report["evidence_bundle_hash"] = _bundle_content_hash(evidence_bundle)
    report["artifact_hashes"] = _artifact_hashes(
        output_root,
        exclude={report_path.resolve(), bundle_path.resolve()},
    )
    validate_burn_in_report(report)
    _write_json(report_path, report)
    evidence_bundle["burn_in_report_hash"] = "sha256:" + file_hash(report_path)
    _write_json(bundle_path, evidence_bundle)
    verify_burn_in_artifact_bundle(output_root)
    append_tools_governance(
        tools_root,
        "observe_burn_in_completed",
        {
            "target_ref": target_ref,
            "base_commit_sha": current_head,
            "cycle_attempts": cycles,
            "valid_cycles": valid_cycles,
            "min_valid_cycles": min_valid_cycles,
            "acceptance_verdict": verdict,
            "report_path": report_path.as_posix(),
        },
    )
    return report


def _required_path(name: str, value: str | Path | None) -> Path:
    if value is None or str(value).strip() == "":
        raise GovernanceError(f"observe_burn_in_requires_{name}")
    return Path(value)


def _validate_args(
    *,
    repo: Path,
    workspace_base: Path,
    tools_root: Path,
    output_root: Path,
    target_ref: str,
    cycles: int,
    min_valid_cycles: int,
) -> None:
    if not repo.exists():
        raise GovernanceError(f"observe_burn_in_workspace_root_missing: {repo.as_posix()}")
    if not target_ref.strip():
        raise GovernanceError("observe_burn_in_requires_target_ref")
    if cycles <= 0:
        raise GovernanceError("observe_burn_in_cycles_must_be_positive")
    if min_valid_cycles <= 0:
        raise GovernanceError("observe_burn_in_min_valid_cycles_must_be_positive")
    if min_valid_cycles > cycles:
        raise GovernanceError("observe_burn_in_min_valid_cycles_exceeds_cycles")
    if cycles != REQUIRED_CYCLE_ATTEMPTS:
        raise GovernanceError(
            f"observe_burn_in_requires_{REQUIRED_CYCLE_ATTEMPTS}_cycles"
        )
    if min_valid_cycles != REQUIRED_MIN_VALID_CYCLES:
        raise GovernanceError(
            f"observe_burn_in_requires_min_{REQUIRED_MIN_VALID_CYCLES}_valid_cycles"
        )
    if _is_inside(tools_root, repo):
        raise GovernanceError("observe_burn_in_tools_dir_must_be_outside_workspace_root")
    if _is_inside(workspace_base, repo):
        raise GovernanceError("observe_burn_in_workspace_base_must_be_outside_workspace_root")
    if _is_inside(output_root, repo):
        raise GovernanceError("observe_burn_in_output_dir_must_be_outside_workspace_root")
    burn_in_root = (tools_root / "burn-in").resolve()
    try:
        output_root.resolve().relative_to(burn_in_root)
    except ValueError as exc:
        raise GovernanceError("observe_burn_in_output_dir_must_be_under_tools_burn_in") from exc


def _is_inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _require_clean_worktree(repo: Path, phase: str) -> None:
    """Refuse to start or finish a burn-in on a dirty SOURCE tree.

    "Dirty" means source-dirty. The kernel appends to its own runtime ledgers
    on every cycle, and a burn-in runs thirty of them, so treating any
    porcelain output as dirt makes the gate self-defeating: the post-check
    fails on the evidence the burn-in was run to produce, and the pre-check
    fails on the previous night's restored state.

    This used to reject any porcelain line at all, while ``worktree.preflight``
    — the other guard over the same question — already excluded runtime paths.
    Two definitions of "clean" over one tree is one definition too many, so the
    notion is imported rather than restated. The concrete failure it caused:
    once ``aria-tools/reports/daily/*.md`` became trackable, ``reflection``
    writes it every cycle, and the next burn-in dispatch died with
    ``observe_burn_in_pre_worktree_not_clean`` — no ladder evidence, from a gate
    that CI cannot see because CI points the kernel at ``.aria-ci/tools``.
    """
    dirty = _git(repo, "status", "--porcelain")
    source_dirty = [
        line for line in dirty.splitlines()
        if line.strip() and not is_runtime_path(line)
    ]
    if source_dirty:
        raise GovernanceError(
            f"observe_burn_in_{phase}_worktree_not_clean: "
            f"{len(source_dirty)} path(s)"
        )


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise GovernanceError(
            f"observe_burn_in_git_failed: git {' '.join(args)}: "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    return result.stdout.strip()


def _cycle_has_terminal_row(tools_root: Path, cycle_id: str) -> bool:
    """Whether cycles.jsonl already carries a terminal row for this cycle.

    Mirrors the terminal set integrity's ``_verify_cycle_lifecycle`` uses;
    the burn-in failure path may close a cycle only when the pipeline did
    not get to.
    """
    try:
        rows = load_declared_jsonl(tools_root / "cycles.jsonl", expected_surface="cycles")
    except GovernanceError:
        return False
    terminal = {"completed", "failed", "stopped", "aborted"}
    return any(
        row.get("cycle_id") == cycle_id and row.get("event") in terminal
        for row in rows
    )


def _cycle_id(index: int) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"burnin-observe-{stamp}-{index:03d}"


def _disallowed_snapshot(root: Path) -> dict[str, dict[str, Any]]:
    return {
        name: _pattern_snapshot(root, relative)
        for name, relative in DISALLOWED_OBSERVE_SURFACES
    }


def _pattern_snapshot(root: Path, relative_pattern: str) -> dict[str, Any]:
    paths = _matching_paths(root, relative_pattern)
    entries = [_file_snapshot(root, path) for path in paths]
    aggregate = {
        "path_pattern": relative_pattern,
        "file_count": len(entries),
        "row_count": sum(int(entry.get("row_count") or 0) for entry in entries),
        "files": entries,
    }
    aggregate["aggregate_hash"] = _stable_hash(entries)
    return aggregate


def _matching_paths(root: Path, relative_pattern: str) -> list[Path]:
    if "*" in relative_pattern:
        return sorted(path for path in root.glob(relative_pattern) if path.is_file())
    path = root / relative_pattern
    return [path] if path.exists() else []


def _file_snapshot(root: Path, path: Path) -> dict[str, Any]:
    rel = path.relative_to(root).as_posix()
    rows: list[dict[str, Any]] = []
    tail_hash = None
    if path.suffix == ".jsonl":
        rows = load_jsonl(path, verify=True)
        tail_hash = rows[-1].get("ledger_hash") if rows else None
    return {
        "path": rel,
        "exists": path.exists(),
        "row_count": len(rows) if path.suffix == ".jsonl" else None,
        "file_hash": file_hash(path),
        "tail_hash": tail_hash,
    }


def _diff_snapshots(before: dict[str, dict[str, Any]], after: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for name, before_snapshot in before.items():
        after_snapshot = after.get(name, {})
        before_count = int(before_snapshot.get("row_count") or 0)
        after_count = int(after_snapshot.get("row_count") or 0)
        before_hash = before_snapshot.get("aggregate_hash")
        after_hash = after_snapshot.get("aggregate_hash")
        if after_count != before_count or after_hash != before_hash:
            rows.append(
                {
                    "surface": name,
                    "before_count": before_count,
                    "after_count": after_count,
                    "row_delta": after_count - before_count,
                    "before_hash": before_hash,
                    "after_hash": after_hash,
                }
            )
    return rows


def _manifest_snapshot(root: Path) -> dict[str, dict[str, Any]]:
    snapshot: dict[str, dict[str, Any]] = {}
    for surface in iter_surfaces():
        if surface.root_kind != "tools":
            continue
        snapshot[surface.name] = {
            "state_class": surface.state_class,
            "path_pattern": surface.path_pattern,
            **_pattern_snapshot(root, surface.path_pattern),
        }
    return snapshot


def _diff_manifest_snapshots(before: dict[str, dict[str, Any]], after: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    deltas: list[dict[str, Any]] = []
    for name, before_snapshot in before.items():
        after_snapshot = after.get(name, {})
        if before_snapshot.get("aggregate_hash") != after_snapshot.get("aggregate_hash"):
            deltas.append(
                {
                    "surface": name,
                    "before_hash": before_snapshot.get("aggregate_hash"),
                    "after_hash": after_snapshot.get("aggregate_hash"),
                    "before_rows": before_snapshot.get("row_count"),
                    "after_rows": after_snapshot.get("row_count"),
                }
            )
    return deltas


def _summaries(root: Path, cycles: list[dict[str, Any]]) -> dict[str, Any]:
    pressure_rows = load_declared_jsonl(
        root / "pressure" / "pressure-log.jsonl",
        expected_surface="pressure_log",
    )
    observations = load_declared_jsonl(
        root / "memory" / "observations.jsonl",
        expected_surface="memory_observations",
    )
    beliefs = load_declared_jsonl(
        root / "memory" / "beliefs.jsonl",
        expected_surface="memory_beliefs",
    )
    triage_rows = load_declared_jsonl(
        root / "triage" / "decisions.jsonl",
        expected_surface="triage_decisions",
    )
    completed = [row for row in cycles if row.get("status") == "completed"]
    latest_pressure = pressure_rows[-1] if pressure_rows else {}
    return {
        "discovery_summary": {
            "completed_cycles": len(completed),
            "max_fated_file_count": max([int(row.get("fated_file_count") or 0) for row in completed] or [0]),
            "all_completed_discoveries_complete": all(bool(row.get("discovery_complete")) for row in completed),
        },
        "memory_summary": {
            "observation_rows": len(observations),
            "belief_rows": len(beliefs),
            "cycle_beliefs_written": sum(int(row.get("memory_beliefs_written") or 0) for row in completed),
        },
        "pressure_summary": {
            "pressure_log_rows": len(pressure_rows),
            "latest_counts": latest_pressure.get("counts") or {},
            "latest_pressure_count": len(latest_pressure.get("pressures") or []) if isinstance(latest_pressure, dict) else 0,
        },
        "finding_summary": {
            "raw_findings_rows": len(load_declared_jsonl(root / "raw-findings.jsonl", expected_surface="raw_findings")),
            "ingested_findings_rows": len(load_declared_jsonl(root / "report-ingestion" / "findings.jsonl", expected_surface="report_ingestion_findings")),
        },
        "triage_summary": {
            "triage_decision_rows": len(triage_rows),
            "cycle_triaged_count": sum(int(row.get("triaged_count") or 0) for row in completed),
        },
    }


def _artifact_hashes(output_root: Path, *, exclude: set[Path] | None = None) -> dict[str, str]:
    excluded = exclude or set()
    hashes: dict[str, str] = {}
    for path in sorted(output_root.rglob("*")):
        if path.is_file() and path.resolve() not in excluded:
            hashes[path.relative_to(output_root).as_posix()] = file_hash(path)
    return hashes


def burn_in_report_schema() -> dict[str, Any]:
    required = [
        "schema_version",
        "generated_at",
        "started_at",
        "completed_at",
        "target_ref",
        "base_commit_sha",
        "cycle_attempts",
        "valid_cycles",
        "failed_cycles",
        "min_valid_cycles",
        "workspace_root",
        "workspace_base",
        "tools_dir",
        "profile",
        "discovery_summary",
        "memory_summary",
        "pressure_summary",
        "finding_summary",
        "triage_summary",
        "skill_gap_candidates",
        "agent_gap_candidates",
        "candidate_observations",
        "disallowed_actions_observed",
        "cycles",
        "cycle_ledger_summary",
        "disallowed_actions_report",
        "manifest_tail_hashes",
        "candidate_detection",
        "evidence_bundle",
        "evidence_bundle_hash",
        "failure_reports",
        "acceptance_conditions",
        "artifact_hashes",
        "acceptance_verdict",
    ]
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": BURN_IN_SCHEMA_VERSION,
        "type": "object",
        "additionalProperties": False,
        "required": required,
        "properties": {field: {} for field in required},
        "x-runtime-constants": {
            "required_cycle_attempts": REQUIRED_CYCLE_ATTEMPTS,
            "required_min_valid_cycles": REQUIRED_MIN_VALID_CYCLES,
            "evidence_bundle_artifact": EVIDENCE_BUNDLE_ARTIFACT,
        },
    }


def validate_burn_in_report(report: dict[str, Any]) -> None:
    schema = burn_in_report_schema()
    required = set(schema["required"])
    actual = set(report)
    missing = sorted(required - actual)
    extra = sorted(actual - required)
    if missing:
        raise GovernanceError(f"burn_in_report_schema_missing:{missing}")
    if extra:
        raise GovernanceError(f"burn_in_report_schema_extra:{extra}")
    if report.get("schema_version") != BURN_IN_SCHEMA_VERSION:
        raise GovernanceError("burn_in_report_schema_version_mismatch")
    if not _is_sha256(str(report.get("base_commit_sha") or ""), git_sha=True):
        raise GovernanceError("burn_in_report_base_commit_sha_invalid")
    if not _is_sha256(str(report.get("evidence_bundle_hash") or "")):
        raise GovernanceError("burn_in_report_evidence_bundle_hash_invalid")
    if report.get("acceptance_verdict") == "passed":
        conditions = report.get("acceptance_conditions") if isinstance(report.get("acceptance_conditions"), dict) else {}
        if int(report.get("cycle_attempts") or 0) != REQUIRED_CYCLE_ATTEMPTS:
            raise GovernanceError("burn_in_report_passed_with_wrong_cycle_attempts")
        if int(report.get("min_valid_cycles") or 0) != REQUIRED_MIN_VALID_CYCLES:
            raise GovernanceError("burn_in_report_passed_with_wrong_min_valid_cycles")
        if int(report.get("valid_cycles") or 0) < REQUIRED_MIN_VALID_CYCLES:
            raise GovernanceError("burn_in_report_passed_with_insufficient_valid_cycles")
        cycles = report.get("cycles") if isinstance(report.get("cycles"), list) else []
        evidence_valid_cycles = len(
            [
                row
                for row in cycles
                if isinstance(row, dict) and row.get("valid_cycle") is True
            ]
        )
        if evidence_valid_cycles != int(report.get("valid_cycles") or 0):
            raise GovernanceError("burn_in_report_valid_cycle_count_mismatch")
        if conditions.get("zero_disallowed_actions") is not True:
            raise GovernanceError("burn_in_report_passed_with_disallowed_actions")
        if conditions.get("post_worktree_clean") is not True:
            raise GovernanceError("burn_in_report_passed_with_dirty_postflight")
        if conditions.get("valid_cycle_evidence_verified") is not True:
            raise GovernanceError("burn_in_report_passed_without_valid_cycle_evidence")


def verify_burn_in_artifact_bundle(output_root: str | Path) -> dict[str, str]:
    root = Path(output_root)
    report_path = root / "autonomy-burn-in-report.json"
    bundle_path = root / EVIDENCE_BUNDLE_ARTIFACT
    if not report_path.exists():
        raise GovernanceError("burn_in_report_missing")
    if not bundle_path.exists():
        raise GovernanceError("burn_in_evidence_bundle_missing")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    validate_burn_in_report(report)
    expected_bundle_hash = _bundle_content_hash(bundle)
    if report.get("evidence_bundle_hash") != expected_bundle_hash:
        raise GovernanceError("burn_in_report_bundle_hash_mismatch")
    report_hash = "sha256:" + file_hash(report_path)
    if bundle.get("burn_in_report_hash") != report_hash:
        raise GovernanceError("burn_in_bundle_report_hash_mismatch")
    artifact_hashes = report.get("artifact_hashes")
    if not isinstance(artifact_hashes, dict):
        raise GovernanceError("burn_in_report_artifact_hashes_invalid")
    for relative, expected_hash in artifact_hashes.items():
        if not _is_sha256(str(expected_hash), allow_bare=True):
            raise GovernanceError(f"burn_in_artifact_hash_invalid:{relative}")
        path = root / str(relative)
        if not path.exists() or file_hash(path) != expected_hash:
            raise GovernanceError(f"burn_in_artifact_hash_mismatch:{relative}")
    return {
        "report_hash": report_hash,
        "evidence_bundle_hash": expected_bundle_hash,
    }


def _cycle_ledger_summary(root: Path, cycles: list[dict[str, Any]]) -> dict[str, Any]:
    rows = load_declared_jsonl(root / "cycles.jsonl", expected_surface="cycles")
    started = [row for row in rows if row.get("event") == "cycle_started" or row.get("status") == "started"]
    terminal = [
        row for row in rows
        if row.get("event") in {"cycle_completed", "cycle_failed"} or row.get("status") in {"completed", "failed"}
    ]
    attempted_ids = [str(row.get("cycle_id")) for row in cycles]
    terminal_ids = {str(row.get("cycle_id")) for row in terminal}
    status_histogram: dict[str, int] = {}
    for row in cycles:
        status = str(row.get("status") or "unknown")
        status_histogram[status] = status_histogram.get(status, 0) + 1
    return {
        "schema_version": "aria/cycle-ledger-summary/v1",
        "generated_at": utc_now(),
        "attempted_cycle_ids": attempted_ids,
        "started_row_count": len(started),
        "terminal_row_count": len(terminal),
        "status_histogram": status_histogram,
        "missing_terminal_rows": sorted(set(attempted_ids) - terminal_ids),
        "tail_hash": rows[-1].get("ledger_hash") if rows else None,
        "valid_cycle_ids": [str(row.get("cycle_id")) for row in cycles if row.get("status") == "completed"],
        "failed_cycle_ids": [str(row.get("cycle_id")) for row in cycles if row.get("status") == "failed"],
    }


def _cycle_validity(
    row: dict[str, Any],
    *,
    cycle_ledger_summary: dict[str, Any],
) -> dict[str, Any]:
    reasons: list[str] = []
    if row.get("status") != "completed":
        reasons.append("cycle_not_completed")
    if row.get("discovery_complete") is not True:
        reasons.append("discovery_not_complete")
    memory = row.get("memory_evidence") if isinstance(row.get("memory_evidence"), dict) else {}
    if not (
        int(memory.get("observations_written") or 0) > 0
        or int(memory.get("beliefs_written") or 0) > 0
        or memory.get("no_op_proof") is True
    ):
        reasons.append("memory_evidence_missing")
    pressure = row.get("pressure_evidence") if isinstance(row.get("pressure_evidence"), dict) else {}
    if pressure.get("evaluated") is not True:
        reasons.append("pressure_evaluation_missing")
    triage = row.get("triage_evidence") if isinstance(row.get("triage_evidence"), dict) else {}
    if not (
        triage.get("evaluated") is True
        and (
            int(triage.get("decision_count") or 0) > 0
            or triage.get("no_op_proof") is True
        )
    ):
        reasons.append("triage_or_noop_proof_missing")
    cycle_id = str(row.get("cycle_id") or "")
    if cycle_id in set(cycle_ledger_summary.get("missing_terminal_rows") or []):
        reasons.append("terminal_cycle_row_missing")
    if not _is_sha256(str(cycle_ledger_summary.get("tail_hash") or "")):
        reasons.append("cycle_ledger_tail_hash_missing")
    return {"valid": not reasons, "reasons": reasons}


def _candidate_detection(root: Path) -> dict[str, Any]:
    pressure_rows = load_declared_jsonl(
        root / "pressure" / "pressure-log.jsonl",
        expected_surface="pressure_log",
    )
    skill_candidates: list[dict[str, Any]] = []
    agent_candidates: list[dict[str, Any]] = []
    for row in pressure_rows[-10:]:
        for item in row.get("pressures") or []:
            if not isinstance(item, dict):
                continue
            text = json.dumps(item, sort_keys=True).lower()
            candidate = {
                "observation_type": "heuristic_gap_candidate",
                "source": "pressure",
                "pressure_id": item.get("pressure_id") or item.get("id"),
                "summary": item.get("summary") or item.get("title") or item.get("kind"),
                "evidence_refs": item.get("evidence_refs") or [],
            }
            if "skill" in text:
                skill_candidates.append(candidate)
            elif "agent" in text:
                agent_candidates.append(candidate)
    return {
        "schema_version": "aria/candidate-detection/v1",
        "generated_at": utc_now(),
        "candidate_observations": {
            "schema_version": "aria/candidate-observations/v1",
            "skill_gap_candidates": skill_candidates,
            "agent_gap_candidates": agent_candidates,
        },
    }


def _failure_reports(output_root: Path) -> list[str]:
    reports: list[str] = []
    for path in sorted(output_root.glob("failure-report.json")) + sorted((output_root / "failures").glob("*.json")):
        if path.exists():
            reports.append(path.relative_to(output_root).as_posix())
    return reports


def _write_failure_report(
    path: Path,
    *,
    phase: str,
    error: Exception,
    cycle_id: str | None,
    repo: Path,
) -> None:
    payload = {
        "schema_version": "aria/burn-in-failure/v1",
        "generated_at": utc_now(),
        "phase": phase,
        "cycle_id": cycle_id,
        "exception_class": type(error).__name__,
        "message": str(error),
        "current_head": _safe_git(repo, "rev-parse", "HEAD"),
        "worktree_status": _safe_git(repo, "status", "--porcelain"),
    }
    _write_json(path, payload)


def _evidence_bundle(output_root: Path, *, target_ref: str, base_commit_sha: str) -> dict[str, Any]:
    artifacts = []
    for path in sorted(output_root.rglob("*")):
        if not path.is_file() or path.name == "evidence-bundle.json":
            continue
        artifacts.append(
            {
                "path": path.relative_to(output_root).as_posix(),
                "sha256": file_hash(path),
                "size_bytes": path.stat().st_size,
            }
        )
    return {
        "schema_version": "aria/evidence-bundle/v1",
        "generated_at": utc_now(),
        "target_ref": target_ref,
        "base_commit_sha": base_commit_sha,
        "artifacts": artifacts,
        "burn_in_report_hash": None,
    }


def _bundle_content_hash(bundle: dict[str, Any]) -> str:
    payload = dict(bundle)
    payload.pop("burn_in_report_hash", None)
    return _stable_hash(payload)


def _is_sha256(value: str, *, git_sha: bool = False, allow_bare: bool = False) -> bool:
    if git_sha:
        return len(value) == 40 and all(ch in "0123456789abcdef" for ch in value)
    if allow_bare and len(value) == 64 and all(ch in "0123456789abcdef" for ch in value):
        return True
    return (
        value.startswith("sha256:")
        and len(value) == len("sha256:") + 64
        and all(ch in "0123456789abcdef" for ch in value[len("sha256:"):])
    )


def _stable_hash(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _safe_git(repo: Path, *args: str) -> str | None:
    try:
        return _git(repo, *args)
    except Exception:
        return None


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    encoded = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        os.write(fd, encoded.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    tmp.replace(path)
    try:
        dir_fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError:
        pass


__all__ = [
    "BURN_IN_SCHEMA_VERSION",
    "CANDIDATE_DETECTION_ARTIFACT",
    "CYCLE_LEDGER_SUMMARY_ARTIFACT",
    "DISALLOWED_OBSERVE_SURFACES",
    "DISALLOWED_ACTIONS_ARTIFACT",
    "EVIDENCE_BUNDLE_ARTIFACT",
    "MANIFEST_TAIL_HASHES_ARTIFACT",
    "REQUIRED_CYCLE_ATTEMPTS",
    "REQUIRED_MIN_VALID_CYCLES",
    "burn_in_report_schema",
    "run_observe_burn_in",
    "validate_burn_in_report",
    "verify_burn_in_artifact_bundle",
]
