"""cycle_and_turn_budget_cap — the two caps a write turn is admitted under.

WHY: the merge gate's seventh pre-merge predicate (``implementation_safety``
``HARD_FAIL_CHECKS[cycle_and_turn_budget_cap]``, policy §14) was declared
against a per-cycle USD reservation and a per-implementer-turn cap and bound
to a placeholder that refused every merge by name (``check_not_implemented``)
while nothing actually bounded an implementer's turns. Two operator decisions since then
changed the dollar half: ORPHAN-HIGH-472 retired the USD dispatch gate for
wall clock, and ARIA-HIGH-074/079 made notional dollars TELEMETRY under the
managed-subscription policy (``cost_budget.assert_within_budget``'s
``telemetry_only`` branch is that owner; under the metered policy it keeps
its own USD caps). Dollars are therefore not admission here, and this module
must never grow a USD read.

WHAT this module owns — the two caps that DO bind, and their vocabulary:

* the CYCLE cap is the run-scoped job deadline. Its writer is
  ``cycle.job_deadline_epoch`` (the only restoring owner of
  ``ARIA_JOB_DEADLINE_EPOCH``, ARIA-HIGH-064); its pre-spawn readers are the
  spawn clamp (``tools/aria-poc/claude_runtime._clamp_timeout_to_job_deadline``)
  and, in the executor lane, the dispatch wall-clock gate
  (``ci_executor._assert_cycle_wall_clock``, which admits a run only when it
  fits the workflow's pinned job cap). At the TURN boundary the kernel hook
  reads the same epoch through :func:`job_deadline_reached` and refuses the
  next Edit/Write/Bash turn with ``cycle_budget_exhausted`` once the job's
  remaining wall clock is inside the close-out margin — the run terminates
  cleanly between turns instead of being killed mid-turn by the clamp.
  ``cycle.py``'s between-phases skip delegates to the same predicate so the
  phase loop and the hook cannot disagree on the margin.

* the TURN cap is :data:`IMPLEMENTER_TURN_BUDGET` = 10 Edit+Write+Bash turns
  per implementer request (the profile's write scope is what marks a spawn
  as budgeted, :func:`turn_budget_for`). The count is derived from the
  ``hook_decisions`` ledger — one row per PreToolUse verdict, appended by
  ``hooks.run_hook`` inside the same state transaction that counted, so two
  parallel tool calls cannot both read nine and both be admitted. The
  eleventh budgeted turn is refused with ``implementer_turn_budget_exhausted``
  at the boundary; a policy-denied turn never ran, so it never counts.

* the EVIDENCE the pre-merge predicate reads. Every budgeted verdict carries
  a ``turn_budget`` observation (cap, turns used before it, the deadline it
  was checked against). ``merge_authority._capture_pre_merge_context`` hands
  the request's rows to :func:`turn_budget_evidence`, and
  ``implementation_safety._check_cycle_and_turn_budget_cap`` fails when a
  refusal of either class was recorded, when more turns were admitted than
  the cap allows, or when the rows are absent — an implementation that ran
  without the hook has no proof its caps held.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Mapping, Sequence

if TYPE_CHECKING:  # the hook imports this module on every tool call; keep it light
    from .runtime_profiles import RuntimeProfile

# N=10 per implementer request (policy §14). One literal; the hook receives it
# through the spawn settings the kernel compiles, and the predicate rejects
# evidence recorded under any other cap.
IMPLEMENTER_TURN_BUDGET: int = 10
# The tools whose PreToolUse verdicts the budget counts, in the order the
# settings matcher spells them. ``claude_settings`` derives its PreToolUse
# matcher from this tuple, so a tool cannot be budgeted without being
# consulted or consulted without being budgeted.
BUDGETED_TOOL_NAMES: tuple[str, ...] = ("Bash", "Edit", "Write", "MultiEdit", "NotebookEdit")
REASON_CYCLE_BUDGET_EXHAUSTED: str = "cycle_budget_exhausted"
REASON_IMPLEMENTER_TURN_BUDGET_EXHAUSTED: str = "implementer_turn_budget_exhausted"
BUDGET_REFUSAL_REASONS: frozenset[str] = frozenset({
    REASON_CYCLE_BUDGET_EXHAUSTED, REASON_IMPLEMENTER_TURN_BUDGET_EXHAUSTED,
})
# The cross-process deadline contract (ARIA-HIGH-064). Read here; written only
# by ``cycle.job_deadline_epoch`` — ``tests/test_job_deadline_scope.py`` scans
# the kernel for any other assignment.
JOB_DEADLINE_EPOCH_ENV: str = "ARIA_JOB_DEADLINE_EPOCH"
# How much of the job's wall clock the close-out chain (reflection, seal,
# publish) needs after the last admitted phase or turn. The phase loop and
# the hook share this one number.
JOB_DEADLINE_CLOSE_OUT_MARGIN_SECONDS: int = 120
# The key the observation is stored under on a ``hook_decisions`` row.
OBSERVATION_KEY: str = "turn_budget"


def turn_budget_for(profile: "RuntimeProfile") -> int | None:
    """The cap for a spawn under ``profile``; None when the spawn is not budgeted.

    A profile with a write scope is one that can produce an implementation
    diff, which is what the policy's "implementer" means; a read-only judge
    or a Bash-only validator has no diff to bound.
    """
    return IMPLEMENTER_TURN_BUDGET if profile.write_scope else None


def parse_deadline_epoch(raw: str | None) -> float | None:
    """A malformed epoch is NOT a deadline — the tolerance every reader shares.

    ``cycle._remaining_wallclock_seconds`` returns inf on garbage rather than
    crashing a cycle; the binder and the hook must agree, or a typo in the
    workflow would become a hard failure in one reader and an ignored value
    in another (the spawn clamp already refuses it loudly at spawn time).
    """
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def job_deadline_reached(
    *, now: float, deadline_epoch: float | None,
    margin_seconds: float = JOB_DEADLINE_CLOSE_OUT_MARGIN_SECONDS,
) -> bool:
    """True when the job's remaining wall clock is inside the close-out margin."""
    if deadline_epoch is None:
        return False
    return now >= deadline_epoch - margin_seconds


