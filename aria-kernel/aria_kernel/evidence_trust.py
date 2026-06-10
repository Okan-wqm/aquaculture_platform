from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any


SHA256_RE = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")
SELF_OUTPUT_PATH_PREFIXES = (
    "agent-workspace/",
    ".aria-poc/",
    "tmp/",
    "temp/",
    "runner-temp/",
)

TRUSTED_PROOF_SOURCE_SURFACES = frozenset(
    {
        "runtime_artifact",
        "retention_event",
        "workflow_preflight_artifact",
        "workflow_artifact",
        "ci_artifact",
        "dlp_scan",
        "token_provenance",
    }
)
UNTRUSTED_PROOF_SOURCE_SURFACES = frozenset(
    {
        "agent_output",
        "caller",
        "caller_string",
        "self_output",
        "workspace",
        "worktree",
    }
)


def recompute_artifact_hash(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def normalize_sha256(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip().lower()
    if not SHA256_RE.fullmatch(candidate):
        return None
    if candidate.startswith("sha256:"):
        return candidate
    return "sha256:" + candidate


def declared_source_surfaces(proof: Any) -> tuple[str, ...]:
    if not isinstance(proof, dict):
        return ()
    raw = proof.get("source_surface")
    if raw is None:
        raw = proof.get("source_surfaces")
    if isinstance(raw, str):
        values = [raw]
    elif isinstance(raw, list):
        values = [item for item in raw if isinstance(item, str)]
    else:
        values = []
    return tuple(value.strip().lower() for value in values if value.strip())


def source_surface_issues(
    proof: Any,
    *,
    allowed_surfaces: frozenset[str] = TRUSTED_PROOF_SOURCE_SURFACES,
    require_declared: bool = True,
) -> list[dict[str, Any]]:
    if not isinstance(proof, dict):
        return [{"code": "proof_ref_not_structured", "ref": repr(proof)}]
    surfaces = declared_source_surfaces(proof)
    if not surfaces:
        if require_declared:
            return [{"code": "proof_source_surface_missing"}]
        return []
    issues: list[dict[str, Any]] = []
    for surface in surfaces:
        if surface in UNTRUSTED_PROOF_SOURCE_SURFACES:
            issues.append({"code": "proof_source_surface_untrusted", "source_surface": surface})
        elif surface not in allowed_surfaces:
            issues.append({"code": "proof_source_surface_unknown", "source_surface": surface})
    return issues


def verify_hash_bound_artifact_ref(
    ref: Any,
    *,
    root: str | Path | None = None,
    trusted_root: str | Path | None = None,
    workspace_root: str | Path | None = None,
    source: dict[str, Any] | None = None,
    require_artifact_id: bool = True,
    require_source_surface: bool = True,
    allowed_source_surfaces: frozenset[str] | None = None,
    allow_workspace_path: bool = False,
    require_content_type: bool = True,
    require_produced_by_workflow_run_id: bool = True,
) -> list[dict[str, Any]]:
    if not isinstance(ref, dict):
        return [{"code": "proof_ref_not_structured", "ref": repr(ref), "source": source or {}}]
    if trusted_root is None and root is None:
        return [{"code": "proof_trusted_root_required", "ref": ref, "source": source or {}}]
    if allowed_source_surfaces is None:
        return [{"code": "proof_allowed_source_surfaces_required", "ref": ref, "source": source or {}}]

    issues = source_surface_issues(
        ref,
        allowed_surfaces=allowed_source_surfaces,
        require_declared=require_source_surface,
    )
    if require_artifact_id and not ref.get("artifact_id"):
        issues.append({"code": "proof_artifact_ref_missing_artifact_id", "ref": ref, "source": source or {}})
    if require_content_type and not _nonempty_string(ref.get("content_type")):
        issues.append({"code": "proof_artifact_ref_missing_content_type", "ref": ref, "source": source or {}})
    if require_produced_by_workflow_run_id and not _nonempty_string(ref.get("produced_by_workflow_run_id")):
        issues.append({"code": "proof_artifact_ref_missing_produced_by_workflow_run_id", "ref": ref, "source": source or {}})

    raw_path = str(ref.get("uri") or ref.get("path") or ref.get("artifact_path") or "")
    expected_hash = normalize_sha256(ref.get("sha256") or ref.get("hash") or ref.get("content_hash"))
    if not expected_hash:
        issues.append({"code": "proof_artifact_ref_missing_hash", "ref": ref, "source": source or {}})
    if not raw_path.strip():
        issues.append({"code": "proof_artifact_ref_missing_path", "ref": ref, "source": source or {}})
        return _with_source(issues, source)
    if not allow_workspace_path and is_self_output_path(raw_path):
        issues.append({"code": "proof_artifact_self_output_path", "path": raw_path})
        return _with_source(issues, source)
    resolved, path_issue = resolve_artifact_ref_path(
        raw_path,
        root=trusted_root if trusted_root is not None else root,
        workspace_root=workspace_root,
        allow_workspace_path=allow_workspace_path,
    )
    if path_issue is not None:
        issues.append({**path_issue, "path": raw_path})
        return _with_source(issues, source)
    assert resolved is not None
    if not resolved.exists() or not resolved.is_file():
        issues.append({"code": "proof_artifact_missing", "path": raw_path})
        return _with_source(issues, source)
    if expected_hash:
        actual_hash = recompute_artifact_hash(resolved)
        if actual_hash != expected_hash:
            issues.append(
                {
                    "code": "proof_artifact_hash_mismatch",
                    "path": raw_path,
                    "expected": expected_hash,
                    "actual": actual_hash,
                }
            )
    return _with_source(issues, source)


def resolve_verified_artifact_payload(
    ref: Any,
    *,
    trusted_root: str | Path,
    allowed_source_surfaces: frozenset[str],
    expected_sha256: str | None = None,
    workspace_root: str | Path | None = None,
    source: dict[str, Any] | None = None,
) -> dict[str, Any]:
    issues = verify_hash_bound_artifact_ref(
        ref,
        trusted_root=trusted_root,
        workspace_root=workspace_root,
        source=source,
        allowed_source_surfaces=allowed_source_surfaces,
        allow_workspace_path=False,
    )
    if issues:
        raise ValueError(f"artifact_ref_untrusted:{issues}")
    expected = normalize_sha256(expected_sha256 or ref.get("sha256"))
    raw_path = str(ref.get("uri") or ref.get("path") or ref.get("artifact_path") or "")
    resolved, path_issue = resolve_artifact_ref_path(
        raw_path,
        root=trusted_root,
        workspace_root=workspace_root,
        allow_workspace_path=False,
    )
    if resolved is None or path_issue is not None:
        raise ValueError(f"artifact_ref_path_untrusted:{path_issue}")
    if expected is not None and recompute_artifact_hash(resolved) != expected:
        raise ValueError("artifact_ref_hash_mismatch")
    payload = json.loads(resolved.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("artifact_payload_not_object")
    return payload


def resolve_artifact_ref_path(
    raw_path: str,
    *,
    root: str | Path,
    workspace_root: str | Path | None = None,
    allow_workspace_path: bool = False,
) -> tuple[Path | None, dict[str, Any] | None]:
    if root is None:
        return None, {"code": "proof_trusted_root_required"}
    trusted_root = Path(root).resolve()
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = trusted_root.parent / raw_path if raw_path.startswith("aria-tools/") else trusted_root / raw_path
    resolved = candidate.resolve()
    try:
        resolved.relative_to(trusted_root)
        return resolved, None
    except ValueError:
        pass
    if allow_workspace_path and workspace_root is not None:
        workspace = Path(workspace_root).resolve()
        try:
            resolved.relative_to(workspace)
            return resolved, None
        except ValueError:
            pass
    return None, {"code": "proof_artifact_path_escape"}


def is_self_output_path(path: str) -> bool:
    normalized = _normalize_posix_path(path)
    return normalized.startswith(SELF_OUTPUT_PATH_PREFIXES)


def verify_retention_event_structure(row: Any) -> list[dict[str, Any]]:
    if not isinstance(row, dict):
        return [{"code": "retention_event_not_object"}]
    issues: list[dict[str, Any]] = []
    kind = str(row.get("kind") or row.get("event") or row.get("event_type") or "").strip()
    if not kind:
        issues.append({"code": "retention_event_kind_missing"})
        return issues
    if row.get("schema_version") not in (1, "1"):
        issues.append({"code": "retention_event_schema_version_invalid", "event": kind})
    if kind in {"retention_apply", "cycle_artifact_archived", "artifact_archived"}:
        _require_string(row, "artifact_id", issues, "retention_event_artifact_id_missing")
        _require_string(row, "original_path", issues, "retention_event_original_path_missing")
        _require_string(row, "new_path", issues, "retention_event_new_path_missing")
        _require_hash(row, issues, "retention_event_hash_invalid")
        _require_string(row, "reason", issues, "retention_event_reason_missing")
        _require_string(row, "operator_approval_ref", issues, "retention_event_operator_approval_missing")
        if row.get("reviewed") is not True:
            issues.append({"code": "retention_event_review_missing", "event": kind})
    elif kind == "artifact_restored":
        _require_string(row, "artifact_id", issues, "retention_event_artifact_id_missing")
        _require_string(row, "path", issues, "retention_event_path_missing")
        _require_hash(row, issues, "retention_event_hash_invalid")
        _require_string(row, "reason", issues, "retention_event_reason_missing")
        _require_string(row, "operator_approval_ref", issues, "retention_event_operator_approval_missing")
    elif kind in {"rollback", "retention_rollback"}:
        if not (row.get("manifest_id") or row.get("manifest_path")):
            issues.append({"code": "unknown_manifest_rollback", "details": row})
        _require_string(row, "reason", issues, "retention_event_reason_missing")
        _require_string(row, "operator_approval_ref", issues, "retention_event_operator_approval_missing")
    return issues


def verify_retention_event_content(
    row: Any,
    *,
    trusted_root: str | Path,
) -> list[dict[str, Any]]:
    issues = verify_retention_event_structure(row)
    if not isinstance(row, dict):
        return issues
    kind = str(row.get("kind") or row.get("event") or row.get("event_type") or "").strip()
    if kind not in {"retention_apply", "cycle_artifact_archived", "artifact_archived", "artifact_restored"}:
        return issues
    expected = normalize_sha256(row.get("sha256") or row.get("hash") or row.get("content_hash"))
    if expected is None:
        issues.append({"code": "retention_event_hash_invalid"})
        return issues
    path_key = "new_path" if kind in {"retention_apply", "cycle_artifact_archived", "artifact_archived"} else "path"
    candidate = row.get(path_key)
    if not isinstance(candidate, str) or not candidate.strip():
        issues.append({"code": "retention_event_archive_path_missing", "field": path_key})
        return issues
    resolved, path_issue = resolve_artifact_ref_path(
        candidate,
        root=trusted_root,
        allow_workspace_path=False,
    )
    if path_issue is not None or resolved is None:
        issues.append({"code": "retention_event_path_escape", "path": candidate})
        return issues
    if not resolved.exists() or not resolved.is_file():
        issues.append({"code": "retention_event_archive_missing", "path": candidate})
        return issues
    actual = recompute_artifact_hash(resolved)
    if actual != expected:
        issues.append({"code": "retention_event_hash_mismatch", "expected": expected, "actual": actual})
    return issues


def verify_workflow_dlp_token_evidence(
    payload: Any,
    *,
    expected_token_source: str | None = None,
    expected_workflow_hash: str | None = None,
    expected_contract_hash: str | None = None,
    expected_network_policy: tuple[str, ...] | list[str] | None = None,
    expected_runtime_write_paths: tuple[str, ...] | list[str] | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return [{"code": "workflow_proof_not_object"}]
    issues: list[dict[str, Any]] = []
    if payload.get("schema_version") != 1:
        issues.append({"code": "workflow_proof_schema_version_invalid"})
    if payload.get("valid") is not True:
        issues.append({"code": "workflow_proof_not_valid"})
    if payload.get("dlp_scan_clean") is not True:
        issues.append({"code": "workflow_proof_dlp_not_clean"})
    token = str(payload.get("token_provenance") or "").strip()
    if not token:
        issues.append({"code": "workflow_proof_token_provenance_missing"})
    elif expected_token_source is not None and token != expected_token_source:
        issues.append(
            {
                "code": "workflow_proof_token_provenance_mismatch",
                "expected": expected_token_source,
                "actual": token,
            }
        )
    _check_hash_field(payload, "workflow_hash", expected_workflow_hash, issues, "workflow_proof_workflow_hash")
    _check_hash_field(payload, "contract_hash", expected_contract_hash, issues, "workflow_proof_contract_hash")

    network = _string_tuple(payload.get("network_policy"))
    if not network:
        issues.append({"code": "workflow_proof_network_policy_missing"})
    elif expected_network_policy is not None and tuple(sorted(network)) != tuple(sorted(expected_network_policy)):
        issues.append({"code": "workflow_proof_network_policy_mismatch", "actual": network})

    runtime_paths = _string_tuple(payload.get("runtime_write_paths"))
    if not runtime_paths:
        issues.append({"code": "workflow_proof_runtime_write_paths_missing"})
    elif expected_runtime_write_paths is not None and tuple(sorted(runtime_paths)) != tuple(sorted(expected_runtime_write_paths)):
        issues.append({"code": "workflow_proof_runtime_write_paths_mismatch", "actual": runtime_paths})
    return issues


def _with_source(issues: list[dict[str, Any]], source: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not source:
        return issues
    return [{**issue, "source": source} if "source" not in issue else issue for issue in issues]


def _normalize_posix_path(path: str) -> str:
    parts: list[str] = []
    for part in str(path).replace("\\", "/").split("/"):
        if part in {"", "."}:
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return "/".join(parts)


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _require_string(row: dict[str, Any], key: str, issues: list[dict[str, Any]], code: str) -> None:
    if not isinstance(row.get(key), str) or not str(row.get(key)).strip():
        issues.append({"code": code, "field": key})


def _require_hash(row: dict[str, Any], issues: list[dict[str, Any]], code: str) -> None:
    if normalize_sha256(row.get("sha256")) is None:
        issues.append({"code": code, "field": "sha256"})


def _check_hash_field(
    payload: dict[str, Any],
    key: str,
    expected: str | None,
    issues: list[dict[str, Any]],
    code_prefix: str,
) -> None:
    value = normalize_sha256(payload.get(key))
    if value is None:
        issues.append({"code": f"{code_prefix}_invalid", "field": key})
        return
    expected_hash = normalize_sha256(expected) if expected is not None else None
    if expected is not None and expected_hash != value:
        issues.append({"code": f"{code_prefix}_mismatch", "expected": expected_hash, "actual": value})


def _string_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(str(item).strip() for item in value if isinstance(item, str) and item.strip())


__all__ = [
    "TRUSTED_PROOF_SOURCE_SURFACES",
    "UNTRUSTED_PROOF_SOURCE_SURFACES",
    "declared_source_surfaces",
    "is_self_output_path",
    "normalize_sha256",
    "recompute_artifact_hash",
    "resolve_artifact_ref_path",
    "source_surface_issues",
    "verify_hash_bound_artifact_ref",
    "verify_retention_event_structure",
    "verify_workflow_dlp_token_evidence",
]
