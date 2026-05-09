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
from .runtime_profile import enforce_profile_for_write
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
    # Plan 020 Phase 1.B — runtime profile write gate (single chokepoint).
    # Why: every adapter / spine_orchestrator invocation routes through
    # run_tool, and each invocation appends to runs.jsonl. Frozen profile
    # forbids tool-run writes; observe profile blocks all tool runs since
    # adapters mutate scan output beyond observation class. Gating at the
    # top of run_tool is the single chokepoint that covers Phase 4 spine
    # orchestrator + Phase 10 agent-harness-security adapter + every
    # backend adapter without each call site having to remember the gate.
    enforce_profile_for_write("tool_runs", base_dir=base_dir)
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
    before = _workspace_snapshot(root, tool)
    # Plan 022 §C-5 — capture an unfiltered raw snapshot alongside the
    # scoped view. The pre-fix mutation comparison ran on the
    # tool-scope-filtered status output, so a buggy/malicious adapter
    # mutating files OUTSIDE its declared scope (package.json, CI
    # configs, registry.json) was invisible. Raw snapshots let us
    # partition the diff into scoped vs scope_out mutations and surface
    # the latter as a hard quarantine signal.
    before_raw = _workspace_snapshot_raw(root)
    started = time.monotonic()
    stdout = ""
    stderr = ""
    exit_code: int | None = None
    timed_out = False
    status = "ok"
    output: dict[str, Any] | None = None
    # Plan 023 v3 §C-2 — runner envelope carries the specific parse
    # error code so observability sees the field-level reason instead
    # of a generic "schema_error" status. Default None (parser
    # succeeded or did not run); populated with codes from
    # PARSE_ERROR_CODES on rejection.
    parse_error: str | None = None

    try:
        if _runner_missing_node_deps(cwd, runner["argv"]):
            stderr = "missing repo-local node dependency: node_modules/ts-node/dist/bin.js"
            status = "tool_unhealthy"
            exit_code = None
            output = {}
        else:
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
                output, parse_error = _parse_tool_output(stdout, tool)
                if output is None:
                    status = "schema_error"
    except subprocess.TimeoutExpired as exc:
        stdout = _decode_timeout_stream(exc.stdout)
        stderr = _decode_timeout_stream(exc.stderr)
        timed_out = True
        status = "budget_exceeded"
    except OSError as exc:
        stderr = str(exc)
        status = "tool_unhealthy" if getattr(exc, "filename", None) else "crash"

    duration_ms = int(round((time.monotonic() - started) * 1000))
    after = _workspace_snapshot(root, tool)
    after_raw = _workspace_snapshot_raw(root)
    # Plan 022 §C-5 — partition every mutated path into scoped vs
    # scope-out using the raw before/after. `mutated` retains its
    # original semantic for backward-compat with downstream consumers
    # that only care whether ANY files changed.
    scoped_mutations, scope_out_mutations = _partition_mutations(
        before_raw=before_raw, after_raw=after_raw, tool=tool,
    )
    mutated = before != after or bool(scope_out_mutations)

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
            "stderr_sample": stderr[:4096],
            "raw_observations_count": len(_array_or_empty(raw_observations)),
            "raw_findings_count": len(_array_or_empty(raw_findings)),
            "raw_findings_sample": _raw_finding_sample(_array_or_empty(raw_findings)),
            # Plan 022 §C-5 — partitioned mutation lists.
            # scoped_mutations: paths inside the tool's declared scope
            # (expected/permitted writes). scope_out_mutations: writes
            # outside the declared scope — a hard signal that the
            # adapter exceeded its sandbox. tool_health.record_run
            # treats non-empty scope_out_mutations as a quarantine
            # trigger via the immediate_quarantine_reason path.
            "scoped_mutations": list(scoped_mutations),
            "scope_out_mutations": list(scope_out_mutations),
            # Plan 023 v3 §C-2 — specific parser rejection code, or None
            # when the parser succeeded. Closed vocabulary listed in
            # PARSE_ERROR_CODES (plus dynamic missing_field:<f> /
            # field_not_list:<f> shapes for minimum-output fields).
            "parse_error": parse_error,
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
        "file_counts": snapshot.get("file_counts", {}),
        "tracked_file_count": snapshot.get("tracked_file_count"),
        "legacy_tracked_file_count": snapshot.get("legacy_tracked_file_count", snapshot.get("tracked_file_count")),
        "tool_scope_allowed_count": snapshot.get("tool_scope_allowed_count"),
        "tool_scope_path_count": snapshot.get("tool_scope_path_count"),
    }


