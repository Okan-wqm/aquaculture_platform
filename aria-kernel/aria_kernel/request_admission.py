"""ARIA-HIGH-364 — the one door every agent request is minted through.

WHY. Measured 2026-10-06 (the RCA's blocker 2): ARIA minted ~66 requests a
day and the executor drained ~28; the ledger held 1,866 rows of which 836
died ANCHOR_STALE and 606 were never claimed, and 325 were minted while the
executor workflow was disabled (09-27..10-04). Eleven producers minted
independently; none could see the drain or whether anything was draining.

WHAT. ``admit_request(producer, role, ...)`` is the decision and the mint
(``agent_invocations.create_agent_invocation_request``) requires its
``Admission`` — a request without one cannot be written. Every producer is
classified in ``PRODUCER_CLASSES``, per role, with no default:

* ``critical_path`` — steps of work already in flight (plan rounds, the
  remint of a dead step, implementation of a CONVERGED plan, its reviews)
  and operator-driven mints. Always admitted and recorded: throttling them
  would stall the very work that drains the backlog and closes findings.
* ``discretionary`` — work that STARTS something (judge and adjudication
  panels, goldset curation, change intelligence, decision questioning, queue
  projections, new-plan seeding, genesis authoring runs). Admitted only while
  the executor drains (``request_drain_capacity``), the role has a provider
  that is not cooled (``provider_outage``), and the claimable backlog stays
  within ``budget = max(backlog_floor, backlog_days_of_drain × drain/day)``.

A refusal is named (``request_admission_throttled:<reason>``), recorded on
``agent-invocations/admissions.jsonl`` once per (cycle, producer, role,
reason), and disclosed on governance once per (cycle, role). An admission is
recorded by the mint, in the request's own transaction, only for an identity
that was new. Each producer re-derives what it did not mint on its next cycle
(``ProducerClass.re_offer``). One new plan per cycle is admitted ahead of the
budget (``SEED_QUOTA_PRODUCERS``) so panels and judges cannot starve planning.
The finding-opener throttle (``cycle_guard``, wall #7) is a separate door for
findings, not requests; the step remint budget (``step_request``) is unchanged.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final, Literal

from .agent_surface import INVOCATION_ROLES
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

PurposeClass = Literal["critical_path", "discretionary"]
CRITICAL_PATH: Final[PurposeClass] = "critical_path"
DISCRETIONARY: Final[PurposeClass] = "discretionary"

THROTTLED_PREFIX: Final = "request_admission_throttled:"
GOVERNANCE_KIND: Final = "request_admission_throttled"
ADMISSIONS_SURFACE: Final = "agent_invocation_admissions"
ADMISSIONS_RELPATH: Final = ("agent-invocations", "admissions.jsonl")

# Refusal reasons, in the order they are checked.
REASON_UNMEASURABLE: Final = "drain_capacity_unmeasurable"
REASON_EXECUTOR_IDLE: Final = "executor_not_draining"
REASON_PROVIDER_STATUS_UNREADABLE: Final = "provider_status_unreadable"
REASON_PROVIDER_UNAVAILABLE: Final = "provider_unavailable"
REASON_BUDGET: Final = "backlog_at_drain_budget"

# Review of #1833 (HIGH-1) — producers whose ask is honoured up to a fixed
# number per cycle BEFORE the budget is consulted, while the executor drains
# and a provider can run the role. Panels and judges refill the budget's
# headroom every night (they run earlier in the cycle than the drainer), so
# without this a new plan would never start; in-flight plans would finish
# and nothing would replace them, and planning is what closes findings. The
# quota is policy (`plan_seeds_per_cycle`, minimum 1).
SEED_QUOTA_PRODUCERS: Final = frozenset({"convergence_drainer.plan_seed"})


@dataclass(frozen=True)
class ProducerClass:
    """One producer's classification, per role it mints, and why a refusal is not lost."""

    roles: Mapping[str, PurposeClass]
    re_offer: str


def _same(purpose: PurposeClass, *roles: str) -> dict[str, PurposeClass]:
    return {role: purpose for role in roles}


