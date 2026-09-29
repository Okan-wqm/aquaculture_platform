from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .cycle import CYCLE_TERMINAL_STATUSES, _failed_event, run_enterprise_cycle
from .ledger import (
    LedgerIntegrityError,
    append_declared_jsonl,
    load_declared_jsonl,
    load_jsonl_verified_text,
)
from .secure_artifact_io import (
    atomic_write_json_path,
    enumerate_regular_files_at,
    enumerate_regular_snapshots_beneath_at,
    load_json_object_bytes,
    normalized_relative_posix,
    read_regular_file_at,
    read_optional_regular_file_at,
    read_regular_path,
    secure_directory_fd,
)
from .runtime_profile import set_profile
from .state_manifest import (
    iter_surfaces,
    observe_disallowed_tool_surfaces,
    surface_for_relative_path,
    surface_path_matches,
)
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_binding, utc_now
from .workspace import ensure_workspace, workspace_paths
from .worktree import is_runtime_path


BURN_IN_SCHEMA_VERSION = "aria/autonomy-burn-in-report/v1"
OBSERVE_BURN_IN_PROFILE = "observe"
REQUIRED_CYCLE_ATTEMPTS = 30
REQUIRED_MIN_VALID_CYCLES = 20
_BURN_IN_CYCLE_ID = re.compile(
    r"^burnin-observe-[0-9]{8}T[0-9]{6}Z-[0-9]{3}$"
)

