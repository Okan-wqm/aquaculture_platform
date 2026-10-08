"""Empty-cycle guard (Plan 016 Faz D8).

Why: Plan 016's convergent planning loop is expensive (5 rounds x 2
decision-tier planners). Issuing it for an empty cycle — no fresh
pressure above threshold, no operator-facing findings to act on, no
queued plans — burns budget without producing operator value. The
guard is a pure read-only check the kernel CLI exposes so an
orchestrator (or operator) can short-circuit before spending on
planner envelopes.

Distinct from the existing `discovery_dirty_tree_skipped` event in
discovery.py: that event blocks discovery on a dirty tree (a
SAFETY guard); the cycle guard is a COST guard that runs AFTER
discovery + pressure scoring to decide whether the next-step
convergent planning is worth firing.
"""
from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from .debt import debts_dir
from .finding import BACKLOG_STATUSES, findings_dir
from .ledger import load_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, parse_utc_stamp


# Default threshold below which a pressure record is treated as "noise"
# for empty-cycle purposes. Plan 007 §Pressure Scoring caps scores at
# 100; 30 is the operational threshold the daily-report next-cycle plan
# uses to decide whether a pressure is worth listing as actionable.
DEFAULT_PRESSURE_THRESHOLD = 30.0


@dataclass(frozen=True)
class CycleEmptiness:
    """Result of evaluating whether a cycle should fire convergent planning.

    `is_empty=True` means the orchestrator MAY short-circuit; the kernel
    does not block — it advises. The orchestrator records its own
    decision (run anyway / skip / defer) so the trail stays auditable.
    """

    cycle_id: str
    is_empty: bool
    pressure_count_above_threshold: int
    pressure_threshold: float
    open_findings: int
    open_debts: int
    reason: str


class CycleGuardRefusal(GovernanceError):
    """ARIA-MEDIUM-230 — the guard cannot see the backlog it was asked about.

    Every unresolvable input used to read as ZERO: no bound repository, a
    bound path that no longer exists, an index that would not parse. Zero
    open findings and zero debts is exactly the verdict that lets a caller
    skip the cycle, so the guard advised "empty" over a backlog it never
    read. It refuses by name instead; the CLI prints the refusal and exits
    3, which is neither "work to do" (0) nor "empty" (2).
    """


