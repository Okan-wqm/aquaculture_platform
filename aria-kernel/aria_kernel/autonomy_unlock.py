from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


AUTONOMY_UNLOCK_SCHEMA = "aria/autonomy-unlock-policy/v1"
AUTONOMY_UNLOCK_POLICY_PATH = Path(__file__).resolve().parents[2] / "docs" / "aria" / "policy" / "autonomy-unlock.json"
ACCEPTANCE_EVENT_TYPES: frozenset[str] = frozenset({
    "observe_success",
    "l1_autonomous_success",
    "l2_supervised_success",
    "l2_autonomous_success",
    "l3_approval_success",
    "rollback_success",
    "critical_violation",
})


@dataclass(frozen=True)
class AutonomyUnlockVerdict:
    valid: bool
    lane: str
    counts: dict[str, int]
    requirements: dict[str, int]
    reasons: tuple[str, ...]


def load_autonomy_unlock_policy(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(policy) if policy is not None else json.loads(AUTONOMY_UNLOCK_POLICY_PATH.read_text(encoding="utf-8"))
    if payload.get("$schema") != AUTONOMY_UNLOCK_SCHEMA:
        raise GovernanceError("autonomy_unlock_policy_schema_must_be_v1")
    if payload.get("schema_version") != 1:
        raise GovernanceError("autonomy_unlock_policy_schema_version_must_be_1")
    if payload.get("critical_violation_limit") != 0:
        raise GovernanceError("autonomy_unlock_critical_violation_limit_must_be_zero")
    requirements = payload.get("lane_requirements")
    if not isinstance(requirements, dict):
        raise GovernanceError("autonomy_unlock_lane_requirements_required")
    for lane in ("L1", "L2", "L3"):
        if not isinstance(requirements.get(lane), dict):
            raise GovernanceError(f"autonomy_unlock_lane_required:{lane}")
    return payload


def record_acceptance_event(
    *,
    event_type: str,
    base_dir: str | Path | None = None,
    pr_number: int | None = None,
    head_sha: str | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    if event_type not in ACCEPTANCE_EVENT_TYPES:
        raise GovernanceError(f"autonomy_acceptance_event_type_unknown:{event_type}")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_id": f"{event_type}:{pr_number or 'global'}:{head_sha or 'none'}:{utc_now()}",
        "row_type": "enterprise_acceptance_event",
        "event_type": event_type,
        "status": "success" if event_type != "critical_violation" else "violation",
        "pr_number": pr_number,
        "head_sha": head_sha,
        "reason": reason,
    }
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "acceptance-events.jsonl",
        row,
        expected_surface="enterprise_acceptance_events",
    )


def evaluate_autonomy_unlock(
    *,
    lane: str,
    base_dir: str | Path | None = None,
    policy: dict[str, Any] | None = None,
) -> AutonomyUnlockVerdict:
    if lane not in {"L1", "L2", "L3"}:
        return AutonomyUnlockVerdict(
            valid=False,
            lane=lane,
            counts={},
            requirements={},
            reasons=(f"autonomy_unlock_lane_not_supported:{lane}",),
        )
    active = load_autonomy_unlock_policy(policy)
    rows = load_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "acceptance-events.jsonl",
        expected_surface="enterprise_acceptance_events",
    )
    counts = {
        "observe_successes": _count(rows, "observe_success"),
        "l1_autonomous_successes": _count(rows, "l1_autonomous_success"),
        "l2_supervised_successes": _count(rows, "l2_supervised_success"),
        "l2_autonomous_successes": _count(rows, "l2_autonomous_success"),
        "l3_approval_successes": _count(rows, "l3_approval_success"),
        "rollback_successes": _count(rows, "rollback_success"),
        "critical_violations": _count(rows, "critical_violation", status="violation"),
    }
    requirements = {
        str(key): int(value)
        for key, value in (active["lane_requirements"][lane] or {}).items()
    }
    reasons: list[str] = []
    if counts["critical_violations"] != 0:
        reasons.append("autonomy_unlock_critical_violation_present")
    for key, required in requirements.items():
        if counts.get(key, 0) < required:
            reasons.append(f"autonomy_unlock_threshold_missing:{key}:{counts.get(key, 0)}/{required}")
    return AutonomyUnlockVerdict(
        valid=not reasons,
        lane=lane,
        counts=counts,
        requirements=requirements,
        reasons=tuple(reasons),
    )


def assert_autonomy_unlocked(
    *,
    lane: str,
    base_dir: str | Path | None = None,
    policy: dict[str, Any] | None = None,
) -> AutonomyUnlockVerdict:
    verdict = evaluate_autonomy_unlock(lane=lane, base_dir=base_dir, policy=policy)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "row_id": f"unlock:{lane}:{utc_now()}",
        "row_type": "enterprise_autonomy_unlock_verdict",
        "lane": lane,
        "valid": verdict.valid,
        "counts": verdict.counts,
        "requirements": verdict.requirements,
        "reasons": list(verdict.reasons),
    }
    append_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "autonomy-unlock-events.jsonl",
        row,
        expected_surface="enterprise_autonomy_unlock_events",
    )
    if not verdict.valid:
        raise GovernanceError("autonomy_unlock_required_for_merge: " + "; ".join(verdict.reasons))
    return verdict


def _count(rows: list[dict[str, Any]], event_type: str, *, status: str = "success") -> int:
    return sum(1 for row in rows if row.get("event_type") == event_type and row.get("status") == status)


__all__ = [
    "ACCEPTANCE_EVENT_TYPES",
    "AutonomyUnlockVerdict",
    "assert_autonomy_unlocked",
    "evaluate_autonomy_unlock",
    "load_autonomy_unlock_policy",
    "record_acceptance_event",
]
