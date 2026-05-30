from __future__ import annotations

import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import LedgerIntegrityError, append_jsonl, file_hash, load_jsonl, verify_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


RUN_LEDGER_FORMAT_ENV = "ARIA_RUN_LEDGER_FORMAT"
RUN_LEDGER_FORMATS = ("v1", "v2-shadow", "v2")
DEFAULT_RUN_LEDGER_FORMAT = "v2-shadow"
SUMMARY_STDOUT_MAX_BYTES = 32 * 1024
ARTIFACT_BEARING = "artifact_bearing"
LIFECYCLE_ONLY = "lifecycle_only"
INTEGRITY_FAILED = "integrity_failed"
INCOMPLETE = "incomplete"

DISCOVERY_ARTIFACTS = (
    "COMPLETION_PROOF.json",
    "FATES.json",
    "REPO_FINGERPRINT.json",
    "SERVICE_MAP.json",
    "SNAPSHOT.json",
)


def run_ledger_format(base_dir: str | Path | None = None) -> str:
    value = os.environ.get(RUN_LEDGER_FORMAT_ENV, DEFAULT_RUN_LEDGER_FORMAT).strip()
    if value not in RUN_LEDGER_FORMATS:
        raise GovernanceError(
            f"{RUN_LEDGER_FORMAT_ENV} must be one of {', '.join(RUN_LEDGER_FORMATS)}",
        )
    if value == "v2":
        require_runtime_v2_promotion(base_dir=base_dir)
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


