from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .tool_health import SELF_OUTPUT_MARKERS, find_scope_violations, normalize_path
from .snapshot import snapshot_allowed_set


# Plan 016 Faz C7 — agent response evidence revalidation regex.
# Why a separate path-parser: agent envelopes ship refs as plain strings
# ("apps/foo.ts:42") whereas tool output uses {path, line} dicts. We keep
# the existing dict-based validator unchanged for backward compatibility
# and add a string-aware revalidator below.
_AGENT_REF_RE = re.compile(r"^(?P<path>[^\s:][^\s:]*(?:[^\s:][^\s:]*)*?)(?::(?P<line>\d+))?$")


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
    # Plan 022 §M-2 — capture the normalized read_paths set so finding
    # evidence references can be checked against it. Pre-fix the tool
    # could surface evidence_refs pointing at files it never declared
    # reading; the dispatch path trusted the self-report read_paths
    # without verifying the evidence stayed inside it.
    declared_read_paths: set[str] = set()
    if isinstance(read_paths, list):
        for path in read_paths:
            normalized = normalize_path(path)
            declared_read_paths.add(normalized)
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
                # Plan 022 §M-2 — additionally enforce evidence path is
                # within the tool's declared read_paths. read_paths is
                # the load-bearing self-report for what the adapter
                # actually inspected; an evidence_ref outside this set
                # is a contract violation.
                if isinstance(ref, dict) and isinstance(ref.get("path"), str) and declared_read_paths:
                    norm = normalize_path(ref["path"])
                    if norm not in declared_read_paths:
                        errors.append({
                            "code": "evidence_outside_declared_read_paths",
                            "path": norm,
                            "finding_id": finding.get("id"),
                        })

    sources = output.get("evidence_sources", [])
    if isinstance(sources, list):
        for source in sources:
            validate_evidence_path(tool, root, source, None, errors, checked_sources, allowed_paths=allowed_paths)
            # Plan 022 §M-2 — same subset check for evidence_sources.
            if isinstance(source, str) and declared_read_paths:
                norm = normalize_path(source)
                if norm not in declared_read_paths:
                    errors.append({
                        "code": "evidence_outside_declared_read_paths",
                        "path": norm,
                    })
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


def _parse_agent_ref(ref: str) -> tuple[str, int | None] | None:
    """Parse a string ref like 'path/to/file.ts:42' into (path, line) or None on malformed input."""
    match = _AGENT_REF_RE.match(ref.strip())
    if not match:
        return None
    line = match.group("line")
    return match.group("path"), int(line) if line is not None else None


def _check_agent_ref(
    ref: str,
    *,
    root: Path,
    errors: list[dict[str, Any]],
    checked: list[str],
    allow_self_output: bool = False,
) -> None:
    parsed = _parse_agent_ref(ref)
    if parsed is None:
        errors.append({"code": "agent_evidence_ref_malformed", "ref": ref})
        return
    path, line = parsed
    normalized = normalize_path(path)
    # ARIA self-output / runtime artefacts are NOT admissible evidence
    # for an agent claim (CLAUDE.md L1, Plan 016 §Agent output untrusted).
    if not allow_self_output and normalized.startswith(SELF_OUTPUT_MARKERS):
        errors.append({"code": "agent_evidence_self_output", "path": normalized})
        return
    absolute = (root / path).resolve()
    try:
        absolute.relative_to(root)
    except ValueError:
        errors.append({"code": "agent_evidence_path_escapes_workspace", "path": path})
        return
    if not absolute.exists() or not absolute.is_file():
        errors.append({"code": "agent_evidence_path_missing", "path": path})
        return
    checked.append(normalized)
    if line is None:
        return
    if line <= 0:
        errors.append({"code": "agent_evidence_line_invalid", "path": path, "line": line})
        return
    line_count = len(absolute.read_text(encoding="utf-8", errors="replace").splitlines())
    if line > line_count:
        errors.append({"code": "agent_evidence_line_missing", "path": path, "line": line, "line_count": line_count})


