from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .file_lock import with_exclusive_lock
from .ledger import (
    _append_jsonl_unlocked,
    _assert_declared_surface,
    append_declared_jsonl,
    load_declared_jsonl,
)
from .agent_network import latest_agent_network_hash
from .pressure import effective_workspace_pressures
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_binding,
    ensure_tools_dir,
    update_tools_index,
    utc_now,
)
from .triage import derive_required_tests, resolve_target_agent
from .workspace import WorkspacePaths


DEFAULT_WORKTREE_TTL_DAYS = 7
DEFAULT_AUTO_BATCH_LIMIT = 10
# Plan 025 §E — assignment claim primitives (mirror of agent_invocations
# claim primitives). worker_dispatch operates on dispatch/requests.jsonl
# rows; the claim ledger lives at dispatch/claims.jsonl.
DEFAULT_LEASE_SECONDS = 1800
LEASE_TOKEN_BYTES = 24

# PLAN Wave 2 PR 1.4 (ORPHAN-HIGH-487) — the assignment states in which work
# is still expected to move, and therefore still holds ARIA's one WIP slot.
#
# Everything OUTSIDE this set is either finished or dead, and a dead
# assignment must not hold a slot: admission without release turns one
# abandoned worker into a permanent freeze.
#
# `verified` is deliberately absent. Nothing in this state machine moves an
# assignment past verification — whether the PR then merges is the MISSION
# layer's question, answered by `mission_reconcile` against GitHub. Counting
# `verified` here would hold the slot forever on a machine that has no event
# to release it.
ACTIVE_ASSIGNMENT_STATES: frozenset[str] = frozenset({
    "pending",
    "prepared",
    "picked_up",
    "submitted",
})

# How many times an expired lease returns its assignment to the queue before
# the assignment is escalated instead. Mirrors
# `agent_invocations.DEFAULT_MAX_REQUEUES`: the same ladder over the same
# failure (a claim whose holder stopped answering) should not have two
# different budgets.
DEFAULT_MAX_LEASE_REQUEUES = 2


_DECLARED_SURFACE_BY_JSONL_SUFFIX: dict[str, str] = {
    "triage/decisions.jsonl": "triage_decisions",
    "dispatch/requests.jsonl": "dispatch_requests",
    "dispatch/claims.jsonl": "dispatch_claims",
    "dispatch/worker-results.jsonl": "dispatch_worker_results",
    "dispatch/verification-results.jsonl": "dispatch_verification_results",
    "governance.jsonl": "tools_governance",
    "pr-lifecycle.jsonl": "pr_lifecycle",
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
    raise GovernanceError(f"worker_dispatch_append_unknown_surface:{path.as_posix()}")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    surface = _declared_surface_name(path)
    if surface is not None:
        return load_declared_jsonl(path, expected_surface=surface)
    raise GovernanceError(f"worker_dispatch_load_unknown_surface:{path.as_posix()}")


def _append_declared_jsonl_unlocked(
    path: Path,
    record: dict[str, Any],
    *,
    expected_surface: str,
) -> dict[str, Any]:
    _assert_declared_surface(
        path,
        expected_surface=expected_surface,
        enforce_write_profile=True,
    )
    return _append_jsonl_unlocked(path.resolve(), record)


def create_dispatch_request(
    paths: WorkspacePaths,
    *,
    pressure_event_id: str,
    tools_root: str | Path | None = None,
    target_agent: str | None = None,
    prepare_worktree: bool = False,
    acknowledge: bool = False,
) -> dict[str, Any]:
    root = ensure_tools_binding(tools_root, workspace_root=paths.repo_root)
    pressure = _pressure_by_id(paths, pressure_event_id)
    if pressure is None:
        raise ValueError(f"pressure not found: {pressure_event_id}")
    decision = _latest_decision(root, pressure_event_id)
    tier = str((decision or {}).get("triage_tier") or "blocked")
    target = target_agent or str((decision or {}).get("target_agent") or "") or resolve_target_agent(pressure, root)
    if not target:
        event = append_tools_governance(root, "agent_resolution_failed", {"pressure_event_id": pressure_event_id, "capability_gap_key": pressure.get("capability_gap_key")})
        return {"schema_version": 1, "status": "not_created", "reason": "agent_resolution_failed", "governance_event_id": event.get("event_id")}
    if tier not in {"auto_fix_safe", "needs_review"}:
        return {"schema_version": 1, "status": "not_created", "reason": f"triage_tier_{tier}_not_dispatchable", "triage_tier": tier}
    if prepare_worktree and not acknowledge:
        raise ValueError("prepare_worktree_requires_acknowledge")
    base_sha = _git(paths.repo_root, "rev-parse", "HEAD")
    created_at = _git_timestamp(paths.repo_root)
    assignment_id = _assignment_id(pressure_event_id, created_at, target)
    worktree_path = paths.repo_root / "aria-worktrees" / assignment_id
    required_tests = list((decision or {}).get("required_tests") or derive_required_tests(paths.repo_root, _evidence_paths(pressure)))
    row = {
        "$schema": "aria/dispatch-request/v1",
        "schema_version": 1,
        "assignment_id": assignment_id,
        "pressure_event_id": pressure_event_id,
        "target_agent": target,
        "triage_tier": tier,
        "worktree_path": worktree_path.as_posix(),
        "base_sha": base_sha,
        "required_tests": required_tests,
        "expected_trailer": ("Closes-Pressure: " if tier == "auto_fix_safe" else "Addresses-Pressure: ") + pressure_event_id,
        "state": "pending",
        "created_at": created_at,
        "index_hash_at_decision": latest_agent_network_hash(base_dir=root),
    }
    if prepare_worktree:
        worktree_path.parent.mkdir(parents=True, exist_ok=True)
        completed = subprocess.run(["git", "worktree", "add", worktree_path.as_posix(), base_sha], cwd=paths.repo_root, text=True, capture_output=True, check=False)
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or "git worktree add failed")
        row["state"] = "prepared"
    stored = append_jsonl(root / "dispatch" / "requests.jsonl", row)
    update_tools_index(root)
    append_tools_governance(root, "dispatch_request_created", {"assignment_id": assignment_id, "pressure_event_id": pressure_event_id, "target_agent": target, "state": row["state"]})
    if row["state"] != "pending":
        append_tools_governance(root, "dispatch_request_state_changed", {"assignment_id": assignment_id, "from_state": "pending", "to_state": row["state"]})
    return stored


