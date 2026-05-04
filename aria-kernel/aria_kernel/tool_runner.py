from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from .evidence_validator import validate_tool_output_evidence
from .snapshot import build_repo_snapshot, ignored_dirty_path, normalize_path, snapshot_allowed_set
from .tool_health import can_emit_operator_facing, find_scope_violations, record_run
from .tool_registry import GovernanceError, get_tool


MINIMUM_OUTPUT_FIELDS = ("observations", "findings", "read_paths", "evidence_sources")
RAW_SAMPLE_LIMIT = 50


def run_tool(
    tool_id: str,
    input_payload: Any,
    cycle_id: str,
    run_id: str | None = None,
    workspace_root: str | os.PathLike[str] | None = None,
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    tool = get_tool(tool_id, base_dir)
    if tool["status"] == "QUARANTINED":
        raise GovernanceError("QUARANTINED tool cannot be run by the normal runner")
    runner = tool.get("runner")
    if not runner:
        raise GovernanceError(f"tool has no runner configuration: {tool_id}")
    if runner.get("type") != "subprocess":
        raise GovernanceError(f"unsupported runner type: {runner.get('type')}")

    root = Path(workspace_root or os.getcwd()).resolve()
    repo_snapshot = _input_repo_snapshot(input_payload)
    if repo_snapshot is None:
        repo_snapshot = build_repo_snapshot(workspace_root=root, mode="working-tree", enforce_clean=False)
    repo_snapshot = _snapshot_for_tool(tool, repo_snapshot)
    if isinstance(input_payload, dict):
        input_payload = {**input_payload, "repo_snapshot": repo_snapshot}
    cwd = (root / runner["cwd"]).resolve()
    try:
        cwd.relative_to(root)
    except ValueError as exc:
        raise GovernanceError("runner.cwd must stay within workspace root") from exc
    if not cwd.exists() or not cwd.is_dir():
        raise GovernanceError(f"runner.cwd does not exist: {runner['cwd']}")

    input_bytes = _canonical_json_bytes(input_payload)
    before = _workspace_snapshot(root)
    started = time.monotonic()
    stdout = ""
    stderr = ""
    exit_code: int | None = None
    timed_out = False
    status = "ok"
    output: dict[str, Any] | None = None

    try:
        completed = subprocess.run(
            runner["argv"],
            cwd=cwd,
            input=input_bytes.decode("utf-8") if runner.get("stdin_json") else None,
            capture_output=True,
            text=True,
            timeout=runner["timeout_ms"] / 1000,
            shell=False,
        )
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        exit_code = completed.returncode
        if completed.returncode != 0:
            status = "crash"
        else:
            output = _parse_tool_output(stdout, tool)
            if output is None:
                status = "schema_error"
    except subprocess.TimeoutExpired as exc:
        stdout = _decode_timeout_stream(exc.stdout)
        stderr = _decode_timeout_stream(exc.stderr)
        timed_out = True
        status = "budget_exceeded"
    except OSError as exc:
        stderr = str(exc)
        status = "crash"

    duration_ms = int(round((time.monotonic() - started) * 1000))
    after = _workspace_snapshot(root)
    mutated = before != after

    if output is None:
        output = {}
    evidence_validation = {
        "evidence_sources": _array_or_empty(output.get("evidence_sources")),
        "repository_mutation_attempt": mutated,
    }
    if status == "ok":
        evidence_validation.update(validate_tool_output_evidence(tool, output, root, repo_snapshot=repo_snapshot))
        memory_errors = _memory_candidate_snapshot_errors(output.get("belief_candidates", []), repo_snapshot)
        if memory_errors:
            evidence_validation.setdefault("errors", [])
            evidence_validation["errors"].extend(memory_errors)
            evidence_validation["valid"] = False
        evidence_validation["repository_mutation_attempt"] = mutated
    raw_observations = output.get("observations", [])
    raw_findings = output.get("findings", [])
    memory_candidates = _array_or_empty(output.get("belief_candidates"))
    can_emit = can_emit_operator_facing(tool_id, base_dir=base_dir)
    envelope = {
        "schema_version": 1,
        "run_id": run_id or str(uuid.uuid4()),
        "tool_id": tool_id,
        "cycle_id": cycle_id,
        "status": status,
        "input_hash": _sha256(input_bytes),
        "output_hash": _sha256(stdout.encode("utf-8")),
        "read_paths": _array_or_empty(output.get("read_paths")),
        "emitted_observations": _array_or_empty(raw_observations) if can_emit else [],
        "emitted_findings": _array_or_empty(raw_findings) if can_emit else [],
        "raw_findings": _array_or_empty(raw_findings),
        "evidence_validation": evidence_validation,
        "operator_feedback_refs": [],
        "memory_candidates": _valid_memory_candidates(memory_candidates, tool_id),
        "duration_ms": duration_ms,
        "cost_units": _non_negative_number(output.get("cost_units"), default=0),
        "runner": {
            "type": runner["type"],
            "exit_code": exit_code,
            "timed_out": timed_out,
            "stderr_hash": _sha256(stderr.encode("utf-8")),
            "raw_observations_count": len(_array_or_empty(raw_observations)),
            "raw_findings_count": len(_array_or_empty(raw_findings)),
            "raw_findings_sample": _raw_finding_sample(_array_or_empty(raw_findings)),
        },
        "repo_snapshot": _compact_snapshot(repo_snapshot),
    }
    return record_run(envelope, base_dir=base_dir)


def _input_repo_snapshot(input_payload: Any) -> dict[str, Any] | None:
    if isinstance(input_payload, dict) and isinstance(input_payload.get("repo_snapshot"), dict):
        return input_payload["repo_snapshot"]
    return None


def _compact_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": snapshot.get("schema_version", 1),
        "snapshot_mode": snapshot.get("snapshot_mode"),
        "repo_state_id": snapshot.get("repo_state_id"),
        "snapshot_hash": snapshot.get("snapshot_hash"),
        "dirty_snapshot": snapshot.get("dirty_snapshot", False),
        "tracked_file_count": snapshot.get("tracked_file_count"),
    }