_RERUN = "critical_path: never throttled"
PRODUCER_CLASSES: Final[Mapping[str, ProducerClass]] = {
    # --- critical_path: in-flight work and operator acts -------------------
    "convergence_drainer.plan_step": ProducerClass(
        _same(CRITICAL_PATH, "challenger_plan", "cross_review", "primary_plan", "completeness_critique"), _RERUN),
    "convergence_drainer.operator_plan_seed": ProducerClass(_same(CRITICAL_PATH, "challenger_plan"), _RERUN),
    "plan_round_controller.plan_step": ProducerClass(
        _same(CRITICAL_PATH, "challenger_plan", "primary_plan", "cross_review"), _RERUN),
    "implementer.converged_plan": ProducerClass(_same(CRITICAL_PATH, "implementation"), _RERUN),
    "review_runner.post_implementation": ProducerClass(_same(CRITICAL_PATH, "adversarial_judgment"), _RERUN),
    "specialist_review_runner.converged_plan": ProducerClass(
        _same(CRITICAL_PATH, "specialist_domain_review"), _RERUN),
    "expert_review_gate.implementation": ProducerClass(_same(CRITICAL_PATH, "specialist_domain_review"), _RERUN),
    "convergent_authoring.round_step": ProducerClass(
        _same(CRITICAL_PATH, "primary_authoring", "challenger_authoring", "evidence_judgment",
              "adversarial_judgment"), _RERUN),
    "operator_cli.request": ProducerClass(_same(CRITICAL_PATH, *sorted(INVOCATION_ROLES)), _RERUN),
    "operator_cli.convergent_plan": ProducerClass(_same(CRITICAL_PATH, "challenger_plan"), _RERUN),
    # --- discretionary: work that starts something new ---------------------
    "next_cycle_queue.projection": ProducerClass(
        _same(DISCRETIONARY, "maintenance_utility"),
        "the queue item is not consumed; the next drain offers it again"),
    "judge_fanout.sample": ProducerClass(
        _same(DISCRETIONARY, "evidence_judgment", "adversarial_judgment"),
        "the finding stays unjudged; the next cycle's sample can draw it again"),
    "judge_fanout.arbitration": ProducerClass(
        _same(DISCRETIONARY, "consensus_arbitration"),
        "split and anchor groups are re-derived from the feedback ledger every cycle"),
    "judge_replay.goldset": ProducerClass(
        _same(DISCRETIONARY, "evidence_judgment", "adversarial_judgment"),
        "every gold item without its replay judges is re-walked every cycle"),
    "human_required_panel.open": ProducerClass(
        _same(DISCRETIONARY, "human_required_adjudication"),
        "an escalation with no panel row is listed again by the next sweep"),
    # Review of #1833 (MEDIUM-2) — a panel's re-mint takes the class the DEAD
    # request was admitted under (recorded on its row at mint), never a role
    # list: a dead Gate-B review or authoring step stays critical. A row minted
    # before the door recorded nothing and re-mints as discretionary: bounded,
    # and re-offered by the next sweep, so never lost.
    "human_required_panel.remint_critical": ProducerClass(_same(CRITICAL_PATH, *sorted(INVOCATION_ROLES)), _RERUN),
    "human_required_panel.remint": ProducerClass(
        _same(DISCRETIONARY, *sorted(INVOCATION_ROLES)),
        "the record stays open; the next sweep folds the panel and re-applies the disposition"),
    "goldset.curation": ProducerClass(
        _same(DISCRETIONARY, "goldset_curation"),
        "a ready proposal whose subject was never asked is offered again every cycle"),
    "pr_tracking.change_intelligence": ProducerClass(
        _same(DISCRETIONARY, "change_intelligence"),
        "merge events whose subject was never asked are re-walked every cycle"),
    "decision_questioning.open": ProducerClass(
        _same(DISCRETIONARY, "verification"),
        "an unquestioned closed decision is sampled again next cycle"),
    "convergence_drainer.plan_seed": ProducerClass(
        _same(DISCRETIONARY, "challenger_plan"),
        "the plan is not started; the synthesizer re-derives the candidate next cycle"),
    "skill_genesis.authoring_run": ProducerClass(
        _same(DISCRETIONARY, "primary_authoring"),
        "the genesis request keeps a non-terminal status and is a candidate next cycle"),
}


class RequestAdmissionThrottled(GovernanceError):
    """A mint was handed an Admission the door refused; nothing was written."""


@dataclass(frozen=True)
class Admission:
    """The door's decision. Only ``admit_request`` builds one (pinned by test_request_admission_door)."""

    producer: str
    role: str
    purpose_class: PurposeClass
    cycle_key: str
    count: int
    admitted: bool
    reason: str

    @property
    def refusal(self) -> str:
        return f"{THROTTLED_PREFIX}{self.reason}"


@dataclass
class _CycleView:
    stamp: tuple[int, int, int]
    snapshot: dict[str, Any] | None = None
    admitted_since_snapshot: int = 0
    minted_by_producer: dict[str, int] = field(default_factory=dict)
    throttled_keys: set[tuple[str, str, str]] = field(default_factory=set)
    throttled_roles: set[str] = field(default_factory=set)


_VIEWS: dict[tuple[str, str], _CycleView] = {}


def admissions_path(root: Path) -> Path:
    return root.joinpath(*ADMISSIONS_RELPATH)


