from __future__ import annotations

import hashlib
import shlex
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_jsonl, load_jsonl
from .file_lock import with_exclusive_lock
from .tool_registry import append_tools_governance, ensure_tools_dir, update_tools_index, utc_now


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
ALLOWED_PREFIXES = (
    "npx nx test ",
    "npx nx lint ",
    "npx nx build ",
    "npm run type-check",
    "python -m pytest ",
    "python -m unittest ",
)


def submit_worker_result(
    *,
    from_worktree: str | Path,
    assignment_id: str | None = None,
    validation_commands: list[str] | None = None,
    tools_root: str | Path | None = None,
    lease_token: str | None = None,
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
    # Plan 026R §G.3 — lease-bound submit. No public tokenless path.
    active_claim: dict[str, Any] | None = None
    if lease_token is None or not lease_token.strip():
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
    too_large = len(diff.encode("utf-8")) > MAX_DIFF_BYTES
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
    root = ensure_tools_dir(tools_root)
    request = _request_for(root, assignment_id=assignment_id)
    result = _latest_result(root, assignment_id)
    if request is None or result is None:
        return _verification(root, assignment_id, "failed", ["missing_dispatch_or_result"], auto_merge_eligible=False)
    worktree = Path(str(request["worktree_path"])).resolve()
    if not worktree.exists():
        return _verification(root, assignment_id, "failed", ["worktree_unreachable"], auto_merge_eligible=False)
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
    return command == "npm run type-check" or any(command.startswith(prefix) for prefix in ALLOWED_PREFIXES if prefix != "npm run type-check")


def _git(worktree: Path, *args: str) -> str:
    completed = subprocess.run(["git", *args], cwd=worktree, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or f"git {' '.join(args)} failed")
    return completed.stdout.strip()