def _assignment_id(pressure_event_id: str, created_at: str, target_agent: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", target_agent.lower()).strip("-")[:32] or "worker"
    digest = hashlib.sha256(f"{pressure_event_id}{created_at}".encode("utf-8")).hexdigest()[:8]
    return f"A-{slug}-{digest}"


def _latest_decision(root: Path, pressure_event_id: str) -> dict[str, Any] | None:
    for row in reversed(load_jsonl(root / "triage" / "decisions.jsonl")):
        if row.get("pressure_event_id") == pressure_event_id:
            return row
    return None


def _pressure_by_id(paths: WorkspacePaths, pressure_event_id: str) -> dict[str, Any] | None:
    for pressure in effective_workspace_pressures(paths):
        if pressure.get("event_id") == pressure_event_id or pressure.get("pressure_id") == pressure_event_id:
            return pressure
    return None


def _evidence_paths(pressure: dict[str, Any]) -> list[str]:
    refs = pressure.get("evidence_refs") if isinstance(pressure.get("evidence_refs"), list) else []
    return [str(ref) for ref in refs if isinstance(ref, str)]


def _git(repo_root: Path, *args: str) -> str:
    completed = subprocess.run(["git", *args], cwd=repo_root, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or f"git {' '.join(args)} failed")
    return completed.stdout.strip()


def _git_timestamp(repo_root: Path) -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def list_dispatch_requests(
    tools_root: str | Path,
    *,
    state: str | None = None,
    target_agent: str | None = None,
    pressure_event_id: str | None = None,
) -> list[dict[str, Any]]:
    root = Path(tools_root)
    rows = load_jsonl(root / "dispatch" / "requests.jsonl")
    states = _latest_assignment_states(root)
    enriched: list[dict[str, Any]] = []
    for row in rows:
        current_state = _current_assignment_state(row, states)
        view = dict(row)
        view["current_state"] = current_state
        enriched.append(view)
    if state is not None:
        enriched = [r for r in enriched if r.get("current_state") == state]
    if target_agent is not None:
        enriched = [r for r in enriched if r.get("target_agent") == target_agent]
    if pressure_event_id is not None:
        enriched = [r for r in enriched if r.get("pressure_event_id") == pressure_event_id]
    return enriched


def _current_assignment_state(row: dict[str, Any], states: dict[str, str]) -> str:
    assignment_id = str(row.get("assignment_id") or "")
    if assignment_id and assignment_id in states:
        return states[assignment_id]
    return str(row.get("state") or "pending")


def mark_dispatch_picked_up(
    tools_root: str | Path,
    *,
    pressure_event_id: str,
    actor: str,
) -> dict[str, Any]:
    if not actor or not actor.strip():
        raise ValueError("mark_picked_up_requires_actor")
    root = Path(tools_root)
    rows = load_jsonl(root / "dispatch" / "requests.jsonl")
    matching = [r for r in rows if r.get("pressure_event_id") == pressure_event_id]
    if not matching:
        return {"schema_version": 1, "status": "not_found", "pressure_event_id": pressure_event_id}
    latest = matching[-1]
    states = _latest_assignment_states(root)
    current_state = _current_assignment_state(latest, states)
    if current_state in {"completed", "cancelled", "expired"}:
        return {
            "schema_version": 1,
            "status": "rejected",
            "pressure_event_id": pressure_event_id,
            "reason": f"already_{current_state}",
        }
    event = append_tools_governance(
        root,
        "dispatch_request_state_changed",
        {
            "assignment_id": latest.get("assignment_id"),
            "pressure_event_id": pressure_event_id,
            "from_state": current_state,
            "to_state": "picked_up",
            "actor": actor,
        },
    )
    return {
        "schema_version": 1,
        "status": "marked",
        "pressure_event_id": pressure_event_id,
        "assignment_id": latest.get("assignment_id"),
        "from_state": current_state,
        "to_state": "picked_up",
        "actor": actor,
        "governance_event_id": event.get("event_id"),
    }


def cancel_dispatch_request(
    tools_root: str | Path,
    *,
    pressure_event_id: str,
    reason: str,
) -> dict[str, Any]:
    if not reason or not reason.strip():
        raise ValueError("cancel_requires_reason")
    root = Path(tools_root)
    rows = load_jsonl(root / "dispatch" / "requests.jsonl")
    matching = [r for r in rows if r.get("pressure_event_id") == pressure_event_id]
    if not matching:
        return {"schema_version": 1, "status": "not_found", "pressure_event_id": pressure_event_id}
    latest = matching[-1]
    states = _latest_assignment_states(root)
    current_state = _current_assignment_state(latest, states)
    if current_state == "cancelled":
        return {"schema_version": 1, "status": "already_cancelled", "pressure_event_id": pressure_event_id}
    if current_state == "completed":
        return {
            "schema_version": 1,
            "status": "rejected",
            "pressure_event_id": pressure_event_id,
            "reason": "already_completed",
        }
    event = append_tools_governance(
        root,
        "dispatch_request_state_changed",
        {
            "assignment_id": latest.get("assignment_id"),
            "pressure_event_id": pressure_event_id,
            "from_state": current_state,
            "to_state": "cancelled",
            "reason": reason,
        },
    )
    return {
        "schema_version": 1,
        "status": "cancelled",
        "pressure_event_id": pressure_event_id,
        "assignment_id": latest.get("assignment_id"),
        "from_state": current_state,
        "to_state": "cancelled",
        "reason": reason,
        "governance_event_id": event.get("event_id"),
    }


def auto_batch_dispatch(
    paths: WorkspacePaths,
    *,
    tools_root: str | Path | None = None,
    limit: int = DEFAULT_AUTO_BATCH_LIMIT,
    prepare_worktree: bool = False,
    acknowledge: bool = False,
) -> dict[str, Any]:
    root = ensure_tools_binding(tools_root, workspace_root=paths.repo_root)
    decisions = load_jsonl(root / "triage" / "decisions.jsonl")
    request_rows = load_jsonl(root / "dispatch" / "requests.jsonl")
    assignment_states = _latest_assignment_states(root)
    states_by_pressure: dict[str, set[str]] = {}
    for request in request_rows:
        pe_id = str(request.get("pressure_event_id") or "")
        if not pe_id:
            continue
        states_by_pressure.setdefault(pe_id, set()).add(
            _current_assignment_state(request, assignment_states),
        )
    seen: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for row in reversed(decisions):
        if row.get("triage_tier") != "auto_fix_safe":
            continue
        pe = str(row.get("pressure_event_id") or "")
        if not pe or pe in seen:
            continue
        if states_by_pressure.get(pe, set()) & {"pending", "prepared", "picked_up", "submitted", "verified", "completed"}:
            continue
        seen.add(pe)
        candidates.append(row)
        if len(candidates) >= max(0, int(limit)):
            break
    results: list[dict[str, Any]] = []
    for decision in candidates:
        pe = str(decision.get("pressure_event_id") or "")
        try:
            result = create_dispatch_request(
                paths,
                pressure_event_id=pe,
                tools_root=root,
                target_agent=decision.get("target_agent"),
                prepare_worktree=prepare_worktree,
                acknowledge=acknowledge,
            )
        except (RuntimeError, ValueError) as exc:
            result = {"schema_version": 1, "status": "error", "pressure_event_id": pe, "error": str(exc)}
        results.append(result)
    return {
        "schema_version": 1,
        "dispatched_count": sum(1 for r in results if r.get("status") not in {"error", "not_created"}),
        "candidate_count": len(candidates),
        "results": results,
    }


def prune_worktrees(
    repo_root: str | Path,
    tools_root: str | Path,
    *,
    acknowledge: bool,
    ttl_days: int = DEFAULT_WORKTREE_TTL_DAYS,
    now: datetime | None = None,
) -> dict[str, Any]:
    if not acknowledge:
        return {"schema_version": 1, "status": "skipped", "reason": "missing_acknowledge"}
    repo = Path(repo_root)
    root = Path(tools_root)
    rows = load_jsonl(root / "dispatch" / "requests.jsonl")
    states = _latest_assignment_states(root)
    moment = now or datetime.now(timezone.utc)
    pruned: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for row in rows:
        pe = row.get("pressure_event_id")
        worktree_rel = row.get("worktree_path")
        assignment_id = row.get("assignment_id")
        if not pe or not worktree_rel or not assignment_id:
            continue
        current_state = _current_assignment_state(row, states)
        if current_state not in {"completed", "cancelled", "expired"}:
            continue
        created = _parse_iso(row.get("created_at"))
        if created is None:
            skipped.append({"assignment_id": assignment_id, "reason": "invalid_created_at"})
            continue
        age_days = (moment - created).days
        if age_days < ttl_days:
            skipped.append({"assignment_id": assignment_id, "reason": "ttl_not_reached", "age_days": age_days})
            continue
        worktree_path = Path(worktree_rel)
        if not worktree_path.is_absolute():
            worktree_path = repo / worktree_rel
        if not worktree_path.exists():
            skipped.append({"assignment_id": assignment_id, "reason": "worktree_missing"})
            continue
        try:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree_path)],
                cwd=repo,
                text=True,
                capture_output=True,
                check=False,
            )
        except OSError:
            pass
        if worktree_path.exists():
            shutil.rmtree(worktree_path, ignore_errors=True)
        event = append_tools_governance(
            root,
            "worktree_pruned",
            {
                "assignment_id": assignment_id,
                "pressure_event_id": pe,
                "worktree_path": worktree_rel,
                "state": current_state,
                "age_days": age_days,
            },
        )
        pruned.append({
            "assignment_id": assignment_id,
            "pressure_event_id": pe,
            "worktree_path": worktree_rel,
            "state": current_state,
            "age_days": age_days,
            "governance_event_id": event.get("event_id"),
        })
    return {
        "schema_version": 1,
        "status": "ok",
        "pruned_count": len(pruned),
        "skipped_count": len(skipped),
        "ttl_days": ttl_days,
        "pruned": pruned,
        "skipped": skipped,
    }