def _snapshot_for_tool(tool: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    allowed = snapshot.get("allowed_paths")
    if not isinstance(allowed, list):
        return snapshot
    filtered = [path for path in allowed if isinstance(path, str) and not find_scope_violations(tool, [path])]
    narrowed = dict(snapshot)
    narrowed["allowed_paths"] = sorted(filtered)
    narrowed["tool_scope_path_count"] = len(filtered)
    return narrowed


def _memory_candidate_snapshot_errors(candidates: Any, repo_snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(candidates, list):
        return []
    allowed = snapshot_allowed_set(repo_snapshot)
    if not allowed:
        return []
    errors = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        for ref in _array_or_empty(candidate.get("evidence_refs")):
            if not isinstance(ref, str) or _is_glob_ref(ref):
                continue
            normalized = ref.replace("\\", "/")
            if normalized not in allowed:
                errors.append(
                    {
                        "code": "memory_evidence_outside_snapshot",
                        "belief_id": candidate.get("belief_id"),
                        "path": normalized,
                    },
                )
    return errors


def _is_glob_ref(ref: str) -> bool:
    return any(char in ref for char in "*?[]")


def _parse_tool_output(stdout: str, tool: dict[str, Any]) -> dict[str, Any] | None:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    required = set(MINIMUM_OUTPUT_FIELDS)
    required.update(tool.get("output_schema", {}).get("required", []))
    for field in required:
        if field not in payload:
            return None
    for field in MINIMUM_OUTPUT_FIELDS:
        if not isinstance(payload.get(field), list):
            return None
    if "cost_units" in payload and _non_negative_number(payload["cost_units"], default=None) is None:
        return None
    if "metadata" in payload and not isinstance(payload["metadata"], dict):
        return None
    if "belief_candidates" in payload and not isinstance(payload["belief_candidates"], list):
        return None
    return payload


def _workspace_snapshot(root: Path) -> Any:
    git_dir = root / ".git"
    if git_dir.exists():
        completed = subprocess.run(
            ["git", "status", "--porcelain", "-z"],
            cwd=root,
            capture_output=True,
            check=False,
        )
        if completed.returncode == 0:
            return ("git", _normalized_git_status(completed.stdout))
    return ("dir", _directory_snapshot(root))


def _normalized_git_status(stdout: bytes) -> tuple[str, ...]:
    entries = [entry.decode("utf-8", errors="replace") for entry in stdout.split(b"\0") if entry]
    paths: list[str] = []
    skip_next = False
    for entry in entries:
        if skip_next:
            skip_next = False
            continue
        status = entry[:2]
        path = entry[3:] if len(entry) > 3 else entry
        if status.startswith("R") or status.startswith("C"):
            skip_next = True
        normalized = normalize_path(path)
        if normalized and not ignored_dirty_path(normalized):
            paths.append(f"{status} {normalized}")
    return tuple(sorted(paths))


def _directory_snapshot(root: Path) -> dict[str, tuple[int, str]]:
    snapshot: dict[str, tuple[int, str]] = {}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            stat = path.stat()
            relative = path.relative_to(root).as_posix()
            snapshot[relative] = (stat.st_size, _sha256(path.read_bytes()))
        except OSError:
            continue
    return snapshot


def _canonical_json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha256(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _array_or_empty(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _non_negative_number(value: Any, *, default: int | None) -> int | float | None:
    if value is None:
        return default
    if isinstance(value, (int, float)) and value >= 0:
        return value
    return None


def _valid_memory_candidates(candidates: list[Any], tool_id: str) -> list[dict[str, Any]]:
    valid = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        belief_id = candidate.get("belief_id")
        claim = candidate.get("claim")
        confidence = _non_negative_number(candidate.get("confidence"), default=None)
        evidence_refs = candidate.get("evidence_refs")
        if (
            not isinstance(belief_id, str)
            or not belief_id.strip()
            or not isinstance(claim, str)
            or not claim.strip()
            or confidence is None
            or not isinstance(evidence_refs, list)
        ):
            continue
        valid.append(
            {
                "belief_id": belief_id,
                "claim": claim,
                "confidence": min(float(confidence), 1.0),
                "evidence_refs": [str(ref) for ref in evidence_refs if isinstance(ref, str) and ref.strip()],
                "source_tool_id": str(candidate.get("source_tool_id") or tool_id),
            },
        )
    return valid


def _raw_finding_sample(findings: list[Any]) -> list[dict[str, Any]]:
    sample = []
    for finding in findings[:RAW_SAMPLE_LIMIT]:
        if isinstance(finding, dict):
            sample.append(finding)
    return sample


def _decode_timeout_stream(value: bytes | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value