def budgeted_turns_used(rows: Sequence[Mapping[str, Any]], *, request_id: str) -> int:
    """Turns already admitted for ``request_id``: allow verdicts on budgeted tools.

    A denied verdict never ran, so it is not a turn; a checkpoint note or a
    verdict on an unbudgeted tool is not one either.
    """
    return sum(
        1 for row in rows
        if row.get("request_id") == request_id
        and row.get("decision") == "allow"
        and row.get("tool_name") in BUDGETED_TOOL_NAMES
    )


@dataclass(frozen=True)
class TurnBudgetObservation:
    """What the hook saw at one turn boundary, before deciding."""

    cap: int
    used_before: int
    deadline_epoch: float | None
    remaining_seconds: float | None
    margin_seconds: float

    def to_row(self) -> dict[str, Any]:
        return {
            "cap": self.cap,
            "used_before": self.used_before,
            "deadline_epoch": self.deadline_epoch,
            "remaining_seconds": (
                None if self.remaining_seconds is None else round(self.remaining_seconds, 3)
            ),
            "margin_seconds": self.margin_seconds,
        }


def observe_turn_budget(
    rows: Sequence[Mapping[str, Any]], *, request_id: str, cap: int, now: float,
    deadline_epoch: float | None,
    margin_seconds: float = JOB_DEADLINE_CLOSE_OUT_MARGIN_SECONDS,
) -> TurnBudgetObservation:
    return TurnBudgetObservation(
        cap=cap,
        used_before=budgeted_turns_used(rows, request_id=request_id),
        deadline_epoch=deadline_epoch,
        remaining_seconds=None if deadline_epoch is None else deadline_epoch - now,
        margin_seconds=margin_seconds,
    )