def _snapshot_for_tool(tool: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    allowed = snapshot.get("allowed_paths")
    if not isinstance(allowed, list):
        return snapshot
    filtered = [path for path in allowed if isinstance(path, str) and not find_scope_violations(tool, [path])]
    narrowed = dict(snapshot)
    narrowed["allowed_paths"] = sorted(filtered)
    narrowed["tool_scope_allowed_count"] = len(filtered)
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


# Plan 023 v3 §C-2 — closed error-code vocabulary for tool-output parse
# rejection. Returned in the tuple second slot so the runner envelope
# carries `runner.parse_error = <code>` and observability / operator
# audit see the specific reason instead of a generic "schema_error".
PARSE_ERROR_CODES: frozenset[str] = frozenset({
    "output_not_json",
    "output_not_dict",
    "cost_units_invalid",
    "metadata_not_dict",
    "belief_candidates_not_list",
    # Plus dynamic codes:
    #   missing_field:<field>
    #   field_not_list:<field>
    # produced by the parser when a required minimum-output field is
    # absent or wrong-typed. The closed set above lists the static
    # codes; the dynamic shape is asserted at the caller via prefix.
})


def _parse_tool_output(
    stdout: str, tool: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    """Plan 023 v3 §C-2 — discriminated parse result.

    Pre-Plan-023 this returned `dict | None`; rejection lost the reason.
    Post-fix: `(payload, None)` on success, `(None, error_code)` on
    rejection. The runner-envelope writer carries `runner.parse_error`
    so operators and observability layers see the specific failure
    mode.
    """
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return None, "output_not_json"
    if not isinstance(payload, dict):
        return None, "output_not_dict"
    required = set(MINIMUM_OUTPUT_FIELDS)
    required.update(tool.get("output_schema", {}).get("required", []))
    # Deterministic order for missing-field detection — the caller's
    # `parse_error` then encodes a stable single field name when
    # multiple are missing (the first in sorted order). Stable ordering
    # makes test assertions reliable and reproducible.
    for field in sorted(required):
        if field not in payload:
            return None, f"missing_field:{field}"
    for field in MINIMUM_OUTPUT_FIELDS:
        if not isinstance(payload.get(field), list):
            return None, f"field_not_list:{field}"
    if "cost_units" in payload and _non_negative_number(payload["cost_units"], default=None) is None:
        return None, "cost_units_invalid"
    if "metadata" in payload and not isinstance(payload["metadata"], dict):
        return None, "metadata_not_dict"
    if "belief_candidates" in payload and not isinstance(payload["belief_candidates"], list):
        return None, "belief_candidates_not_list"
    return payload, None


def _workspace_snapshot(root: Path, tool: dict[str, Any] | None = None) -> Any:
    git_dir = root / ".git"
    if git_dir.exists():
        completed = subprocess.run(
            ["git", "status", "--porcelain", "-z"],
            cwd=root,
            capture_output=True,
            check=False,
        )
        if completed.returncode == 0:
            return ("git", _normalized_git_status(completed.stdout, tool))
    return ("dir", _directory_snapshot(root))


def _workspace_snapshot_raw(root: Path) -> Any:
    """Plan 022 §C-5 — unfiltered workspace snapshot.

    Mirrors _workspace_snapshot but does NOT apply the tool-scope
    filter. The raw view is the load-bearing input for scope-out
    mutation detection: comparing before_raw vs after_raw catches
    every mutation regardless of declared scope.
    """
    git_dir = root / ".git"
    if git_dir.exists():
        completed = subprocess.run(
            ["git", "status", "--porcelain", "-z"],
            cwd=root,
            capture_output=True,
            check=False,
        )
        if completed.returncode == 0:
            return ("git", _normalized_git_status_raw(completed.stdout))
    return ("dir", _directory_snapshot(root))


def _normalized_git_status_raw(stdout: bytes) -> tuple[str, ...]:
    """Like _normalized_git_status but never applies the tool-scope filter."""
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


def _partition_mutations(
    *,
    before_raw: Any,
    after_raw: Any,
    tool: dict[str, Any] | None,
) -> tuple[list[str], list[str]]:
    """Plan 022 §C-5 — partition raw mutation diff into scoped vs scope-out.

    Both before_raw and after_raw are the tuple-shaped output of
    _workspace_snapshot_raw. The diff is the symmetric difference
    interpreted as path-string set; partitioning applies the tool's
    allowed_read_globs / declared_scope via find_scope_violations.

    Returns (scoped, scope_out) lists sorted for stable envelope shape.
    """
    if before_raw == after_raw:
        return [], []
    before_set = set(before_raw[1] if isinstance(before_raw, tuple) and len(before_raw) > 1 else ())
    after_set = set(after_raw[1] if isinstance(after_raw, tuple) and len(after_raw) > 1 else ())
    diff = sorted(before_set ^ after_set)
    scoped: list[str] = []
    scope_out: list[str] = []
    for entry in diff:
        # entry shape from _normalized_git_status_raw mirrors git status
        # --porcelain output: "<2-char status><space><path>". Strip the
        # 3-char prefix to recover the path; fall back to the rsplit
        # result for any unexpected shape.
        if len(entry) > 3 and entry[2] == " ":
            path = entry[3:]
        else:
            path = entry.rsplit(" ", 1)[-1]
        if _mutation_path_in_tool_scope(tool, path):
            scoped.append(entry)
        else:
            scope_out.append(entry)
    return scoped, scope_out


def _normalized_git_status(stdout: bytes, tool: dict[str, Any] | None = None) -> tuple[str, ...]:
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
        if normalized and not ignored_dirty_path(normalized) and _mutation_path_in_tool_scope(tool, normalized):
            paths.append(f"{status} {normalized}")
    return tuple(sorted(paths))


def _mutation_path_in_tool_scope(tool: dict[str, Any] | None, path: str) -> bool:
    if not isinstance(tool, dict):
        return True
    scoped = tool.get("allowed_read_globs") or tool.get("declared_scope")
    if not isinstance(scoped, list) or not scoped:
        return True
    return not find_scope_violations(tool, [path])


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


def _runner_missing_node_deps(cwd: Path, argv: list[str]) -> bool:
    if len(argv) >= 2 and argv[0] == "node" and argv[1] == "./node_modules/ts-node/dist/bin.js":
        return not (cwd / "node_modules" / "ts-node" / "dist" / "bin.js").exists()
    return False