# --------------------- Plan 025 §E — claim + retry + PR bridge ---------------------


def _claims_path(root: Path) -> Path:
    return root / "dispatch" / "claims.jsonl"


def _hash_lease_token(token: str) -> str:
    return "sha256:" + hashlib.sha256(token.encode("utf-8")).hexdigest()


def _claim_id(assignment_id: str, agent_id: str, now: datetime) -> str:
    digest = hashlib.sha256(
        f"{assignment_id}|{agent_id}|{now.isoformat()}".encode("utf-8")
    ).hexdigest()[:16]
    return f"DC-{digest}"


def _utc_now_dt() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def _find_assignment(root: Path, assignment_id: str) -> dict[str, Any] | None:
    """Return the most recent dispatch request row for ``assignment_id``."""
    found: dict[str, Any] | None = None
    for row in load_jsonl(root / "dispatch" / "requests.jsonl"):
        if row.get("assignment_id") == assignment_id:
            found = row
    return found


def _derive_assignment_state(root: Path, assignment_id: str) -> str:
    """Derive an assignment's current state by following its lifecycle.

    Sources (in precedence order):
      1. Latest ``dispatch_request_state_changed`` event for the
         assignment's pressure_event_id in governance.jsonl.
      2. The assignment row's own ``state`` field.

    States: pending / prepared / picked_up / completed / cancelled /
    expired. The worker daemon writes ``picked_up`` (via the claim
    primitive below); ``completed`` is set after verification.

    PLAN Wave 2 PR 1.4 — this docstring previously said "the reaper writes
    ``expired`` when a lease times out". There was no reaper, and nothing
    has ever produced ``expired``. `reap_expired_assignment_claims` is that
    reaper now, and it writes into the claims vocabulary this fold already
    understands (``released`` back to pending, or terminal
    ``human_required``) rather than a state with no producer. ``expired``
    survives only as a state `prune_worktrees` still recognises.
    """
    assignment = _find_assignment(root, assignment_id)
    if assignment is None:
        return "missing"
    return _current_assignment_state(assignment, _latest_assignment_states(root))


