from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl
from .mission import assert_wip_available
from .plan_convergence import plan_status
from .runtime_artifacts import ARTIFACT_BEARING, classify_cycle_evidence, verify_runtime_artifacts
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_binding, utc_now
from .worker_dispatch import active_dispatch_assignments
from .workspace import WorkspacePaths


def promote_converged_plan_to_dispatch(
    paths: WorkspacePaths,
    *,
    plan_id: str,
    cycle_id: str,
    pressure_event_id: str | None = None,
    tools_root: str | Path | None = None,
    target_agent: str | None = None,
    base_sha: str | None = None,
    impact_ref: str | None = None,
    validation_ref: str | None = None,
    allowed_scope: list[str] | None = None,
    forbidden_scope: list[str] | None = None,
    acknowledge: bool = False,
) -> dict[str, Any]:
    """Gate a converged plan before worker dispatch materialization."""
    from .runtime_profile import enforce_profile_for_write
    enforce_profile_for_write("plan_promotion_dispatch", base_dir=tools_root)
    root = ensure_tools_binding(tools_root, workspace_root=paths.repo_root)
    blockers: list[str] = []

    # PLAN Wave 2 PR 1.4 / ORPHAN-HIGH-487 — the WIP gate, FIRST, before any
    # per-plan check. The operator rule it enforces (2026-07-28) is that ARIA
    # must not start a new plan before the current one is completely finished.
    #
    # Order matters for the refusal a human reads: a second promotion attempted
    # while work is in flight would otherwise report whatever the candidate
    # plan's own state happens to be and hide the real reason.
    #
    # TWO POPULATIONS, both real. Dispatch assignments are today's in-flight
    # record — the finding proposed `list_active_plans()`, but promotion writes
    # no plan event, so a promoted plan stays CONVERGED, which
    # `list_active_plans` treats as terminal; that gate could never have fired.
    # Mission WIP is the record the mission layer is taking over, live from the
    # moment plans carry mission ids.
    in_flight = active_dispatch_assignments(base_dir=root)
    if in_flight:
        blockers.append("dispatch_wip_unavailable")
    mission_wip_error: str | None = None
    try:
        assert_wip_available(base_dir=root)
    except GovernanceError as exc:
        mission_wip_error = str(exc)
        blockers.append("mission_wip_unavailable")

    state = plan_status(plan_id=plan_id, base_dir=root)
    if state.get("state") != "CONVERGED":
        blockers.append("plan_not_converged")
    converged_plan_hash = _converged_plan_hash(state)
    if not converged_plan_hash:
        blockers.append("missing_converged_plan_hash")
    base_sha = base_sha or _git_head(paths.repo_root)
    if not base_sha:
        blockers.append("missing_base_sha")
    if not impact_ref:
        blockers.append("missing_impact_ref")
    if not validation_ref:
        blockers.append("missing_validation_ref")
    artifact_check = verify_runtime_artifacts(base_dir=root, cycle_id=cycle_id)
    evidence_class = classify_cycle_evidence(base_dir=root, cycle_id=cycle_id)
    if artifact_check.get("status") != "ok":
        blockers.append("evidence_integrity_failed")
    if evidence_class.get("cycle_evidence_class") != ARTIFACT_BEARING:
        blockers.append("cycle_not_artifact_bearing")
    if blockers:
        event = append_tools_governance(
            root,
            "plan_promotion_blocked",
            {
                "plan_id": plan_id,
                "pressure_event_id": pressure_event_id,
                "cycle_id": cycle_id,
                "blockers": blockers,
                "artifact_issues": artifact_check.get("issues", []),
                "cycle_evidence_class": evidence_class.get("cycle_evidence_class"),
                # A refusal that does not name what is holding the slot is a
                # refusal an operator cannot act on.
                "in_flight_assignment_ids": [
                    row["assignment_id"] for row in in_flight
                ],
                "mission_wip_error": mission_wip_error,
            },
        )
        return {
            "schema_version": 1,
            "status": "blocked",
            "plan_id": plan_id,
            "pressure_event_id": pressure_event_id,
            "blockers": blockers,
            "governance_event_id": event.get("event_id"),
        }
    if not acknowledge:
        raise GovernanceError("promote_converged_plan_requires_acknowledge")
    pressure_event_id = pressure_event_id or f"plan-promotion:{plan_id}:{cycle_id}"
    assignment_id = _assignment_id(plan_id, pressure_event_id, target_agent or "aria-worker")
    row = {
        "$schema": "aria/dispatch-request/v2",
        "schema_version": 2,
        "assignment_id": assignment_id,
        "pressure_event_id": pressure_event_id,
        "target_agent": target_agent or "aria-worker",
        "triage_tier": "needs_review",
        "worktree_path": (paths.repo_root / "aria-worktrees" / assignment_id).as_posix(),
        "base_sha": base_sha,
        "required_tests": _validation_commands_from_ref(validation_ref),
        "expected_trailer": "Addresses-Pressure: " + pressure_event_id,
        "state": "pending",
        "created_at": utc_now(),
        "plan_id": plan_id,
        "cycle_id": cycle_id,
        "converged_plan_hash": converged_plan_hash,
        "impact_ref": impact_ref,
        "validation_ref": validation_ref,
        "allowed_scope": list(allowed_scope or ["aria-kernel/**", "aria-tools/**", ".claude/**"]),
        "forbidden_scope": list(forbidden_scope or ["apps/**", "libs/**", "platform/**"]),
        "artifact_verification_ref": {
            "verified_artifact_count": artifact_check.get("verified_artifact_count", 0),
            "cycle_evidence_class": evidence_class.get("cycle_evidence_class"),
        },
    }
    stored = append_declared_jsonl(
        root / "dispatch" / "requests.jsonl",
        row,
        expected_surface="dispatch_requests",
    )
    append_tools_governance(
        root,
        "plan_promoted_to_dispatch",
        {
            "assignment_id": assignment_id,
            "pressure_event_id": pressure_event_id,
            "plan_id": plan_id,
            "cycle_id": cycle_id,
            "converged_plan_hash": converged_plan_hash,
            "base_sha": base_sha,
        },
    )
    return stored


def _converged_plan_hash(state: dict[str, Any]) -> str | None:
    latest = state.get("latest_revision") or {}
    value = latest.get("content_hash")
    if isinstance(value, str) and value.startswith("sha256:"):
        return value
    payload = state.get("plan_started") or {}
    if payload:
        return "sha256:" + hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8"),
        ).hexdigest()
    return None


def _assignment_id(plan_id: str, pressure_event_id: str, target_agent: str) -> str:
    raw = f"{plan_id}:{pressure_event_id}:{target_agent}:{utc_now()}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]
    slug = "".join(ch if ch.isalnum() else "-" for ch in target_agent.lower()).strip("-")[:32] or "worker"
    return f"A-{slug}-{digest}"


def _git_head(repo_root: Path) -> str | None:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        return None
    return completed.stdout.strip() or None


def _validation_commands_from_ref(validation_ref: str | None) -> list[str]:
    if not validation_ref:
        return []
    path = Path(validation_ref)
    if path.exists() and path.is_file():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        commands = payload.get("validation_commands") or payload.get("commands") or []
        if isinstance(commands, list):
            return [str(cmd) for cmd in commands if isinstance(cmd, str) and cmd.strip()]
    return [str(validation_ref)]


__all__ = ["promote_converged_plan_to_dispatch"]