def classify_cycle_evidence(
    *,
    base_dir: str | Path | None = None,
    cycle_id: str,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    verification = verify_runtime_artifacts(base_dir=root, cycle_id=cycle_id)
    cycle_rows = [row for row in load_jsonl(root / "cycles.jsonl") if row.get("cycle_id") == cycle_id]
    has_terminal = any(row.get("event") in {"completed", "failed", "stopped", "aborted"} or row.get("status") in {"completed", "failed", "stopped", "aborted"} for row in cycle_rows)
    run_rows = [row for row in load_jsonl(root / "runs.jsonl") if row.get("cycle_id") == cycle_id]
    runnable_tools = [tool for tool in _load_registry_tools(root) if tool.get("status") in {"ACTIVE", "SHADOW", "CALIBRATE"}]
    expected_tool_count = len(runnable_tools)
    ok_runs = [row for row in run_rows if row.get("status") == "ok"]
    non_ok_count = sum(1 for row in run_rows if row.get("status") != "ok")
    missing_expected = max(0, expected_tool_count - len(run_rows))
    hidden_non_ok_count = non_ok_count + missing_expected
    if not has_terminal:
        evidence_class = INCOMPLETE
    elif verification["status"] != "ok" or hidden_non_ok_count:
        evidence_class = INTEGRITY_FAILED
    elif ok_runs:
        evidence_class = ARTIFACT_BEARING
    else:
        evidence_class = LIFECYCLE_ONLY
    return {"schema_version": 1, "cycle_id": cycle_id, "cycle_evidence_class": evidence_class, "verified_artifact_count": int(verification["verified_artifact_count"]), "expected_tool_count": expected_tool_count, "hidden_non_ok_count": hidden_non_ok_count, "promotion_eligible": evidence_class == ARTIFACT_BEARING, "issues": verification["issues"]}


def verify_runtime_artifacts(
    *,
    base_dir: str | Path | None = None,
    workspace_root: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    workspace = Path(workspace_root).resolve() if workspace_root else None
    issues: list[dict[str, Any]] = []
    verified = 0
    issues.extend(_ledger_issues(root / "runs.jsonl", "runs"))
    issues.extend(_ledger_issues(root / "raw-findings.jsonl", "raw_findings"))
    issues.extend(_ledger_issues(root / "cycles.jsonl", "cycles"))
    issues.extend(_ledger_issues(root / "pressure" / "pressure-log.jsonl", "pressure_log"))
    issues.extend(_ledger_issues(artifact_index_path(root), "runtime_artifact_index"))
    issues.extend(_ledger_issues(artifact_manifest_path(root), "runtime_artifact_manifest"))
    issues.extend(_ledger_issues(artifact_inventory_path(root), "runtime_artifact_inventory"))
    runs = _safe_load_jsonl(root / "runs.jsonl", issues, "runs")
    by_cycle = root / "runs" / "by-cycle" / f"{_safe_segment(cycle_id)}.jsonl" if cycle_id is not None else None
    if by_cycle is not None and by_cycle.exists():
        runs.extend(_safe_load_jsonl(by_cycle, issues, "runs_by_cycle"))
    raw_findings = _safe_load_jsonl(root / "raw-findings.jsonl", issues, "raw_findings")
    if cycle_id is not None:
        runs = [row for row in runs if row.get("cycle_id") == cycle_id or row.get("cycle_uid") == cycle_id]
        raw_findings = [row for row in raw_findings if row.get("cycle_id") == cycle_id]
    raw_by_run: dict[str, list[dict[str, Any]]] = {}
    for row in raw_findings:
        raw_by_run.setdefault(str(row.get("run_id") or ""), []).append(row)
        raw_issue = _raw_finding_issue(row)
        if raw_issue:
            issues.append(raw_issue)
    artifact_refs_seen: list[Any] = []
    seen_run_ids: set[str] = set()
    for run in runs:
        run_id = str(run.get("run_id") or "")
        if run_id in seen_run_ids:
            continue
        if run_id:
            seen_run_ids.add(run_id)
        verified += 1
        expected_raw = int((run.get("runner") or {}).get("raw_findings_count") or 0)
        if expected_raw and not raw_by_run.get(run_id) and not _artifact_ref_has_raw_findings(run, base_dir=root):
            issues.append({"code": "raw_pointer_missing", "run_id": run_id, "cycle_id": run.get("cycle_id") or run.get("cycle_uid"), "expected_raw_findings_count": expected_raw})
        for ref in _artifact_refs_from_run(run):
            artifact_refs_seen.append(ref)
            issue = _verify_artifact_ref(ref, root=root, workspace_root=workspace, source={"kind": "run", "run_id": run_id})
            if issue:
                issues.append(issue)
            else:
                verified += 1
    verified += _verify_cycle_files(root=root, cycle_id=cycle_id, issues=issues)
    _verify_artifact_indexes(root=root, artifact_refs_seen=artifact_refs_seen, issues=issues)
    _verify_manifests_and_inventory(root=root, cycle_id=cycle_id, issues=issues)
    _verify_retention_events(root=root, issues=issues)
    return {"schema_version": 1, "status": "ok" if not issues else "failed", "valid": not issues, "cycle_id": cycle_id, "verified_artifact_count": verified, "issues": issues}


def approve_runtime_v2_promotion(
    *,
    evidence_bundle: str | Path,
    base_dir: str | Path | None = None,
    operator_approval_ref: str | None = None,
) -> dict[str, Any]:
    from .runtime_profile import enforce_profile_for_write
    enforce_profile_for_write("runtime_v2_promotion", base_dir=base_dir)
    root = ensure_tools_dir(base_dir)
    bundle_path = Path(evidence_bundle).expanduser().resolve()
    if not bundle_path.exists() or not bundle_path.is_file():
        raise GovernanceError("runtime_v2_evidence_bundle_missing")
    try:
        bundle_path.relative_to(root.resolve())
    except ValueError as exc:
        raise GovernanceError("runtime_v2_evidence_bundle_must_be_under_tools_root") from exc
    payload = _read_json(bundle_path)
    if operator_approval_ref is None:
        operator_approval_ref = str(payload.get("operator_approval_ref") or "")
    if not operator_approval_ref.strip():
        raise GovernanceError("runtime_v2_promotion_requires_operator_approval_ref")
    verification = verify_runtime_artifacts(base_dir=root)
    if verification["status"] != "ok":
        raise GovernanceError("runtime_v2_promotion_evidence_integrity_failed")
    row = {"$schema": "aria/runtime-v2-promotion/v1", "schema_version": 1, "recorded_at": utc_now(), "status": "approved", "operator_approval_ref": operator_approval_ref, "evidence_bundle": bundle_path.as_posix(), "evidence_bundle_hash": "sha256:" + hashlib.sha256(bundle_path.read_bytes()).hexdigest(), "verification": {"verified_artifact_count": verification["verified_artifact_count"], "issue_count": len(verification["issues"])}}
    return append_jsonl(root / "runtime" / "v2-promotions.jsonl", row)


def require_runtime_v2_promotion(*, base_dir: str | Path | None = None) -> None:
    root = ensure_tools_dir(base_dir)
    rows = load_jsonl(root / "runtime" / "v2-promotions.jsonl")
    if not any(row.get("status") == "approved" for row in rows):
        raise GovernanceError("ARIA_RUN_LEDGER_FORMAT=v2 requires approved runtime v2 promotion record")


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


def _ledger_issues(path: Path, name: str) -> list[dict[str, Any]]:
    result = verify_jsonl(path)
    if result.get("valid") is True:
        return []
    return [{"code": "ledger_integrity_failed", "ledger": name, "details": result}]


def _safe_load_jsonl(path: Path, issues: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
    try:
        return load_jsonl(path)
    except LedgerIntegrityError as exc:
        issues.append({"code": "ledger_load_failed", "ledger": name, "error": str(exc)})
        return []


def _artifact_refs_from_run(run: dict[str, Any]) -> list[Any]:
    refs: list[Any] = []
    singular = run.get("artifact_ref")
    if isinstance(singular, (dict, str)):
        refs.append(singular)
    for key in ("artifact_refs", "artifacts"):
        value = run.get(key)
        if isinstance(value, list):
            refs.extend(value)
    runner = run.get("runner")
    if isinstance(runner, dict):
        value = runner.get("artifact_refs")
        if isinstance(value, list):
            refs.extend(value)
    return refs


def _verify_artifact_ref(ref: Any, *, root: Path, workspace_root: Path | None, source: dict[str, Any]) -> dict[str, Any] | None:
    if isinstance(ref, str):
        raw_path = ref
        expected_hash = None
    elif isinstance(ref, dict):
        raw_path = str(ref.get("uri") or ref.get("path") or ref.get("artifact_path") or "")
        expected_hash = ref.get("sha256") or ref.get("hash") or ref.get("content_hash")
    else:
        return {"code": "artifact_ref_invalid", "ref": repr(ref), "source": source}
    if not raw_path.strip():
        return {"code": "artifact_ref_missing_path", "ref": ref, "source": source}
    try:
        path = _resolve_artifact_path(raw_path, root=root, workspace_root=workspace_root)
    except GovernanceError as exc:
        return {"code": "artifact_path_escape", "path": raw_path, "source": source, "reason": str(exc)}
    if not path.exists():
        return {"code": "artifact_ref_missing", "path": raw_path, "source": source}
    if path.is_file():
        actual = file_hash(path)
        if expected_hash:
            normalized = str(expected_hash)
            if normalized.startswith("sha256:"):
                normalized = normalized.split(":", 1)[1]
            if normalized != actual:
                return {"code": "artifact_hash_mismatch", "path": raw_path, "expected": expected_hash, "actual": "sha256:" + actual, "source": source}
    return None


def _resolve_artifact_path(raw_path: str, *, root: Path, workspace_root: Path | None) -> Path:
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = root.parent / raw_path if raw_path.startswith("aria-tools/") else root / raw_path
    resolved = candidate.resolve()
    allowed_roots = [root.resolve()]
    if workspace_root is not None:
        allowed_roots.append(workspace_root.resolve())
    for allowed in allowed_roots:
        try:
            resolved.relative_to(allowed)
            return resolved
        except ValueError:
            continue
    raise GovernanceError("artifact path escapes tools/workspace roots")


def _artifact_ref_has_raw_findings(run: dict[str, Any], *, base_dir: Path) -> bool:
    for ref in _artifact_refs_from_run(run):
        payload = resolve_artifact_payload(ref, base_dir=base_dir)
        inner = payload.get("payload") if isinstance(payload, dict) else None
        if isinstance(inner, dict) and isinstance(inner.get("raw_findings"), list):
            return True
    return False


def _raw_finding_issue(row: dict[str, Any]) -> dict[str, Any] | None:
    finding = row.get("finding")
    if not isinstance(finding, dict):
        return {"code": "raw_pointer_corrupt", "run_id": row.get("run_id"), "finding_id": row.get("finding_id")}
    expected = row.get("evidence_hash")
    if expected:
        actual = _evidence_hash_for_finding(finding)
        if actual != expected:
            return {"code": "raw_pointer_hash_mismatch", "run_id": row.get("run_id"), "finding_id": row.get("finding_id"), "expected": expected, "actual": actual}
    return None


def _evidence_hash_for_finding(finding: dict[str, Any]) -> str:
    refs = finding.get("evidence_refs") or finding.get("evidence") or []
    if not isinstance(refs, list):
        refs = []
    canonical = json.dumps(sorted(str(ref) for ref in refs), sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _verify_cycle_files(*, root: Path, cycle_id: str | None, issues: list[dict[str, Any]]) -> int:
    if cycle_id is None:
        return 0
    verified = 0
    discovery_dir = root / "discovery" / cycle_id
    if discovery_dir.exists():
        for name in DISCOVERY_ARTIFACTS:
            path = discovery_dir / name
            if not path.exists():
                issues.append({"code": "discovery_artifact_missing", "cycle_id": cycle_id, "path": path.as_posix()})
                continue
            try:
                _read_json(path)
                verified += 1
            except (OSError, json.JSONDecodeError):
                issues.append({"code": "discovery_artifact_corrupt", "cycle_id": cycle_id, "path": path.as_posix()})
    for path in (root / "cycle-diff" / f"{cycle_id}.json", root / "pressure" / f"{cycle_id}.json"):
        if path.exists():
            try:
                _read_json(path)
                verified += 1
            except (OSError, json.JSONDecodeError):
                issues.append({"code": "cycle_artifact_corrupt", "cycle_id": cycle_id, "path": path.as_posix()})
    return verified


def _verify_artifact_indexes(*, root: Path, artifact_refs_seen: list[Any], issues: list[dict[str, Any]]) -> None:
    index_paths = [artifact_index_path(root), root / "artifact-index.json", root / "artifact-index.jsonl", root / "artifacts" / "index.json"]
    existing = [path for path in index_paths if path.exists()]
    if artifact_refs_seen and not existing:
        issues.append({"code": "missing_artifact_index", "artifact_ref_count": len(artifact_refs_seen)})
        return
    for path in existing:
        if path.suffix == ".jsonl":
            rows = _safe_load_jsonl(path, issues, "artifact_index")
            if artifact_refs_seen and not rows:
                issues.append({"code": "artifact_index_empty_with_run_refs", "path": path.as_posix()})
            continue
        try:
            payload = _read_json(path)
        except (OSError, json.JSONDecodeError):
            issues.append({"code": "artifact_index_corrupt", "path": path.as_posix()})
            continue
        entries = payload.get("artifacts") or payload.get("entries") or []
        if artifact_refs_seen and not entries:
            issues.append({"code": "artifact_index_empty_with_run_refs", "path": path.as_posix()})


def _verify_manifests_and_inventory(*, root: Path, cycle_id: str | None, issues: list[dict[str, Any]]) -> None:
    cycle_dirs: list[Path] = []
    by_cycle = root / "runs" / "by-cycle"
    if cycle_id is not None:
        cycle_dirs.append(by_cycle / cycle_id)
    elif by_cycle.exists():
        cycle_dirs.extend(path for path in by_cycle.iterdir() if path.is_dir())
    for directory in cycle_dirs:
        if not directory.exists() or directory.is_file():
            continue
        manifest = directory / "manifest.json"
        inventory = directory / "inventory.json"
        if not manifest.exists() and not inventory.exists():
            continue
        if not manifest.exists():
            issues.append({"code": "missing_manifest", "path": manifest.as_posix()})
            continue
        try:
            manifest_payload = _read_json(manifest)
        except (OSError, json.JSONDecodeError):
            issues.append({"code": "manifest_corrupt", "path": manifest.as_posix()})
            manifest_payload = {}
        if inventory.exists():
            try:
                inventory_payload = _read_json(inventory)
            except (OSError, json.JSONDecodeError):
                issues.append({"code": "inventory_corrupt", "path": inventory.as_posix()})
                inventory_payload = {}
            manifest_items = set(_item_paths(manifest_payload))
            inventory_items = set(_item_paths(inventory_payload))
            if manifest_items and inventory_items and manifest_items != inventory_items:
                issues.append({"code": "inventory_drift", "path": inventory.as_posix(), "manifest_only": sorted(manifest_items - inventory_items), "inventory_only": sorted(inventory_items - manifest_items)})
        else:
            issues.append({"code": "missing_inventory", "path": inventory.as_posix()})


def _item_paths(payload: dict[str, Any]) -> list[str]:
    value = payload.get("artifacts") or payload.get("files") or payload.get("items") or []
    out: list[str] = []
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, dict):
                path = item.get("path") or item.get("artifact_path") or item.get("uri")
                if isinstance(path, str):
                    out.append(path)
    return out


def _verify_retention_events(*, root: Path, issues: list[dict[str, Any]]) -> None:
    candidates = [retention_events_path(root), root / "retention-events.jsonl", root / "archive" / "retention-events.jsonl"]
    for path in candidates:
        for row in _safe_load_jsonl(path, issues, "retention_events"):
            kind = str(row.get("kind") or row.get("event") or row.get("event_type") or "")
            source = row.get("source_path") or row.get("artifact_path") or row.get("original_path")
            archive = row.get("archive_path") or row.get("new_path")
            if kind in {"retention_apply", "cycle_artifact_archived", "artifact_archived"} and source:
                try:
                    source_path = _resolve_artifact_path(str(source), root=root, workspace_root=None)
                except GovernanceError:
                    issues.append({"code": "archive_mismatch", "source_path": str(source), "archive_path": str(archive)})
                    continue
                if source_path.exists() and archive:
                    try:
                        archive_path = _resolve_artifact_path(str(archive), root=root, workspace_root=None)
                    except GovernanceError:
                        issues.append({"code": "archive_mismatch", "source_path": str(source), "archive_path": str(archive)})
                        continue
                    if not archive_path.exists():
                        issues.append({"code": "archive_mismatch", "source_path": str(source), "archive_path": str(archive)})
            if kind in {"retention_missing_source", "restore_failed"}:
                issues.append({"code": str(kind), "details": row})
            if kind == "rollback" and not row.get("manifest_id") and not row.get("manifest_path"):
                issues.append({"code": "unknown_manifest_rollback", "details": row})


def _load_registry_tools(root: Path) -> list[dict[str, Any]]:
    try:
        payload = _read_json(root / "registry.json")
    except (OSError, json.JSONDecodeError):
        return []
    tools = payload.get("tools")
    return tools if isinstance(tools, list) else []


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise json.JSONDecodeError("JSON payload must be object", "", 0)
    return payload


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


__all__ = [
    "ARTIFACT_BEARING", "LIFECYCLE_ONLY", "INTEGRITY_FAILED", "INCOMPLETE",
    "RUN_LEDGER_FORMAT_ENV", "RUN_LEDGER_FORMATS", "DEFAULT_RUN_LEDGER_FORMAT",
    "SUMMARY_STDOUT_MAX_BYTES", "append_run_by_cycle", "approve_runtime_v2_promotion",
    "artifact_index_path", "artifact_inventory_path", "artifact_manifest_path",
    "autonomy_exit_code", "autonomy_output_summary", "by_cycle_runs_path",
    "classify_cycle_evidence", "read_runs_for_cycle", "require_runtime_v2_promotion",
    "resolve_artifact_payload", "resolve_finding_from_artifact", "restore_artifact",
    "retention_apply", "retention_dry_run", "rollback_retention", "run_artifacts_root",
    "run_ledger_format", "verify_artifacts", "verify_runtime_artifacts", "write_run_artifact",
]
