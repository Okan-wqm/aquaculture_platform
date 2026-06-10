from __future__ import annotations

import hashlib
import shlex
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .artifact_safety import write_sanitized_json
from .ledger import (
    append_declared_jsonl,
    append_jsonl as _append_jsonl,
    load_declared_jsonl,
    load_jsonl as _load_jsonl,
)
from .file_lock import with_exclusive_lock
from .implementation_safety import verify_bash_command_allowed
from .runtime_profile import enforce_profile_for_write
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, update_tools_index, utc_now


def _hash_lease_token(token: str) -> str:
    """Plan 026R §G.3 — mirror of worker_dispatch._hash_lease_token /
    agent_invocations._hash_lease_token. Token never leaves the
    hashed form once recorded on the claim row."""
    return "sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest()


def _resolve_active_claim_for_submit(
    root: Path, assignment_id: str, *, lease_token: str,
) -> dict[str, Any] | str:
    """Plan 026R §G.3 — three-gate active-claim resolution for worker
    submit.

    Returns the active claim dict on success, or a reason string when
    the submit must be rejected. Reason codes:

    * ``submit_worker_result_multiple_active_claims_corruption``
    * ``submit_worker_result_no_active_claim``
    * ``submit_worker_result_lease_token_mismatch``
    * ``submit_worker_result_lease_expired``
    * ``submit_worker_result_claim_already_released`` (etc. for
      terminal events).

    Gate order:
    1. Multi-active-claim corruption (token NOT verified — corruption
       is the more serious signal).
    2. Active-claim lease verify.
    3. Lease-expiry fail-closed.
    """
    claims_path = root / "dispatch" / "claims.jsonl"
    claim_rows = load_jsonl(claims_path)
    # Group by claim_id to find active (claimed without terminal).
    by_claim: dict[str, list[dict[str, Any]]] = {}
    for row in claim_rows:
        if row.get("assignment_id") != assignment_id:
            continue
        cid = str(row.get("claim_id") or "")
        if not cid:
            continue
        by_claim.setdefault(cid, []).append(row)
    terminal_events = frozenset({"released", "stale", "human_required"})
    active_claims: list[dict[str, Any]] = []
    for cid, events in by_claim.items():
        # Sort by recorded_at fallback to sequence.
        events_sorted = events
        latest = events_sorted[-1]
        if latest.get("event") == "claimed":
            active_claims.append(latest)
        elif latest.get("event") in terminal_events:
            # Check if this claim_id's token matches the submit token.
            # If yes, return a specific reason (already released/stale).
            if (
                latest.get("lease_token_hash") == _hash_lease_token(lease_token)
                or any(
                    e.get("lease_token_hash") == _hash_lease_token(lease_token)
                    for e in events_sorted
                )
            ):
                return f"submit_worker_result_claim_already_{latest.get('event')}"
    if len(active_claims) > 1:
        return "submit_worker_result_multiple_active_claims_corruption"
    if not active_claims:
        return "submit_worker_result_no_active_claim"
    active = active_claims[0]
    if active.get("lease_token_hash") != _hash_lease_token(lease_token):
        return "submit_worker_result_lease_token_mismatch"
    # Lease-expiry check — mirror agent_invocations, but fail closed
    # for malformed/missing dispatch leases on the worker path.
    expires_raw = active.get("lease_expires_at")
    if not expires_raw:
        return "submit_worker_result_lease_expired"
    try:
        expires = datetime.fromisoformat(str(expires_raw).replace("Z", "+00:00"))
    except ValueError:
        return "submit_worker_result_lease_expired"
    now = datetime.now(timezone.utc)
    if expires < now:
        return "submit_worker_result_lease_expired"
    return active


MAX_DIFF_BYTES = 1024 * 1024


_DECLARED_SURFACE_BY_JSONL_SUFFIX: dict[str, str] = {
    "dispatch/claims.jsonl": "dispatch_claims",
    "dispatch/requests.jsonl": "dispatch_requests",
    "dispatch/worker-results.jsonl": "dispatch_worker_results",
    "dispatch/verification-results.jsonl": "dispatch_verification_results",
}


def _declared_surface_name(path: str | Path) -> str | None:
    concrete = Path(path)
    if len(concrete.parts) >= 2:
        suffix = "/".join(concrete.parts[-2:])
        if suffix in _DECLARED_SURFACE_BY_JSONL_SUFFIX:
            return _DECLARED_SURFACE_BY_JSONL_SUFFIX[suffix]
    return _DECLARED_SURFACE_BY_JSONL_SUFFIX.get(concrete.name)


