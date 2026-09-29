from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .ledger import LedgerIntegrityError, append_declared_jsonl, load_declared_jsonl
from .runtime_profile import (
    DEFAULT_SCHEDULER_PROFILE_CEILING,
    PROFILES_WITH_ACTION_AUTHORITY,
    SCHEDULER_MAX_PROPOSABLE_PROFILE,
    bound_profile_to_ceiling,
    get_profile,
    get_scheduler_profile_ceiling_with_diagnostic,
)
from .tool_registry import (
    GovernanceError,
    ensure_tools_dir,
    parse_utc_stamp as _parse_stamp,
    utc_now,
)


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


# The nightly lane runs once a day. Three days of slack absorbs a delayed
# GitHub schedule (this repository's cron routinely slips ~2.5h) or a
# single skipped night, without accepting a hole big enough to mean the
# lane stopped. ORPHAN-HIGH-530's outage was seventeen days.
MAX_ACCEPTANCE_GAP_HOURS = 72


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


def _continuity_reasons(
    rows: list[dict[str, Any]],
    *,
    now: datetime | None,
    max_gap_hours: int,
) -> list[str]:
    """Refusals for evidence that is COUNTED but not CONSECUTIVE.

    ORPHAN-HIGH-530. The ladder's premise is "N consecutive clean cycles
    demonstrate stability", and counting cannot see a hole: thirty
    successes spanning a seventeen-day outage satisfy a threshold of
    thirty exactly as well as thirty consecutive nightly ones do. ARIA's
    own nightly lane was dead for seventeen days while the watchdog said
    so hourly into issue #1005, and nothing in the kernel read that — the
    accumulated evidence stayed valid the whole time and would have gone
    on unlocking as if operation had been continuous.

    This is deliberately NOT a second watchdog. Detection already exists
    and works; the missing half was a consumer, and the rows carry their
    own timestamps, so the question is answerable from ARIA's own ledger
    with no GitHub call and nothing to keep in sync.

    An empty ledger produces no reason here: there is nothing to be
    discontinuous about, and the threshold refusal is the honest one.
    """
    stamps: list[datetime] = []
    for index, row in enumerate(rows):
        raw = row.get("recorded_at")
        parsed = _parse_stamp(raw) if isinstance(raw, str) else None
        if parsed is None:
            # REFUSED, not skipped. Dropping an undateable row would let a
            # malformed or hand-written entry bridge a gap the timestamps
            # would otherwise expose — the chain would be checked against
            # a version of itself with the inconvenient parts removed.
            return [
                f"autonomy_unlock_continuity_row_undateable:index={index}:"
                f"recorded_at={raw!r}"
            ]
        stamps.append(parsed)
    if not stamps:
        return []

    stamps.sort()
    reasons: list[str] = []
    limit = timedelta(hours=max_gap_hours)
    for earlier, later in zip(stamps, stamps[1:]):
        gap = later - earlier
        if gap > limit:
            reasons.append(
                "autonomy_unlock_continuity_gap:"
                f"{int(gap.total_seconds() // 3600)}h>{max_gap_hours}h "
                f"between {earlier.strftime('%Y-%m-%dT%H:%M:%SZ')} and "
                f"{later.strftime('%Y-%m-%dT%H:%M:%SZ')}"
            )
    if now is not None:
        # The same rule applied to the open end. Thirty perfect cycles
        # that all ended a month ago describe a system that WAS stable,
        # which is not the claim an unlock rests on.
        since = now - stamps[-1]
        if since > limit:
            reasons.append(
                "autonomy_unlock_continuity_stale:"
                f"{int(since.total_seconds() // 3600)}h>{max_gap_hours}h "
                f"since {stamps[-1].strftime('%Y-%m-%dT%H:%M:%SZ')}"
            )
    return reasons


def verdict_from_rows(
    rows: list[dict[str, Any]],
    *,
    lane: str,
    policy: dict[str, Any] | None = None,
    now: datetime | None = None,
    max_gap_hours: int = MAX_ACCEPTANCE_GAP_HOURS,
) -> AutonomyUnlockVerdict:
    """Compute an unlock verdict from already-loaded acceptance-event rows.

    Plan 031 §031a — extracted so the burn-in→ladder bridge can evaluate the
    SEPARATE mock-mode ledger with the IDENTICAL counting + threshold logic,
    without the real ``evaluate_autonomy_unlock`` ever reading the mock ledger.
    The real and mock paths thus share one rule and one policy, but two ledgers.
    """
    if lane not in {"L1", "L2", "L3"}:
        return AutonomyUnlockVerdict(
            valid=False,
            lane=lane,
            counts={},
            requirements={},
            reasons=(f"autonomy_unlock_lane_not_supported:{lane}",),
        )
    active = load_autonomy_unlock_policy(policy)
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
    # Continuity over the SUCCESS rows the thresholds count. A violation
    # row is not part of the "consecutive clean cycles" claim, so its
    # timestamp must not be able to bridge a gap between them.
    reasons.extend(
        _continuity_reasons(
            [row for row in rows if str(row.get("status")) == "success"],
            now=now,
            max_gap_hours=max_gap_hours,
        )
    )
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
    rows = load_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "acceptance-events.jsonl",
        expected_surface="enterprise_acceptance_events",
    )
    return verdict_from_rows(rows, lane=lane, policy=policy)


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