CYCLE_LEDGER_SUMMARY_ARTIFACT = "cycle-ledger-summary.json"
DISALLOWED_ACTIONS_ARTIFACT = "disallowed-actions.json"
MANIFEST_TAIL_HASHES_ARTIFACT = "manifest-tail-hashes.json"
CANDIDATE_DETECTION_ARTIFACT = "candidate-detection.json"
EVIDENCE_BUNDLE_ARTIFACT = "evidence-bundle.json"
BURN_IN_HASHED_ARTIFACTS: tuple[str, ...] = (
    "cycles.json",
    CYCLE_LEDGER_SUMMARY_ARTIFACT,
    DISALLOWED_ACTIONS_ARTIFACT,
    MANIFEST_TAIL_HASHES_ARTIFACT,
    CANDIDATE_DETECTION_ARTIFACT,
)

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
    output_root = _required_path("output_dir", output_dir).absolute()
    _validate_args(
        repo=repo,
        workspace_base=workspace_base_path,
        tools_root=tools_root,
        output_root=output_root,
        target_ref=target_ref,
        cycles=cycles,
        min_valid_cycles=min_valid_cycles,
    )
    with secure_directory_fd(output_root, create=True):
        pass
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
            "state_continuity": None,
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
            continuity = state.get("state_continuity")
            cycle_row["state_continuity"] = {
                "status": continuity.get("status"),
                "reference_kind": continuity.get("reference_kind"),
                "blocks_action": continuity.get("blocks_action"),
                "recovery": continuity.get("recovery"),
            } if isinstance(continuity, dict) else None
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
            observations_written = int(memory.get("observations_written") or 0)
            beliefs_written = int(memory.get("beliefs_written") or 0)
            triage_decision_count = len(triage.get("decisions") or [])
            cycle_row.update(
                {
                    "status": "completed",
                    "completed_at": utc_now(),
                    "discovery_complete": bool(discovery.get("completion_proof", {}).get("complete")),
                    "fated_file_count": int(discovery.get("completion_proof", {}).get("fated_file_count") or 0),
                    "diff_changed_count": int(diff.get("changed_count") or 0),
                    "memory_beliefs_written": beliefs_written,
                    "memory_evidence": {
                        "observations_written": observations_written,
                        "beliefs_written": beliefs_written,
                        "no_op_proof": _memory_no_op_proof(
                            observations_written,
                            beliefs_written,
                        ),
                    },
                    "pressure_count": len(pressure.get("pressures") or []),
                    "pressure_evidence": {
                        "evaluated": isinstance(pressure.get("pressures"), list),
                        "pressure_count": len(pressure.get("pressures") or []),
                    },
                    "triaged_count": int(triage.get("triaged_count") or 0),
                    "triage_evidence": {
                        "evaluated": "triaged_count" in triage,
                        "decision_count": triage_decision_count,
                        "no_op_proof": _triage_no_op_proof(
                            triage_decision_count
                        ),
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
    acceptance = _derive_burn_in_acceptance(
        cycle_results,
        cycle_ledger_summary=cycle_ledger_summary,
        disallowed_actions=disallowed,
        min_valid_cycles=min_valid_cycles,
        post_worktree_clean=not postflight_errors,
    )
    for row in cycle_results:
        validity = acceptance["validity_by_id"][str(row.get("cycle_id"))]
        row["valid_cycle"] = validity["valid"]
        row["validity_reasons"] = validity["reasons"]
    valid_cycles = acceptance["valid_cycles"]
    cycle_ledger_summary["valid_cycle_ids"] = acceptance["valid_cycle_ids"]
    cycle_ledger_summary["invalid_cycle_ids"] = acceptance["invalid_cycle_ids"]
    candidate_detection = _candidate_detection(tools_root)
    disallowed_report = {
        "schema_version": "aria/disallowed-actions/v1",
        "generated_at": utc_now(),
        "before": before_disallowed,
        "after": after_disallowed,
        "deltas": disallowed,
    }
    _validate_disallowed_snapshot_world(before_disallowed, after_disallowed)
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
            and acceptance["terminal_rows_exact"]
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
        "workflow_run_id": os.environ.get("GITHUB_RUN_ID", ""),
        "workflow_run_attempt": int(os.environ.get("GITHUB_RUN_ATTEMPT", "0") or 0),
        "cycle_attempts": cycles,
        "valid_cycles": valid_cycles,
        "failed_cycles": acceptance["failed_cycles"],
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
        "acceptance_conditions": acceptance["acceptance_conditions"],
        "artifact_hashes": {},
        "acceptance_verdict": verdict,
    }
    report_path = output_root / "autonomy-burn-in-report.json"
    bundle_path = output_root / EVIDENCE_BUNDLE_ARTIFACT
    evidence_bundle = _evidence_bundle(
        output_root,
        target_ref=target_ref,
        base_commit_sha=current_head,
        workflow_run_id=report["workflow_run_id"],
        workflow_run_attempt=report["workflow_run_attempt"],
    )
    report["evidence_bundle_hash"] = _bundle_content_hash(evidence_bundle)
    report["artifact_hashes"] = _artifact_hashes(
        output_root,
        exclude={report_path.resolve(), bundle_path.resolve()},
    )
    validate_burn_in_report(report)
    _write_json(report_path, report)
    evidence_bundle["burn_in_report_hash"] = read_regular_path(report_path).sha256
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
    if (
        not isinstance(cycles, int)
        or isinstance(cycles, bool)
        or not isinstance(min_valid_cycles, int)
        or isinstance(min_valid_cycles, bool)
    ):
        raise GovernanceError("observe_burn_in_counts_must_be_integers")
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


def _cycle_row_is_terminal(row: dict[str, Any]) -> bool:
    """Whether a cycle-ledger row closes its cycle lifecycle."""
    status = row.get("status")
    event = row.get("event")
    return (
        status in CYCLE_TERMINAL_STATUSES
        or event in CYCLE_TERMINAL_STATUSES
        or event in {"cycle_completed", "cycle_failed"}
    )


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
    return any(
        row.get("cycle_id") == cycle_id and _cycle_row_is_terminal(row)
        for row in rows
    )


def _cycle_id(index: int) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"burnin-observe-{stamp}-{index:03d}"


def _disallowed_snapshot(root: Path) -> dict[str, dict[str, Any]]:
    try:
        with secure_directory_fd(root) as root_fd:
            return {
                name: _pattern_snapshot_at(root_fd, relative, surface_name=name)
                for name, relative in DISALLOWED_OBSERVE_SURFACES
            }
    except (GovernanceError, LedgerIntegrityError, UnicodeDecodeError) as exc:
        raise GovernanceError("burn_in_disallowed_snapshot_path_invalid") from exc


def _pattern_snapshot_at(
    root_fd: int,
    relative_pattern: str,
    *,
    surface_name: str,
) -> dict[str, Any]:
    snapshots: tuple[tuple[str, Any], ...]
    if any(token in relative_pattern for token in ("*", "?", "[")):
        prefix_parts: list[str] = []
        for component in relative_pattern.split("/"):
            if any(token in component for token in ("*", "?", "[")):
                break
            prefix_parts.append(component)
        if not prefix_parts:
            raise GovernanceError("burn_in_snapshot_pattern_root_unbounded")
        snapshots = enumerate_regular_snapshots_beneath_at(
            root_fd,
            "/".join(prefix_parts),
        )
        snapshots = tuple(
            (relative, snapshot)
            for relative, snapshot in snapshots
            if surface_path_matches(relative, relative_pattern)
        )
    else:
        snapshot = read_optional_regular_file_at(root_fd, relative_pattern)
        snapshots = () if snapshot is None else ((relative_pattern, snapshot),)
    entries = [
        _file_snapshot_from_bytes(
            relative,
            snapshot.data,
            snapshot.sha256,
            surface_name=surface_name,
        )
        for relative, snapshot in snapshots
    ]
    aggregate = {
        "path_pattern": relative_pattern,
        "file_count": len(entries),
        "row_count": sum(entry["row_count"] or 0 for entry in entries),
        "files": entries,
    }
    aggregate["aggregate_hash"] = _stable_hash(entries)
    return aggregate


def _file_snapshot_from_bytes(
    relative: str,
    data: bytes,
    digest: str,
    *,
    surface_name: str,
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    tail_hash = None
    if relative.endswith(".jsonl"):
        try:
            concrete_surface = surface_for_relative_path(
                relative,
                root_kind="tools",
            )
        except ValueError as exc:
            raise GovernanceError("burn_in_snapshot_surface_ambiguous") from exc
        if concrete_surface is None:
            raise GovernanceError("burn_in_snapshot_surface_unowned")
        rows = load_jsonl_verified_text(
            data.decode("utf-8"),
            source=relative,
            expected_surface=concrete_surface.name,
        )
        tail_hash = rows[-1].get("ledger_hash") if rows else None
    return {
        "path": relative,
        "exists": True,
        "row_count": len(rows) if relative.endswith(".jsonl") else None,
        "file_hash": digest.removeprefix("sha256:"),
        "tail_hash": tail_hash,
    }


def _diff_snapshots(before: dict[str, dict[str, Any]], after: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for name in sorted(before):
        before_snapshot = before[name]
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


def _validate_disallowed_snapshot_world(
    before: dict[str, Any],
    after: dict[str, Any],
) -> None:
    expected = dict(DISALLOWED_OBSERVE_SURFACES)
    if set(before) != set(expected) or set(after) != set(expected):
        raise GovernanceError("burn_in_disallowed_snapshot_invalid")
    for world in (before, after):
        for name, pattern in expected.items():
            aggregate = world.get(name)
            if not isinstance(aggregate, dict) or set(aggregate) != {
                "path_pattern", "file_count", "row_count", "files",
                "aggregate_hash",
            }:
                raise GovernanceError("burn_in_disallowed_snapshot_invalid")
            file_count = aggregate.get("file_count")
            row_count = aggregate.get("row_count")
            files = aggregate.get("files")
            if (
                aggregate.get("path_pattern") != pattern
                or not isinstance(file_count, int)
                or isinstance(file_count, bool)
                or file_count < 0
                or not isinstance(row_count, int)
                or isinstance(row_count, bool)
                or row_count < 0
                or not isinstance(files, list)
            ):
                raise GovernanceError("burn_in_disallowed_snapshot_invalid")
            _validate_snapshot_aggregate(
                aggregate,
                pattern=pattern,
                error="burn_in_disallowed_snapshot_invalid",
            )


def _validate_snapshot_aggregate(
    aggregate: dict[str, Any],
    *,
    pattern: str,
    error: str,
) -> None:
    files = aggregate.get("files")
    if not isinstance(files, list):
        raise GovernanceError(error)
    paths: list[str] = []
    derived_rows = 0
    for record in files:
        if not isinstance(record, dict) or set(record) != {
            "path", "exists", "row_count", "file_hash", "tail_hash",
        }:
            raise GovernanceError(error)
        try:
            relative = normalized_relative_posix(record.get("path"))
            matches = surface_path_matches(relative, pattern)
        except (GovernanceError, ValueError) as exc:
            raise GovernanceError(error) from exc
        record_rows = record.get("row_count")
        file_hash_value = record.get("file_hash")
        tail_hash = record.get("tail_hash")
        is_jsonl = relative.endswith(".jsonl")
        if (
            not matches
            or record.get("exists") is not True
            or not isinstance(file_hash_value, str)
            or not _is_sha256(file_hash_value, allow_bare=True)
            or file_hash_value.startswith("sha256:")
            or (
                is_jsonl
                and (
                    not isinstance(record_rows, int)
                    or isinstance(record_rows, bool)
                    or record_rows < 0
                    or (record_rows == 0 and tail_hash is not None)
                    or (
                        record_rows > 0
                        and (
                            not isinstance(tail_hash, str)
                            or not _is_sha256(tail_hash)
                        )
                    )
                )
            )
            or (not is_jsonl and (record_rows is not None or tail_hash is not None))
        ):
            raise GovernanceError(error)
        paths.append(relative)
        derived_rows += record_rows or 0
    if paths != sorted(paths) or len(paths) != len(set(paths)):
        raise GovernanceError(error)
    file_count = aggregate.get("file_count")
    row_count = aggregate.get("row_count")
    if (
        not isinstance(file_count, int)
        or isinstance(file_count, bool)
        or file_count != len(files)
        or not isinstance(row_count, int)
        or isinstance(row_count, bool)
        or row_count != derived_rows
        or aggregate.get("aggregate_hash") != _stable_hash(files)
    ):
        raise GovernanceError(error)


def _manifest_snapshot(root: Path) -> dict[str, dict[str, Any]]:
    snapshot: dict[str, dict[str, Any]] = {}
    try:
        with secure_directory_fd(root) as root_fd:
            for surface in iter_surfaces():
                if surface.root_kind != "tools":
                    continue
                snapshot[surface.name] = {
                    "state_class": surface.state_class,
                    **_pattern_snapshot_at(
                        root_fd,
                        surface.path_pattern,
                        surface_name=surface.name,
                    ),
                }
    except (GovernanceError, LedgerIntegrityError, UnicodeDecodeError) as exc:
        raise GovernanceError("burn_in_manifest_snapshot_path_invalid") from exc
    return snapshot


def _diff_manifest_snapshots(before: dict[str, dict[str, Any]], after: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    deltas: list[dict[str, Any]] = []
    for name in sorted(before):
        before_snapshot = before[name]
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
    excluded = {
        path.absolute().relative_to(output_root.absolute()).as_posix()
        for path in (exclude or set())
    }
    hashes: dict[str, str] = {}
    with secure_directory_fd(output_root) as root_fd:
        for relative in enumerate_regular_files_at(root_fd):
            if relative not in excluded:
                hashes[relative] = read_regular_file_at(
                    root_fd, relative
                ).sha256.removeprefix("sha256:")
    return hashes


def burn_in_report_schema() -> dict[str, Any]:
    required = [
        "schema_version",
        "generated_at",
        "started_at",
        "completed_at",
        "target_ref",
        "base_commit_sha",
        "workflow_run_id",
        "workflow_run_attempt",
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
        "properties": {
            **{field: {} for field in required},
            "workflow_run_attempt": {"type": "integer", "minimum": 0},
            "cycle_attempts": {
                "type": "integer",
                "const": REQUIRED_CYCLE_ATTEMPTS,
            },
            "valid_cycles": {
                "type": "integer",
                "minimum": 0,
                "maximum": REQUIRED_CYCLE_ATTEMPTS,
            },
            "failed_cycles": {
                "type": "integer",
                "minimum": 0,
                "maximum": REQUIRED_CYCLE_ATTEMPTS,
            },
            "min_valid_cycles": {
                "type": "integer",
                "const": REQUIRED_MIN_VALID_CYCLES,
            },
        },
        "x-runtime-constants": {
            "required_cycle_attempts": REQUIRED_CYCLE_ATTEMPTS,
            "required_min_valid_cycles": REQUIRED_MIN_VALID_CYCLES,
            "evidence_bundle_artifact": EVIDENCE_BUNDLE_ARTIFACT,
        },
    }


def _is_nonnegative_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _memory_no_op_proof(
    observations_written: int,
    beliefs_written: int,
) -> bool:
    return observations_written == 0 and beliefs_written == 0


def _triage_no_op_proof(decision_count: int) -> bool:
    return decision_count == 0


def _validate_cycle_records(cycles: object) -> list[dict[str, Any]]:
    if not isinstance(cycles, list):
        raise GovernanceError("burn_in_cycle_record_invalid")
    seen: set[str] = set()
    validated: list[dict[str, Any]] = []
    for row in cycles:
        if not isinstance(row, dict):
            raise GovernanceError("burn_in_cycle_record_invalid")
        cycle_id = row.get("cycle_id")
        status = row.get("status")
        common = {
            "schema_version", "cycle_id", "status", "started_at",
            "state_continuity", "valid_cycle", "validity_reasons",
        }
        completed = {
            *common, "completed_at", "discovery_complete", "fated_file_count",
            "diff_changed_count", "memory_beliefs_written", "memory_evidence",
            "pressure_count", "pressure_evidence", "triaged_count",
            "triage_evidence",
        }
        failed = {*common, "failed_at", "error"}
        if (
            row.get("schema_version") != 1
            or not isinstance(cycle_id, str)
            or _BURN_IN_CYCLE_ID.fullmatch(cycle_id) is None
            or cycle_id in seen
            or not isinstance(row.get("started_at"), str)
            or not row["started_at"]
            or not isinstance(row.get("valid_cycle"), bool)
            or not isinstance(row.get("validity_reasons"), list)
            or any(
                not isinstance(reason, str) or not reason
                for reason in row["validity_reasons"]
            )
            or len(row["validity_reasons"])
            != len(set(row["validity_reasons"]))
            or (
                status == "completed" and set(row) != completed
            )
            or (status == "failed" and set(row) != failed)
            or status not in {"completed", "failed"}
        ):
            raise GovernanceError("burn_in_cycle_record_invalid")
        continuity = row.get("state_continuity")
        if continuity is not None and (
            not isinstance(continuity, dict)
            or set(continuity) != {
                "status", "reference_kind", "blocks_action", "recovery",
            }
            or not isinstance(continuity.get("status"), str)
            or not isinstance(continuity.get("reference_kind"), str)
            or not isinstance(continuity.get("blocks_action"), bool)
        ):
            raise GovernanceError("burn_in_cycle_record_invalid")
        if status == "failed":
            if (
                not isinstance(row.get("failed_at"), str)
                or not row["failed_at"]
                or not isinstance(row.get("error"), str)
                or not row["error"]
                or row.get("valid_cycle") is not False
            ):
                raise GovernanceError("burn_in_cycle_record_invalid")
        else:
            memory = row.get("memory_evidence")
            pressure = row.get("pressure_evidence")
            triage = row.get("triage_evidence")
            if (
                not isinstance(row.get("completed_at"), str)
                or not row["completed_at"]
                or not isinstance(row.get("discovery_complete"), bool)
                or not all(
                    _is_nonnegative_int(row.get(field))
                    for field in (
                        "fated_file_count", "diff_changed_count",
                        "memory_beliefs_written", "pressure_count",
                        "triaged_count",
                    )
                )
                or not isinstance(memory, dict)
                or set(memory) != {
                    "observations_written", "beliefs_written", "no_op_proof",
                }
                or not _is_nonnegative_int(memory.get("observations_written"))
                or not _is_nonnegative_int(memory.get("beliefs_written"))
                or not isinstance(memory.get("no_op_proof"), bool)
                or memory.get("no_op_proof") is not _memory_no_op_proof(
                    memory["observations_written"],
                    memory["beliefs_written"],
                )
                or row.get("memory_beliefs_written") != memory.get("beliefs_written")
                or not isinstance(pressure, dict)
                or set(pressure) != {"evaluated", "pressure_count"}
                or not isinstance(pressure.get("evaluated"), bool)
                or not _is_nonnegative_int(pressure.get("pressure_count"))
                or row.get("pressure_count") != pressure.get("pressure_count")
                or not isinstance(triage, dict)
                or set(triage) != {"evaluated", "decision_count", "no_op_proof"}
                or not isinstance(triage.get("evaluated"), bool)
                or not _is_nonnegative_int(triage.get("decision_count"))
                or not isinstance(triage.get("no_op_proof"), bool)
                or triage.get("no_op_proof") is not _triage_no_op_proof(
                    triage["decision_count"]
                )
                or row.get("triaged_count") != triage.get("decision_count")
            ):
                raise GovernanceError("burn_in_cycle_record_invalid")
        seen.add(cycle_id)
        validated.append(row)
    return validated


def _validate_report_summaries(
    report: dict[str, Any],
    cycles: list[dict[str, Any]],
) -> None:
    discovery = report.get("discovery_summary")
    memory = report.get("memory_summary")
    pressure = report.get("pressure_summary")
    finding = report.get("finding_summary")
    triage = report.get("triage_summary")
    if (
        not isinstance(discovery, dict)
        or set(discovery) != {
            "completed_cycles", "max_fated_file_count",
            "all_completed_discoveries_complete",
        }
        or not isinstance(memory, dict)
        or set(memory) != {
            "observation_rows", "belief_rows", "cycle_beliefs_written",
        }
        or not isinstance(pressure, dict)
        or set(pressure) != {
            "pressure_log_rows", "latest_counts", "latest_pressure_count",
        }
        or not isinstance(finding, dict)
        or set(finding) != {"raw_findings_rows", "ingested_findings_rows"}
        or not isinstance(triage, dict)
        or set(triage) != {"triage_decision_rows", "cycle_triaged_count"}
    ):
        raise GovernanceError("burn_in_report_summary_invalid")
    counter_groups = (
        (discovery, ("completed_cycles", "max_fated_file_count")),
        (memory, ("observation_rows", "belief_rows", "cycle_beliefs_written")),
        (pressure, ("pressure_log_rows", "latest_pressure_count")),
        (finding, ("raw_findings_rows", "ingested_findings_rows")),
        (triage, ("triage_decision_rows", "cycle_triaged_count")),
    )
    if any(
        not _is_nonnegative_int(group.get(field))
        for group, fields in counter_groups
        for field in fields
    ):
        raise GovernanceError("burn_in_report_summary_invalid")
    latest_counts = pressure.get("latest_counts")
    if (
        not isinstance(discovery.get("all_completed_discoveries_complete"), bool)
        or not isinstance(latest_counts, dict)
        or any(
            not isinstance(key, str) or not key or not _is_nonnegative_int(value)
            for key, value in latest_counts.items()
        )
    ):
        raise GovernanceError("burn_in_report_summary_invalid")
    completed = [row for row in cycles if row["status"] == "completed"]
    if (
        discovery["completed_cycles"] != len(completed)
        or discovery["max_fated_file_count"]
        != max([row["fated_file_count"] for row in completed] or [0])
        or discovery["all_completed_discoveries_complete"]
        is not all(row["discovery_complete"] for row in completed)
        or memory["cycle_beliefs_written"]
        != sum(row["memory_beliefs_written"] for row in completed)
        or triage["cycle_triaged_count"]
        != sum(row["triaged_count"] for row in completed)
    ):
        raise GovernanceError("burn_in_report_summary_invalid")


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
    for field in (
        "workflow_run_attempt", "cycle_attempts", "valid_cycles",
        "failed_cycles", "min_valid_cycles",
    ):
        value = report.get(field)
        if (
            not isinstance(value, int)
            or isinstance(value, bool)
            or value < 0
        ):
            raise GovernanceError(f"burn_in_report_{field}_invalid")
    cycles = _validate_cycle_records(report.get("cycles"))
    _validate_report_summaries(report, cycles)
    for row in cycles:
        if not isinstance(row, dict) or "state_continuity" not in row:
            raise GovernanceError("burn_in_report_state_continuity_evidence_missing")
        if row.get("valid_cycle") is True:
            continuity_reasons = _continuity_validity_reasons(row)
            if continuity_reasons:
                raise GovernanceError(
                    "burn_in_report_valid_cycle_continuity_invalid:"
                    + ",".join(continuity_reasons)
                )
    if report.get("acceptance_verdict") == "passed":
        conditions = report.get("acceptance_conditions") if isinstance(report.get("acceptance_conditions"), dict) else {}
        if report.get("cycle_attempts") != REQUIRED_CYCLE_ATTEMPTS:
            raise GovernanceError("burn_in_report_passed_with_wrong_cycle_attempts")
        if report.get("min_valid_cycles") != REQUIRED_MIN_VALID_CYCLES:
            raise GovernanceError("burn_in_report_passed_with_wrong_min_valid_cycles")
        if report.get("valid_cycles", 0) < REQUIRED_MIN_VALID_CYCLES:
            raise GovernanceError("burn_in_report_passed_with_insufficient_valid_cycles")
        evidence_valid_cycles = len(
            [
                row
                for row in cycles
                if isinstance(row, dict) and row.get("valid_cycle") is True
            ]
        )
        if evidence_valid_cycles != report.get("valid_cycles"):
            raise GovernanceError("burn_in_report_valid_cycle_count_mismatch")
        if conditions.get("zero_disallowed_actions") is not True:
            raise GovernanceError("burn_in_report_passed_with_disallowed_actions")
        if conditions.get("post_worktree_clean") is not True:
            raise GovernanceError("burn_in_report_passed_with_dirty_postflight")
        if conditions.get("valid_cycle_evidence_verified") is not True:
            raise GovernanceError("burn_in_report_passed_without_valid_cycle_evidence")


def _validate_disallowed_artifact(payload: dict[str, Any]) -> None:
    if (
        set(payload) != {"schema_version", "generated_at", "before", "after", "deltas"}
        or payload.get("schema_version") != "aria/disallowed-actions/v1"
        or not isinstance(payload.get("generated_at"), str)
        or not payload["generated_at"]
        or not isinstance(payload.get("before"), dict)
        or not isinstance(payload.get("after"), dict)
        or not isinstance(payload.get("deltas"), list)
    ):
        raise GovernanceError("burn_in_disallowed_snapshot_invalid")
    _validate_disallowed_snapshot_world(payload["before"], payload["after"])
    if payload["deltas"] != _diff_snapshots(payload["before"], payload["after"]):
        raise GovernanceError("burn_in_disallowed_snapshot_invalid")


def _validate_manifest_snapshot_world(world: object) -> dict[str, Any]:
    expected = {
        surface.name: surface
        for surface in iter_surfaces()
        if surface.root_kind == "tools"
    }
    if not isinstance(world, dict) or set(world) != set(expected):
        raise GovernanceError("burn_in_manifest_tail_invalid")
    for name, surface in expected.items():
        aggregate = world.get(name)
        if not isinstance(aggregate, dict) or set(aggregate) != {
            "state_class", "path_pattern", "file_count", "row_count", "files",
            "aggregate_hash",
        }:
            raise GovernanceError("burn_in_manifest_tail_invalid")
        if (
            aggregate.get("state_class") != surface.state_class
            or aggregate.get("path_pattern") != surface.path_pattern
        ):
            raise GovernanceError("burn_in_manifest_tail_invalid")
        _validate_snapshot_aggregate(
            aggregate,
            pattern=surface.path_pattern,
            error="burn_in_manifest_tail_invalid",
        )
    return world


def _validate_manifest_tail_artifact(payload: dict[str, Any]) -> None:
    if (
        set(payload) != {"schema_version", "generated_at", "before", "after", "deltas"}
        or payload.get("schema_version") != "aria/manifest-tail-hashes/v1"
        or not isinstance(payload.get("generated_at"), str)
        or not payload["generated_at"]
        or not isinstance(payload.get("deltas"), list)
    ):
        raise GovernanceError("burn_in_manifest_tail_invalid")
    before = _validate_manifest_snapshot_world(payload.get("before"))
    after = _validate_manifest_snapshot_world(payload.get("after"))
    if payload["deltas"] != _diff_manifest_snapshots(before, after):
        raise GovernanceError("burn_in_manifest_tail_invalid")


def _validate_cross_artifact_snapshot_bindings(
    *,
    disallowed: dict[str, Any],
    manifest_tail: dict[str, Any],
    cycle_ledger: dict[str, Any],
) -> None:
    for world_name in ("before", "after"):
        disallowed_world = disallowed[world_name]
        manifest_world = manifest_tail[world_name]
        for surface_name, _pattern in DISALLOWED_OBSERVE_SURFACES:
            manifest_aggregate = {
                key: value
                for key, value in manifest_world[surface_name].items()
                if key != "state_class"
            }
            if disallowed_world[surface_name] != manifest_aggregate:
                raise GovernanceError(
                    "burn_in_disallowed_manifest_binding_mismatch"
                )

    cycles_after = manifest_tail["after"]["cycles"]
    cycle_files = cycles_after["files"]
    manifest_tail_hash = (
        cycle_files[0]["tail_hash"] if cycle_files else None
    )
    if (
        cycle_ledger["tail_hash"] != manifest_tail_hash
        or cycle_ledger["started_row_count"]
        + cycle_ledger["terminal_row_count"]
        != cycles_after["row_count"]
    ):
        raise GovernanceError(
            "burn_in_cycle_ledger_manifest_binding_mismatch"
        )


def _validate_candidate_artifact(
    payload: dict[str, Any],
    report: dict[str, Any],
) -> None:
    if (
        set(payload) != {"schema_version", "generated_at", "candidate_observations"}
        or payload.get("schema_version") != "aria/candidate-detection/v1"
        or not isinstance(payload.get("generated_at"), str)
        or not payload["generated_at"]
    ):
        raise GovernanceError("burn_in_candidate_detection_invalid")
    observations = payload.get("candidate_observations")
    if (
        not isinstance(observations, dict)
        or set(observations) != {
            "schema_version", "skill_gap_candidates", "agent_gap_candidates",
        }
        or observations.get("schema_version")
        != "aria/candidate-observations/v1"
    ):
        raise GovernanceError("burn_in_candidate_detection_invalid")
    for field in ("skill_gap_candidates", "agent_gap_candidates"):
        rows = observations.get(field)
        if not isinstance(rows, list):
            raise GovernanceError("burn_in_candidate_detection_invalid")
        for row in rows:
            if (
                not isinstance(row, dict)
                or set(row) != {
                    "observation_type", "source", "pressure_id", "summary",
                    "evidence_refs",
                }
                or row.get("observation_type") != "heuristic_gap_candidate"
                or row.get("source") != "pressure"
                or (
                    row.get("pressure_id") is not None
                    and not isinstance(row.get("pressure_id"), str)
                )
                or (
                    row.get("summary") is not None
                    and not isinstance(row.get("summary"), str)
                )
                or not isinstance(row.get("evidence_refs"), list)
                or any(
                    not isinstance(reference, str) or not reference
                    for reference in row["evidence_refs"]
                )
            ):
                raise GovernanceError("burn_in_candidate_detection_invalid")
    if (
        report.get("candidate_observations") != observations
        or report.get("skill_gap_candidates")
        != observations["skill_gap_candidates"]
        or report.get("agent_gap_candidates")
        != observations["agent_gap_candidates"]
    ):
        raise GovernanceError("burn_in_candidate_detection_invalid")


def _validate_cycle_ledger_artifact(
    payload: dict[str, Any],
    cycles: list[dict[str, Any]],
) -> None:
    expected_keys = {
        "schema_version", "generated_at", "attempted_cycle_ids",
        "terminal_cycle_ids", "started_row_count", "terminal_row_count",
        "status_histogram", "missing_terminal_rows", "tail_hash",
        "valid_cycle_ids", "invalid_cycle_ids", "failed_cycle_ids",
    }
    id_lists = (
        "attempted_cycle_ids", "terminal_cycle_ids", "missing_terminal_rows",
        "valid_cycle_ids", "invalid_cycle_ids", "failed_cycle_ids",
    )
    if (
        set(payload) != expected_keys
        or payload.get("schema_version") != "aria/cycle-ledger-summary/v2"
        or not isinstance(payload.get("generated_at"), str)
        or not payload["generated_at"]
        or not _is_nonnegative_int(payload.get("started_row_count"))
        or not _is_nonnegative_int(payload.get("terminal_row_count"))
        or not isinstance(payload.get("status_histogram"), dict)
        or any(
            not isinstance(status, str)
            or not status
            or not _is_nonnegative_int(count)
            for status, count in payload["status_histogram"].items()
        )
        or (
            payload.get("tail_hash") is not None
            and (
                not isinstance(payload.get("tail_hash"), str)
                or not _is_sha256(payload["tail_hash"])
            )
        )
    ):
        raise GovernanceError("burn_in_cycle_ledger_invalid")
    for field in id_lists:
        values = payload.get(field)
        if (
            not isinstance(values, list)
            or any(
                not isinstance(value, str)
                or _BURN_IN_CYCLE_ID.fullmatch(value) is None
                for value in values
            )
        ):
            raise GovernanceError("burn_in_cycle_ledger_invalid")
    attempted = payload["attempted_cycle_ids"]
    if (
        attempted != [row["cycle_id"] for row in cycles]
        or len(attempted) != len(set(attempted))
        or any(
            len(payload[field]) != len(set(payload[field]))
            for field in (
                "missing_terminal_rows", "valid_cycle_ids",
                "invalid_cycle_ids", "failed_cycle_ids",
            )
        )
    ):
        raise GovernanceError("burn_in_cycle_ledger_invalid")


def _validate_failure_artifacts(
    failure_paths: list[str],
    artifact_payloads: dict[str, dict[str, Any]],
    cycles: list[dict[str, Any]],
    *,
    acceptance_verdict: object,
) -> None:
    if failure_paths != sorted(failure_paths) or len(failure_paths) != len(set(failure_paths)):
        raise GovernanceError("burn_in_failure_reports_invalid")
    failed_ids = [row["cycle_id"] for row in cycles if row["status"] == "failed"]
    expected_cycle_paths = [f"failures/{cycle_id}.json" for cycle_id in failed_ids]
    actual_cycle_paths = [path for path in failure_paths if path != "failure-report.json"]
    if actual_cycle_paths != sorted(expected_cycle_paths):
        raise GovernanceError("burn_in_failure_reports_invalid")
    if "failure-report.json" in failure_paths and acceptance_verdict != "failed":
        raise GovernanceError("burn_in_failure_reports_invalid")
    for relative in failure_paths:
        payload = artifact_payloads.get(relative)
        if not isinstance(payload, dict) or set(payload) != {
            "schema_version", "generated_at", "phase", "cycle_id",
            "exception_class", "message", "current_head", "worktree_status",
        }:
            raise GovernanceError("burn_in_failure_report_invalid")
        if (
            payload.get("schema_version") != "aria/burn-in-failure/v1"
            or not isinstance(payload.get("generated_at"), str)
            or not payload["generated_at"]
            or not isinstance(payload.get("exception_class"), str)
            or not payload["exception_class"]
            or not isinstance(payload.get("message"), str)
            or (
                payload.get("current_head") is not None
                and (
                    not isinstance(payload.get("current_head"), str)
                    or not _is_sha256(payload["current_head"], git_sha=True)
                )
            )
            or (
                payload.get("worktree_status") is not None
                and not isinstance(payload.get("worktree_status"), str)
            )
        ):
            raise GovernanceError("burn_in_failure_report_invalid")
        if relative == "failure-report.json":
            if payload.get("phase") not in {"preflight", "postflight"} or payload.get("cycle_id") is not None:
                raise GovernanceError("burn_in_failure_report_invalid")
        else:
            cycle_id = relative.removeprefix("failures/").removesuffix(".json")
            if payload.get("phase") != "cycle" or payload.get("cycle_id") != cycle_id:
                raise GovernanceError("burn_in_failure_report_invalid")


def verify_burn_in_artifact_bundle(output_root: str | Path) -> dict[str, str]:
    with secure_directory_fd(output_root) as root_fd:
        return _verify_burn_in_artifact_bundle_at(root_fd)


def _verify_burn_in_artifact_bundle_at(root_fd: int) -> dict[str, str]:
    try:
        report_snapshot = read_regular_file_at(
            root_fd, "autonomy-burn-in-report.json"
        )
    except GovernanceError as exc:
        raise GovernanceError("burn_in_report_missing") from exc
    try:
        bundle_snapshot = read_regular_file_at(root_fd, EVIDENCE_BUNDLE_ARTIFACT)
    except GovernanceError as exc:
        raise GovernanceError("burn_in_evidence_bundle_missing") from exc
    report = load_json_object_bytes(report_snapshot.data)
    bundle = load_json_object_bytes(bundle_snapshot.data)
    validate_burn_in_report(report)
    if not isinstance(bundle, dict) or set(bundle) != {
        "schema_version",
        "generated_at",
        "target_ref",
        "base_commit_sha",
        "workflow_run_id",
        "workflow_run_attempt",
        "artifacts",
        "burn_in_report_hash",
    }:
        raise GovernanceError("burn_in_bundle_schema_invalid")
    if bundle.get("schema_version") != "aria/evidence-bundle/v1":
        raise GovernanceError("burn_in_bundle_schema_invalid")
    if any(
        bundle.get(field) != report.get(field)
        for field in (
            "target_ref",
            "base_commit_sha",
            "workflow_run_id",
            "workflow_run_attempt",
        )
    ):
        raise GovernanceError("burn_in_bundle_binding_mismatch")
    expected_bundle_hash = _bundle_content_hash(bundle)
    if report.get("evidence_bundle_hash") != expected_bundle_hash:
        raise GovernanceError("burn_in_report_bundle_hash_mismatch")
    report_hash = report_snapshot.sha256
    if bundle.get("burn_in_report_hash") != report_hash:
        raise GovernanceError("burn_in_bundle_report_hash_mismatch")
    artifact_hashes = report.get("artifact_hashes")
    if not isinstance(artifact_hashes, dict):
        raise GovernanceError("burn_in_report_artifact_hashes_invalid")
    normalized_hashes: dict[str, str] = {}
    for relative, expected_hash in artifact_hashes.items():
        try:
            normalized = normalized_relative_posix(relative)
        except GovernanceError as exc:
            raise GovernanceError(
                f"burn_in_artifact_hash_path_invalid:{relative}"
            ) from exc
        if (
            not isinstance(expected_hash, str)
            or not _is_sha256(expected_hash, allow_bare=True)
            or expected_hash.startswith("sha256:")
        ):
            raise GovernanceError(f"burn_in_artifact_hash_invalid:{relative}")
        normalized_hashes[normalized] = expected_hash
    failure_reports = report.get("failure_reports")
    if not isinstance(failure_reports, list):
        raise GovernanceError("burn_in_failure_reports_invalid")
    normalized_failures: list[str] = []
    for relative in failure_reports:
        try:
            normalized = normalized_relative_posix(relative)
        except GovernanceError as exc:
            raise GovernanceError(
                f"burn_in_artifact_hash_path_invalid:{relative}"
            ) from exc
        if not (
            normalized == "failure-report.json"
            or (
                normalized.startswith("failures/burnin-observe-")
                and normalized.endswith(".json")
            )
        ):
            raise GovernanceError(f"burn_in_artifact_hash_path_invalid:{relative}")
        normalized_failures.append(normalized)
    if (
        normalized_failures != sorted(normalized_failures)
        or len(normalized_failures) != len(set(normalized_failures))
    ):
        raise GovernanceError("burn_in_failure_reports_invalid")
    expected_paths = set(BURN_IN_HASHED_ARTIFACTS) | set(normalized_failures)
    if set(normalized_hashes) != expected_paths:
        raise GovernanceError("burn_in_artifact_hash_set_mismatch")
    try:
        actual_failure_paths = {
            relative
            for relative in enumerate_regular_files_at(root_fd)
            if relative == "failure-report.json" or relative.startswith("failures/")
        }
    except GovernanceError as exc:
        raise GovernanceError("burn_in_artifact_not_regular") from exc
    if actual_failure_paths != set(normalized_failures):
        raise GovernanceError("burn_in_artifact_file_set_mismatch")
    artifact_snapshots: dict[str, Any] = {}
    for relative, expected_hash in normalized_hashes.items():
        try:
            snapshot = read_regular_file_at(root_fd, relative)
        except GovernanceError as exc:
            raise GovernanceError(f"burn_in_artifact_not_regular:{relative}") from exc
        if snapshot.sha256.removeprefix("sha256:") != expected_hash:
            raise GovernanceError(f"burn_in_artifact_hash_mismatch:{relative}")
        artifact_snapshots[relative] = snapshot

    bundle_artifacts = bundle.get("artifacts")
    if not isinstance(bundle_artifacts, list):
        raise GovernanceError("burn_in_bundle_artifacts_invalid")
    bundle_records: dict[str, dict[str, Any]] = {}
    for record in bundle_artifacts:
        if not isinstance(record, dict) or set(record) != {
            "path", "sha256", "size_bytes",
        }:
            raise GovernanceError("burn_in_bundle_artifact_record_invalid")
        try:
            relative = normalized_relative_posix(record.get("path"))
        except GovernanceError as exc:
            raise GovernanceError("burn_in_bundle_artifact_path_invalid") from exc
        if relative in bundle_records:
            raise GovernanceError("burn_in_bundle_artifact_path_duplicate")
        digest = record.get("sha256")
        size = record.get("size_bytes")
        if not _is_sha256(str(digest), allow_bare=True):
            raise GovernanceError("burn_in_bundle_artifact_hash_invalid")
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise GovernanceError("burn_in_bundle_artifact_size_invalid")
        bundle_records[relative] = record
    if set(bundle_records) != expected_paths:
        raise GovernanceError("burn_in_bundle_artifact_set_mismatch")
    for relative, record in bundle_records.items():
        snapshot = artifact_snapshots[relative]
        if (
            record["sha256"] != normalized_hashes[relative]
            or snapshot.sha256.removeprefix("sha256:") != record["sha256"]
        ):
            raise GovernanceError(f"burn_in_bundle_artifact_hash_mismatch:{relative}")
        if snapshot.size_bytes != record["size_bytes"]:
            raise GovernanceError(f"burn_in_bundle_artifact_size_mismatch:{relative}")

    artifact_payloads: dict[str, dict[str, Any]] = {}
    for relative, snapshot in artifact_snapshots.items():
        artifact_payloads[relative] = load_json_object_bytes(snapshot.data)
    cycles_payload = artifact_payloads["cycles.json"]
    if (
        set(cycles_payload) != {"schema_version", "cycles"}
        or cycles_payload.get("schema_version")
        != "aria/autonomy-burn-in-cycles/v1"
    ):
        raise GovernanceError("burn_in_cycles_artifact_invalid")
    cycles = _validate_cycle_records(cycles_payload.get("cycles"))
    if report.get("cycles") != cycles:
        raise GovernanceError("burn_in_report_acceptance_facts_mismatch")
    ledger_summary = artifact_payloads[CYCLE_LEDGER_SUMMARY_ARTIFACT]
    disallowed_payload = artifact_payloads[DISALLOWED_ACTIONS_ARTIFACT]
    manifest_tail_payload = artifact_payloads[MANIFEST_TAIL_HASHES_ARTIFACT]
    candidate_payload = artifact_payloads[CANDIDATE_DETECTION_ARTIFACT]
    _validate_cycle_ledger_artifact(ledger_summary, cycles)
    _validate_disallowed_artifact(disallowed_payload)
    _validate_manifest_tail_artifact(manifest_tail_payload)
    _validate_cross_artifact_snapshot_bindings(
        disallowed=disallowed_payload,
        manifest_tail=manifest_tail_payload,
        cycle_ledger=ledger_summary,
    )
    _validate_candidate_artifact(candidate_payload, report)
    _validate_failure_artifacts(
        normalized_failures,
        artifact_payloads,
        cycles,
        acceptance_verdict=report.get("acceptance_verdict"),
    )

    if report.get("acceptance_verdict") == "passed":
        if not (
            report.get("cycle_ledger_summary") == CYCLE_LEDGER_SUMMARY_ARTIFACT
            and report.get("disallowed_actions_report") == DISALLOWED_ACTIONS_ARTIFACT
            and report.get("manifest_tail_hashes") == MANIFEST_TAIL_HASHES_ARTIFACT
            and report.get("candidate_detection") == CANDIDATE_DETECTION_ARTIFACT
            and report.get("evidence_bundle") == EVIDENCE_BUNDLE_ARTIFACT
        ):
            raise GovernanceError("burn_in_report_acceptance_facts_mismatch")
        if not (
            set(ledger_summary) == {
                "schema_version", "generated_at", "attempted_cycle_ids",
                "terminal_cycle_ids", "started_row_count", "terminal_row_count",
                "status_histogram", "missing_terminal_rows", "tail_hash",
                "valid_cycle_ids", "invalid_cycle_ids", "failed_cycle_ids",
            }
        ):
            raise GovernanceError("burn_in_report_acceptance_facts_mismatch")
        disallowed = disallowed_payload["deltas"]
        if not isinstance(disallowed, list):
            raise GovernanceError("burn_in_report_acceptance_facts_mismatch")
        derived = _derive_burn_in_acceptance(
            cycles,
            cycle_ledger_summary=ledger_summary,
            disallowed_actions=disallowed,
            min_valid_cycles=report["min_valid_cycles"],
            post_worktree_clean="failure-report.json" not in expected_paths,
        )
        for row in cycles:
            cycle_id = str(row.get("cycle_id") or "")
            validity = derived["validity_by_id"][cycle_id]
            if (
                row.get("valid_cycle") is not validity["valid"]
                or row.get("validity_reasons") != validity["reasons"]
            ):
                raise GovernanceError("burn_in_report_acceptance_facts_mismatch")
        attempted_ids = derived["cycle_ids"]
        terminal_ids = ledger_summary.get("terminal_cycle_ids")
        if not isinstance(terminal_ids, list) or len(terminal_ids) != len(set(terminal_ids)):
            raise GovernanceError("burn_in_report_acceptance_facts_mismatch")
        started_count = ledger_summary.get("started_row_count")
        terminal_count = ledger_summary.get("terminal_row_count")
        ledger_facts_match = (
            ledger_summary.get("attempted_cycle_ids") == attempted_ids
            and set(terminal_ids) == set(attempted_ids)
            and ledger_summary.get("valid_cycle_ids") == derived["valid_cycle_ids"]
            and ledger_summary.get("invalid_cycle_ids") == derived["invalid_cycle_ids"]
            and ledger_summary.get("failed_cycle_ids") == derived["failed_cycle_ids"]
            and ledger_summary.get("missing_terminal_rows")
            == sorted(set(attempted_ids) - set(terminal_ids))
            and ledger_summary.get("status_histogram") == derived["status_histogram"]
            and isinstance(started_count, int) and not isinstance(started_count, bool)
            and started_count >= len(attempted_ids)
            and isinstance(terminal_count, int) and not isinstance(terminal_count, bool)
            and terminal_count >= len(terminal_ids)
        )
        if not (
            len(cycles) == REQUIRED_CYCLE_ATTEMPTS
            and report.get("cycle_attempts") == len(cycles)
            and report.get("min_valid_cycles") == REQUIRED_MIN_VALID_CYCLES
            and report.get("valid_cycles") == derived["valid_cycles"]
            and report.get("failed_cycles") == derived["failed_cycles"]
            and report.get("disallowed_actions_observed") == disallowed == []
            and report.get("acceptance_conditions")
            == derived["acceptance_conditions"]
            and derived["valid_cycles"] >= REQUIRED_MIN_VALID_CYCLES
            and ledger_facts_match
        ):
            raise GovernanceError("burn_in_report_acceptance_facts_mismatch")
    return {
        "report_hash": report_hash,
        "evidence_bundle_hash": expected_bundle_hash,
    }


def _cycle_ledger_summary(root: Path, cycles: list[dict[str, Any]]) -> dict[str, Any]:
    rows = load_declared_jsonl(root / "cycles.jsonl", expected_surface="cycles")
    started = [row for row in rows if row.get("event") == "cycle_started" or row.get("status") == "started"]
    terminal = [row for row in rows if _cycle_row_is_terminal(row)]
    attempted_ids = [str(row.get("cycle_id")) for row in cycles]
    attempted_set = set(attempted_ids)
    terminal_cycle_ids = [
        str(row.get("cycle_id"))
        for row in terminal
        if str(row.get("cycle_id")) in attempted_set
    ]
    terminal_ids = set(terminal_cycle_ids)
    status_histogram: dict[str, int] = {}
    for row in cycles:
        status = str(row.get("status") or "unknown")
        status_histogram[status] = status_histogram.get(status, 0) + 1
    return {
        "schema_version": "aria/cycle-ledger-summary/v2",
        "generated_at": utc_now(),
        "attempted_cycle_ids": attempted_ids,
        "terminal_cycle_ids": terminal_cycle_ids,
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
    reasons.extend(_continuity_validity_reasons(row))
    if row.get("status") != "completed":
        reasons.append("cycle_not_completed")
    if row.get("discovery_complete") is not True:
        reasons.append("discovery_not_complete")
    memory = row.get("memory_evidence") if isinstance(row.get("memory_evidence"), dict) else {}
    observations = memory.get("observations_written")
    beliefs = memory.get("beliefs_written")
    if not (
        _is_nonnegative_int(observations)
        and _is_nonnegative_int(beliefs)
        and (
            observations > 0
            or beliefs > 0
            or _memory_no_op_proof(observations, beliefs)
        )
    ):
        reasons.append("memory_evidence_missing")
    pressure = row.get("pressure_evidence") if isinstance(row.get("pressure_evidence"), dict) else {}
    if pressure.get("evaluated") is not True:
        reasons.append("pressure_evaluation_missing")
    triage = row.get("triage_evidence") if isinstance(row.get("triage_evidence"), dict) else {}
    decision_count = triage.get("decision_count")
    if not (
        triage.get("evaluated") is True
        and _is_nonnegative_int(decision_count)
        and (
            decision_count > 0
            or _triage_no_op_proof(decision_count)
        )
    ):
        reasons.append("triage_or_noop_proof_missing")
    cycle_id = str(row.get("cycle_id") or "")
    if cycle_id in set(cycle_ledger_summary.get("missing_terminal_rows") or []):
        reasons.append("terminal_cycle_row_missing")
    if not _is_sha256(str(cycle_ledger_summary.get("tail_hash") or "")):
        reasons.append("cycle_ledger_tail_hash_missing")
    return {"valid": not reasons, "reasons": reasons}


def _derive_burn_in_acceptance(
    cycles: list[dict[str, Any]],
    *,
    cycle_ledger_summary: dict[str, Any],
    disallowed_actions: list[dict[str, Any]],
    min_valid_cycles: int,
    post_worktree_clean: bool,
) -> dict[str, Any]:
    """Derive the acceptance counters and claims from primary evidence."""
    cycle_ids: list[str] = []
    validity_by_id: dict[str, dict[str, Any]] = {}
    status_histogram: dict[str, int] = {}
    failed_cycle_ids: list[str] = []
    for row in cycles:
        if not isinstance(row, dict):
            raise GovernanceError("burn_in_report_acceptance_facts_mismatch")
        cycle_id = str(row.get("cycle_id") or "")
        if not cycle_id or cycle_id in validity_by_id:
            raise GovernanceError("burn_in_report_acceptance_facts_mismatch")
        cycle_ids.append(cycle_id)
        validity_by_id[cycle_id] = _cycle_validity(
            row,
            cycle_ledger_summary=cycle_ledger_summary,
        )
        status = str(row.get("status") or "unknown")
        status_histogram[status] = status_histogram.get(status, 0) + 1
        if status == "failed":
            failed_cycle_ids.append(cycle_id)
    valid_cycle_ids = [
        cycle_id
        for cycle_id in cycle_ids
        if validity_by_id[cycle_id]["valid"]
    ]
    invalid_cycle_ids = [
        cycle_id
        for cycle_id in cycle_ids
        if not validity_by_id[cycle_id]["valid"]
    ]
    terminal_cycle_ids = cycle_ledger_summary.get("terminal_cycle_ids")
    terminal_rows_exact = (
        isinstance(terminal_cycle_ids, list)
        and all(
            terminal_cycle_ids.count(cycle_id) == 1
            for cycle_id in cycle_ids
        )
        and all(cycle_id in set(cycle_ids) for cycle_id in terminal_cycle_ids)
    )
    return {
        "cycle_ids": cycle_ids,
        "validity_by_id": validity_by_id,
        "valid_cycle_ids": valid_cycle_ids,
        "invalid_cycle_ids": invalid_cycle_ids,
        "failed_cycle_ids": failed_cycle_ids,
        "status_histogram": status_histogram,
        "valid_cycles": len(valid_cycle_ids),
        "failed_cycles": len(failed_cycle_ids),
        "terminal_rows_exact": terminal_rows_exact,
        "acceptance_conditions": {
            "required_cycle_attempts": REQUIRED_CYCLE_ATTEMPTS,
            "required_min_valid_cycles": REQUIRED_MIN_VALID_CYCLES,
            "actual_cycle_attempts": len(cycles),
            "actual_min_valid_cycles": min_valid_cycles,
            "valid_cycles": len(valid_cycle_ids),
            "zero_disallowed_actions": not disallowed_actions,
            "post_worktree_clean": post_worktree_clean,
            "valid_cycle_evidence_verified": (
                len(valid_cycle_ids) >= min_valid_cycles
                and terminal_rows_exact
            ),
        },
    }


def _continuity_validity_reasons(row: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    continuity = row.get("state_continuity")
    if not isinstance(continuity, dict):
        reasons.append("state_continuity_evidence_missing")
        return reasons
    if continuity.get("status") != "ok":
        reasons.append("state_continuity_not_ok")
    if continuity.get("reference_kind") != "state_branch":
        reasons.append("state_continuity_not_state_branch")
    if continuity.get("blocks_action") is not False:
        reasons.append("state_continuity_blocks_action")
    if continuity.get("recovery") is not None:
        reasons.append("state_continuity_recovery_forbidden")
    return reasons


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
    with secure_directory_fd(output_root) as root_fd:
        files = enumerate_regular_files_at(root_fd)
    return [
        relative
        for relative in files
        if relative == "failure-report.json"
        or relative.startswith("failures/burnin-observe-")
    ]


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


def _evidence_bundle(
    output_root: Path,
    *,
    target_ref: str,
    base_commit_sha: str,
    workflow_run_id: str,
    workflow_run_attempt: int,
) -> dict[str, Any]:
    artifacts: list[dict[str, Any]] = []
    with secure_directory_fd(output_root) as root_fd:
        for relative in enumerate_regular_files_at(root_fd):
            if relative == EVIDENCE_BUNDLE_ARTIFACT:
                continue
            snapshot = read_regular_file_at(root_fd, relative)
            artifacts.append(
                {
                    "path": relative,
                    "sha256": snapshot.sha256.removeprefix("sha256:"),
                    "size_bytes": snapshot.size_bytes,
                }
            )
    return {
        "schema_version": "aria/evidence-bundle/v1",
        "generated_at": utc_now(),
        "target_ref": target_ref,
        "base_commit_sha": base_commit_sha,
        "workflow_run_id": workflow_run_id,
        "workflow_run_attempt": workflow_run_attempt,
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
    atomic_write_json_path(path, payload)


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