def turn_budget_refusal(observation: TurnBudgetObservation, *, now: float) -> str | None:
    """The refusal reason for the NEXT turn under ``observation``, or None.

    Time first: a run out of wall clock must stop even with turns to spare.
    Both reasons are ``class:detail`` so the class is greppable and the
    detail says what was measured.
    """
    if job_deadline_reached(
        now=now, deadline_epoch=observation.deadline_epoch,
        margin_seconds=observation.margin_seconds,
    ):
        remaining = int(observation.deadline_epoch - now)
        return (
            f"{REASON_CYCLE_BUDGET_EXHAUSTED}:remaining={remaining}s"
            f":margin={int(observation.margin_seconds)}s"
        )
    if observation.used_before >= observation.cap:
        return (
            f"{REASON_IMPLEMENTER_TURN_BUDGET_EXHAUSTED}:used={observation.used_before}"
            f":cap={observation.cap}"
        )
    return None


def refusal_class(reason: str | None) -> str | None:
    """The reason class of a hook verdict: the text before the first colon."""
    if not reason:
        return None
    return reason.split(":", 1)[0]


def turn_budget_evidence(
    rows: Sequence[Mapping[str, Any]], *, request_id: str,
) -> dict[str, Any]:
    """The pre-merge observation over ``request_id``'s budgeted verdicts.

    Keys are the ``_PreMergeEvidence`` fields the predicate reads. Absence
    and malformation are named reasons, never an empty pass: no rows means
    the implementation ran without the hook, and a budgeted verdict without
    its observation (or under a cap other than the kernel's) means the hook
    that recorded it was not the one this kernel compiles.
    """
    bound = [
        row for row in rows
        if row.get("request_id") == request_id and row.get("tool_name") in BUDGETED_TOOL_NAMES
    ]
    if not bound:
        return {"turn_budget_unavailable_reason": "native_turn_budget_evidence_unavailable"}
    caps: set[int] = set()
    for row in bound:
        observation = row.get(OBSERVATION_KEY)
        if (
            not isinstance(observation, Mapping)
            or type(observation.get("cap")) is not int
            or type(observation.get("used_before")) is not int
        ):
            return {"turn_budget_unavailable_reason": "native_turn_budget_observation_unavailable"}
        caps.add(observation["cap"])
    if caps != {IMPLEMENTER_TURN_BUDGET}:
        return {"turn_budget_unavailable_reason": "native_turn_budget_cap_mismatch"}
    refusal = next(
        (row.get("reason") for row in bound
         if row.get("decision") == "deny" and refusal_class(row.get("reason")) in BUDGET_REFUSAL_REASONS),
        None,
    )
    return {
        "turn_budget_cap": IMPLEMENTER_TURN_BUDGET,
        "turn_budget_used": budgeted_turns_used(bound, request_id=request_id),
        "turn_budget_refusal_reason": refusal,
        "turn_budget_ledger_tip": bound[-1].get("ledger_hash"),
    }


__all__ = [
    "BUDGETED_TOOL_NAMES",
    "BUDGET_REFUSAL_REASONS",
    "IMPLEMENTER_TURN_BUDGET",
    "JOB_DEADLINE_CLOSE_OUT_MARGIN_SECONDS",
    "JOB_DEADLINE_EPOCH_ENV",
    "OBSERVATION_KEY",
    "REASON_CYCLE_BUDGET_EXHAUSTED",
    "REASON_IMPLEMENTER_TURN_BUDGET_EXHAUSTED",
    "TurnBudgetObservation",
    "budgeted_turns_used",
    "job_deadline_reached",
    "observe_turn_budget",
    "parse_deadline_epoch",
    "refusal_class",
    "turn_budget_evidence",
    "turn_budget_for",
    "turn_budget_refusal",
]