def cycle_key_for(cycle_id: str | None, now: datetime) -> str:
    """The key a decision is budgeted under.

    A producer outside any cycle (operator CLI, tests) gets a key of its own
    call, so it is measured fresh rather than against a snapshot up to a day
    old (review of #1833, MEDIUM-4).
    """
    return cycle_id if cycle_id else f"uncycled:{now.astimezone(timezone.utc).isoformat()}"


def _stamp(path: Path) -> tuple[int, int, int]:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return (0, 0, 0)
    return (stat.st_size, stat.st_mtime_ns, stat.st_ino)


def _view(root: Path, cycle_key: str) -> _CycleView:
    """This cycle's admissions, folded once per process and refolded when another writer appended."""
    from .ledger import load_declared_jsonl

    path = admissions_path(root)
    key = (str(root.resolve()), cycle_key)
    cached = _VIEWS.get(key)
    if cached is not None and cached.stamp == _stamp(path):
        return cached
    view = _CycleView(stamp=_stamp(path))
    rows = load_declared_jsonl(path, expected_surface=ADMISSIONS_SURFACE) if path.exists() else []
    for row in rows:
        if row.get("cycle_key") != cycle_key:
            continue
        _fold(view, row)
    _VIEWS[key] = view
    return view


def _fold(view: _CycleView, row: dict[str, Any]) -> None:
    kind = row.get("row_type")
    if kind == "snapshot":
        view.snapshot, view.admitted_since_snapshot = dict(row.get("capacity") or {}), 0
    elif kind == "minted":
        view.admitted_since_snapshot += 1
        producer = str(row.get("producer"))
        view.minted_by_producer[producer] = view.minted_by_producer.get(producer, 0) + 1
    elif kind == "decision" and not row.get("admitted"):
        view.throttled_keys.add((str(row.get("producer")), str(row.get("role")), str(row.get("reason"))))
        view.throttled_roles.add(str(row.get("role")))


def _append(root: Path, view: _CycleView, row: dict[str, Any]) -> None:
    from .ledger import append_declared_jsonl

    path = admissions_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    append_declared_jsonl(path, row, expected_surface=ADMISSIONS_SURFACE)
    _fold(view, row)
    view.stamp = _stamp(path)


def _measure(root: Path, now: datetime) -> dict[str, Any]:
    """The cycle's snapshot: drain capacity plus the cooled providers, or the fault that stopped it."""
    from .provider_outage import cooled_providers
    from .request_drain_capacity import measure_drain_capacity, request_admission_policy

    try:
        capacity: dict[str, Any] = measure_drain_capacity(
            root, now=now, policy=request_admission_policy(root)).to_row()
    except (GovernanceError, OSError, ValueError) as exc:
        capacity = {"measured_at": now.isoformat(), "fault": f"{type(exc).__name__}: {exc}"[:300]}
    try:
        capacity["cooled_providers"] = cooled_providers(root, now=now)
    except (GovernanceError, OSError, ValueError) as exc:
        capacity["cooled_providers"] = None
        capacity["cooldown_fault"] = f"{type(exc).__name__}: {exc}"[:300]
    return capacity


def _discretionary_reason(producer: str, role: str, capacity: Mapping[str, Any], view: _CycleView,
                          count: int, now: datetime) -> tuple[bool, str]:
    from .provider_outage import provider_outage

    if "fault" in capacity:
        return False, REASON_UNMEASURABLE
    if not capacity.get("executor_live"):
        return False, REASON_EXECUTOR_IDLE
    cooled = capacity.get("cooled_providers")
    if cooled is None:
        return False, REASON_PROVIDER_STATUS_UNREADABLE
    try:
        outage = provider_outage(role, cooled, now=now)
    except GovernanceError:
        return False, REASON_PROVIDER_STATUS_UNREADABLE
    if outage is not None:
        return False, REASON_PROVIDER_UNAVAILABLE
    quota = int(capacity.get("plan_seeds_per_cycle") or 0)
    if producer in SEED_QUOTA_PRODUCERS and view.minted_by_producer.get(producer, 0) + count <= quota:
        return True, "plan_seed_quota"
    backlog_now = int(capacity.get("backlog") or 0) + view.admitted_since_snapshot
    if backlog_now + count > float(capacity.get("budget") or 0.0):
        return False, REASON_BUDGET
    return True, "within_drain_budget"