def validate_agent_response_evidence(
    *,
    response: dict[str, Any],
    workspace_root: str | Path,
    request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Re-fetch every evidence ref claimed by an agent response and verify it exists in the repo.

    Why: Plan 016 V-24 — agent output is data, not truth. The contract
    layer (agent_contract.validate_response) checks the SHAPE of the
    satisfaction matrix and the response envelope. This function checks
    that every evidence_ref the agent attached to its verdicts actually
    points at a real file (and line, when given) at the workspace SHA.
    A response that passes both gates is contractually safe to publish
    as a CONVERGED plan / promoted finding.

    Returns: {
        "valid": bool,
        "errors": [{"code": ..., "path": ..., ...}],
        "checked_refs": [<sorted unique paths>],
    }
    """
    root = Path(workspace_root).resolve()
    errors: list[dict[str, Any]] = []
    checked: list[str] = []

    response_refs = response.get("evidence_refs") or []
    if not isinstance(response_refs, list):
        errors.append({"code": "agent_evidence_refs_not_list"})
        response_refs = []
    for ref in response_refs:
        if not isinstance(ref, str) or not ref.strip():
            errors.append({"code": "agent_evidence_ref_not_string"})
            continue
        _check_agent_ref(ref, root=root, errors=errors, checked=checked)

    matrix = response.get("satisfaction_matrix") or []
    if isinstance(matrix, list):
        for entry in matrix:
            if not isinstance(entry, dict):
                continue
            entry_refs = entry.get("evidence_refs") or []
            if not isinstance(entry_refs, list):
                errors.append({"code": "agent_matrix_evidence_refs_not_list", "id": entry.get("id")})
                continue
            for ref in entry_refs:
                if not isinstance(ref, str) or not ref.strip():
                    errors.append(
                        {"code": "agent_matrix_evidence_ref_not_string", "id": entry.get("id")}
                    )
                    continue
                _check_agent_ref(ref, root=root, errors=errors, checked=checked)

    # Cross-check: when a request is provided AND carries a non-empty
    # allowed_scope, every ref the agent claims must either live inside
    # that scope OR be one of the request's evidence_refs (the canonical
    # bounding box). Refs outside the box are rejected as scope leakage.
    #
    # An EMPTY allowed_scope is interpreted as "no scope constraint" —
    # this preserves backward compatibility with legacy
    # aria/agent-invocation-request/v1 rows that pre-date Plan 016.
    # The strict aria/agent-request/v1 envelope's validate_request requires
    # a non-empty allowed_scope, so v3 callers always run the scope check.
    if request is not None:
        allowed_globs = list(request.get("allowed_scope") or [])
        if allowed_globs:
            allowed_request_refs = {
                (_parse_agent_ref(r) or ("", None))[0]
                for r in (request.get("evidence_refs") or [])
                if isinstance(r, str)
            }
            for path in checked:
                if path in allowed_request_refs:
                    continue
                if not _path_matches_any_glob(path, allowed_globs):
                    errors.append(
                        {
                            "code": "agent_evidence_outside_allowed_scope",
                            "path": path,
                            "allowed_scope": allowed_globs,
                        }
                    )

    return {
        "valid": not errors,
        "errors": errors,
        "checked_refs": sorted(set(checked)),
    }


def _path_matches_any_glob(path: str, globs: list[str]) -> bool:
    """Cheap fnmatch-based glob match for `aria-kernel/**` style scope rules."""
    import fnmatch

    for pattern in globs:
        # Translate `dir/**` into `dir/*` for fnmatch (single-level), and try
        # both — operators commonly mean recursive, but fnmatch only does
        # single-segment matching. Recursive emulation: walk parents.
        if fnmatch.fnmatchcase(path, pattern):
            return True
        if pattern.endswith("/**"):
            prefix = pattern[:-3]
            if path == prefix or path.startswith(prefix + "/"):
                return True
        if pattern.endswith("/*"):
            prefix = pattern[:-2]
            head, _, _ = path.rpartition("/")
            if head == prefix:
                return True
    return False