@dataclass(frozen=True)
class ScheduledProfileDecision:
    """What authority an UNATTENDED lane runs under tonight, and why.

    ``ladder_profile`` / ``l1_valid`` are None when the ladder was never
    consulted — an operator hold short-circuits before the read, and the
    difference between "the ladder said no" and "the ladder was not asked"
    is exactly what an auditor needs from this row.
    """

    profile: str
    persisted: str
    ceiling: str
    ladder_profile: str | None
    l1_valid: bool | None
    counts: dict[str, int]
    reasons: tuple[str, ...]


def resolve_scheduled_profile(
    *,
    lane: str = "L1",
    base_dir: str | Path | None = None,
    policy: dict[str, Any] | None = None,
) -> ScheduledProfileDecision:
    """ORPHAN-HIGH-728 — the profile a scheduled lane may run, decided ONCE.

    Three inputs, in this order, and the order is the point:

    1. THE OPERATOR'S HOLD. A persisted profile outside
       ``PROFILES_WITH_ACTION_AUTHORITY`` (frozen, observe — named by
       construction, never by a hand-written list) is returned untouched and
       the ladder is never read. Reading it first is not an optimisation: the
       ladder read goes through ``ensure_tools_dir``, which mkdirs, rewrites
       the tools index and can bootstrap identity files. A frozen kernel is
       one an operator stopped, and the gate that decides whether to honour
       the stop must not write to the store on its way to asking.

    2. THE OPERATOR'S CEILING. ``scheduler_profile_ceiling`` (default
       ``standard``) is the authority a human granted unattended lanes. It is
       the only ceiling here: evidence cannot raise it.

    3. THE EVIDENCE. The existing L1 acceptance ladder proposes at most
       ``SCHEDULER_MAX_PROPOSABLE_PROFILE`` and the result is
       ``bound_profile_to_ceiling(proposal, ceiling)`` — the ladder chooses
       WITHIN the grant, never above it.

    A ladder that cannot be READ demotes to ``standard`` with a named reason
    instead of raising. The caller is a nightly job under ``set -euo
    pipefail``: an exception there costs the whole night's discovery to
    protect an authority the demotion already withholds. The catch is narrow
    (the ledger's own failure modes), the reason is carried out to the caller,
    and no other exception class is swallowed.
    """
    reasons: list[str] = []
    # Both reads are read-only (`ensure_tools_dir_readonly`), so they are
    # safe to take BEFORE the hold is honoured — unlike the ladder read
    # below. Reporting the recorded ceiling even on a hold keeps the summary
    # from telling an operator their grant is `standard` when they wrote
    # something else.
    persisted = get_profile(base_dir=base_dir)
    ceiling, ceiling_diagnostic = get_scheduler_profile_ceiling_with_diagnostic(
        base_dir=base_dir,
    )
    if ceiling_diagnostic is not None:
        reasons.append(
            f"{ceiling_diagnostic['kind']}:"
            f"{ceiling_diagnostic.get('scheduler_profile_ceiling')!r}"
        )
    if persisted not in PROFILES_WITH_ACTION_AUTHORITY:
        return ScheduledProfileDecision(
            profile=persisted,
            persisted=persisted,
            ceiling=ceiling,
            ladder_profile=None,
            l1_valid=None,
            counts={},
            reasons=tuple(
                [*reasons, f"operator_held_profile_preserved:{persisted}"]
            ),
        )
    try:
        verdict = evaluate_autonomy_unlock(
            lane=lane, base_dir=base_dir, policy=policy,
        )
    except (LedgerIntegrityError, OSError, ValueError) as exc:
        # `repr` and not `str`: this reason carries a LEDGER-DERIVED message
        # and reaches a GitHub Actions annotation, where a raw newline would
        # end the `::warning::` line and let the remainder be read as a
        # further workflow command. Escaping at the point the string is built
        # keeps every consumer safe instead of each one remembering to.
        reasons.append(
            f"l1_ladder_unreadable:{type(exc).__name__}:{str(exc)[:200]!r}"
        )
        proposal = DEFAULT_SCHEDULER_PROFILE_CEILING
        l1_valid: bool | None = False
        counts: dict[str, int] = {}
    else:
        l1_valid = verdict.valid
        counts = verdict.counts
        proposal = (
            SCHEDULER_MAX_PROPOSABLE_PROFILE
            if verdict.valid
            else DEFAULT_SCHEDULER_PROFILE_CEILING
        )
        reasons.extend(verdict.reasons)
    profile = bound_profile_to_ceiling(proposal, ceiling)
    if profile != proposal:
        reasons.append(
            f"scheduler_ceiling_bound:proposed={proposal}:ceiling={ceiling}"
        )
    if not reasons:
        reasons.append("l1_unlock_valid")
    return ScheduledProfileDecision(
        profile=profile,
        persisted=persisted,
        ceiling=ceiling,
        ladder_profile=proposal,
        l1_valid=l1_valid,
        counts=counts,
        reasons=tuple(reasons),
    )


def _count(rows: list[dict[str, Any]], event_type: str, *, status: str = "success") -> int:
    return sum(1 for row in rows if row.get("event_type") == event_type and row.get("status") == status)


__all__ = [
    "ACCEPTANCE_EVENT_TYPES",
    "AutonomyUnlockVerdict",
    "ScheduledProfileDecision",
    "resolve_scheduled_profile",
    "assert_autonomy_unlocked",
    "evaluate_autonomy_unlock",
    "verdict_from_rows",
    "load_autonomy_unlock_policy",
    "record_acceptance_event",
]