def append_jsonl(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    surface = _declared_surface_name(path)
    if surface is not None:
        return append_declared_jsonl(path, record, expected_surface=surface)
    return _append_jsonl(path, record)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    surface = _declared_surface_name(path)
    if surface is not None:
        return load_declared_jsonl(path, expected_surface=surface)
    return _load_jsonl(path)


def submit_worker_result(
    *,
    from_worktree: str | Path,
    assignment_id: str | None = None,
    validation_commands: list[str] | None = None,
    tools_root: str | Path | None = None,
    lease_token: str | None = None,
    allow_legacy_no_token: bool = False,
) -> dict[str, Any]:
    """Submit a worker result for verification.

    Plan 026R §G.3 — ``lease_token`` is REQUIRED for new callers; the
    agent submit path (``agent_invocations.submit_claim_result``)
    already enforces hash + active-claim + expiry checks. The worker
    submit path mirrors that contract:

    * Multi-active-claim corruption (detected first, no token verify).
    * Active-claim lease verify: hash matches the LATEST claim row
      whose ``event == "claimed"`` and no subsequent
      released/stale/human_required event.
    * Lease-expiry fail-closed (mirror of agent_invocations:884-893):
      latest_active_claim.lease_expires_at < now → reject.

    Tokenless callers are rejected. The worker submit path is a live
    execution boundary, so preserving the pre-§G.3 path would leave the
    canonical CLI fail-open.
    """
    enforce_profile_for_write("worker_result", base_dir=tools_root)
    root = ensure_tools_dir(tools_root)
    worktree = Path(from_worktree).resolve()
    request = _request_for(root, assignment_id=assignment_id, worktree=worktree)
    if request is None:
        return _reject(root, "unknown_assignment", assignment_id=assignment_id, worktree=worktree)
    expected = Path(str(request["worktree_path"])).resolve()
    if worktree != expected:
        return _reject(root, "worktree_path_mismatch", assignment_id=str(request["assignment_id"]), worktree=worktree)
    if not worktree.exists():
        return _reject(root, "worktree_unreachable", assignment_id=str(request["assignment_id"]), worktree=worktree)
    commands = validation_commands or list(request.get("required_tests") or [])
    unsafe = [command for command in commands if not _allowed_command(command)]
    if unsafe:
        return _reject(root, "unsafe_validation_command", assignment_id=str(request["assignment_id"]), worktree=worktree, details={"commands": unsafe})
    required = set(str(command) for command in request.get("required_tests") or [])
    if any(command not in required for command in commands):
        return _reject(root, "validation_command_not_required", assignment_id=str(request["assignment_id"]), worktree=worktree, details={"required_tests": sorted(required), "commands": commands})
    # Plan 026R §G.3 — lease-bound submit. Legacy tokenless callers
    # require an explicit compatibility flag; the normal path fails closed.
    active_claim: dict[str, Any] | None = None
    if lease_token is None and not allow_legacy_no_token:
        return _reject(
            root, "submit_worker_result_lease_token_required",
            assignment_id=str(request["assignment_id"]), worktree=worktree,
        )
    if lease_token is not None:
        if not lease_token.strip():
            return _reject(
                root, "submit_worker_result_lease_token_required",
                assignment_id=str(request["assignment_id"]), worktree=worktree,
            )
        claims_path = root / "dispatch" / "claims.jsonl"
        with with_exclusive_lock(claims_path):
            active_claim_or_reject = _resolve_active_claim_for_submit(
                root, str(request["assignment_id"]), lease_token=lease_token,
            )
            if isinstance(active_claim_or_reject, str):
                return _reject(
                    root, active_claim_or_reject,
                    assignment_id=str(request["assignment_id"]), worktree=worktree,
                )
            active_claim = active_claim_or_reject
    base_sha = str(request["base_sha"])
    head_sha = _git(worktree, "rev-parse", "HEAD")
    diff = _git(worktree, "diff", f"{base_sha}...{head_sha}")
    diff_hash = _sha256_text(diff)
    too_large = len(diff.encode("utf-8")) > MAX_DIFF_BYTES
    diff_artifact_ref = _write_diff_artifact(root, str(request["assignment_id"]), diff, diff_hash) if too_large else None
    row = {
        "$schema": "aria/worker-result/v1",
        "schema_version": 1,
        "assignment_id": request["assignment_id"],
        "pressure_event_id": request["pressure_event_id"],
        "target_agent": request["target_agent"],
        "worktree_path": str(expected),
        "base_sha": base_sha,
        "head_sha": head_sha,
        "validation_commands": commands,
        "unified_diff": "" if too_large else diff,
        "diff_truncated": too_large,
        "diff_hash": diff_hash,
        "diff_artifact_ref": diff_artifact_ref,
        "state": "accepted",
        # Plan 026R §G.2 — recorded_at timestamp for the reducer fold's
        # deterministic ordering (the fold sorts by recorded_at + source
        # priority + sequence number).
        "recorded_at": utc_now(),
    }
    # Plan 026R §G.3 — provenance fields on accepted worker-result row.
    # The accepted row anchors the originating claim event for audit +
    # re-claim trace + verification correlation. NEVER persist the raw
    # lease_token or lease_token_hash — those stay claim-ledger only.
    if active_claim is not None:
        row["claim_id"] = active_claim.get("claim_id")
        row["agent_id"] = active_claim.get("agent_id")
    stored = append_jsonl(root / "dispatch" / "worker-results.jsonl", row)
    update_tools_index(root)
    append_tools_governance(root, "worker_result_accepted", {"assignment_id": request["assignment_id"], "target_agent": request["target_agent"], "diff_truncated": too_large})
    return stored


def verify_worker_result(
    *,
    assignment_id: str,
    tools_root: str | Path | None = None,
    auto_merge_eligible: bool = False,
) -> dict[str, Any]:
    enforce_profile_for_write("worker_verification", base_dir=tools_root)
    root = ensure_tools_dir(tools_root)
    request = _request_for(root, assignment_id=assignment_id)
    result = _latest_result(root, assignment_id)
    if request is None or result is None:
        return _verification(root, assignment_id, "failed", ["missing_dispatch_or_result"], auto_merge_eligible=False)
    worktree = Path(str(request["worktree_path"])).resolve()
    if not worktree.exists():
        return _verification(root, assignment_id, "failed", ["worktree_unreachable"], auto_merge_eligible=False)
    submitted_head = str(result.get("head_sha") or "")
    current_head = _git(worktree, "rev-parse", "HEAD")
    if submitted_head and current_head != submitted_head:
        return _verification(root, assignment_id, "failed", ["submitted_head_drift"], auto_merge_eligible=False)
    dirty = _git(worktree, "status", "--porcelain")
    if dirty.strip():
        return _verification(root, assignment_id, "failed", ["worktree_dirty_at_verification"], auto_merge_eligible=False)
    base_sha = str(request.get("base_sha") or "")
    if base_sha:
        try:
            _git(worktree, "merge-base", "--is-ancestor", base_sha, current_head)
        except RuntimeError:
            return _verification(root, assignment_id, "failed", ["base_sha_not_ancestor"], auto_merge_eligible=False)
    current_diff = _git(worktree, "diff", f"{base_sha}...{current_head}") if base_sha else ""
    submitted_diff_hash = str(result.get("diff_hash") or "")
    if submitted_diff_hash and submitted_diff_hash != _sha256_text(current_diff):
        return _verification(root, assignment_id, "failed", ["submitted_diff_drift"], auto_merge_eligible=False)
    if result.get("diff_truncated"):
        artifact_issue = _verify_diff_artifact_ref(root, result.get("diff_artifact_ref"))
        if artifact_issue is not None:
            return _verification(root, assignment_id, "failed", [artifact_issue], auto_merge_eligible=False)
    trailer = str(request.get("expected_trailer") or "")
    log = _git(worktree, "log", "--format=%B", f"{request['base_sha']}..HEAD")
    if trailer and trailer not in log:
        return _verification(root, assignment_id, "failed", ["trailer_mismatch"], auto_merge_eligible=False)
    failures: list[str] = []
    for command in result.get("validation_commands") or []:
        if not _allowed_command(str(command)):
            failures.append("unsafe_validation_command")
            continue
        completed = subprocess.run(shlex.split(str(command)), cwd=worktree, text=True, capture_output=True, check=False, timeout=120)
        if completed.returncode != 0:
            failures.append(f"validation_failed:{command}")
    status = "passed" if not failures else "failed"
    merge_evaluated = bool(auto_merge_eligible and status == "passed" and request.get("triage_tier") == "auto_fix_safe")
    return _verification(root, assignment_id, status, failures, auto_merge_eligible=auto_merge_eligible, auto_merge_evaluated=merge_evaluated)


def _sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _safe_segment(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "-" for ch in value).strip(".-") or "item"


def _write_diff_artifact(root: Path, assignment_id: str, diff: str, diff_hash: str) -> dict[str, Any]:
    path = root / "dispatch" / "artifacts" / _safe_segment(assignment_id) / "diff.json"
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise GovernanceError("worker_diff_artifact_path_escape") from exc
    payload = {
        "schema_version": 1,
        "assignment_id": assignment_id,
        "diff_hash": diff_hash,
        "unified_diff": diff,
        "recorded_at": utc_now(),
    }
    encoded_size = len(diff.encode("utf-8"))
    write_sanitized_json(path, payload, max_bytes=max(2_000_000, encoded_size * 2 + 4096))
    raw = path.read_bytes()
    return {
        "schema_version": 1,
        "path": path.relative_to(root).as_posix(),
        "sha256": "sha256:" + hashlib.sha256(raw).hexdigest(),
        "size_bytes": len(raw),
    }


def _verify_diff_artifact_ref(root: Path, ref: Any) -> str | None:
    if not isinstance(ref, dict):
        return "worker_diff_artifact_ref_missing"
    relative = str(ref.get("path") or "")
    expected_hash = str(ref.get("sha256") or "")
    if not relative or not expected_hash:
        return "worker_diff_artifact_ref_incomplete"
    path = (root / relative).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError:
        return "worker_diff_artifact_path_escape"
    if not path.exists() or not path.is_file():
        return "worker_diff_artifact_missing"
    actual_hash = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    if actual_hash != expected_hash:
        return "worker_diff_artifact_hash_mismatch"
    return None


def _verification(root: Path, assignment_id: str, status: str, failures: list[str], *, auto_merge_eligible: bool, auto_merge_evaluated: bool = False) -> dict[str, Any]:
    request = _request_for(root, assignment_id=assignment_id) or {}
    row = {
        "$schema": "aria/verification-result/v1",
        "schema_version": 1,
        "assignment_id": assignment_id,
        "pressure_event_id": request.get("pressure_event_id"),
        "target_agent": request.get("target_agent"),
        "status": status,
        "failures": failures,
        "auto_merge_eligible_flag": auto_merge_eligible,
        "auto_merge_evaluated": auto_merge_evaluated,
        # Plan 026R §G.2 — recorded_at timestamp for the reducer fold's
        # deterministic ordering.
        "recorded_at": utc_now(),
    }
    stored = append_jsonl(root / "dispatch" / "verification-results.jsonl", row)
    update_tools_index(root)
    append_tools_governance(root, "verification_gate_passed" if status == "passed" else "verification_gate_failed", {"assignment_id": assignment_id, "result": status, "failures": failures})
    return stored


def _reject(root: Path, reason: str, *, assignment_id: str | None, worktree: Path, details: dict[str, Any] | None = None) -> dict[str, Any]:
    row = {
        "$schema": "aria/worker-result/v1",
        "schema_version": 1,
        "assignment_id": assignment_id,
        "worktree_path": worktree.as_posix(),
        "state": "rejected",
        "reason": reason,
        "details": details or {},
        "recorded_at": utc_now(),
    }
    stored = append_jsonl(root / "dispatch" / "worker-results.jsonl", row)
    update_tools_index(root)
    append_tools_governance(root, "worker_result_rejected", {"assignment_id": assignment_id, "reason": reason})
    return stored


def _request_for(root: Path, *, assignment_id: str | None = None, worktree: Path | None = None) -> dict[str, Any] | None:
    for row in reversed(load_jsonl(root / "dispatch" / "requests.jsonl")):
        if assignment_id and row.get("assignment_id") == assignment_id:
            return row
        if worktree is not None and Path(str(row.get("worktree_path") or "")).resolve() == worktree:
            return row
    return None


def _latest_result(root: Path, assignment_id: str) -> dict[str, Any] | None:
    for row in reversed(load_jsonl(root / "dispatch" / "worker-results.jsonl")):
        if row.get("assignment_id") == assignment_id and row.get("state") == "accepted":
            return row
    return None


def _allowed_command(command: str) -> bool:
    try:
        argv = shlex.split(command)
        verify_bash_command_allowed(argv)
    except Exception:
        return False
    return True


def _git(worktree: Path, *args: str) -> str:
    completed = subprocess.run(["git", *args], cwd=worktree, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or f"git {' '.join(args)} failed")
    return completed.stdout.strip()
