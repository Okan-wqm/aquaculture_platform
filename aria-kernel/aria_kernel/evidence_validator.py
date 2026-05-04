from __future__ import annotations

from pathlib import Path
from typing import Any

from .tool_health import SELF_OUTPUT_MARKERS, find_scope_violations, normalize_path
from .snapshot import snapshot_allowed_set


def validate_tool_output_evidence(
    tool: dict[str, Any],
    output: dict[str, Any],
    workspace_root: str | Path,
    repo_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    root = Path(workspace_root).resolve()
    errors: list[dict[str, Any]] = []
    checked_sources: list[str] = []
    allowed_paths = snapshot_allowed_set(repo_snapshot)

    read_paths = output.get("read_paths", [])
    if isinstance(read_paths, list):
        for path in read_paths:
            normalized = normalize_path(path)
            if allowed_paths and normalized not in allowed_paths:
                errors.append({"code": "read_path_outside_snapshot", "path": normalized})
    else:
        errors.append({"code": "read_paths_not_array"})

    findings = output.get("findings", [])
    if isinstance(findings, list):
        for finding in findings:
            if not isinstance(finding, dict):
                continue
            evidence = finding.get("evidence")
            if not isinstance(evidence, list) or not evidence:
                errors.append(
                    {
                        "code": "finding_evidence_missing",
                        "finding_id": finding.get("id"),
                    },
                )
                continue
            for ref in evidence:
                validate_evidence_ref(tool, root, ref, errors, checked_sources, allowed_paths=allowed_paths)

    sources = output.get("evidence_sources", [])
    if isinstance(sources, list):
        for source in sources:
            validate_evidence_path(tool, root, source, None, errors, checked_sources, allowed_paths=allowed_paths)
    else:
        errors.append({"code": "evidence_sources_not_array"})

    self_output = any(
        normalize_path(error.get("path", "")).startswith(SELF_OUTPUT_MARKERS)
        for error in errors
    )
    return {
        "valid": not errors,
        "errors": errors,
        "checked_sources": sorted(set(checked_sources)),
        "self_output_evidence": self_output,
    }


def validate_evidence_ref(
    tool: dict[str, Any],
    root: Path,
    ref: Any,
    errors: list[dict[str, Any]],
    checked_sources: list[str],
    allowed_paths: set[str] | None = None,
) -> None:
    if not isinstance(ref, dict) or not isinstance(ref.get("path"), str):
        errors.append({"code": "invalid_evidence_ref"})
        return
    line = ref.get("line")
    validate_evidence_path(tool, root, ref["path"], line, errors, checked_sources, allowed_paths=allowed_paths)


def validate_evidence_path(
    tool: dict[str, Any],
    root: Path,
    raw_path: Any,
    line: Any,
    errors: list[dict[str, Any]],
    checked_sources: list[str],
    allowed_paths: set[str] | None = None,
) -> None:
    path = normalize_path(raw_path)
    checked_sources.append(path)

    if allowed_paths and path not in allowed_paths:
        errors.append({"code": "evidence_outside_snapshot", "path": path})
        return
    if any(path.startswith(marker) for marker in SELF_OUTPUT_MARKERS):
        errors.append({"code": "self_output_evidence", "path": path})
        return
    scope_violations = find_scope_violations(tool, [path])
    if scope_violations:
        errors.append({"code": "evidence_scope_violation", "path": path})
        return

    absolute = (root / path).resolve()
    try:
        absolute.relative_to(root)
    except ValueError:
        errors.append({"code": "evidence_path_escapes_workspace", "path": path})
        return
    if not absolute.exists() or not absolute.is_file():
        errors.append({"code": "evidence_path_missing", "path": path})
        return
    if line is None:
        return
    if not isinstance(line, int) or line <= 0:
        errors.append({"code": "evidence_line_invalid", "path": path, "line": line})
        return
    line_count = len(absolute.read_text(encoding="utf-8", errors="replace").splitlines())
    if line > line_count:
        errors.append({"code": "evidence_line_missing", "path": path, "line": line})
