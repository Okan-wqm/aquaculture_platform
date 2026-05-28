from __future__ import annotations

import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


RUN_LEDGER_FORMAT_ENV = "ARIA_RUN_LEDGER_FORMAT"
RUN_LEDGER_FORMATS = ("v1", "v2-shadow", "v2")
DEFAULT_RUN_LEDGER_FORMAT = "v2-shadow"
SUMMARY_STDOUT_MAX_BYTES = 32 * 1024


def run_ledger_format() -> str:
    value = os.environ.get(RUN_LEDGER_FORMAT_ENV, DEFAULT_RUN_LEDGER_FORMAT).strip()
    if value not in RUN_LEDGER_FORMATS:
        raise GovernanceError(
            f"{RUN_LEDGER_FORMAT_ENV} must be one of {', '.join(RUN_LEDGER_FORMATS)}",
        )
    return value


def run_artifacts_root(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "run-artifacts"


def artifact_index_path(base_dir: str | Path | None = None) -> Path:
    return run_artifacts_root(base_dir) / "artifact-index.jsonl"


def artifact_manifest_path(base_dir: str | Path | None = None) -> Path:
    return run_artifacts_root(base_dir) / "manifest.jsonl"


def retention_events_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "retention" / "events.jsonl"


def artifact_inventory_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "observability" / "artifact-inventory.jsonl"


def by_cycle_runs_path(base_dir: str | Path | None, cycle_uid: str) -> Path:
    safe_cycle = _safe_segment(cycle_uid)
    return ensure_tools_dir(base_dir) / "runs" / "by-cycle" / f"{safe_cycle}.jsonl"


def write_run_artifact(
    *,
    base_dir: str | Path | None,
    run_id: str,
    cycle_uid: str,
    tool_id: str,
    kind: str,
    payload: dict[str, Any],
    run_status: str,
    repo_state_id: str | None = None,
    owner: str = "tool_runner",
) -> dict[str, Any]:
    """Persist full runtime evidence before the thin run row is appended.

    The returned dict is intentionally ledger-ready: callers can copy
    ``artifact_ref``, ``artifact_hash`` and ``artifact_status`` onto the
    run row without re-reading the artifact.
    """
    root = run_artifacts_root(base_dir)
    artifact_id = f"{_safe_segment(cycle_uid)}.{_safe_segment(run_id)}.{_safe_segment(kind)}"
    artifact_path = root / "hot" / _safe_segment(cycle_uid) / _safe_segment(run_id) / f"{_safe_segment(kind)}.json"
    _assert_under_root(artifact_path, root)
    payload = {
        "schema_version": 1,
        "artifact_id": artifact_id,
        "artifact_kind": kind,
        "run_id": run_id,
        "cycle_uid": cycle_uid,
        "tool_id": tool_id,
        "created_at": utc_now(),
        "payload": payload,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    digest = _sha256_bytes(encoded)
    try:
        _atomic_write_bytes(artifact_path, encoded)
        actual = _sha256_bytes(artifact_path.read_bytes())
        if actual != digest:
            raise GovernanceError("run_artifact_hash_mismatch_after_write")
        status = "present"
        reason = None
    except Exception as exc:
        return {
            "artifact_id": artifact_id,
            "artifact_ref": None,
            "artifact_hash": None,
            "artifact_status": "write_failed",
            "artifact_error": str(exc),
        }

    uri = _relative_uri(ensure_tools_dir(base_dir), artifact_path)
    ref = {
        "schema_version": 1,
        "artifact_id": artifact_id,
        "kind": kind,
        "uri": uri,
        "sha256": digest,
        "size_bytes": len(encoded),
        "verification_status": status,
    }
    index_row = {
        "schema_version": 1,
        "artifact_id": artifact_id,
        "cycle_id": cycle_uid,
        "cycle_uid": cycle_uid,
        "run_id": run_id,
        "tool_id": tool_id,
        "kind": kind,
        "sha256": digest,
        "size_bytes": len(encoded),
        "created_at": utc_now(),
        "storage_tier": "hot",
        "current_uri": uri,
        "owner": owner,
        "repo_state_id": repo_state_id,
        "run_status": run_status,
        "artifact_status": status,
    }
    append_jsonl(artifact_index_path(base_dir), index_row)
    append_jsonl(artifact_manifest_path(base_dir), {"event": "artifact_created", **index_row})
    append_jsonl(artifact_inventory_path(base_dir), {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_uid,
        "run_id": run_id,
        "artifact_id": artifact_id,
        "artifact_class": kind,
        "path": uri,
        "bytes": len(encoded),
        "sha256": digest,
        "storage_tier": "hot",
        "retention_action": None,
    })
    return {
        "artifact_id": artifact_id,
        "artifact_ref": ref,
        "artifact_hash": digest,
        "artifact_status": status,
        "artifact_error": reason,
    }


def append_run_by_cycle(
    *,
    base_dir: str | Path | None,
    cycle_uid: str,
    run_row: dict[str, Any],
) -> None:
    summary = {
        "schema_version": 1,
        "recorded_at": run_row.get("recorded_at") or utc_now(),
        "cycle_id": run_row.get("cycle_id"),
        "cycle_uid": cycle_uid,
        "run_id": run_row.get("run_id"),
        "tool_id": run_row.get("tool_id"),
        "status": run_row.get("status"),
        "artifact_ref": run_row.get("artifact_ref"),
        "artifact_hash": run_row.get("artifact_hash"),
        "artifact_status": run_row.get("artifact_status", "legacy_inline_or_sample_only"),
        "runner": _runner_summary(run_row.get("runner")),
    }
    append_jsonl(by_cycle_runs_path(base_dir, cycle_uid), summary)


def read_runs_for_cycle(
    *,
    base_dir: str | Path | None,
    cycle_uid: str,
) -> list[dict[str, Any]]:
    from .runs_reader import read_runs_rows
    from .tool_health import runs_path

    by_cycle = by_cycle_runs_path(base_dir, cycle_uid)
    if by_cycle.exists():
        return list(read_runs_rows(by_cycle, base_dir=ensure_tools_dir(base_dir)))
    return [
        row for row in read_runs_rows(runs_path(base_dir), base_dir=ensure_tools_dir(base_dir))
        if row.get("cycle_id") == cycle_uid
    ]


def resolve_artifact_payload(
    artifact_ref: Any,
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    if not isinstance(artifact_ref, dict):
        return None
    uri = artifact_ref.get("uri")
    if not isinstance(uri, str) or not uri:
        return None
    path = _resolve_uri(ensure_tools_dir(base_dir), uri)
    if not path.exists() or not path.is_file():
        return None
    expected = artifact_ref.get("sha256")
    raw = path.read_bytes()
    if isinstance(expected, str) and expected and _sha256_bytes(raw) != expected:
        return None
    payload = json.loads(raw.decode("utf-8"))
    return payload if isinstance(payload, dict) else None


def resolve_finding_from_artifact(
    row: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    pointer = row.get("json_pointer")
    if not isinstance(pointer, str) or not pointer.startswith("/payload/raw_findings/"):
        return None
    artifact = resolve_artifact_payload(row.get("artifact_ref"), base_dir=base_dir)
    if artifact is None:
        return None
    payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
    findings = payload.get("raw_findings")
    if not isinstance(findings, list):
        return None
    try:
        index = int(pointer.rsplit("/", 1)[-1])
    except ValueError:
        return None
    if index < 0 or index >= len(findings) or not isinstance(findings[index], dict):
        return None
    return findings[index]


def verify_artifacts(*, base_dir: str | Path | None = None) -> dict[str, Any]:
    root = Path(base_dir) if base_dir is not None else ensure_tools_dir(None)
    issues: list[dict[str, Any]] = []
    rows = load_jsonl(root / "run-artifacts" / "artifact-index.jsonl")
    verified = 0
    for row in rows:
        artifact_id = str(row.get("artifact_id") or "")
        uri = str(row.get("current_uri") or "")
        expected = str(row.get("sha256") or "")
        if not uri:
            issues.append({"code": "run_artifact_missing", "artifact_id": artifact_id, "reason": "empty_uri"})
            continue
        try:
            path = _resolve_uri(root, uri)
        except GovernanceError as exc:
            issues.append({"code": "run_artifact_path_escape", "artifact_id": artifact_id, "reason": str(exc)})
            continue
        if not path.exists():
            issues.append({"code": "run_artifact_missing", "artifact_id": artifact_id, "path": uri})
            continue
        actual = _sha256_bytes(path.read_bytes())
        if actual != expected:
            issues.append({
                "code": "run_artifact_hash_mismatch",
                "artifact_id": artifact_id,
                "expected": expected,
                "actual": actual,
            })
            continue
        verified += 1
    return {
        "schema_version": 1,
        "status": "ok" if not issues else "drift",
        "valid": not issues,
        "artifact_count": len(rows),
        "verified_count": verified,
        "issues": issues,
    }


def retention_dry_run(
    *,
    base_dir: str | Path | None = None,
    retain_hot_cycles: int = 20,
) -> dict[str, Any]:
    rows = load_jsonl(artifact_index_path(base_dir))
    candidates = _retention_candidates(rows, retain_hot_cycles=retain_hot_cycles)
    return {
        "schema_version": 1,
        "mode": "dry-run",
        "retain_hot_cycles": retain_hot_cycles,
        "candidate_count": len(candidates),
        "candidates": candidates,
    }


def retention_apply(
    *,
    base_dir: str | Path | None = None,
    acknowledge: bool = False,
    retain_hot_cycles: int = 20,
) -> dict[str, Any]:
    if not acknowledge:
        raise GovernanceError("retention_apply_requires_acknowledge")
    root = ensure_tools_dir(base_dir)
    candidates = _retention_candidates(load_jsonl(artifact_index_path(root)), retain_hot_cycles=retain_hot_cycles)
    archived: list[dict[str, Any]] = []
    for candidate in candidates:
        if candidate.get("review_required"):
            continue
        source = _resolve_uri(root, str(candidate["current_uri"]))
        if not source.exists():
            continue
        archive_path = root / ".archive" / "runtime" / str(candidate["artifact_id"]) / source.name
        _assert_under_root(archive_path, root / ".archive")
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, archive_path)
        actual = _sha256_bytes(archive_path.read_bytes())
        if actual != candidate.get("sha256"):
            raise GovernanceError("archive_hash_mismatch")
        event = {
            "schema_version": 1,
            "event": "artifact_archived",
            "manifest_id": f"retention.{candidate['artifact_id']}",
            "artifact_id": candidate["artifact_id"],
            "cycle_uid": candidate.get("cycle_uid"),
            "original_path": candidate["current_uri"],
            "new_path": _relative_uri(root, archive_path),
            "sha256": actual,
            "size": archive_path.stat().st_size,
            "reason": candidate.get("reason"),
            "reviewed": True,
            "recorded_at": utc_now(),
        }
        append_jsonl(retention_events_path(root), event)
        archived.append(event)
    return {
        "schema_version": 1,
        "mode": "apply",
        "archived_count": len(archived),
        "archived": archived,
    }


def restore_artifact(
    *,
    base_dir: str | Path | None = None,
    artifact_ref: str,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    rows = load_jsonl(root / "run-artifacts" / "artifact-index.jsonl")
    row = next((item for item in rows if item.get("artifact_id") == artifact_ref or item.get("current_uri") == artifact_ref), None)
    if row is None:
        raise GovernanceError(f"artifact_not_found:{artifact_ref}")
    uri = str(row.get("current_uri") or "")
    path = _resolve_uri(root, uri)
    if not path.exists():
        archive = _latest_archive_event(root, str(row.get("artifact_id") or ""))
        if archive is None:
            raise GovernanceError(f"artifact_unavailable:{artifact_ref}")
        archived_path = _resolve_uri(root, str(archive.get("new_path")))
        if not archived_path.exists():
            raise GovernanceError(f"archive_restore_failed:{artifact_ref}")
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(archived_path, path)
    actual = _sha256_bytes(path.read_bytes())
    if actual != row.get("sha256"):
        raise GovernanceError(f"artifact_hash_mismatch:{artifact_ref}")
    return {
        "schema_version": 1,
        "status": "restored",
        "artifact_id": row.get("artifact_id"),
        "path": uri,
        "sha256": actual,
    }


def rollback_retention(
    *,
    base_dir: str | Path | None = None,
    manifest_id: str,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    events = load_jsonl(retention_events_path(root))
    matches = [row for row in events if row.get("manifest_id") == manifest_id]
    restored: list[dict[str, Any]] = []
    for row in matches:
        source = _resolve_uri(root, str(row.get("new_path")))
        destination = _resolve_uri(root, str(row.get("original_path")))
        if not source.exists():
            raise GovernanceError(f"archive_restore_failed:{manifest_id}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        actual = _sha256_bytes(destination.read_bytes())
        if actual != row.get("sha256"):
            raise GovernanceError(f"artifact_hash_mismatch:{manifest_id}")
        restored.append({"artifact_id": row.get("artifact_id"), "path": row.get("original_path")})
    return {
        "schema_version": 1,
        "status": "rolled_back",
        "manifest_id": manifest_id,
        "restored_count": len(restored),
        "restored": restored,
    }


def autonomy_output_summary(result: dict[str, Any], *, result_detail: str = "summary") -> dict[str, Any]:
    per_cycle = result.get("per_cycle") if isinstance(result.get("per_cycle"), list) else []
    cycle_status_counts: dict[str, int] = {}
    tool_status_counts: dict[str, int] = {}
    artifact_refs: list[dict[str, Any]] = []
    non_ok_tools: list[dict[str, Any]] = []
    evidence_errors = 0
    incomplete_lifecycle_count = 0
    failed_phases: list[dict[str, Any]] = []
    suppressed_count = 0
    truncated_count = 0
    for item in per_cycle:
        if not isinstance(item, dict):
            continue
        cycle = item.get("cycle") if isinstance(item.get("cycle"), dict) else {}
        status = str(cycle.get("runtime_status") or cycle.get("status") or "unknown")
        cycle_status_counts[status] = cycle_status_counts.get(status, 0) + 1
        incomplete_lifecycle_count += int(cycle.get("incomplete_lifecycle_count") or 0)
        for phase in cycle.get("failed_phases", []) if isinstance(cycle.get("failed_phases"), list) else []:
            if isinstance(phase, dict):
                failed_phases.append(phase)
        for ref in cycle.get("artifact_refs", []) if isinstance(cycle.get("artifact_refs"), list) else []:
            if isinstance(ref, dict):
                artifact_refs.append(ref)
        for run in cycle.get("tool_run_summary", []) if isinstance(cycle.get("tool_run_summary"), list) else []:
            if not isinstance(run, dict):
                continue
            tool_status = str(run.get("status") or "unknown")
            tool_status_counts[tool_status] = tool_status_counts.get(tool_status, 0) + 1
            if tool_status not in {"ok"}:
                non_ok_tools.append({
                    "cycle_id": cycle.get("cycle_id"),
                    "tool_id": run.get("tool_id"),
                    "status": tool_status,
                    "artifact_status": run.get("artifact_status"),
                })
            if tool_status == "evidence_error":
                evidence_errors += 1
            if run.get("artifact_status") in {"missing", "hash_mismatch", "write_failed"}:
                non_ok_tools.append({
                    "cycle_id": cycle.get("cycle_id"),
                    "tool_id": run.get("tool_id"),
                    "status": "integrity_failed",
                    "artifact_status": run.get("artifact_status"),
                })
    if result.get("exits_clean") is False:
        overall = "blocked" if result.get("exit_reason") == "daemon_already_running" else "failed"
    elif any(status in cycle_status_counts for status in ("failed", "integrity_failed", "aborted")) or non_ok_tools:
        overall = "failed"
    elif any(status in cycle_status_counts for status in ("degraded", "partial")):
        overall = "degraded"
    else:
        overall = "ok"
    summary = {
        "schema_version": 2,
        "result_detail": result_detail,
        "overall_status": overall,
        "exit_code": autonomy_exit_code(overall),
        "exit_reason": result.get("exit_reason"),
        "cycles_completed": result.get("cycles_completed", 0),
        "cycle_status_counts": dict(sorted(cycle_status_counts.items())),
        "tool_status_counts": dict(sorted(tool_status_counts.items())),
        "error_count": len(non_ok_tools),
        "warning_count": 0,
        "suppressed_count": suppressed_count,
        "truncated_count": truncated_count,
        "non_ok_tools": non_ok_tools,
        "evidence_errors": evidence_errors,
        "artifact_refs": artifact_refs,
        "artifact_hash_status": _artifact_hash_status(artifact_refs),
        "quarantine_count": sum(1 for item in non_ok_tools if item.get("status") == "scope_violation"),
        "scope_out_count": sum(1 for item in non_ok_tools if item.get("status") == "scope_violation"),
        "failed_phases": failed_phases,
        "incomplete_lifecycle_count": incomplete_lifecycle_count,
    }
    if result_detail == "full":
        summary["full_result"] = result
    return summary


def autonomy_exit_code(status: str) -> int:
    return {
        "ok": 0,
        "failed": 1,
        "degraded": 2,
        "blocked": 3,
        "integrity_failed": 4,
        "contract_error": 4,
    }.get(status, 1)


def _retention_candidates(rows: list[dict[str, Any]], *, retain_hot_cycles: int) -> list[dict[str, Any]]:
    cycles = []
    seen = set()
    for row in reversed(rows):
        cycle = str(row.get("cycle_uid") or row.get("cycle_id") or "")
        if cycle and cycle not in seen:
            seen.add(cycle)
            cycles.append(cycle)
    retained = set(cycles[:retain_hot_cycles])
    candidates: list[dict[str, Any]] = []
    for row in rows:
        cycle = str(row.get("cycle_uid") or row.get("cycle_id") or "")
        if row.get("storage_tier") != "hot" or cycle in retained:
            continue
        status = str(row.get("run_status") or "")
        review_required = status not in {"ok", "completed", ""}
        candidates.append({
            "artifact_id": row.get("artifact_id"),
            "cycle_uid": cycle,
            "current_uri": row.get("current_uri"),
            "sha256": row.get("sha256"),
            "size": row.get("size_bytes"),
            "reason": "hot_retention_window_exceeded",
            "review_required": review_required,
        })
    return candidates


def _latest_archive_event(root: Path, artifact_id: str) -> dict[str, Any] | None:
    latest = None
    for row in load_jsonl(retention_events_path(root)):
        if row.get("artifact_id") == artifact_id and row.get("event") == "artifact_archived":
            latest = row
    return latest


def _artifact_hash_status(refs: list[dict[str, Any]]) -> str:
    if not refs:
        return "none"
    statuses = {str(ref.get("verification_status") or "") for ref in refs}
    return "ok" if statuses <= {"present", "ok"} else "drift"


def _runner_summary(runner: Any) -> dict[str, Any]:
    if not isinstance(runner, dict):
        return {}
    return {
        "type": runner.get("type"),
        "exit_code": runner.get("exit_code"),
        "timed_out": runner.get("timed_out"),
        "raw_observations_count": runner.get("raw_observations_count", 0),
        "raw_findings_count": runner.get("raw_findings_count", 0),
        "scoped_mutations": runner.get("scoped_mutations", []),
        "scope_out_mutations": runner.get("scope_out_mutations", []),
        "parse_error": runner.get("parse_error"),
    }


def _relative_uri(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _resolve_uri(root: Path, uri: str) -> Path:
    candidate = (root / uri).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise GovernanceError(f"run_artifact_path_escape:{uri}") from exc
    if candidate.is_symlink():
        raise GovernanceError(f"run_artifact_path_escape:{uri}")
    return candidate


def _assert_under_root(path: Path, root: Path) -> None:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise GovernanceError(f"run_artifact_path_escape:{path}") from exc


def _safe_segment(value: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "_" for ch in str(value))
    return safe.strip("._") or "unknown"


def _sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{datetime.now(timezone.utc).timestamp()}.tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        try:
            os.write(fd, content)
            os.fsync(fd)
        finally:
            os.close(fd)
        tmp.replace(path)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    if not os.name == "nt":
        dir_fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
