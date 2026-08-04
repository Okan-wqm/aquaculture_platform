"""Reconciliation — what the world did while the cycle was not looking.

PLAN Wave 2 PR 1.3. A mission's state is what ARIA last WROTE; reality is what
GitHub currently IS. Between two nightlies a PR can be merged by a human,
closed unmerged, or have its branch deleted, and nothing in the pipeline
notices: the mission sits in IMPLEMENTING forever, holding a WIP slot for work
that already landed. Reconciliation is the phase that reads the world back.

THE ONE RULE. Only a POSITIVE, RECOGNISED observation moves a mission.
Everything else — an unrecognised state, a `None`, an adapter that raised —
is recorded and touches nothing.

That rule is not caution for its own sake, it is the shape of the production
lane. `select_github_adapter` hands `observe`/`standard`/`frozen` a
`RecordingGitHubAdapter` that never fetches, and its lifecycle answer is
`None`. A reconciler that read "not merged" as "closed unmerged" would advance
the retry rung of every mission on every dry-run night and on every GitHub
outage, burning the ladder to `justified_reject` without one real observation.
Absence and damage are not the same observation.

The same rule is why the dry-run lane needs no flag to soak on: the profile
that must not act gets an adapter that cannot answer, so "observe first" is a
property of the adapter table rather than a switch someone has to remember to
flip.

AT MOST ONE STATE TRANSITION PER MISSION PER SWEEP. The mission snapshot is
folded once at the top; applying two transitions from one snapshot would
decide the second against a state that no longer exists. Divergence that
survives is reconciled on the next cycle, which is exactly what a reconciler
is for. Bindings are content-keyed and idempotent, so adoption is unbounded.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from .mission import (
    MAINLINE_STATES,
    RECONCILED_EXTERNAL_MERGE,
    RETRY_LADDER,
    bind_mission,
    list_open_missions,
    mainline_index,
    transition_mission,
)
from .tool_registry import append_tools_governance, ensure_tools_dir

# The closed vocabulary of what a PR lookup can tell us. `unobserved` is a
# first-class member rather than an error: "I did not look" is an answer, and
# it is the answer the dry-run lane gives every night.
RECONCILE_OBSERVATIONS: tuple[str, ...] = (
    "merged",
    "closed_unmerged",
    "open",
    "unobserved",
)

# Reason codes this module may write. `reconciled_external_merge` is defined
# in `mission.py` because the state machine has to bless it as a legal
# forward-skip reason; importing it rather than retyping the literal is what
# keeps the two halves of that contract from drifting apart. The rest ride
# explicit edges and are owned here.
RECONCILED_CLOSED_UNMERGED = "reconciled_closed_unmerged"
RECONCILED_LOST_BRANCH = "reconciled_lost_branch"
RETRY_LADDER_EXHAUSTED = "retry_ladder_exhausted"

# Where a merged PR lands a mission that never saw the merge: merging is done,
# main verification is what is now outstanding.
EXTERNAL_MERGE_TARGET = "MAIN_VERIFYING"

# A closed-unmerged PR replans only from the states where an implementation
# attempt was actually in flight. Earlier states are already behind the PR
# (a previous reconcile put them there), and the merge tail is the
# contradiction set below.
CLOSED_UNMERGED_REPLAN_STATES: frozenset[str] = frozenset(
    {"IMPLEMENTING", "VALIDATING", "READY", "MERGING"}
)

# A branch is only a mission's live workspace before it has a PR, so these are
# the states where its disappearance means the work is gone.
LOST_BRANCH_REPLAN_STATES: frozenset[str] = frozenset(
    {"IMPLEMENTING", "VALIDATING", "READY"}
)

# States where the mission believes the change is already on main. A PR that
# is closed-unmerged, or a branch that vanished, contradicts that belief
# rather than describing a step it can take — recorded, never acted on.
MERGE_TAIL_STATES: frozenset[str] = frozenset({"MAIN_VERIFYING", "OUTCOME_OBSERVING"})

# `ARIA-Mission: m-<16 hex>` in a PR body. Deliberately strict and anchored:
# a PR body is content ARIA did not write, and the only thing extracted from
# it is an identifier that must already name an open mission.
MISSION_TRAILER_PATTERN = re.compile(
    r"^ARIA-Mission:[ \t]*(m-[0-9a-f]{16})[ \t]*$", re.MULTILINE
)

# One step_id for everything this module writes, so a repeated observation is
# the SAME idempotency key rather than a new one per cycle. What varies is the
# target (`pr:7:merged`, `branch:x:absent`), which is the observation's own
# identity — the fact, not the night it was seen.
RECONCILE_STEP_ID = "reconcile"


@runtime_checkable
class MissionObserver(Protocol):
    """What reconciliation needs from the world, and nothing more.

    Deliberately NOT an extension of `auto_merge.GitHubAdapter`: that Protocol
    describes what merge evaluation needs, and three implementations satisfy
    it for that purpose. Reconciliation declares its own narrow surface so a
    payload-backed merge fixture is not forced to grow methods it never calls.

    Every method returns ``None`` for "no observation". Raising is equally
    acceptable — the caller treats both as `unobserved` — but a return of
    ``None`` is the honest shape for an adapter that declined to look, as
    opposed to one that tried and failed.
    """

    def get_pr_lifecycle(self, number: int) -> dict[str, Any] | None: ...

    def observe_branch(self, name: str) -> bool | None: ...

    def list_open_pull_requests(self) -> list[dict[str, Any]] | None: ...


def classify_pr_lifecycle(payload: Any) -> str:
    """Map a lifecycle payload onto `RECONCILE_OBSERVATIONS`.

    There is no ``else`` arm that guesses. A payload this function does not
    recognise is `unobserved`, which is what makes the dry-run adapter's
    ``{"state": "recording_adapter_no_fetch"}`` and a future GitHub state
    nobody anticipated behave identically: neither moves a mission.
    """
    if not isinstance(payload, dict):
        return "unobserved"
    # `merged` is read FIRST and compared to the boolean, not for truthiness.
    # GitHub's REST API reports a merged PR with ``state: "closed"``, so
    # reading state alone would call every merge a failed attempt.
    if payload.get("merged") is True:
        return "merged"
    state = payload.get("state")
    if not isinstance(state, str):
        return "unobserved"
    normalised = state.strip().upper()
    if normalised == "MERGED":
        return "merged"
    if normalised == "CLOSED":
        return "closed_unmerged"
    if normalised == "OPEN":
        return "open"
    return "unobserved"


def next_retry_rung(current: str | None) -> str | None:
    """The rung after ``current``, or ``None`` when the ladder is spent."""
    if current is None:
        return RETRY_LADDER[0]
    if current not in RETRY_LADDER:
        return RETRY_LADDER[0]
    index = RETRY_LADDER.index(current)
    if index + 1 >= len(RETRY_LADDER):
        return None
    return RETRY_LADDER[index + 1]


# ---------------------------------------------------------------------------
# Observation.
# ---------------------------------------------------------------------------


class _Sweep:
    """Per-run accumulator. A class rather than five parallel lists because
    every helper needs to record into the same three places."""

    def __init__(self, root: Path, cycle_id: str) -> None:
        self.root = root
        self.cycle_id = cycle_id
        self.transitions: list[dict[str, Any]] = []
        self.adoptions: list[dict[str, Any]] = []
        self.unobserved = 0
        self.contradictions = 0
        self.errors = 0

    def record(self, kind: str, details: dict[str, Any]) -> None:
        append_tools_governance(
            self.root, kind, {"schema_version": 1, "cycle_id": self.cycle_id, **details}
        )

    def adapter_error(self, mission_id: str | None, call: str, exc: BaseException) -> None:
        """An adapter that raised did not observe anything. It is recorded
        because a lane whose GitHub calls are all failing looks exactly like a
        lane with nothing to reconcile, and those must be distinguishable."""
        self.errors += 1
        self.unobserved += 1
        self.record(
            "mission_reconcile_adapter_error",
            {
                "mission_id": mission_id,
                "call": call,
                "error": f"{type(exc).__name__}: {exc}",
            },
        )

    def contradiction(
        self, mission_id: str, state: str, observation: str, detail: str
    ) -> None:
        self.contradictions += 1
        self.record(
            "mission_reconcile_contradiction",
            {
                "mission_id": mission_id,
                "mission_state": state,
                "observation": observation,
                "detail": detail,
            },
        )


def _observe_pull_requests(
    observer: Any, mission_id: str, numbers: list[int], sweep: _Sweep
) -> dict[int, str]:
    observations: dict[int, str] = {}
    for number in numbers:
        try:
            payload = observer.get_pr_lifecycle(number)
        except Exception as exc:  # noqa: BLE001 - any failure is "did not observe"
            sweep.adapter_error(mission_id, f"get_pr_lifecycle:{number}", exc)
            continue
        verdict = classify_pr_lifecycle(payload)
        if verdict == "unobserved":
            sweep.unobserved += 1
            continue
        observations[number] = verdict
    return observations


def _pr_numbers(bindings: dict[str, Any]) -> list[int]:
    numbers: list[int] = []
    for value in bindings.get("pr_numbers") or []:
        try:
            numbers.append(int(value))
        except (TypeError, ValueError):
            continue
    return sorted(set(numbers))


def _branches(bindings: dict[str, Any]) -> list[str]:
    return sorted(
        {str(value) for value in bindings.get("branch") or [] if str(value).strip()}
    )


# ---------------------------------------------------------------------------
# The divergence table.
# ---------------------------------------------------------------------------


def _apply(
    sweep: _Sweep,
    mission: dict[str, Any],
    *,
    to_state: str,
    reason_code: str,
    target: str,
    next_action: str,
    wake_condition: dict[str, Any],
    retry_rung: str | None = None,
    evidence_refs: list[str] | None = None,
) -> bool:
    """One transition, with the closure contract satisfied at the callsite.

    `next_action` and `wake_condition` are REQUIRED parameters, not optional
    ones: `assert_cycle_closure` fails any open mission missing either, so a
    reconciler that omitted them would manufacture the very half-done plans
    the closure gate exists to catch.
    """
    result = transition_mission(
        mission_id=mission["mission_id"],
        to_state=to_state,
        reason_code=reason_code,
        step_id=RECONCILE_STEP_ID,
        target_sha=target,
        retry_rung=retry_rung,
        next_action=next_action,
        wake_condition=wake_condition,
        evidence_refs=evidence_refs or [],
        base_dir=sweep.root,
    )
    if result["idempotent"]:
        return False
    sweep.transitions.append(
        {
            "mission_id": mission["mission_id"],
            "from_state": mission["state"],
            "to_state": to_state,
            "reason_code": reason_code,
        }
    )
    return True


def _reconcile_external_merge(
    sweep: _Sweep, mission: dict[str, Any], number: int
) -> bool:
    state = mission["state"]
    index = mainline_index(state)
    if index is None:
        sweep.contradiction(
            mission["mission_id"],
            state,
            "merged",
            f"a waiting mission cannot reach {EXTERNAL_MERGE_TARGET} by any edge",
        )
        return False
    if index >= MAINLINE_STATES.index(EXTERNAL_MERGE_TARGET):
        # Already at or past main verification: the merge is old news, not a
        # divergence. Silent on purpose — this is the steady state for every
        # mission between its merge and its outcome window closing.
        return False
    return _apply(
        sweep,
        mission,
        to_state=EXTERNAL_MERGE_TARGET,
        reason_code=RECONCILED_EXTERNAL_MERGE,
        target=f"pr:{number}:merged",
        next_action="verify main after a merge that happened outside the cycle",
        wake_condition={"kind": "ci_status", "key": f"pr:{number}"},
        evidence_refs=[f"pr:{number}"],
    )


def _reconcile_closed_unmerged(
    sweep: _Sweep, mission: dict[str, Any], number: int
) -> bool:
    state = mission["state"]
    if state in MERGE_TAIL_STATES:
        sweep.contradiction(
            mission["mission_id"],
            state,
            "closed_unmerged",
            "mission believes the change is on main; the PR was closed without merging",
        )
        return False
    if state not in CLOSED_UNMERGED_REPLAN_STATES:
        return False
    rung = next_retry_rung(mission.get("retry_rung"))
    if rung is None:
        # The ladder ends at `justified_reject`. Replanning past it would loop
        # forever on work the system has already run out of strategies for.
        return _apply(
            sweep,
            mission,
            to_state="HUMAN_REQUIRED",
            reason_code=RETRY_LADDER_EXHAUSTED,
            target=f"pr:{number}:closed",
            next_action="operator decision: every retry rung is spent",
            wake_condition={"kind": "evidence", "key": f"operator:{mission['mission_id']}"},
            evidence_refs=[f"pr:{number}"],
        )
    return _apply(
        sweep,
        mission,
        to_state="PLANNING",
        reason_code=RECONCILED_CLOSED_UNMERGED,
        target=f"pr:{number}:closed",
        retry_rung=rung,
        next_action=f"replan at retry rung {rung}",
        wake_condition={"kind": "timer", "key": f"replan:{mission['mission_id']}"},
        evidence_refs=[f"pr:{number}"],
    )


def _reconcile_lost_branch(
    sweep: _Sweep, mission: dict[str, Any], branch: str
) -> bool:
    state = mission["state"]
    if state in MERGE_TAIL_STATES:
        sweep.contradiction(
            mission["mission_id"],
            state,
            "lost_branch",
            "mission believes the change is on main but has no PR and no branch",
        )
        return False
    if state not in LOST_BRANCH_REPLAN_STATES:
        return False
    return _apply(
        sweep,
        mission,
        to_state="PLANNING",
        reason_code=RECONCILED_LOST_BRANCH,
        target=f"branch:{branch}:absent",
        next_action="reimplement: the branch holding this work no longer exists",
        wake_condition={"kind": "timer", "key": f"replan:{mission['mission_id']}"},
        evidence_refs=[f"branch:{branch}"],
    )


def _reconcile_one(sweep: _Sweep, observer: Any, mission: dict[str, Any]) -> None:
    bindings = mission.get("bindings") or {}
    numbers = _pr_numbers(bindings)
    if numbers:
        observations = _observe_pull_requests(
            observer, mission["mission_id"], numbers, sweep
        )
        merged = [n for n, verdict in observations.items() if verdict == "merged"]
        if merged:
            # A merge is the strongest fact available: it outranks a closed
            # sibling attempt, because acting on the closed one would replan
            # work that is already on main.
            _reconcile_external_merge(sweep, mission, max(merged))
            return
        if any(verdict == "open" for verdict in observations.values()):
            # Some attempt is still in flight. Replanning would abandon it.
            return
        closed = [n for n, verdict in observations.items() if verdict == "closed_unmerged"]
        if closed:
            _reconcile_closed_unmerged(sweep, mission, max(closed))
        return

    # No PR: the branch is the mission's only live artifact. This branch of
    # the code is reached ONLY when there is no PR, and that is the point —
    # GitHub deletes the head branch when a PR merges, so checking the branch
    # of a mission that has one would report every clean merge as a loss.
    for branch in _branches(bindings):
        try:
            exists = observer.observe_branch(branch)
        except Exception as exc:  # noqa: BLE001 - any failure is "did not observe"
            sweep.adapter_error(mission["mission_id"], f"observe_branch:{branch}", exc)
            continue
        if exists is None:
            sweep.unobserved += 1
            continue
        if exists is False and _reconcile_lost_branch(sweep, mission, branch):
            return


# ---------------------------------------------------------------------------
# Trailer adoption.
# ---------------------------------------------------------------------------


def _adopt_trailered_pull_requests(
    sweep: _Sweep, observer: Any, missions: list[dict[str, Any]]
) -> None:
    """Bind PRs that name their mission but are not bound to it.

    A PR opened outside the dispatch path — by an operator, or by a worker
    whose binding write was lost — carries `ARIA-Mission:` in its body. That
    trailer is the adoption key, and it is the ONLY thing read out of a PR
    body: an id that names no open mission is recorded and refused, never
    opened. Mission identity is derived from the source of the work; a PR
    cannot assert work into existence.
    """
    try:
        pull_requests = observer.list_open_pull_requests()
    except Exception as exc:  # noqa: BLE001 - any failure is "did not observe"
        sweep.adapter_error(None, "list_open_pull_requests", exc)
        return
    if not isinstance(pull_requests, list):
        return
    by_id = {mission["mission_id"]: mission for mission in missions}
    for entry in pull_requests:
        if not isinstance(entry, dict):
            continue
        try:
            number = int(entry.get("number"))
        except (TypeError, ValueError):
            continue
        body = entry.get("body")
        if not isinstance(body, str):
            continue
        match = MISSION_TRAILER_PATTERN.search(body)
        if match is None:
            continue
        mission_id = match.group(1)
        mission = by_id.get(mission_id)
        if mission is None:
            sweep.record(
                "mission_reconcile_unknown_trailer",
                {"mission_id": mission_id, "pr_number": number},
            )
            continue
        if number in _pr_numbers(mission.get("bindings") or {}):
            continue
        result = bind_mission(
            mission_id=mission_id,
            bindings={"pr_numbers": [number]},
            step_id=RECONCILE_STEP_ID,
            base_dir=sweep.root,
        )
        if not result["idempotent"]:
            sweep.adoptions.append({"mission_id": mission_id, "pr_number": number})


# ---------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------


def reconcile_missions(
    *,
    cycle_id: str,
    observer: Any,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Read the world back into every open mission that binds a PR or branch.

    One mission's failure costs only that mission: the sweep catches per
    mission, records, and continues. A single unreadable row must not cost the
    night's reconciliation — the same rule adoption follows.
    """
    root = ensure_tools_dir(base_dir)
    sweep = _Sweep(root, cycle_id)
    missions = list_open_missions(base_dir=root)
    examined = 0
    for mission in missions:
        bindings = mission.get("bindings") or {}
        if not _pr_numbers(bindings) and not _branches(bindings):
            continue
        examined += 1
        try:
            _reconcile_one(sweep, observer, mission)
        except Exception as exc:  # noqa: BLE001 - one bad mission is not the night
            sweep.record(
                "mission_reconcile_failed",
                {
                    "mission_id": mission.get("mission_id"),
                    "error": f"{type(exc).__name__}: {exc}",
                },
            )
    _adopt_trailered_pull_requests(sweep, observer, missions)
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "examined": examined,
        "transitions": sweep.transitions,
        "adoptions": sweep.adoptions,
        "unobserved": sweep.unobserved,
        "contradictions": sweep.contradictions,
        "adapter_errors": sweep.errors,
    }


__all__ = [
    "CLOSED_UNMERGED_REPLAN_STATES",
    "EXTERNAL_MERGE_TARGET",
    "LOST_BRANCH_REPLAN_STATES",
    "MERGE_TAIL_STATES",
    "MISSION_TRAILER_PATTERN",
    "MissionObserver",
    "RECONCILED_CLOSED_UNMERGED",
    "RECONCILED_EXTERNAL_MERGE",
    "RECONCILED_LOST_BRANCH",
    "RECONCILE_OBSERVATIONS",
    "RETRY_LADDER_EXHAUSTED",
    "classify_pr_lifecycle",
    "next_retry_rung",
    "reconcile_missions",
]
