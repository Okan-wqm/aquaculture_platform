from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import time
from pathlib import Path
from typing import Any, Iterator

from .evidence_validator import validate_tool_output_evidence
from .implementation_safety import BashAllowlistMiss, BashDenylistHit, verify_bash_command_allowed
from .ledger import (
    LEDGER_ROW_MAX_BYTES,
    LedgerIntegrityError,
    LedgerReadLimitError,
    append_declared_jsonl,
    append_jsonl as append_chained_jsonl,
    verify_jsonl_chunks,
)
from .ledger_inline import spill_evidence_validation
from .state_manifest import surface_for_path
from .tool_registry import GovernanceError, ensure_tools_dir, get_tool, utc_now
from .tool_runner import _canonical_json_bytes, _decode_timeout_stream, _parse_tool_output


SEMANTIC_FIXTURE_REQUIRED_TOOLS = {
    "security-boundary-adapter",
    "tenant-scoping-adapter",
    "test-gap-adapter",
}

FIXTURE_RUN_SCHEMA = "aria/agent-eval-fixture-run/v1"
FIXTURE_RUN_LEDGER_MAX_BYTES = 64 * 1024 * 1024
FIXTURE_RUN_LEDGER_MAX_LINE_BYTES = LEDGER_ROW_MAX_BYTES  # ARIA-HIGH-034 / I-V12-LEDGER-02: the reader's cap IS the writer's
FIXTURE_RUN_LEDGER_MAX_ROWS = 100_000
_FIXTURE_RUN_READ_CHUNK_BYTES = 1024 * 1024
_FIXTURE_RUN_SURFACE = "agent_eval_fixture_runs"
_FIXTURE_RUN_STORED_KEYS = frozenset({
    "$schema",
    "schema_version",
    "row_type",
    "at",
    "tool_id",
    "tool_version",
    "tool_manifest_hash",
    "fixture_set_hash",
    "cycle_id",
    "fixture_set",
    "passed",
    "case_count",
    "fixture_lanes",
    "fixture_baseline_passed",
    "semantic_fixture_passed",
    "failed_cases",
    "cases",
    "execution_run_id",
    "actual_status",
    "error_code",
    "evidence_hash",
    "previous_ledger_hash",
    "ledger_hash",
})


def fixture_runs_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "fixture-runs.jsonl"