def _read_index(index: Path) -> dict[str, Any]:
    """An index that does not exist is an empty backlog; one that exists and
    cannot be read is a refusal."""
    if not index.exists():
        return {}
    try:
        payload = json.loads(index.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CycleGuardRefusal(
            f"cycle_guard_index_unreadable:{index.as_posix()}:{type(exc).__name__}"
        ) from exc
    if not isinstance(payload, dict):
        raise CycleGuardRefusal(f"cycle_guard_index_unreadable:{index.as_posix()}:not_an_object")
    return payload


def _open_finding_count(repo_root: Path) -> int:
    # ARIA-HIGH-191: through the seam the writers use, so a redirected
    # state store is counted, not the checkout's stale copy.
    # E25-a (ORPHAN-710) — IN_PROGRESS counts as backlog: work someone has
    # started is still unfinished work. The emptiness guard reads the same
    # truth (a cycle with in-progress work is not empty).
    return len(_backlog_index_rows(repo_root))


def _backlog_index_rows(repo_root: Path) -> list[dict[str, Any]]:
    payload = _read_index(findings_dir(repo_root) / "_index.json")
    rows = payload.get("findings") or []
    return [r for r in rows if isinstance(r, dict) and r.get("status") in BACKLOG_STATUSES]


# Wall #7 — who opens findings, by the origin families their findings carry
# (finding.ORIGINATING_SKILL_ALLOWLIST). The closure SLO throttles an opener
# only when ITS findings grew the closable backlog; the cap throttles every
# opener. Operator origins are never throttled. A test pins the partition:
# every allowlisted origin has exactly one opener or is an operator act.
FINDING_OPENERS: dict[str, tuple[str, ...]] = {
    "watchdog_sweep": ("aria-watchdog:",),
    "experiment_author": (),  # mints bench work; opens no finding itself
    "judgment_fanout": ("ai_consensus:",),
    "seed_drift_findings": ("seed:drift-scan",),
    # ARIA-HIGH-279 — the deterministic class builder (CB-3) is an ARIA
    # producer (not in finding.EXTERNAL_ORIGINATING_SKILLS), so its exact
    # origin is throttled like every other ARIA opener. finding.py admits the
    # origin ahead of its emitter; the CB-3 emitter admits through
    # admit_finding_opener(..., "class_builder", ...) under this name.
    "class_builder": ("class_builder:tool_rule",),
}
FINDING_OPERATOR_ORIGINS: tuple[str, ...] = ("manual:operator", "report_ingestion:")
OPENER_THROTTLE_KIND = "finding_opener_throttled"
OPERATOR_ESCALATION_KIND = "finding_operator_escalated"
# Bounded reverse reads: escalations are once per finding, throttle rows once
# per admission or changed claim, so the newest few thousand hold the answer.
_GOVERNANCE_SCAN_LIMIT = 4096


def _utc(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def backlog_census(repo_root: str | Path, *, now: datetime | None = None) -> dict[str, Any]:
    """Wall #7 — the backlog split by who can close it, and its closure SLO.

    E25-a counted every OPEN/IN_PROGRESS finding against the cap, so findings
    only an operator can close (all surfaces under READONLY_PATHS) froze
    discovery. Each backlog finding is judged by the one closability rule,
    ``finding_grounding.closure_blocker``: closable, operator-only (an
    admission refusal; counted apart with its age) or undecided (a runner
    fault). ``capped`` = closable + undecided — the brake fails closed when
    it cannot judge; with no event ledger every index row is undecided. The
    SLO reads ``finding.backlog_flow``. A pure read shared by the cycle's
    census phase, the doctor and the chain.
    """
    from .finding import backlog_flow
    from .finding_grounding import RUNNER_FAULT_REASONS, closure_blocker, load_grounding_context
    from .genesis_policy import rhythm_policy

    root, moment = Path(repo_root), now or datetime.now(timezone.utc)
    policy = rhythm_policy(root)
    context = load_grounding_context(root)
    closable: list[str] = []
    undecided: list[dict[str, Any]] = []
    operator_only: list[dict[str, Any]] = []
    origin: dict[str, str] = {}
    if context.findings is None:
        undecided = [{"finding_id": r.get("finding_id"), "reason": context.fold_fault}
                     for r in _backlog_index_rows(root)]
    for finding_id, record in sorted((context.findings or {}).items()):
        origin[finding_id] = str(record.get("originating_skill") or "")
        if record.get("status") not in BACKLOG_STATUSES:
            continue
        reason = closure_blocker(context, finding_id)
        if reason is None:
            closable.append(finding_id)
        elif reason in RUNNER_FAULT_REASONS:
            undecided.append({"finding_id": finding_id, "reason": reason})
        else:
            created = parse_utc_stamp(record.get("created_at"))
            operator_only.append({
                "finding_id": finding_id, "reason": reason, "created_at": record.get("created_at"),
                "age_days": None if created is None else round((moment - created).total_seconds() / 86400, 1),
            })
    window = int(policy["closure_slo_window_days"])
    flow = backlog_flow(root, since=moment - timedelta(days=window)) or {"opened": [], "closed": []}
    blocked = {row["finding_id"] for row in operator_only}
    opened = [finding_id for finding_id in flow["opened"] if finding_id not in blocked]
    by_origin = dict(Counter(origin.get(finding_id, "") for finding_id in opened))
    return {
        "schema_version": 1, "backlog_cap": int(policy["backlog_cap"]),
        "capped": len(closable) + len(undecided), "closable": closable, "undecided": undecided,
        "operator_only": operator_only, "fault": context.fold_fault,
        "slo": {"window_days": window, "opened_closable": len(opened), "closed": len(flow["closed"]),
                "opened_by_origin": by_origin, "breached": len(opened) > len(flow["closed"])},
        "opener_throttle_interval_hours": float(policy["opener_throttle_interval_hours"]),
        "operator_escalation_age_days": int(policy["operator_escalation_age_days"]),
    }


def escalate_operator_only(base_dir: str | Path | None, census: Mapping[str, Any]) -> list[str]:
    """Wall #7 — one governance row per operator-only finding past the declared
    age (finding, the refusal that needs an operator, age). Never repeated for
    a finding, and it pauses or throttles nothing."""
    from .governance_reader import read_governance_rows_reverse

    limit = census["operator_escalation_age_days"]
    due = [row for row in census["operator_only"] if row["age_days"] is not None and row["age_days"] >= limit]
    if not due:
        return []
    root = ensure_tools_dir(base_dir)
    seen = {(row.get("details") or {}).get("finding_id") for row in read_governance_rows_reverse(
        base_dir=root, limit=_GOVERNANCE_SCAN_LIMIT, kind_filter=(OPERATOR_ESCALATION_KIND,))}
    escalated: list[str] = []
    for row in due:
        if row["finding_id"] not in seen:
            append_tools_governance(root, OPERATOR_ESCALATION_KIND, {**row, "age_limit_days": limit})
            escalated.append(row["finding_id"])
    return escalated


@dataclass(frozen=True)
class OpenerAdmission:
    """Whether one finding opener may run now, and the pressure that decided it."""

    opener: str
    admitted: bool
    reasons: tuple[str, ...] = ()
    next_admission_at: str | None = None


def _opener_pressure(opener: str, census: Mapping[str, Any] | None) -> tuple[str, ...]:
    if census is None:
        return ("backlog_census_unavailable",)
    reasons = ["closable_backlog_at_cap"] if census["capped"] >= census["backlog_cap"] else []
    slo = census["slo"]
    if slo["breached"] and any(origin.startswith(FINDING_OPENERS[opener]) for origin in slo["opened_by_origin"]):
        reasons.append("closure_slo_breached")
    return tuple(reasons)


def admit_finding_opener(
    base_dir: str | Path | None, opener: str, census: Mapping[str, Any] | None, *, now: datetime | None = None,
) -> OpenerAdmission:
    """Wall #7 — throttle a finding opener under backlog pressure: a rate, never a freeze.

    Pressure is the closable backlog at the cap (every opener), or a breached
    closure SLO whose window openings came from THIS opener's origins. Under
    pressure the opener is admitted once per ``opener_throttle_interval_hours``,
    measured from its last recorded admission; every admission and every
    change of a held claim is a ``finding_opener_throttled`` governance row
    naming the reasons, the counts and the next admission time. Without a
    census (the census phase failed) the shipped interval applies. An
    admission that cannot be recorded leaves no proof of the rate, so it holds.
    """
    from .genesis_policy import RHYTHM_DEFAULTS
    from .governance_reader import read_governance_rows_reverse

    if opener not in FINDING_OPENERS:
        raise GovernanceError(f"finding_opener_unknown:{opener}")
    reasons = _opener_pressure(opener, census)
    if not reasons:
        return OpenerAdmission(opener, True)
    moment = now or datetime.now(timezone.utc)
    interval = timedelta(hours=float((census or RHYTHM_DEFAULTS)["opener_throttle_interval_hours"]))
    root = ensure_tools_dir(base_dir)
    try:
        rows = [row["details"] for row in read_governance_rows_reverse(
            base_dir=root, limit=_GOVERNANCE_SCAN_LIMIT, kind_filter=(OPENER_THROTTLE_KIND,),
        ) if isinstance(row.get("details"), dict) and row["details"].get("opener") == opener]
    except (GovernanceError, OSError):
        return OpenerAdmission(opener, False, (*reasons, "throttle_history_unreadable"))
    last = next((parse_utc_stamp(row.get("decided_at")) for row in rows if row.get("admitted")), None)
    admitted = last is None or moment - last >= interval
    details = {
        "opener": opener, "admitted": admitted, "reasons": list(reasons), "decided_at": _utc(moment),
        "next_admission_at": _utc(moment + interval if admitted else last + interval),
        "interval_hours": interval.total_seconds() / 3600,
        "capped": census["capped"] if census else None, "backlog_cap": census["backlog_cap"] if census else None,
        "slo": census["slo"] if census else None,
    }
    claim = ("admitted", "reasons", "next_admission_at", "capped", "slo")
    if admitted or not rows or any(rows[0].get(key) != details[key] for key in claim):
        try:
            append_tools_governance(root, OPENER_THROTTLE_KIND, details)
        except (GovernanceError, OSError):
            return OpenerAdmission(opener, False, (*reasons, "throttle_record_unwritable"))
    return OpenerAdmission(opener, admitted, reasons, details["next_admission_at"])


def _open_debt_count(repo_root: Path) -> int:
    payload = _read_index(debts_dir(repo_root) / "_index.json")
    rows = payload.get("debts") or []
    return sum(1 for r in rows if isinstance(r, dict) and r.get("current_status") in {"OPEN", "IN_PROGRESS"})


def _resolve_repo_root(tools_root: Path, override: str | Path | None) -> Path:
    """The checkout the backlog is read through, or a named refusal.

    ``--workspace-root`` when given (it must exist); otherwise the tools
    root's bound repository, which must be bound and must still exist.
    Under ``ARIA_REPO_STATE_ROOT`` the findings and debts live in the store
    and the seam ignores the checkout path — but an unbound or stale
    identity is still a tools root that cannot say which repository's
    backlog it holds, and it used to turn into a count of zero.
    """
    if override is not None:
        candidate = Path(override)
        if not candidate.exists():
            raise CycleGuardRefusal(f"cycle_guard_workspace_root_missing:{candidate.as_posix()}")
        return candidate
    identity = tools_root / "repo_identity.json"
    if not identity.exists():
        raise CycleGuardRefusal(f"cycle_guard_repo_identity_missing:{identity.as_posix()}")
    try:
        payload = json.loads(identity.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CycleGuardRefusal(
            f"cycle_guard_repo_identity_unreadable:{identity.as_posix()}:{type(exc).__name__}"
        ) from exc
    bound = payload.get("bound_repo_root") if isinstance(payload, dict) else None
    if not bound:
        raise CycleGuardRefusal(f"cycle_guard_repo_identity_unbound:{identity.as_posix()}")
    candidate = Path(str(bound))
    if not candidate.exists():
        raise CycleGuardRefusal(f"cycle_guard_repo_identity_stale:{candidate.as_posix()}")
    return candidate


def evaluate_cycle_emptiness(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
    repo_root_override: str | Path | None = None,
    pressure_threshold: float = DEFAULT_PRESSURE_THRESHOLD,
) -> CycleEmptiness:
    """Decide whether a cycle is empty enough to skip convergent planning.

    Empty when ALL of these hold:
    - no recorded pressure for `cycle_id` has score >= `pressure_threshold`;
    - no `aria-findings/F-*.json` is in OPEN status;
    - no `aria-debts/DEBT-*.json` is OPEN or IN_PROGRESS.

    Returns a `CycleEmptiness` record with the count breakdown so the
    operator can audit the decision.
    """
    tools_root = ensure_tools_dir(base_dir)
    repo_root = _resolve_repo_root(tools_root, repo_root_override)

    pressure_path = tools_root / "pressure" / f"{cycle_id}.json"
    pressures: list[dict[str, Any]] = []
    if pressure_path.exists():
        try:
            payload = json.loads(pressure_path.read_text(encoding="utf-8"))
            pressures = payload.get("pressures") or []
            if not isinstance(pressures, list):
                pressures = []
        except (OSError, json.JSONDecodeError):
            pressures = []
    above = sum(
        1 for p in pressures
        if isinstance(p, dict) and isinstance(p.get("score"), (int, float)) and float(p["score"]) >= pressure_threshold
    )

    open_findings = _open_finding_count(repo_root)
    open_debts = _open_debt_count(repo_root)

    is_empty = above == 0 and open_findings == 0 and open_debts == 0
    if is_empty:
        reason = (
            f"no pressure>={pressure_threshold}, no open findings, no open debts"
        )
    else:
        parts = []
        if above > 0:
            parts.append(f"{above} pressure>={pressure_threshold}")
        if open_findings > 0:
            parts.append(f"{open_findings} open findings")
        if open_debts > 0:
            parts.append(f"{open_debts} open debts")
        reason = "non-empty: " + ", ".join(parts)

    return CycleEmptiness(
        cycle_id=cycle_id,
        is_empty=is_empty,
        pressure_count_above_threshold=above,
        pressure_threshold=pressure_threshold,
        open_findings=open_findings,
        open_debts=open_debts,
        reason=reason,
    )