def next_pending_assignment(
    *,
    target_agent: str | None = None,
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any] | None:
    """Return the oldest dispatch assignment in pending or prepared state.

    Plan 025 §E — discovery primitive consumed by the autonomous
    worker scheduler daemon. Mirrors agent_invocations.next_pending_
    request semantics: pending and prepared are eligible (prepared
    means the worktree is git-checked out but no worker has claimed
    yet); picked_up / completed / cancelled / expired are skipped.
    """
    root = ensure_tools_dir(base_dir)
    rows = load_jsonl(root / "dispatch" / "requests.jsonl")
    states = _latest_assignment_states(root)
    for row in rows:
        if target_agent and row.get("target_agent") != target_agent:
            continue
        current_state = _current_assignment_state(row, states)
        if current_state in {"pending", "prepared"}:
            return row
    return None


def claim_assignment(
    *,
    assignment_id: str,
    agent_id: str,
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Atomic-locked CAS claim on a dispatch assignment.

    Plan 025 §E — mirror of agent_invocations.claim_request. Writes
    a ``claimed`` row to dispatch/claims.jsonl inside an exclusive
    file lock so two daemons cannot both pass the state check and
    both append (TOCTOU race that pre-fix mark_dispatch_picked_up
    silently allowed because it was a state-transition only with
    no lease-token mutex).

    Returns ``{claim_id, lease_token, lease_expires_at, ...}`` —
    the raw lease_token is returned exactly once; its sha256 hash
    is what gets persisted to claims.jsonl. Caller MUST forward the
    raw token via env var (ARIA_LEASE_TOKEN) per the lease-token
    redaction discipline.
    """
    if lease_seconds <= 0:
        raise GovernanceError("lease_seconds must be positive")
    if not agent_id or not agent_id.strip():
        raise GovernanceError("agent_id is required")
    root = ensure_tools_dir(base_dir)
    claims_path = _claims_path(root)
    with with_exclusive_lock(claims_path):
        state = _derive_assignment_state(root, assignment_id)
        if state == "missing":
            raise GovernanceError(
                f"assignment_not_found: {assignment_id}"
            )
        if state not in {"pending", "prepared"}:
            raise GovernanceError(
                f"cannot claim assignment {assignment_id} in state "
                f"{state} (must be pending or prepared)"
            )
        # CAS recheck after the lock fires — if another worker
        # released or expired the assignment between our read and
        # the lock acquisition, the claim raises a specific
        # claim_assignment_state_changed_during_lock signal.
        rechecked = _derive_assignment_state(root, assignment_id)
        if rechecked != state:
            raise GovernanceError(
                f"claim_assignment_state_changed_during_lock: "
                f"{state} -> {rechecked}"
            )
        now = _utc_now_dt()
        expires = now + timedelta(seconds=lease_seconds)
        lease_token = secrets.token_hex(LEASE_TOKEN_BYTES)
        cid = _claim_id(assignment_id, agent_id, now)
        assignment = _find_assignment(root, assignment_id)
        row = {
            "schema_version": 1,
            "event": "claimed",
            "claim_id": cid,
            "assignment_id": assignment_id,
            "pressure_event_id": (assignment or {}).get("pressure_event_id"),
            "agent_id": agent_id,
            "lease_token_hash": _hash_lease_token(lease_token),
            "lease_seconds": lease_seconds,
            "recorded_at": _iso(now),
            "claimed_at": _iso(now),
            "lease_expires_at": _iso(expires),
        }
        # Plan 026R §A.1 — caller already holds with_exclusive_lock(claims_path)
        # at the enclosing block; use the unlocked helper to avoid POSIX flock
        # re-acquisition.
        _append_declared_jsonl_unlocked(
            claims_path,
            row,
            expected_surface="dispatch_claims",
        )
    # Mirror dispatch_request_state_changed event so the existing
    # state-derivation reads pick the new picked_up state without
    # adding a second derivation source.
    pe_id = (assignment or {}).get("pressure_event_id")
    if pe_id:
        append_tools_governance(
            root, "dispatch_request_state_changed",
            {
                "assignment_id": assignment_id,
                "pressure_event_id": pe_id,
                "from_state": state,
                "to_state": "picked_up",
                "claim_id": cid,
                "agent_id": agent_id,
            },
        )
    append_tools_governance(
        root, "dispatch_claim_created",
        {
            "claim_id": cid, "assignment_id": assignment_id,
            "agent_id": agent_id, "lease_expires_at": _iso(expires),
        },
    )
    return {**row, "lease_token": lease_token}


def release_claim_assignment(
    *,
    claim_id: str,
    lease_token: str,
    reason: str,
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Release a claim back to the assignment queue.

    Plan 025 §E — used by the worker hook when verification fails
    and the retry budget is not yet exhausted; the assignment
    returns to ``pending`` state so the next daemon tick can re-
    claim. The lease_token is verified against the persisted hash
    so a stale or stolen token cannot release another worker's
    claim.
    """
    if not claim_id or not claim_id.strip():
        raise GovernanceError("claim_id is required")
    if not lease_token:
        raise GovernanceError("lease_token is required")
    if not reason or not reason.strip():
        raise GovernanceError("release reason is required")
    root = ensure_tools_dir(base_dir)
    claims_path = _claims_path(root)
    with with_exclusive_lock(claims_path):
        claims = load_jsonl(claims_path)
        claim_event = next(
            (r for r in claims
             if r.get("claim_id") == claim_id and r.get("event") == "claimed"),
            None,
        )
        if claim_event is None:
            raise GovernanceError(f"claim {claim_id} not found")
        if claim_event.get("lease_token_hash") != _hash_lease_token(lease_token):
            raise GovernanceError(
                f"claim {claim_id} lease_token mismatch"
            )
        terminal = [
            r for r in claims
            if r.get("claim_id") == claim_id
            and r.get("event") in {"released", "stale", "human_required"}
        ]
        if terminal:
            raise GovernanceError(
                f"claim {claim_id} already terminal "
                f"({terminal[-1].get('event')})"
            )
        released_at = _iso(_utc_now_dt())
        row = {
            "schema_version": 1,
            "event": "released",
            "claim_id": claim_id,
            "assignment_id": claim_event.get("assignment_id"),
            "pressure_event_id": claim_event.get("pressure_event_id"),
            "agent_id": claim_event.get("agent_id"),
            "reason": reason,
            "recorded_at": released_at,
            "released_at": released_at,
        }
        # Plan 026R §A.1 — caller already holds with_exclusive_lock(claims_path)
        # at the enclosing block; use the unlocked helper to avoid POSIX flock
        # re-acquisition.
        _append_declared_jsonl_unlocked(
            claims_path,
            row,
            expected_surface="dispatch_claims",
        )
    pe_id = claim_event.get("pressure_event_id")
    if pe_id:
        # State derivation rolls back to pending so the next
        # daemon tick can re-claim. Operators reading governance
        # see the explicit reason code.
        append_tools_governance(
            root, "dispatch_request_state_changed",
            {
                "assignment_id": claim_event.get("assignment_id"),
                "pressure_event_id": pe_id,
                "from_state": "picked_up",
                "to_state": "pending",
                "claim_id": claim_id,
                "reason": reason,
            },
        )
    append_tools_governance(
        root, "dispatch_claim_released",
        {
            "claim_id": claim_id, "reason": reason,
            "assignment_id": claim_event.get("assignment_id"),
        },
    )
    return row


def assignment_retry_count(
    *,
    assignment_id: str,
    base_dir: str | os.PathLike[str] | None = None,
) -> int:
    """Count prior verification failures for an assignment.

    Plan 025 §E — read-only governance ledger scan. The dispatch
    row is append-only; rewriting it for a retry counter would
    re-open the same write-side defect Plan 024 §H-1 closed for
    claims.jsonl. Counting verification_gate_failed events scoped
    to the assignment is the SSoT.
    """
    root = ensure_tools_dir(base_dir)
    count = 0
    for row in load_jsonl(root / "governance.jsonl"):
        if row.get("kind") != "verification_gate_failed":
            continue
        details = row.get("details") or {}
        if details.get("assignment_id") == assignment_id:
            count += 1
    return count


def pr_for_assignment(
    *,
    assignment_id: str,
    base_dir: str | os.PathLike[str] | None = None,
) -> int | None:
    """Lookup the PR number associated with a verified assignment.

    Plan 025 §E — scans pr-lifecycle.jsonl for the most recent row
    carrying ``assignment_id``. Pre-fix that ledger never recorded
    the assignment_id link; the open_pr_for_action surface is
    extended in this same batch to thread assignment_id into
    record_pr_lifecycle so future PR rows match.

    Legacy rows (lacking assignment_id) return None — the caller's
    fail-closed path emits ``verified_pending_merge`` instead of
    silently routing to merge_if_green with the wrong PR. This is
    architecturally correct: a verified worker run with no PR
    cannot be merged, so the only operator-visible state is
    pending-merge.
    """
    root = ensure_tools_dir(base_dir)
    pr_path = root / "pr-lifecycle.jsonl"
    if not pr_path.exists():
        return None
    pr_number: int | None = None
    for row in load_jsonl(pr_path):
        if row.get("assignment_id") != assignment_id:
            continue
        num = row.get("pr_number")
        if isinstance(num, int):
            pr_number = num
    return pr_number


def _latest_request_states(root: Path) -> dict[str, str]:
    states: dict[str, str] = {}
    for row in load_jsonl(root / "dispatch" / "requests.jsonl"):
        pe = row.get("pressure_event_id")
        if pe:
            states[pe] = row.get("state", "pending")
    for row in load_jsonl(root / "governance.jsonl"):
        if row.get("kind") != "dispatch_request_state_changed":
            continue
        details = row.get("details") or {}
        pe = details.get("pressure_event_id")
        to_state = details.get("to_state")
        if pe and to_state:
            states[pe] = str(to_state)
    return states


def _latest_assignment_states(root: Path) -> dict[str, str]:
    """Plan 026R §G.1+§G.2 — assignment-id-keyed state derivation.

    Pre-§G.1 ``_latest_request_states`` was pressure_event_id-keyed
    so two assignments for the same pressure (e.g. a retry after a
    rejected first attempt) clobbered each other in the state map.
    Multi-assignment-per-pe is a real flow; the legacy keying made
    list_dispatch_requests / mark_dispatch_picked_up ambiguous.

    Reducer fold rules (Plan 026R §G.2):

    1. Collect events from claims.jsonl ∪ worker-results.jsonl ∪
       verification-results.jsonl. governance.jsonl is audit-trail
       ONLY — the reducer does NOT read it for state.
    2. Sort by ``(recorded_at, source_priority, sequence_number)``.
       source_priority: verification-results > worker-results > claims.
       Legacy rows lacking ``recorded_at`` fall back to a deterministic
       (source_priority, sequence_number) ordering so the fold remains
       deterministic across runs.
    3. Fold: initial state ``pending``; each event applies a transition.
    4. Terminal precedence: ``{stale, human_required, verified}`` are
       terminal — later non-terminal events ignored.
    5. Multiple-active-claim corruption: if at any moment >1 active
       claim exists for an assignment_id, the assignment's state is
       set to ``multiple_active_claims_corruption`` so operators see
       the corruption signal rather than a derived state.
    """
    SOURCE_PRIORITY = {
        "requests": 0,
        "verification-results": 3,
        "worker-results": 2,
        "claims": 1,
    }
    TERMINAL_STATES = frozenset({
        "cancelled",
        "completed",
        "expired",
        "human_required",
        "multiple_active_claims_corruption",
        "stale",
        "verified",
    })

    events: list[tuple[Any, int, int, str, dict[str, Any]]] = []
    for seq, row in enumerate(load_jsonl(root / "dispatch" / "requests.jsonl")):
        events.append((
            row.get("created_at") or "",
            SOURCE_PRIORITY["requests"], seq, "requests", row,
        ))
    for seq, row in enumerate(load_jsonl(root / "dispatch" / "claims.jsonl")):
        ts = row.get("recorded_at") or row.get("claimed_at") or row.get("released_at") or row.get("at") or ""
        events.append((ts, SOURCE_PRIORITY["claims"], seq, "claims", row))
    for seq, row in enumerate(load_jsonl(root / "dispatch" / "worker-results.jsonl")):
        events.append((
            row.get("recorded_at") or "",
            SOURCE_PRIORITY["worker-results"], seq, "worker-results", row,
        ))
    for seq, row in enumerate(load_jsonl(root / "dispatch" / "verification-results.jsonl")):
        events.append((
            row.get("recorded_at") or "",
            SOURCE_PRIORITY["verification-results"], seq, "verification-results", row,
        ))
    events.sort(key=lambda e: (e[0], e[1], e[2]))

    states: dict[str, str] = {}
    active_claims: dict[str, set[str]] = {}
    for _ts, _prio, _seq, source, row in events:
        assignment_id = str(row.get("assignment_id") or "")
        if not assignment_id:
            continue
        if states.get(assignment_id) in TERMINAL_STATES:
            continue
        if source == "requests":
            states.setdefault(assignment_id, str(row.get("state") or "pending"))
        elif source == "claims":
            event = row.get("event")
            claim_id = str(row.get("claim_id") or "")
            if event == "claimed" and claim_id:
                active_claims.setdefault(assignment_id, set()).add(claim_id)
                if len(active_claims[assignment_id]) > 1:
                    states[assignment_id] = "multiple_active_claims_corruption"
                else:
                    states[assignment_id] = "picked_up"
            elif event == "released" and claim_id:
                active_claims.setdefault(assignment_id, set()).discard(claim_id)
                states[assignment_id] = "pending"
            elif event == "stale":
                states[assignment_id] = "stale"
            elif event == "human_required":
                states[assignment_id] = "human_required"
        elif source == "worker-results":
            state_val = row.get("state")
            if state_val == "accepted":
                states[assignment_id] = "submitted"
            elif state_val == "rejected":
                states[assignment_id] = "submit_rejected"
        elif source == "verification-results":
            status_val = row.get("status")
            if status_val == "passed":
                states[assignment_id] = "verified"
            elif status_val == "failed":
                states[assignment_id] = "verification_failed"
    return states


def recover_orphan_governance(base_dir: str | Path | None = None) -> dict[str, Any]:
    """Plan 026R §G.2 — boot-time scanner that emits recovery audit
    events for claims rows without matching governance entries.

    Idempotent. Not load-bearing for state correctness (the reducer
    does not read governance.jsonl), but restores operator audit
    trail when governance.jsonl loses a row.
    """
    root = ensure_tools_dir(base_dir)
    claim_rows = load_jsonl(root / "dispatch" / "claims.jsonl")
    gov_rows = load_jsonl(root / "governance.jsonl")
    gov_claim_ids: set[str] = set()
    for row in gov_rows:
        kind = str(row.get("kind") or "")
        if not (kind.startswith("worker_claim_") or kind.startswith("dispatch_")):
            continue
        details = row.get("details") or {}
        cid = details.get("claim_id")
        if cid:
            gov_claim_ids.add(str(cid))
    recovered = 0
    for row in claim_rows:
        cid = row.get("claim_id")
        event = row.get("event")
        if not cid or str(cid) in gov_claim_ids:
            continue
        if event in ("claimed", "released", "stale", "human_required"):
            append_tools_governance(
                root,
                f"worker_claim_recovered_{event}",
                {
                    "claim_id": cid,
                    "assignment_id": row.get("assignment_id"),
                    "agent_id": row.get("agent_id"),
                    "recovered_at": utc_now(),
                },
            )
            recovered += 1
    return {"recovered_count": recovered}


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# =============================================================================
# PLAN Wave 2 PR 1.4 — the in-flight set, and the lease that ends it.
# =============================================================================


def active_dispatch_assignments(
    *, base_dir: str | os.PathLike[str] | None = None
) -> list[dict[str, Any]]:
    """Every assignment still expected to move, with its derived state.

    THIS IS THE LIVE IN-FLIGHT RECORD, and it is not the one ORPHAN-HIGH-487
    proposed. The finding named `plan_convergence.list_active_plans()`, which
    filters out `TERMINAL_STATES` — and `CONVERGED` is in that set, while
    `promote_converged_plan_to_dispatch` refuses any plan that is not
    CONVERGED. Promotion writes a dispatch row and no plan event at all, so a
    promoted plan stays CONVERGED, which is terminal. A gate on that source
    could never have fired.
    """
    root = ensure_tools_dir(base_dir)
    states = _latest_assignment_states(root)
    active: list[dict[str, Any]] = []
    for row in load_jsonl(root / "dispatch" / "requests.jsonl"):
        assignment_id = str(row.get("assignment_id") or "")
        if not assignment_id:
            continue
        state = _current_assignment_state(row, states)
        if state in ACTIVE_ASSIGNMENT_STATES:
            active.append({
                "assignment_id": assignment_id,
                "state": state,
                "plan_id": row.get("plan_id"),
                "pressure_event_id": row.get("pressure_event_id"),
                "created_at": row.get("created_at"),
            })
    return active


def _lease_expiry_count(root: Path, assignment_id: str) -> int:
    """How many of this assignment's leases have already been reaped.

    Counted from the governance ledger for the same reason
    `assignment_retry_count` is: the dispatch row is append-only, and
    rewriting it for a counter would re-open the write-side defect
    Plan 024 §H-1 closed.
    """
    count = 0
    for row in load_jsonl(root / "governance.jsonl"):
        if row.get("kind") != "dispatch_claim_lease_expired":
            continue
        details = row.get("details") or {}
        if details.get("assignment_id") == assignment_id:
            count += 1
    return count


def reap_expired_assignment_claims(
    *,
    base_dir: str | os.PathLike[str] | None = None,
    now: datetime | None = None,
    max_requeues: int = DEFAULT_MAX_LEASE_REQUEUES,
) -> dict[str, list[dict[str, Any]]]:
    """Release assignments whose worker stopped answering.

    `_derive_assignment_state` has always documented a reaper that "writes
    ``expired`` when a lease times out". There was none: `cancel_dispatch_
    request` is the only writer of a dead state, and it is operator-invoked.
    So a worker that died left its assignment `picked_up` forever — harmless
    while nothing read the in-flight set, and a permanent freeze the moment
    ORPHAN-HIGH-487's admission gate started reading it.

    The reaper writes into the SAME claims vocabulary the fold already
    understands (`released` returns the assignment to `pending`;
    `human_required` is terminal) rather than introducing `expired`, which
    the fold has no claims-row producer for. Two dead states for one death
    would be a vocabulary that has to be kept in agreement with itself.

    It does not go through `release_claim_assignment`, which authenticates the
    caller against the raw lease token: only the token's hash is persisted, so
    the system genuinely cannot present one. That check exists to stop one
    worker releasing another's live claim. Here the claim is EXPIRED, and the
    expiry is the authority — which is why the reaper reads the recorded
    deadline and refuses to act without one.
    """
    root = ensure_tools_dir(base_dir)
    moment = now or _utc_now_dt()
    claims_path = _claims_path(root)
    by_claim: dict[str, list[dict[str, Any]]] = {}
    for row in load_jsonl(claims_path):
        claim_id = str(row.get("claim_id") or "")
        if claim_id:
            by_claim.setdefault(claim_id, []).append(row)

    # Only assignments still expected to move are reapable. A claim left over
    # on an assignment that has already died has nothing to release, and
    # writing it another terminal row would put noise in the audit trail where
    # the first row is the fact.
    live = {row["assignment_id"] for row in active_dispatch_assignments(base_dir=root)}

    reaped: dict[str, list[dict[str, Any]]] = {
        "expired": [],
        "requeued": [],
        "human_required": [],
    }
    for claim_id, events in by_claim.items():
        if any(
            event.get("event") in {"released", "stale", "human_required"}
            for event in events
        ):
            continue
        claimed = next(
            (event for event in events if event.get("event") == "claimed"), None
        )
        if claimed is None:
            continue
        expires = _parse_iso(claimed.get("lease_expires_at"))
        # No recorded deadline is not an expired deadline. A claim whose row
        # never carried one is a claim this reaper cannot judge, and guessing
        # would kill live work.
        if expires is None or expires > moment:
            continue
        assignment_id = str(claimed.get("assignment_id") or "")
        if not assignment_id or assignment_id not in live:
            continue
        expiry_count = _lease_expiry_count(root, assignment_id) + 1
        requeue = expiry_count <= max_requeues
        disposition = "requeued" if requeue else "human_required"
        recorded_at = _iso(moment)
        row: dict[str, Any] = {
            "schema_version": 1,
            "event": "released" if requeue else "human_required",
            "claim_id": claim_id,
            "assignment_id": assignment_id,
            "pressure_event_id": claimed.get("pressure_event_id"),
            "agent_id": claimed.get("agent_id"),
            "reason": "lease_expired",
            "lease_expires_at": claimed.get("lease_expires_at"),
            "expiry_count": expiry_count,
            "recorded_at": recorded_at,
        }
        if requeue:
            row["released_at"] = recorded_at
        append_declared_jsonl(claims_path, row, expected_surface="dispatch_claims")
        append_tools_governance(
            root,
            "dispatch_claim_lease_expired",
            {
                "claim_id": claim_id,
                "assignment_id": assignment_id,
                "agent_id": claimed.get("agent_id"),
                "lease_expires_at": claimed.get("lease_expires_at"),
                "expiry_count": expiry_count,
                "disposition": disposition,
            },
        )
        pressure_event_id = claimed.get("pressure_event_id")
        if pressure_event_id and requeue:
            append_tools_governance(
                root,
                "dispatch_request_state_changed",
                {
                    "assignment_id": assignment_id,
                    "pressure_event_id": pressure_event_id,
                    "from_state": "picked_up",
                    "to_state": "pending",
                    "claim_id": claim_id,
                    "reason": "lease_expired",
                },
            )
        reaped["expired"].append(row)
        reaped[disposition].append(row)
    return reaped