def run_fixture_suite(
    tool_id: str,
    *,
    workspace_root: str | os.PathLike[str],
    cycle_id: str,
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    tool = get_tool(tool_id, base_dir)
    fixture_dir = resolve_fixture_dir(tool, base_dir, workspace_root=workspace_root)
    cases_dir = fixture_dir / "cases"
    if not cases_dir.exists() or not cases_dir.is_dir():
        raise GovernanceError(f"fixture cases directory does not exist: {cases_dir}")

    case_results = []
    for case_path in sorted(cases_dir.glob("*.json")):
        case = read_json(case_path)
        if not isinstance(case, dict):
            raise GovernanceError(f"fixture case must be a JSON object: {case_path}")
        case_results.append(run_fixture_case(tool, case, case_path, fixture_dir, workspace_root))

    # Plan 023 v3 §A-7 — empty case_results is NOT a pass. Pre-fix
    # `all([]) is True` so an empty fixture suite was reported as
    # passed. Post-fix: explicit bool(case_results) gates the pass
    # decision; empty suite produces actual_status='error_no_cases'.
    has_cases = bool(case_results)
    passed = has_cases and all(case["passed"] for case in case_results)
    lane_counts = _fixture_lane_counts(case_results)

    # Plan 023 v3 §A-1 — suite-level provenance fields. execution_run_id
    # is a UUIDv7 issued at this exact run; downstream genesis-sandbox
    # provenance check joins on this ID against fixture-runs.jsonl so
    # a fabricated dict can no longer claim a fictional run.
    import uuid as _uuid
    execution_run_id = f"exec-{_uuid.uuid4().hex[:24]}"

    # Plan 023 v3 §A-1 — actual_status enum derivation:
    #   error_no_cases : empty suite (caught above).
    #   pass           : has cases AND all passed.
    #   fail           : has cases AND ≥1 case failed (no exception).
    #   error          : runtime exception path (not reachable in this
    #                    function — the parent caller traps subprocess
    #                    errors and writes a separate envelope).
    if not has_cases:
        actual_status = "error_no_cases"
        error_code: str | None = "no_cases_in_fixture_dir"
    elif passed:
        actual_status = "pass"
        error_code = None
    else:
        actual_status = "fail"
        error_code = None

    base_summary: dict[str, Any] = {
        "$schema": FIXTURE_RUN_SCHEMA,
        "schema_version": 1,
        # Plan 023 v3 §A-1 — explicit row_type so reader helpers can
        # discriminate suite rows from append-only legacy backfill rows.
        "row_type": "fixture_run_suite",
        "at": utc_now(),
        "tool_id": tool_id,
        "tool_version": tool.get("version"),
        "tool_manifest_hash": tool_manifest_hash(tool),
        "fixture_set_hash": fixture_set_hash(fixture_dir),
        "cycle_id": cycle_id,
        "fixture_set": tool["fixture_set"],
        "passed": passed,
        "case_count": len(case_results),
        "fixture_lanes": lane_counts,
        "fixture_baseline_passed": _lane_passed(case_results, "real_repo_baseline"),
        "semantic_fixture_passed": _lane_passed(case_results, "semantic_regression"),
        "failed_cases": [case["name"] for case in case_results if not case["passed"]],
        "cases": case_results,
        "execution_run_id": execution_run_id,
        "actual_status": actual_status,
        "error_code": error_code,
    }
    # Plan 023 v3 §A-1 — evidence_hash binds the suite content. The
    # hash payload EXCLUDES evidence_hash itself (avoids self-reference),
    # at (write timestamp varies per attempt), execution_run_id (the
    # volatile UUID — orthogonal identity), and row_type (file-shape
    # concern, not content).
    summary = dict(base_summary)
    summary["evidence_hash"] = _compute_suite_evidence_hash(base_summary)
    append_declared_jsonl(
        fixture_runs_path(base_dir),
        summary,
        expected_surface="agent_eval_fixture_runs",
    )
    return summary


def _compute_suite_evidence_hash(summary: dict[str, Any]) -> str:
    """Plan 023 v3 §A-1 — canonical evidence hash payload.

    INCLUDED fields (deterministic order via sort_keys at serialization):
      tool_id, tool_version, tool_manifest_hash, fixture_set,
      fixture_set_hash, cycle_id, case_count, passed, actual_status,
      error_code, fixture_lanes, fixture_baseline_passed,
      semantic_fixture_passed, failed_cases, cases.
    EXCLUDED:
      evidence_hash (self-reference), at (volatile timestamp),
      execution_run_id (orthogonal identity), row_type (file shape).
    """
    excluded = {
        "evidence_hash",
        "at",
        "execution_run_id",
        "row_type",
        "schema_version",
        "ledger_hash",
        "previous_ledger_hash",
    }
    payload = {k: v for k, v in summary.items() if k not in excluded}
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def latest_fixture_pass(
    tool_id: str,
    *,
    base_dir: str | os.PathLike[str] | None = None,
) -> bool:
    return latest_fixture_status(tool_id, base_dir=base_dir)["passed"]


def latest_current_fixture_pass(
    tool_id: str,
    *,
    base_dir: str | os.PathLike[str] | None = None,
) -> bool:
    return latest_fixture_status(tool_id, base_dir=base_dir)["current_tool_passed"]


def latest_fixture_status(
    tool_id: str,
    *,
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    rows = load_fixture_runs(tool_id, base_dir=base_dir)
    tool = get_tool(tool_id, base_dir)
    latest = rows[-1] if rows else {}
    version_matches = latest.get("tool_version") == tool.get("version")
    manifest_matches = latest.get("tool_manifest_hash") == tool_manifest_hash(tool)
    fixture_dir = resolve_fixture_dir(tool, base_dir)
    fixture_matches = True if latest and "fixture_set_hash" not in latest else latest.get("fixture_set_hash") == fixture_set_hash(fixture_dir)
    passed = latest.get("passed") is True
    return {
        "passed": passed,
        "current_tool_passed": bool(passed and version_matches and manifest_matches and fixture_matches),
        "tool_version": latest.get("tool_version"),
        "current_tool_version": tool.get("version"),
        "tool_manifest_hash": latest.get("tool_manifest_hash"),
        "current_tool_manifest_hash": tool_manifest_hash(tool),
        "fixture_set_hash": latest.get("fixture_set_hash"),
        "current_fixture_set_hash": fixture_set_hash(fixture_dir),
        "version_matches": version_matches,
        "manifest_matches": manifest_matches,
        "fixture_matches": fixture_matches,
        "fixture_baseline_passed": bool(latest.get("fixture_baseline_passed")),
        "semantic_fixture_passed": bool(latest.get("semantic_fixture_passed")),
        "latest": latest,
    }


def fixture_status_report(
    tool_id: str,
    *,
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    status = latest_fixture_status(tool_id, base_dir=base_dir)
    semantic_required = tool_id in SEMANTIC_FIXTURE_REQUIRED_TOOLS
    blockers = []
    if not status["current_tool_passed"]:
        blockers.append("latest_current_fixture_not_passed")
    if not status["fixture_baseline_passed"]:
        blockers.append("fixture_baseline_not_passed")
    if semantic_required and not status["semantic_fixture_passed"]:
        blockers.append("semantic_fixture_not_passed")
    return {
        "schema_version": 1,
        "tool_id": tool_id,
        "status": "current" if status["current_tool_passed"] else "stale_or_failed",
        "current_tool_passed": status["current_tool_passed"],
        "fixture_baseline_passed": status["fixture_baseline_passed"],
        "semantic_fixture_passed": status["semantic_fixture_passed"],
        "semantic_fixture_required": semantic_required,
        "version_matches": status["version_matches"],
        "manifest_matches": status["manifest_matches"],
        "fixture_matches": status["fixture_matches"],
        "blocked_by": blockers,
        "refresh_command": f"aria-kernel fixture refresh --tool-id {tool_id} --workspace-root . --cycle-id <cycle-id>",
        "latest": status["latest"],
    }


def refresh_fixture_suite(
    tool_id: str,
    *,
    workspace_root: str | os.PathLike[str],
    cycle_id: str,
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    before = latest_fixture_status(tool_id, base_dir=base_dir)
    result = run_fixture_suite(tool_id, workspace_root=workspace_root, cycle_id=cycle_id, base_dir=base_dir)
    after = latest_fixture_status(tool_id, base_dir=base_dir)
    return {
        "schema_version": 1,
        "tool_id": tool_id,
        "cycle_id": cycle_id,
        "before": before,
        "result": result,
        "after": after,
        "status": "current" if after["current_tool_passed"] else "stale_or_failed",
    }


def load_fixture_runs(
    tool_id: str,
    *,
    base_dir: str | os.PathLike[str] | None = None,
) -> list[dict[str, Any]]:
    path = fixture_runs_path(base_dir)
    if not os.path.lexists(path):
        return []
    return _load_verified_fixture_run_ledger(path, tool_id=tool_id)


def _fixture_run_file_identity(value: os.stat_result) -> tuple[int, ...]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _assert_fixture_run_surface_owner(path: Path) -> None:
    try:
        match = surface_for_path(path)
    except ValueError as exc:
        raise LedgerIntegrityError(
            f"fixture_run_surface_ambiguous:{path.as_posix()}",
        ) from exc
    if match is None or match[0].name != _FIXTURE_RUN_SURFACE:
        actual = match[0].name if match is not None else "undeclared"
        raise LedgerIntegrityError(
            "fixture_run_surface_owner_mismatch:"
            f"expected={_FIXTURE_RUN_SURFACE}:actual={actual}:"
            f"path={path.as_posix()}",
        )


def _load_verified_fixture_run_ledger(
    path: Path,
    *,
    tool_id: str,
) -> list[dict[str, Any]]:
    """Stream one stable regular file through bounded chain verification."""
    _assert_fixture_run_surface_owner(path)
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        raise LedgerIntegrityError("fixture_run_nofollow_unavailable")
    try:
        before = os.stat(path, follow_symlinks=False)
    except OSError as exc:
        raise LedgerIntegrityError(
            f"fixture_run_ledger_unavailable:{path.as_posix()}",
        ) from exc
    if not stat.S_ISREG(before.st_mode):
        raise LedgerIntegrityError(
            f"fixture_run_ledger_not_regular:{path.as_posix()}",
        )
    if before.st_size > FIXTURE_RUN_LEDGER_MAX_BYTES:
        raise LedgerReadLimitError(
            f"fixture_run_ledger_too_large:{path.as_posix()}",
        )

    descriptor: int | None = None
    try:
        flags = os.O_RDONLY | nofollow
        flags |= int(getattr(os, "O_CLOEXEC", 0))
        flags |= int(getattr(os, "O_NONBLOCK", 0))
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or _fixture_run_file_identity(opened)
            != _fixture_run_file_identity(before)
        ):
            raise LedgerIntegrityError(
                f"fixture_run_ledger_changed:{path.as_posix()}",
            )

        observed = 0
        matching_rows: list[dict[str, Any]] = []
        row_number = 0

        def chunks() -> Iterator[bytes]:
            nonlocal observed
            while True:
                chunk = os.read(descriptor, _FIXTURE_RUN_READ_CHUNK_BYTES)
                if not chunk:
                    break
                observed += len(chunk)
                if observed > FIXTURE_RUN_LEDGER_MAX_BYTES:
                    raise LedgerReadLimitError(
                        f"fixture_run_ledger_too_large:{path.as_posix()}",
                    )
                if observed > opened.st_size:
                    raise LedgerIntegrityError(
                        f"fixture_run_ledger_changed:{path.as_posix()}",
                    )
                yield chunk

        def admit(row: dict[str, Any]) -> None:
            nonlocal row_number
            row_number += 1
            _validate_fixture_run_row(row, path=path, line=row_number)
            if row["tool_id"] == tool_id:
                matching_rows.append(row)

        verify_jsonl_chunks(
            chunks(),
            source=path,
            expected_size=opened.st_size,
            max_line_bytes=FIXTURE_RUN_LEDGER_MAX_LINE_BYTES,
            max_rows=FIXTURE_RUN_LEDGER_MAX_ROWS,
            expected_surface=_FIXTURE_RUN_SURFACE,
            on_row=admit,
        )

        after = os.fstat(descriptor)
        try:
            current = os.stat(path, follow_symlinks=False)
        except OSError as exc:
            raise LedgerIntegrityError(
                f"fixture_run_ledger_changed:{path.as_posix()}",
            ) from exc
        opened_identity = _fixture_run_file_identity(opened)
        if (
            observed != opened.st_size
            or _fixture_run_file_identity(after) != opened_identity
            or _fixture_run_file_identity(current) != opened_identity
        ):
            raise LedgerIntegrityError(
                f"fixture_run_ledger_changed:{path.as_posix()}",
            )
    except (LedgerIntegrityError, LedgerReadLimitError):
        raise
    except OSError as exc:
        raise LedgerIntegrityError(
            f"fixture_run_ledger_unavailable:{path.as_posix()}",
        ) from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
    return matching_rows


def _fixture_run_schema_error(path: Path, line: int, reason: str) -> None:
    raise LedgerIntegrityError(
        f"fixture_run_schema_rejected:{path.as_posix()}:line={line}:reason={reason}",
    )


def _is_sha256(value: Any) -> bool:
    if not isinstance(value, str) or not value.startswith("sha256:"):
        return False
    digest = value.removeprefix("sha256:")
    return len(digest) == 64 and all(character in "0123456789abcdef" for character in digest)


def _validate_fixture_run_row(row: dict[str, Any], *, path: Path, line: int) -> None:
    keys = frozenset(row)
    unexpected = sorted(keys - _FIXTURE_RUN_STORED_KEYS)
    if unexpected:
        _fixture_run_schema_error(
            path,
            line,
            "unexpected_top_level_fields=" + ",".join(unexpected),
        )
    missing = sorted(_FIXTURE_RUN_STORED_KEYS - keys)
    if missing:
        _fixture_run_schema_error(
            path,
            line,
            "missing_top_level_fields=" + ",".join(missing),
        )

    exact = {
        "$schema": FIXTURE_RUN_SCHEMA,
        "schema_version": 1,
        "row_type": "fixture_run_suite",
    }
    for field, expected in exact.items():
        if type(row.get(field)) is not type(expected) or row.get(field) != expected:
            _fixture_run_schema_error(path, line, f"{field}_invalid")

    for field in (
        "at",
        "tool_id",
        "tool_version",
        "cycle_id",
        "fixture_set",
        "execution_run_id",
    ):
        value = row.get(field)
        if type(value) is not str or not value.strip():
            _fixture_run_schema_error(path, line, f"{field}_invalid")
    for field in (
        "tool_manifest_hash",
        "fixture_set_hash",
        "evidence_hash",
        "ledger_hash",
    ):
        if not _is_sha256(row.get(field)):
            _fixture_run_schema_error(path, line, f"{field}_invalid")
    previous_hash = row.get("previous_ledger_hash")
    if previous_hash is not None and not _is_sha256(previous_hash):
        _fixture_run_schema_error(path, line, "previous_ledger_hash_invalid")
    for field in (
        "passed",
        "fixture_baseline_passed",
        "semantic_fixture_passed",
    ):
        if type(row.get(field)) is not bool:
            _fixture_run_schema_error(path, line, f"{field}_invalid")

    case_count = row.get("case_count")
    cases = row.get("cases")
    if type(case_count) is not int or case_count < 0:
        _fixture_run_schema_error(path, line, "case_count_invalid")
    if type(cases) is not list or any(type(case) is not dict for case in cases):
        _fixture_run_schema_error(path, line, "cases_invalid")
    if case_count != len(cases):
        _fixture_run_schema_error(path, line, "case_count_mismatch")

    lanes = row.get("fixture_lanes")
    if type(lanes) is not dict or any(
        type(lane) is not str
        or not lane
        or type(count) is not int
        or count < 0
        for lane, count in lanes.items()
    ):
        _fixture_run_schema_error(path, line, "fixture_lanes_invalid")
    failed_cases = row.get("failed_cases")
    if type(failed_cases) is not list or any(
        type(name) is not str or not name
        for name in failed_cases
    ):
        _fixture_run_schema_error(path, line, "failed_cases_invalid")

    actual_status = row.get("actual_status")
    if actual_status not in {"pass", "fail", "error", "error_no_cases"}:
        _fixture_run_schema_error(path, line, "actual_status_invalid")
    if (row["passed"] is True) != (actual_status == "pass"):
        _fixture_run_schema_error(path, line, "passed_status_mismatch")
    error_code = row.get("error_code")
    if error_code is not None and (
        type(error_code) is not str or not error_code.strip()
    ):
        _fixture_run_schema_error(path, line, "error_code_invalid")

    if row["evidence_hash"] != _compute_suite_evidence_hash(row):
        _fixture_run_schema_error(path, line, "evidence_hash_mismatch")


def run_fixture_case(
    tool: dict[str, Any],
    case: dict[str, Any],
    case_path: Path,
    fixture_dir: Path,
    default_workspace_root: str | os.PathLike[str],
) -> dict[str, Any]:
    name = str(case.get("name") or case_path.stem)
    lane = str(case.get("lane") or _default_fixture_lane(name))
    if lane == "semantic_regression":
        validate_semantic_regression_case(case, case_path)
    input_payload = case.get("input", {})
    workspace_root = resolve_case_workspace(case, fixture_dir, default_workspace_root)
    runner = tool.get("runner")
    if not runner:
        raise GovernanceError(f"tool has no runner configuration: {tool['tool_id']}")
    try:
        verify_bash_command_allowed(
            list(runner.get("argv") or []),
            cwd=str(runner.get("cwd") or "."),
        )
    except (BashAllowlistMiss, BashDenylistHit) as exc:
        raise GovernanceError(f"runner_argv_policy_rejected:{exc}") from exc
    cwd = (workspace_root / runner["cwd"]).resolve()
    input_bytes = _canonical_json_bytes(input_payload)
    started = time.monotonic()
    stdout = ""
    stderr = ""
    exit_code: int | None = None
    status = "ok"
    output: dict[str, Any] | None = None
    timed_out = False

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
            # Plan 023 v3 §C-2 — parser now returns (payload, error_code).
            # The fixture runner only needs the payload to drive
            # fixture-expectation evaluation; the discriminated error
            # code is not surfaced here since fixture status already
            # encodes "schema_error" at this layer. Drop the error code
            # explicitly so fixture run-row shape stays unchanged.
            output, _parse_error = _parse_tool_output(stdout, tool)
            if output is None:
                status = "schema_error"
    except subprocess.TimeoutExpired as exc:
        stdout = _decode_timeout_stream(exc.stdout)
        stderr = _decode_timeout_stream(exc.stderr)
        status = "budget_exceeded"
        timed_out = True

    # C3/E13 — a fixture's OWN workspace tree is legitimate evidence scope.
    # The semantic_regression lane demands curated mini-workspaces under
    # fixtures/<tool>/workspaces/, but the scope check judged their evidence
    # against the tool's PRODUCTION read globs — so the lane was not merely
    # empty, it was unfillable: every curated case died on
    # evidence_scope_violation. The widening is runner-local and case-scoped
    # (a copy, never the registry tool), so production scans are untouched
    # and a fixture still cannot cite paths outside its own tree.
    evidence_tool = tool
    try:
        rel_fixture = fixture_dir.resolve().relative_to(Path(workspace_root).resolve())
        evidence_tool = {
            **tool,
            "allowed_read_globs": [
                *list(tool.get("allowed_read_globs") or []),
                f"{rel_fixture.as_posix()}/workspaces/**",
            ],
        }
    except ValueError:
        pass  # fixture_dir outside the workspace: keep production scope
    evidence_validation = (
        validate_tool_output_evidence(evidence_tool, output, workspace_root) if output is not None else {"valid": False}
    )
    if status == "ok" and evidence_validation.get("valid") is False:
        status = "evidence_error"
    expected = case.get("expected", {})
    passed, errors = evaluate_fixture_expectation(status, output or {}, expected)
    return {
        "name": name,
        "lane": lane,
        "path": case_path.as_posix(),
        "passed": passed,
        "errors": errors,
        "status": status,
        "duration_ms": int(round((time.monotonic() - started) * 1000)),
        "input_hash": sha256(input_bytes),
        "output_hash": sha256(stdout.encode("utf-8")),
        "stderr_hash": sha256(stderr.encode("utf-8")),
        "exit_code": exit_code,
        "timed_out": timed_out,
        "raw_observations_count": len(array_or_empty((output or {}).get("observations"))),
        "raw_findings_count": len(array_or_empty((output or {}).get("findings"))),
        # ARIA-HIGH-034 — the validation inventory (checked_sources +
        # evidence_envelopes) grows with the repository; on 2026-09-02 one
        # baseline case serialised to 1.46 MB and the sealed row broke the
        # publish. The verdict, error list and source sample stay inline;
        # the inventory is bounded here, BEFORE the suite hash binds the
        # row, so evidence_hash covers exactly what is written. The full
        # inventory is a pure function of the case output (pinned by
        # output_hash) and the workspace at the cycle's commit.
        "evidence_validation": spill_evidence_validation(
            evidence_validation,
            recovery=(
                "re-run validate_tool_output_evidence on this case's output "
                "(output_hash pins it) at the cycle's workspace commit"
            ),
        ),
    }


def evaluate_fixture_expectation(
    status: str,
    output: dict[str, Any],
    expected: Any,
) -> tuple[bool, list[str]]:
    errors: list[str] = []
    expected = expected if isinstance(expected, dict) else {}
    if status != expected.get("status", "ok"):
        errors.append(f"status expected {expected.get('status', 'ok')} got {status}")
    findings = array_or_empty(output.get("findings"))
    observations = array_or_empty(output.get("observations"))
    finding_rules = {item.get("rule") for item in findings if isinstance(item, dict)}
    observation_types = {item.get("type") for item in observations if isinstance(item, dict)}
    for rule in expected.get("required_findings", []):
        if rule not in finding_rules:
            errors.append(f"required finding rule missing: {rule}")
    for rule in expected.get("forbidden_findings", []):
        if rule in finding_rules:
            errors.append(f"forbidden finding rule present: {rule}")
    for observation_type in expected.get("required_observations", []):
        if observation_type not in observation_types:
            errors.append(f"required observation type missing: {observation_type}")
    for expectation in array_or_empty(expected.get("required_observation_values")):
        error = evaluate_required_observation_value(observations, expectation)
        if error:
            errors.append(error)
    max_findings = expected.get("max_findings")
    if isinstance(max_findings, int) and len(findings) > max_findings:
        errors.append(f"max_findings expected <= {max_findings} got {len(findings)}")
    for field, actual in (
        ("findings_count", len(findings)),
        ("observations_count", len(observations)),
        ("raw_findings_count", len(findings)),
        ("raw_observations_count", len(observations)),
    ):
        expected_count = expected.get(field)
        if isinstance(expected_count, int) and actual != expected_count:
            errors.append(f"{field} expected {expected_count} got {actual}")
    return not errors, errors


def validate_semantic_regression_case(case: dict[str, Any], case_path: Path) -> None:
    curation = case.get("curation")
    if not isinstance(curation, dict):
        raise GovernanceError(f"semantic_regression fixture requires curation metadata: {case_path}")
    curator = curation.get("curator")
    gold_set = curation.get("gold_set")
    if not isinstance(curator, str) or not curator.strip():
        raise GovernanceError(f"semantic_regression fixture requires curation.curator: {case_path}")
    if not isinstance(gold_set, dict):
        raise GovernanceError(f"semantic_regression fixture requires curation.gold_set: {case_path}")
    true_positive_count = gold_set.get("true_positive_count")
    known_false_positive_count = gold_set.get("known_false_positive_count")
    if not isinstance(true_positive_count, int) or true_positive_count < 1:
        raise GovernanceError(f"semantic_regression fixture requires at least one true-positive gold item: {case_path}")
    if not isinstance(known_false_positive_count, int) or known_false_positive_count < 0:
        raise GovernanceError(f"semantic_regression fixture requires known_false_positive_count: {case_path}")


def evaluate_required_observation_value(
    observations: list[Any],
    expectation: Any,
) -> str | None:
    if not isinstance(expectation, dict):
        return "required_observation_values entries must be JSON objects"
    observation_type = expectation.get("type")
    if not isinstance(observation_type, str) or not observation_type:
        return "required_observation_values entry missing selector field: type"
    expected_name = expectation.get("name")
    if expected_name is not None and not isinstance(expected_name, str):
        return f"required_observation_values entry for {observation_type} has non-string name"

    expected_fields = {
        key: value
        for key, value in expectation.items()
        if key not in {"type", "name"}
    }
    candidates = [
        item
        for item in observations
        if isinstance(item, dict)
        and item.get("type") == observation_type
        and (expected_name is None or item.get("name") == expected_name)
    ]
    if not candidates:
        selector = observation_type if expected_name is None else f"{observation_type}/{expected_name}"
        return f"required observation selector missing: {selector}"
    for candidate in candidates:
        if all(resolve_field(candidate, key) == value for key, value in expected_fields.items()):
            return None
    selector = observation_type if expected_name is None else f"{observation_type}/{expected_name}"
    expected_pairs = ", ".join(f"{key}={value!r}" for key, value in sorted(expected_fields.items()))
    return f"required observation values missing for {selector}: {expected_pairs}"


def _enforce_path_inside_repo(candidate: Path, repo_root: Path) -> Path:
    """Plan 023 v3 §A-2 — path traversal guard.

    `candidate.resolve()` chases symlinks; `relative_to(repo_root.resolve())`
    raises ValueError when the resolved path is outside the repo. We
    catch that and re-raise as the operator-readable GovernanceError so
    fixture_set='../../etc/passwd' or symlink targets outside the repo
    cannot be loaded.
    """
    resolved = candidate.resolve()
    try:
        resolved.relative_to(repo_root.resolve())
    except ValueError as exc:
        raise GovernanceError(
            f"fixture_path_escape_outside_repo: {candidate!s} resolved to "
            f"{resolved!s}, which is outside repo_root {repo_root!s}"
        ) from exc
    return resolved


def _discover_git_root(start: Path) -> Path | None:
    """Walk upward looking for a real `.git` DIRECTORY — the filesystem
    shape of "this is a repository checkout", independent of any git
    subprocess and therefore safe in sandboxed runners where git itself
    may be absent.

    ORPHAN-HIGH-797 — only a .git DIRECTORY anchors discovery. A `.git`
    FILE is a linked-worktree stub (the state store at
    ``.aria-state-store/`` is a worktree of the aria/state branch), and
    anchoring there makes the CHECKOUT's own paths read as escapes —
    exactly the live failure the fixture_refresh_blocked signal surfaced
    on the first fully-alive night: discovery walked up from the store's
    tools root, hit the store's stub first, and repo-relative fixture
    paths "escaped" a repo that was never their repo. Skipping stub
    files lets discovery continue to the checkout's real .git.
    """
    current = start.resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".git").is_dir():
            return candidate
    return None


def _repo_root_for_path_guard(
    base_dir: str | os.PathLike[str] | None,
    *,
    workspace_root: str | os.PathLike[str] | None = None,
) -> Path:
    """Plan 023 v3 §A-2 — repo_root anchor for the path-escape guard.

    Resolution order, most-explicit first:

    1. ``ARIA_REPO_ROOT`` env var (test override, unchanged);
    2. ``workspace_root`` — the cycle/phase knows its workspace and passes
       it down (ORPHAN-HIGH-779);
    3. git-root discovery upward from the tools root — the state-store
       layout (``<workspace>/.aria-state-store/tools``) keeps the tools
       root INSIDE the checkout, so the checkout's ``.git`` is on the
       ancestor chain even though the tools root's parent is not the repo;
    4. ``tools_dir.parent`` — the original "aria-tools/ lives inside the
       repo by convention" assumption, DEMOTED to last resort. It was the
       production default until ORPHAN-HIGH-779: with tools at
       ``.aria-state-store/tools`` the parent is ``.aria-state-store``, the
       guard then rejected every valid fixture path as an escape
       (``fixture_path_escape_outside_repo``), and no fixture suite row was
       ever written. It survives only for non-git sandboxes (unit-test
       temp trees, genesis fixtures) where the caller is the layout's own
       author.
    """
    override = os.environ.get("ARIA_REPO_ROOT")
    if override:
        return Path(override).resolve()
    if workspace_root is not None:
        return Path(workspace_root).resolve()
    tools_root = ensure_tools_dir(base_dir).resolve()
    discovered = _discover_git_root(tools_root)
    if discovered is not None:
        return discovered
    return tools_root.parent


def resolve_fixture_dir(
    tool: dict[str, Any],
    base_dir: str | os.PathLike[str] | None,
    *,
    workspace_root: str | os.PathLike[str] | None = None,
) -> Path:
    root = ensure_tools_dir(base_dir)
    repo_root = _repo_root_for_path_guard(base_dir, workspace_root=workspace_root)
    fixture_set = Path(tool["fixture_set"])
    # Registry `fixture_set` values are REPO-relative
    # ("tools/aria-adapters/fixtures/<tool>"), so the repo-relative
    # candidate is tried FIRST (ORPHAN-HIGH-779: the previous CWD-relative
    # first branch only worked when CWD happened to be the checkout, and
    # the candidate that existed from CWD was then rejected by a guard
    # anchored elsewhere). Each candidate carries its OWN guard anchor:
    # repo-spelled candidates are contained by repo_root, tools-local
    # candidates (sandbox layouts keep the corpus under the tools root,
    # as siblings of the workspace) are contained by the tools root. The
    # escape guard is exactly as strict — a path must live inside the
    # root that sanctions its spelling.
    pairs: list[tuple[Path, Path]] = []
    if not fixture_set.is_absolute():
        pairs.append((repo_root / fixture_set, repo_root))
    pairs.append((fixture_set, repo_root))
    pairs.append((root / fixture_set, root))
    pairs.append((root / "fixtures" / fixture_set.name, root))
    for candidate, anchor in pairs:
        if candidate.exists():
            # Plan 023 v3 §A-2 — even when the candidate exists on disk,
            # we still require it to live inside its anchor root.
            return _enforce_path_inside_repo(candidate, anchor)
    # Even when nothing exists yet, the candidate path itself must
    # resolve inside its anchor so a `fixture_set: '../../etc/passwd'`
    # cannot be silently quarantined as "candidate that doesn't exist
    # yet" and processed downstream. pairs[0] is the repo-relative
    # (or absolute) spelling — the contract's own form.
    return _enforce_path_inside_repo(pairs[0][0], pairs[0][1])


def resolve_case_workspace(
    case: dict[str, Any],
    fixture_dir: Path,
    default_workspace_root: str | os.PathLike[str],
) -> Path:
    repo_root = Path(os.environ.get("ARIA_REPO_ROOT") or default_workspace_root).resolve()
    raw = case.get("workspace_root")
    if raw is None:
        return Path(default_workspace_root).resolve()
    path = Path(str(raw))
    if not path.is_absolute():
        path = fixture_dir / path
    # Plan 023 v3 §A-2 — case.workspace_root must stay inside repo_root.
    return _enforce_path_inside_repo(path, repo_root)


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    append_chained_jsonl(path, payload)


def array_or_empty(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def resolve_field(payload: dict[str, Any], field: str) -> Any:
    current: Any = payload
    for part in field.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def sha256(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def tool_manifest_hash(tool: dict[str, Any]) -> str:
    stable = {
        key: value
        for key, value in tool.items()
        if key not in {"created_at", "updated_at", "last_transition"}
    }
    return sha256(json.dumps(stable, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def fixture_set_hash(fixture_dir: Path) -> str:
    payload = []
    if fixture_dir.exists():
        for path in sorted(item for item in fixture_dir.rglob("*") if item.is_file()):
            try:
                payload.append((path.relative_to(fixture_dir).as_posix(), sha256(path.read_bytes())))
            except OSError:
                payload.append((path.relative_to(fixture_dir).as_posix(), "unreadable"))
    return sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def _default_fixture_lane(name: str) -> str:
    return "real_repo_baseline"


def _fixture_lane_counts(case_results: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for case in case_results:
        lane = str(case.get("lane") or "unknown")
        counts[lane] = counts.get(lane, 0) + 1
    return counts


def _lane_passed(case_results: list[dict[str, Any]], lane: str) -> bool:
    lane_cases = [case for case in case_results if case.get("lane") == lane]
    return bool(lane_cases) and all(case.get("passed") is True for case in lane_cases)