def admit_request(
    producer: str,
    role: str,
    *,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    count: int = 1,
    now: datetime | None = None,
) -> Admission:
    """Decide whether ``producer`` may mint ``count`` new ``role`` requests now.

    Unknown producer or an unclassified (producer, role) is a refusal by
    name, never a default class. Critical path is always admitted.
    Discretionary is measured once per cycle and decided against that
    snapshot plus every request minted since; a refusal writes its admissions
    row once per (cycle, producer, role, reason) and its governance row once
    per (cycle, role). An admission is recorded by the MINT, and only for an
    identity that was new (``minted_row``): a re-request of a sealed row
    consumes nothing (review of #1833, MEDIUM-4).
    """
    spec = PRODUCER_CLASSES.get(producer)
    if spec is None:
        raise GovernanceError(f"request_admission_producer_unclassified:{producer}")
    purpose = spec.roles.get(role)
    if purpose is None:
        raise GovernanceError(f"request_admission_role_unclassified:{producer}:{role}")
    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        raise GovernanceError(f"request_admission_count_invalid:{count!r}")
    moment = now or datetime.now(timezone.utc)
    root = ensure_tools_dir(base_dir)
    cycle_key = cycle_key_for(cycle_id, moment)
    view = _view(root, cycle_key)
    decided_at = moment.replace(microsecond=0).isoformat()
    row: dict[str, Any] = {
        "schema_version": 1, "row_type": "decision", "cycle_key": cycle_key, "producer": producer,
        "role": role, "purpose_class": purpose, "count": count, "decided_at": decided_at,
    }
    if purpose == CRITICAL_PATH:
        return Admission(producer, role, purpose, cycle_key, count, True, CRITICAL_PATH)
    if view.snapshot is None:
        _append(root, view, {"schema_version": 1, "row_type": "snapshot", "cycle_key": cycle_key,
                             "decided_at": decided_at, "capacity": _measure(root, moment)})
    capacity = view.snapshot or {}
    backlog_now = int(capacity.get("backlog") or 0) + view.admitted_since_snapshot
    admitted, reason = _discretionary_reason(producer, role, capacity, view, count, moment)
    if not admitted and (producer, role, reason) not in view.throttled_keys:
        first_for_role = role not in view.throttled_roles
        _append(root, view, {**row, "admitted": False, "reason": reason, "backlog_before": backlog_now})
        if first_for_role:
            append_tools_governance(root, GOVERNANCE_KIND, {
                "cycle_key": cycle_key, "role": role, "producer": producer, "reason": reason,
                "backlog": backlog_now, "budget": capacity.get("budget"),
                "drain_per_day": capacity.get("drain_per_day"), "executor_live": capacity.get("executor_live"),
                "last_drain_at": capacity.get("last_drain_at"),
            })
    return Admission(producer, role, purpose, cycle_key, count, admitted, reason)


def minted_row(admission: Admission, *, request_id: str) -> dict[str, Any]:
    """The admissions row the mint appends, in its own transaction, for a NEW identity."""
    return {
        "schema_version": 1, "row_type": "minted", "cycle_key": admission.cycle_key,
        "producer": admission.producer, "role": admission.role, "purpose_class": admission.purpose_class,
        "reason": admission.reason, "request_id": request_id,
        "decided_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }


def ledger_stamp(root: Path) -> tuple[int, int, int]:
    return _stamp(admissions_path(root))


def note_minted(root: Path, row: dict[str, Any], *, stamp_before: tuple[int, int, int]) -> None:
    """Fold the mint's row into this process's view; drop the view if another writer appended."""
    key = (str(root.resolve()), str(row.get("cycle_key")))
    view = _VIEWS.get(key)
    if view is None:
        return
    if view.stamp != stamp_before:
        _VIEWS.pop(key, None)
        return
    _fold(view, row)
    view.stamp = ledger_stamp(root)


def check_admission_binding(admission: Admission, *, role: str) -> None:
    """The mint's first check, for every call: an Admission, decided for this role."""
    if not isinstance(admission, Admission):
        raise GovernanceError(f"request_admission_missing:{type(admission).__name__}")
    if admission.role != role:
        raise GovernanceError(f"request_admission_role_mismatch:{admission.role}!={role}")


def require_admitted(admission: Admission) -> None:
    """The mint's second check, for a NEW identity only: re-requesting a sealed row mints nothing."""
    if not admission.admitted:
        raise RequestAdmissionThrottled(admission.refusal)


__all__ = [
    "CRITICAL_PATH", "DISCRETIONARY", "GOVERNANCE_KIND", "PRODUCER_CLASSES", "SEED_QUOTA_PRODUCERS",
    "THROTTLED_PREFIX", "Admission", "ProducerClass", "PurposeClass", "RequestAdmissionThrottled",
    "admissions_path", "admit_request", "check_admission_binding", "cycle_key_for", "ledger_stamp",
    "ADMISSIONS_SURFACE", "minted_row", "note_minted", "require_admitted",
]
