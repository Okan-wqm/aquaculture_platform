"""Persistent missions — work identity that outlives the cycle that saw it.

PLAN Wave 2 PR 1.1 (`aria/mission/v1`). `task.py` derives task identity from
`cycle_id`, so the same defect rediscovered tonight is a NEW task every night:
nothing accumulates, nothing resumes, and "no plan silently half-done" has no
durable subject to be enforced against. A mission's identity is derived from
WHAT the work is — ``sha256(source_kind|source_id|repo_hash)`` — and NEVER
from when it was seen. Invariant I-W1-05 pins the derivation at the source
level (`test_mission_id_source_never_reads_cycle`).

State is an event-sourced ledger folded on read, the pattern
`plan_convergence` has proven in production: the history IS the audit trail —
how a mission got stuck, which retry rungs were spent, what it is waiting for.
The fold is authoritative; `missions/mission-index.json` is a derived
projection whose loss costs one rebuild.

THE VOCABULARIES ARE CLOSED. States, transition edges, retry rungs, wake
kinds and binding keys are each a finite table in this module and nowhere
else. A transition outside `ALLOWED_TRANSITIONS` is refused — with one stated
exception: a FORWARD jump along the mainline is legal when
``reason_code == "coarse_observation"``, because today's pipeline genuinely
cannot distinguish every intermediate state and a skip that says so is honest
where a skip wearing a precise reason would be the schema lying about its own
resolution. Backward moves always need an explicit edge.

The waiting states (blocked on revalidation, a capability, evidence, an
external system, or a human) are deliberately OUTSIDE `ACTIVE_WIP_STATES`: a
stuck mission releases its WIP slot rather than deadlocking the pipeline, and
the wake condition records what would un-stick it.

THE CLOSURE CONTRACT IS PART OF THE MINT, AND OF EVERY MOVE AFTER IT
(ORPHAN-MEDIUM-730). `open_mission` refuses a mission that cannot say what
happens next (``next_action``) and what would un-stick it
(``wake_condition``), and `transition_mission` refuses to move a mission on
without restating both — an omitting transition used to CLEAR what the mint
had just required, so the class returned one event later.

THE NUMBERS ARE THE STORE'S, RE-MEASURED (2026-08-19) RATHER THAN QUOTED. An
earlier revision of this module asserted "28 opened events against 27
violations, produced by the service-hardening seeder"; no such store exists on
this machine and the measurement disproves the attribution.
`aria-tools/missions/mission-events.jsonl` — the only mission ledger this
repository has ever produced — holds 5 events, ALL of them ``opened``, every
one carrying ``next_action: null`` and ``wake_condition: null``. Their source
kinds are ``pressure`` x2 and ``shadow_run_summary`` x3: all five came from
`adopt_task_candidates` below, and NONE from the seeder. `governance.jsonl`
holds exactly one ``mission_closure_violation`` row, naming those same five.

So the ingest path is the producer that actually filled the store, and the
refusal has to be reachable FROM IT: a candidate whose own source cannot name
a next action is disclosed as a refusal rather than minted as a mission
nothing can advance. Re-opening a mission that predates the rule installs the
contract instead of leaving it paralysed — except where a human owns it
(`OPERATOR_HELD_STATES`), which no unattended writer may overwrite.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from typing import Any

from .task import generate_task_candidates
from .ledger import (
    load_declared_jsonl,
    rewrite_declared_json,
    state_transaction,
)
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    append_tools_governance_once,
    ensure_tools_dir,
    utc_now,
)

MISSION_SCHEMA = "aria/mission/v1"

MAINLINE_STATES: tuple[str, ...] = (
    "DISCOVERED",
    "CONTRACTING",
    "PLANNING",
    "IMPLEMENTING",
    "VALIDATING",
    "READY",
    "MERGING",
    "MAIN_VERIFYING",
    "OUTCOME_OBSERVING",
)

WAITING_STATES: tuple[str, ...] = (
    "REVALIDATION_REQUIRED",
    "CAPABILITY_REQUIRED",
    "EVIDENCE_REQUIRED",
    "BLOCKED_EXTERNAL",
    "HUMAN_REQUIRED",
)

TERMINAL_STATES: tuple[str, ...] = (
    "VERIFIED",
    "POLICY_REJECTED",
    "CANCELLED_BY_CONSTITUTION",
    "SUPERSEDED",
    "FAILED_AND_ROLLED_BACK",
)

MISSION_STATES: tuple[str, ...] = MAINLINE_STATES + WAITING_STATES + TERMINAL_STATES

# The states whose forward pointer belongs to a HUMAN, not to a writer.
# WHAT it does: every unattended producer treats a mission in one of these
# states as read-only for the closure contract — it may neither install one
# nor heal a missing one. WHY it exists as a table rather than a literal:
# the rule has two enforcement points (`set_closure_contract` refuses, and
# `open_mission`'s heal declines), and a second copy of the membership test
# is how two writers come to disagree about who owns a parked mission.
#
# Measured need: a mission parked in HUMAN_REQUIRED with the operator's own
# ``next_action`` could be re-observed by the nightly seed phase and have that
# sentence replaced by a machine-composed "Review the 1 path(s) changed in
# farm-service this cycle…". The machine cannot move the mission (the
# scheduler skips every WAITING state), so this is not a merge-authority
# breach — but a machine writing over an operator's statement of what happens
# next is exactly the authority line ARIA does not cross.
#
# The other waiting states are machine-owned (a missing capability, absent
# evidence, an external system) and healing them is the intended behaviour.
OPERATOR_HELD_STATES: frozenset[str] = frozenset({"HUMAN_REQUIRED"})

# The step_id every mint-time heal writes under. Fixed rather than
# caller-supplied so a healed row is greppable in the ledger as "the contract
# a re-open installed" and cannot be confused with an operator's own
# `mission set-contract`.
MINT_HEAL_STEP_ID = "mint_heal"

# WIP is counted over the states where a mission holds real resources — a
# branch, a worker, a PR slot. Waiting states are excluded ON PURPOSE: a
# mission waiting on a human must not starve the pipeline of its one slot.
ACTIVE_WIP_STATES: tuple[str, ...] = (
    "IMPLEMENTING",
    "VALIDATING",
    "READY",
    "MERGING",
    "MAIN_VERIFYING",
)

# How many missions may hold a WIP slot at once. ONE, because that is the
# operator rule this enforces verbatim (2026-07-28): ARIA must not start a new
# plan before the current one is completely finished. It is a default rather
# than a constant so raising it is a reviewed argument at a callsite, not an
# edit that silently widens the rule everywhere.
DEFAULT_WIP_CAP = 1

RETRY_LADDER: tuple[str, ...] = (
    "transient",
    "in_plan_repair",
    "alternative",
    "scope_shrink",
    "new_evidence",
    "new_capability",
    "justified_reject",
)

WAKE_KINDS: tuple[str, ...] = ("ci_status", "pr_state", "timer", "evidence")

BINDING_KEYS: tuple[str, ...] = (
    "plan_ids",
    "change_ids",
    "assignment_ids",
    "pr_numbers",
    "branch",
    "finding_ids",
    "queue_item_ids",
    "task_ids",
    # Plan 033 Faz 033e — a security mission binds its campaign runs and the grants they consumed.
    "campaign_run_ids",
    "grant_jtis",
)

EVENT_KINDS: tuple[str, ...] = ("opened", "transition", "binding", "wake", "note")

# The reasons a skip-forward may carry. A closed set, and small on purpose:
# each member is a claim that we observed an END STATE and not the path to it,
# which is the only honest justification for jumping mainline states.
#
#   coarse_observation        — today's pipeline cannot distinguish every
#                               intermediate state, and a skip that says so is
#                               honest where a precise reason would be the
#                               schema lying about its own resolution.
#   reconciled_external_merge — `mission_reconcile` found the PR already
#                               merged. The merge happened; VALIDATING, READY
#                               and MERGING were passed through without this
#                               system watching, so writing them as observed
#                               events would be inventing history.
#
# Widening this set is a deliberate edit here, reviewed against that rule.
COARSE_OBSERVATION = "coarse_observation"
RECONCILED_EXTERNAL_MERGE = "reconciled_external_merge"
FORWARD_SKIP_REASONS: frozenset[str] = frozenset(
    {COARSE_OBSERVATION, RECONCILED_EXTERNAL_MERGE}
)


def _adjacent(state: str) -> frozenset[str]:
    index = MAINLINE_STATES.index(state)
    if index + 1 == len(MAINLINE_STATES):
        return frozenset()
    return frozenset({MAINLINE_STATES[index + 1]})


# Closed edge table. Three families beyond mainline adjacency:
#   * every non-terminal state may enter any waiting state (getting stuck is
#     not a privilege of a particular phase) and every terminal-cancel edge
#     (constitution/policy/supersession can end anything);
#   * waiting states re-enter through PLANNING — re-planning is the one safe
#     re-entry that cannot assume resources still exist — with HUMAN_REQUIRED
#     additionally able to end the mission outright;
#   * reconciliation's backward edges (lost branch, closed-unmerged PR) from
#     the WIP states back to PLANNING, and the failure edges from the merge
#     tail to FAILED_AND_ROLLED_BACK.
_ALWAYS_AVAILABLE: frozenset[str] = frozenset(WAITING_STATES) | frozenset(
    {"SUPERSEDED", "POLICY_REJECTED", "CANCELLED_BY_CONSTITUTION"}
)

ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    "DISCOVERED": _adjacent("DISCOVERED") | _ALWAYS_AVAILABLE,
    "CONTRACTING": _adjacent("CONTRACTING") | _ALWAYS_AVAILABLE,
    "PLANNING": _adjacent("PLANNING") | _ALWAYS_AVAILABLE,
    "IMPLEMENTING": _adjacent("IMPLEMENTING") | _ALWAYS_AVAILABLE | frozenset({"PLANNING"}),
    "VALIDATING": _adjacent("VALIDATING") | _ALWAYS_AVAILABLE | frozenset({"PLANNING"}),
    "READY": _adjacent("READY") | _ALWAYS_AVAILABLE | frozenset({"PLANNING"}),
    "MERGING": (
        _adjacent("MERGING")
        | _ALWAYS_AVAILABLE
        | frozenset({"PLANNING", "FAILED_AND_ROLLED_BACK"})
    ),
    "MAIN_VERIFYING": (
        _adjacent("MAIN_VERIFYING") | _ALWAYS_AVAILABLE | frozenset({"FAILED_AND_ROLLED_BACK"})
    ),
    "OUTCOME_OBSERVING": (
        frozenset({"VERIFIED", "FAILED_AND_ROLLED_BACK"}) | _ALWAYS_AVAILABLE
    ),
    "REVALIDATION_REQUIRED": frozenset({"PLANNING"}) | _ALWAYS_AVAILABLE,
    "CAPABILITY_REQUIRED": frozenset({"PLANNING"}) | _ALWAYS_AVAILABLE,
    "EVIDENCE_REQUIRED": frozenset({"PLANNING"}) | _ALWAYS_AVAILABLE,
    "BLOCKED_EXTERNAL": frozenset({"PLANNING"}) | _ALWAYS_AVAILABLE,
    "HUMAN_REQUIRED": frozenset({"PLANNING"}) | _ALWAYS_AVAILABLE,
    "VERIFIED": frozenset(),
    "POLICY_REJECTED": frozenset(),
    "CANCELLED_BY_CONSTITUTION": frozenset(),
    "SUPERSEDED": frozenset(),
    "FAILED_AND_ROLLED_BACK": frozenset(),
}


# Identifiers a candidate can carry that do not actually identify anything.
# `task._candidate_from_pressure` falls back to the literal string "pressure"
# when a pressure row has neither `event_id` nor `pressure_id`; hashing that
# would give every identifier-less pressure the SAME mission_id, so unrelated
# work would share one mission and accumulate contradictory bindings. Identity
# that cannot identify is worse than no identity, so these are refused.
UNUSABLE_SOURCE_IDS: frozenset[str] = frozenset({
    "pressure",
    "finding",
    "shadow_run_summary",
    "capability_gap",
    "None",
    "",
})


def events_path(root: Path) -> Path:
    return root / "missions" / "mission-events.jsonl"


def index_path(root: Path) -> Path:
    return root / "missions" / "mission-index.json"


def mission_id_for(source_kind: str, source_id: str, repo_hash: str) -> str:
    """``m-`` + 16 hex of sha256 over WHAT the work is.

    No timestamp, no counter and no cycle reference may enter this
    derivation — the same source re-observed in any later cycle MUST fold
    into the same mission. I-W1-05 pins this at the AST level.
    """
    for name, value in (
        ("source_kind", source_kind),
        ("source_id", source_id),
        ("repo_hash", repo_hash),
    ):
        if not isinstance(value, str) or not value.strip():
            raise GovernanceError(f"mission identity requires a non-empty {name}")
    digest = hashlib.sha256(
        f"{source_kind}|{source_id}|{repo_hash}".encode("utf-8")
    ).hexdigest()
    return f"m-{digest[:16]}"


def _idempotency_key(
    mission_id: str, step_id: str, target_sha: str, action_type: str
) -> str:
    raw = f"{mission_id}|{step_id}|{target_sha}|{action_type}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def mainline_index(state: str) -> int | None:
    """Position on the mainline, or ``None`` for a waiting/terminal state.

    Public because reconciliation has to ask the same question the transition
    guard asks — "is this state before that one?" — and a second copy of the
    ordering rule is how two callers come to disagree about it.
    """
    try:
        return MAINLINE_STATES.index(state)
    except ValueError:
        return None


def _validate_wake_condition(wake_condition: Any) -> dict[str, Any] | None:
    if wake_condition is None:
        return None
    if not isinstance(wake_condition, dict):
        raise GovernanceError("wake_condition must be an object")
    kind = wake_condition.get("kind")
    if kind not in WAKE_KINDS:
        raise GovernanceError(
            f"wake_condition.kind {kind!r} is outside the closed vocabulary {list(WAKE_KINDS)}"
        )
    key = wake_condition.get("key")
    if not isinstance(key, str) or not key.strip():
        raise GovernanceError("wake_condition.key must be a non-empty string")
    validated: dict[str, Any] = {"kind": kind, "key": key}
    not_before = wake_condition.get("not_before")
    if not_before is not None:
        if not isinstance(not_before, str) or not not_before.strip():
            raise GovernanceError("wake_condition.not_before must be a string timestamp")
        validated["not_before"] = not_before
    return validated


def validate_closure_contract(
    next_action: Any, wake_condition: Any
) -> tuple[str, dict[str, Any]]:
    """The two fields `assert_cycle_closure` fails an open mission for.

    ORPHAN-MEDIUM-730 — measured on the store (2026-08-19): all 5 events in
    `missions/mission-events.jsonl` are ``opened`` rows carrying
    ``next_action: null`` and ``wake_condition: null``, so not one of those
    missions could ever leave DISCOVERED, and `governance.jsonl` carries the
    one violation row that names all five. The gate observed the class and no
    writer ever refused it, which is a gate reporting weather.

    So the contract is validated HERE — one function, called by the mint, by
    every non-terminal transition, and by `set_closure_contract` — because a
    rule enforced at only one of three doors is a rule the other two erase. A
    mission that cannot say what happens next and what would un-stick it is
    not a mission; it is a row, and rows that can never move are the exact
    shape the closure gate exists to make impossible rather than visible.
    """
    if not isinstance(next_action, str) or not next_action.strip():
        raise GovernanceError(
            "the closure contract requires a non-empty next_action: a mission "
            "that cannot say what happens next can never leave DISCOVERED"
        )
    if wake_condition is None:
        raise GovernanceError(
            "the closure contract requires a wake_condition: a mission that "
            "cannot say what would un-stick it can never be woken"
        )
    validated = _validate_wake_condition(wake_condition)
    if validated is None:  # pragma: no cover - None already refused above
        raise GovernanceError("the closure contract requires a wake_condition")
    return next_action.strip(), validated


def _validate_bindings(bindings: Any) -> dict[str, list[Any]]:
    if not isinstance(bindings, dict) or not bindings:
        raise GovernanceError("bindings must be a non-empty object")
    validated: dict[str, list[Any]] = {}
    for key, values in bindings.items():
        if key not in BINDING_KEYS:
            raise GovernanceError(
                f"binding key {key!r} is outside the closed vocabulary {list(BINDING_KEYS)}"
            )
        if isinstance(values, (str, int)):
            values = [values]
        if not isinstance(values, list):
            raise GovernanceError(f"binding {key!r} must be a list")
        validated[key] = values
    return validated


def _strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if isinstance(item, str) and item.strip()]


# ---------------------------------------------------------------------------
# Event store.
# ---------------------------------------------------------------------------


def _load_events(root: Path) -> list[dict[str, Any]]:
    path = events_path(root)
    if not path.exists():
        return []
    return load_declared_jsonl(path, expected_surface="mission_events")


def _fold(events: list[dict[str, Any]], mission_id: str) -> dict[str, Any] | None:
    state: dict[str, Any] | None = None
    for event in events:
        if event.get("mission_id") != mission_id:
            continue
        kind = event.get("event")
        if kind == "opened":
            state = {
                "schema_version": 1,
                "schema": MISSION_SCHEMA,
                "mission_id": mission_id,
                "source_kind": event.get("source_kind"),
                "source_id": event.get("source_id"),
                "repo_hash": event.get("repo_hash"),
                "title": event.get("title"),
                "capability": event.get("capability"),
                "priority": event.get("priority"),
                "target_project": event.get("target_project"),
                "state": "DISCOVERED",
                "opened_at": event.get("recorded_at"),
                "updated_at": event.get("recorded_at"),
                "opened_count": 1,
                "transition_count": 0,
                "retry_rung": None,
                # ORPHAN-MEDIUM-730 — the mint carries the forward pointer, so
                # a mission is answerable to the closure gate from its first
                # event rather than from its first transition.
                "next_action": event.get("next_action"),
                "wake_condition": event.get("wake_condition"),
                "bindings": {},
                "evidence_refs": [],
            }
            continue
        if state is None:
            continue
        state["updated_at"] = event.get("recorded_at")
        if kind == "transition":
            state["state"] = event.get("to_state")
            state["transition_count"] += 1
            # The transition RESTATES the contract; it never inherits the
            # previous one. WHY overwriting is correct here: a forward
            # pointer written for DISCOVERED is a lie once the mission is
            # CONTRACTING, so carrying it forward would keep a stale
            # instruction alive under a new state. What makes the overwrite
            # safe is `transition_mission`, which refuses a non-terminal move
            # that carries no contract and refuses a terminal move that
            # carries one — so ``None`` here means "terminal, owes nothing",
            # never "the writer forgot".
            state["next_action"] = event.get("next_action")
            state["wake_condition"] = event.get("wake_condition")
            if event.get("retry_rung") is not None:
                state["retry_rung"] = event.get("retry_rung")
            refs = _strings(event.get("evidence_refs"))
            if refs:
                merged = list(state["evidence_refs"]) + refs
                state["evidence_refs"] = sorted(set(merged))
        elif kind == "binding":
            for key, values in (event.get("bindings") or {}).items():
                existing = list(state["bindings"].get(key, []))
                for value in values:
                    if value not in existing:
                        existing.append(value)
                state["bindings"][key] = existing
        elif kind == "wake":
            # The contract is ONE thing, not two: a wake row that moved only
            # half of it would leave the mission wake-able and still unable
            # to say what to do once woken. WHAT the guard does: a wake row
            # that carries less than the whole contract INSTALLS NOTHING
            # rather than half-installing or clearing. WHY: `_fold` is the
            # only reader every consumer sees, so a row missing a field would
            # silently delete a contract the mission already had — the same
            # clearing defect the transition branch above no longer allows,
            # arriving through the other event kind. The write side cannot
            # emit such a row (`set_closure_contract` validates both fields);
            # a hand-edited ledger can, and then it moves nothing.
            healed_action = event.get("next_action")
            healed_wake = event.get("wake_condition")
            if healed_action and healed_wake:
                state["next_action"] = healed_action
                state["wake_condition"] = healed_wake
    return state


def fold_mission(
    *, mission_id: str, base_dir: str | Path | None = None
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    state = _fold(_load_events(root), mission_id)
    if state is None:
        raise GovernanceError(f"unknown mission: {mission_id}")
    return state


def list_open_missions(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    root = ensure_tools_dir(base_dir)
    events = _load_events(root)
    seen: list[str] = []
    for event in events:
        mid = event.get("mission_id")
        if isinstance(mid, str) and mid not in seen:
            seen.append(mid)
    missions = []
    for mid in seen:
        state = _fold(events, mid)
        if state is not None and state["state"] not in TERMINAL_STATES:
            missions.append(state)
    return missions


def _find_by_idempotency(
    events: list[dict[str, Any]], key: str
) -> dict[str, Any] | None:
    for event in events:
        if event.get("idempotency_key") == key:
            return event
    return None


def _append(
    txn: Any, root: Path, event: dict[str, Any]
) -> dict[str, Any]:
    event = {
        "schema_version": 1,
        "schema": MISSION_SCHEMA,
        "event_id": str(uuid.uuid4()),
        "recorded_at": utc_now(),
        **event,
    }
    if event.get("event") not in EVENT_KINDS:
        raise GovernanceError(
            f"mission event {event.get('event')!r} is outside the closed vocabulary "
            f"{list(EVENT_KINDS)}"
        )
    return txn.append_declared_jsonl(
        events_path(root), event, expected_surface="mission_events"
    )


def _result(event: dict[str, Any], *, idempotent: bool, **extra: Any) -> dict[str, Any]:
    """``**extra`` carries a command's own verdict fields (`open_mission`
    reports whether the re-open healed a contract-less mission and why not)
    without every other command growing keys it has no opinion about."""
    return {
        "schema_version": 1,
        "mission_id": event.get("mission_id"),
        "idempotent": idempotent,
        "event": event,
        **extra,
    }


# ---------------------------------------------------------------------------
# Commands.
# ---------------------------------------------------------------------------


def open_mission(
    *,
    source_kind: str,
    source_id: str,
    repo_hash: str,
    title: str,
    next_action: str,
    wake_condition: dict[str, Any],
    capability: str | None = None,
    priority: int | None = None,
    target_project: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Open (or replay-open) the mission this source identifies.

    ``target_project`` names the platform project the mission hardens
    (charter §5): until now a service could only be smuggled inside
    ``source_id`` or the title, which no scheduler or report could query.

    ``next_action`` and ``wake_condition`` are REQUIRED (ORPHAN-MEDIUM-730).
    The mint is the FIRST of the three doors that enforce the contract — the
    other two are `transition_mission` and `set_closure_contract` — because
    refusing here alone was measured to buy exactly one event: the next legal
    transition cleared what the mint had required. A producer that cannot
    derive the contract from its own evidence must NOT mint; the honest
    outcome is a disclosed refusal, not a mission nothing can ever advance.

    Idempotent by construction: the mission_id IS the identity, so a second
    open of the same source is a no-op returning the existing mission.

    A RE-OPEN HEALS. Refusing contract-less mints only fixes the future: the
    5 missions on the live store were opened before the mint required
    anything, mission identity deliberately ignores the cycle, so re-seeding
    them is a no-op that would leave them stuck forever. When the re-opened
    mission is MISSING a contract, this sighting's contract is installed
    through `set_closure_contract`. The heal lives here rather than at each
    producer because both producers (`adopt_task_candidates` and the service
    seed phase) need it and a copy in each is how two writers come to disagree
    about when a stuck mission may be repaired.

    Healing NEVER overwrites: a mission that already has a contract keeps the
    one it has (the first sighting owns it; a producer that learned a better
    one says so explicitly through `set_closure_contract`), and a mission in
    `OPERATOR_HELD_STATES` is declined outright — a human owns that sentence.
    The result reports ``healed`` and, when it declined, ``heal_declined``.
    """
    root = ensure_tools_dir(base_dir)
    mission_id = mission_id_for(source_kind, source_id, repo_hash)
    if not isinstance(title, str) or not title.strip():
        raise GovernanceError("open_mission requires a non-empty title")
    action, wake = validate_closure_contract(next_action, wake_condition)
    key = _idempotency_key(mission_id, "genesis", "", "opened")
    with state_transaction([events_path(root)]) as txn:
        events = _load_events(root)
        existing = _find_by_idempotency(events, key)
        if existing is None:
            event = _append(
                txn,
                root,
                {
                    "event": "opened",
                    "mission_id": mission_id,
                    "idempotency_key": key,
                    "source_kind": source_kind,
                    "source_id": source_id,
                    "repo_hash": repo_hash,
                    "title": title,
                    "capability": capability,
                    "priority": priority,
                    "target_project": target_project,
                    "next_action": action,
                    "wake_condition": wake,
                },
            )
            return _result(event, idempotent=False, healed=False, heal_declined=None)
        state = _fold(events, mission_id)
    # OUTSIDE the transaction on purpose: `set_closure_contract` takes the
    # same file lock, and taking it twice from one thread would deadlock.
    # What the gap can cost is bounded: two producers healing the same mission
    # in the same instant either write the identical contract (identical
    # idempotency key, the second folds into a no-op) or two contracts each
    # derived from real evidence, of which the mission keeps the later. What
    # cannot happen is a heal that CLEARS anything — `_heal_on_reopen` writes
    # only when the contract is missing, and `_fold` ignores a wake row that
    # names nothing.
    verdict = _heal_on_reopen(
        mission_id=mission_id,
        state=state,
        next_action=action,
        wake_condition=wake,
        root=root,
    )
    return _result(existing, idempotent=True, **verdict)


def _heal_on_reopen(
    *,
    mission_id: str,
    state: dict[str, Any] | None,
    next_action: str,
    wake_condition: dict[str, Any],
    root: Path,
) -> dict[str, Any]:
    """Install a contract on a re-opened mission that has none, or say why not.

    Returns the two verdict fields `open_mission` reports. Every ``False``
    carries its reason, because "the nightly did not heal this mission" is a
    fact an operator debugs and a silent skip is indistinguishable from a
    mission that was never re-observed.
    """
    if state is None:  # pragma: no cover - the genesis row exists by construction
        return {"healed": False, "heal_declined": "unknown_mission"}
    if state.get("next_action") and state.get("wake_condition"):
        return {"healed": False, "heal_declined": None}
    if state["state"] in TERMINAL_STATES:
        return {"healed": False, "heal_declined": "terminal"}
    if state["state"] in OPERATOR_HELD_STATES:
        return {"healed": False, "heal_declined": "operator_held"}
    set_closure_contract(
        mission_id=mission_id,
        next_action=next_action,
        wake_condition=wake_condition,
        step_id=MINT_HEAL_STEP_ID,
        base_dir=root,
    )
    return {"healed": True, "heal_declined": None}


def set_closure_contract(
    *,
    mission_id: str,
    next_action: str,
    wake_condition: dict[str, Any],
    step_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Install a forward pointer on a mission that is already open.

    The FIRST producer of the ``wake`` event kind, which `EVENT_KINDS` has
    declared and `_fold` has folded since Wave 2 with nothing on the write
    side ever emitting one — dead vocabulary that the fold pretended to
    support.

    It exists because refusing contract-less mints heals only the future:
    the missions already on the store were opened before the mint required
    anything, and mission identity is deliberately stable across cycles, so
    re-seeding them is idempotent and would leave them stuck forever. A
    producer that re-observes such a mission and CAN derive the contract
    installs it here, and the whole ledger converges instead of splitting
    into a healthy new half and a permanently paralysed old one.

    Refused on a terminal mission: a finished mission owes no next action,
    and writing one would be the schema claiming work that will never run.

    Refused on an `OPERATOR_HELD_STATES` mission for a different reason: the
    forward pointer of a mission parked for a human IS the human's statement
    of what happens next. Reproduced before this refusal existed — an
    operator's "do not touch, awaiting my decision" was replaced by a
    machine-composed "Review the 1 path(s) changed in farm-service this
    cycle…" written by the unattended nightly seed phase. The machine cannot
    move such a mission (the scheduler skips every waiting state), so this
    was never a merge-authority breach; it was a machine overwriting an
    operator, which is the same line one layer down.
    """
    root = ensure_tools_dir(base_dir)
    if not isinstance(step_id, str) or not step_id.strip():
        raise GovernanceError("set_closure_contract requires a step_id")
    action, wake = validate_closure_contract(next_action, wake_condition)
    canonical = json.dumps(
        {"next_action": action, "wake_condition": wake},
        sort_keys=True,
        separators=(",", ":"),
    )
    key = _idempotency_key(mission_id, step_id, canonical, "wake")
    with state_transaction([events_path(root)]) as txn:
        events = _load_events(root)
        existing = _find_by_idempotency(events, key)
        if existing is not None:
            return _result(existing, idempotent=True)
        state = _fold(events, mission_id)
        if state is None:
            raise GovernanceError(f"unknown mission: {mission_id}")
        if state["state"] in TERMINAL_STATES:
            raise GovernanceError(
                f"mission {mission_id} is terminal ({state['state']}); a finished "
                "mission owes no next action"
            )
        if state["state"] in OPERATOR_HELD_STATES:
            raise GovernanceError(
                f"mission {mission_id} is {state['state']}; its next action is the "
                "operator's statement and no writer may overwrite it"
            )
        event = _append(
            txn,
            root,
            {
                "event": "wake",
                "mission_id": mission_id,
                "idempotency_key": key,
                "next_action": action,
                "wake_condition": wake,
            },
        )
        return _result(event, idempotent=False)


def transition_mission(
    *,
    mission_id: str,
    to_state: str,
    reason_code: str,
    step_id: str,
    target_sha: str = "",
    retry_rung: str | None = None,
    next_action: str | None = None,
    wake_condition: dict[str, Any] | None = None,
    evidence_refs: list[str] | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Move a mission along the closed edge table, or refuse.

    One stated exception to the table: a FORWARD jump along the mainline is
    legal when ``reason_code == "coarse_observation"`` — today's pipeline
    cannot distinguish every intermediate state, and a skip that says so is
    honest where a skip wearing a precise reason would be the schema lying
    about its own resolution. Backward moves always need an explicit edge.

    THE CLOSURE CONTRACT IS PART OF THE MOVE (ORPHAN-MEDIUM-730). Both fields
    were optional here and `_fold` overwrites them from the event, so ONE
    legal transition that omitted them emptied a contract the mint had just
    required — reproduced end to end: mint carries ``next_action='do the
    thing'``; ``transition_mission(to_state="CONTRACTING")`` with no contract
    folds to ``next_action=None, wake_condition=None``; `assert_cycle_closure`
    then records ``missing: ['next_action', 'wake_condition']``. Refusing at
    the mint alone therefore bought exactly one event of safety.

    So a NON-TERMINAL move must restate both, and a TERMINAL move must carry
    neither — a finished mission owes no next action, and recording one would
    be the schema claiming work that will never run. That is the same split
    `set_closure_contract` enforces, expressed once in
    `validate_closure_contract` rather than re-derived per door.
    """
    root = ensure_tools_dir(base_dir)
    if to_state not in MISSION_STATES:
        raise GovernanceError(f"unknown mission state: {to_state!r}")
    if not isinstance(reason_code, str) or not reason_code.strip():
        raise GovernanceError("transition requires a reason_code")
    if not isinstance(step_id, str) or not step_id.strip():
        raise GovernanceError("transition requires a step_id")
    if retry_rung is not None and retry_rung not in RETRY_LADDER:
        raise GovernanceError(
            f"retry_rung {retry_rung!r} is outside the closed ladder {list(RETRY_LADDER)}"
        )
    if to_state in TERMINAL_STATES:
        if next_action is not None or wake_condition is not None:
            raise GovernanceError(
                f"transition to {to_state} may not carry a closure contract; a "
                "terminal mission owes no next action"
            )
        validated_action: str | None = None
        validated_wake: dict[str, Any] | None = None
    else:
        validated_action, validated_wake = validate_closure_contract(
            next_action, wake_condition
        )
    key = _idempotency_key(mission_id, step_id, target_sha, f"transition:{to_state}")
    with state_transaction([events_path(root)]) as txn:
        events = _load_events(root)
        existing = _find_by_idempotency(events, key)
        if existing is not None:
            return _result(existing, idempotent=True)
        state = _fold(events, mission_id)
        if state is None:
            raise GovernanceError(f"unknown mission: {mission_id}")
        current = state["state"]
        if current in TERMINAL_STATES:
            raise GovernanceError(
                f"mission {mission_id} is terminal ({current}); no transition may leave it"
            )
        allowed = ALLOWED_TRANSITIONS[current]
        if to_state not in allowed:
            from_index = mainline_index(current)
            to_index = mainline_index(to_state)
            is_forward_skip = (
                from_index is not None and to_index is not None and to_index > from_index
            )
            if not (is_forward_skip and reason_code in FORWARD_SKIP_REASONS):
                raise GovernanceError(
                    f"transition {current} -> {to_state} is not in the closed table "
                    f"(reason_code={reason_code!r}); forward mainline skips require "
                    f"one of {sorted(FORWARD_SKIP_REASONS)}"
                )
        if retry_rung is not None and state.get("retry_rung") is not None:
            if RETRY_LADDER.index(retry_rung) < RETRY_LADDER.index(state["retry_rung"]):
                raise GovernanceError(
                    f"retry_rung cannot move backward: {state['retry_rung']} -> {retry_rung}"
                )
        event = _append(
            txn,
            root,
            {
                "event": "transition",
                "mission_id": mission_id,
                "idempotency_key": key,
                "from_state": current,
                "to_state": to_state,
                "reason_code": reason_code,
                "retry_rung": retry_rung,
                "next_action": validated_action,
                "wake_condition": validated_wake,
                "evidence_refs": _strings(evidence_refs),
            },
        )
        return _result(event, idempotent=False)


def bind_mission(
    *,
    mission_id: str,
    bindings: dict[str, Any],
    step_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    validated = _validate_bindings(bindings)
    if not isinstance(step_id, str) or not step_id.strip():
        raise GovernanceError("bind_mission requires a step_id")
    canonical = json.dumps(validated, sort_keys=True, separators=(",", ":"))
    key = _idempotency_key(mission_id, step_id, canonical, "binding")
    with state_transaction([events_path(root)]) as txn:
        events = _load_events(root)
        existing = _find_by_idempotency(events, key)
        if existing is not None:
            return _result(existing, idempotent=True)
        if _fold(events, mission_id) is None:
            raise GovernanceError(f"unknown mission: {mission_id}")
        event = _append(
            txn,
            root,
            {
                "event": "binding",
                "mission_id": mission_id,
                "idempotency_key": key,
                "bindings": validated,
            },
        )
        return _result(event, idempotent=False)


# ---------------------------------------------------------------------------
# Projections and the closure gate.
# ---------------------------------------------------------------------------


def rebuild_mission_index(*, base_dir: str | Path | None = None) -> dict[str, Any]:
    """Rewrite the derived index from the ledger. Deterministic: same events,
    same bytes — losing the index costs one rebuild and nothing else."""
    root = ensure_tools_dir(base_dir)
    events = _load_events(root)
    seen: list[str] = []
    for event in events:
        mid = event.get("mission_id")
        if isinstance(mid, str) and mid not in seen:
            seen.append(mid)
    missions = {}
    for mid in sorted(seen):
        state = _fold(events, mid)
        if state is not None:
            missions[mid] = {
                "state": state["state"],
                "source_kind": state["source_kind"],
                "source_id": state["source_id"],
                "title": state["title"],
                "retry_rung": state["retry_rung"],
                "next_action": state["next_action"],
                "wake_condition": state["wake_condition"],
                "updated_at": state["updated_at"],
            }
    payload = {
        "schema_version": 1,
        "schema": MISSION_SCHEMA,
        "mission_count": len(missions),
        "missions": missions,
    }
    path = index_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    rewrite_declared_json(path, payload, expected_surface="mission_index")
    return {"schema_version": 1, "path": str(path), "mission_count": len(missions)}


def adopt_task_candidates(
    *,
    cycle_id: str,
    repo_hash: str,
    base_dir: str | Path | None = None,
    limit: int = 10,
) -> dict[str, Any]:
    """Turn this cycle's task candidates into persistent missions.

    The FIRST production caller of `task.generate_task_candidates`, which has
    existed with none. Adoption is idempotent by construction: `open_mission`
    keys on ``sha256(source_kind|source_id|repo_hash)``, so the same candidate
    re-discovered on a later night folds into the mission it already opened
    rather than starting a new one — which is the entire reason mission
    identity refuses to read the cycle.

    One candidate at a time, and a bad row costs only itself: a malformed or
    unusably-identified candidate is refused and RECORDED, never dropped in
    silence, because a candidate that vanishes without a trace is
    indistinguishable from one that was never generated.

    THIS IS THE PRODUCER THAT FILLED THE LIVE STORE (ORPHAN-MEDIUM-730). All
    5 events in `missions/mission-events.jsonl` are contract-less ``opened``
    rows from here — ``pressure`` x2, ``shadow_run_summary`` x3 — and none
    from the service seeder. The first attempt at the refusal made it
    unreachable from exactly this path: it passed ``next_action=title``, and
    since `UNUSABLE_SOURCE_IDS` already guarantees a non-empty ``source_id``,
    the title was never empty and `open_mission` therefore never refused. A
    mission whose "what happens next" is the restated defect (a finding's own
    message) or a bare identifier satisfies the gate and still tells an agent
    nothing to do.

    So the forward pointer is READ off the candidate's ``next_action``, which
    `task.py` composes from the SOURCE'S OWN evidence — a pressure's
    ``recommended_action``, a finding's id and cited path, a gap's
    recommendation. A candidate whose source cannot name one carries no
    ``next_action``, and this function refuses it with
    ``no_derivable_next_action`` through the same disclosure the other
    refusals use. Nothing is composed here: a mission-layer reword would be
    this module inventing an instruction it has no evidence for.

    Re-adoption also HEALS, through `open_mission`: the 5 rows above were
    written before any contract was required, and re-adopting them is a
    no-op that would otherwise leave them stuck forever.
    """
    root = ensure_tools_dir(base_dir)
    payload = generate_task_candidates(
        cycle_id=cycle_id, base_dir=root, limit=limit
    )
    candidates = payload.get("tasks") if isinstance(payload, dict) else None
    adopted = already = refused = healed = 0
    for candidate in candidates if isinstance(candidates, list) else []:
        if not isinstance(candidate, dict):
            refused += 1
            continue
        source = candidate.get("source")
        source_id = str(candidate.get("source_id") or "")
        forward = _candidate_forward_pointer(candidate)
        reason = None
        if not isinstance(source, str) or not source.strip():
            reason = "missing_source"
        elif source_id in UNUSABLE_SOURCE_IDS:
            # Refused rather than adopted: see UNUSABLE_SOURCE_IDS.
            reason = "unusable_source_id"
        elif candidate.get("blocked_by"):
            # C9/E8 — a candidate ARIA itself declared blocked is
            # operator-facing work, NOT schedulable work: adopting it opens
            # a mission that mints an agent request for work that cannot
            # run. The pressure path already refuses a blocked item
            # (reflection.py "A blocked pressure is operator-facing work,
            # not schedulable work"); the mission path re-opened the same
            # door. Live proof: all three shadow_run_summary missions on
            # the store originate from task candidates carrying
            # blocked_by=["operator_feedback_required"].
            reason = "candidate_blocked"
        elif forward is None:
            # ORPHAN-MEDIUM-730 — the source could not name what to do next,
            # so there is no mission to open. Ordered AFTER `candidate_blocked`
            # because blocked-ness is the stronger statement about the same
            # candidate: it is operator-facing work either way, and the
            # operator debugging it wants the block named first. Disclosed
            # like every other refusal, so a source that keeps producing
            # unactionable work becomes visible instead of becoming a
            # paralysed mission.
            reason = "no_derivable_next_action"
        if reason is not None:
            refused += 1
            append_tools_governance(
                root,
                "mission_candidate_refused",
                {
                    "schema_version": 1,
                    "cycle_id": cycle_id,
                    "reason": reason,
                    "source": source if isinstance(source, str) else None,
                    "source_id": source_id or None,
                },
            )
            continue
        title = str(candidate.get("title") or source_id)
        # The title says WHAT the work is; `next_action` says what to DO, and
        # they are different sentences read from different fields on purpose.
        # The wake key is the candidate's identity because what un-sticks the
        # mission is new evidence on exactly that pressure / finding / gap —
        # and `UNUSABLE_SOURCE_IDS` has already refused the identities that
        # identify nothing, so the key cannot collapse two unrelated missions
        # onto one handle.
        # `forward` is a string on this line: the refusal chain above is what
        # makes the None case impossible here, and that chain is the whole
        # reason the refusal is reachable from this producer at all.
        result = open_mission(
            source_kind=source,
            source_id=source_id,
            repo_hash=repo_hash,
            title=title,
            next_action=forward,
            wake_condition={"kind": "evidence", "key": f"{source}:{source_id}"},
            base_dir=root,
        )
        if result["idempotent"]:
            already += 1
            if result.get("healed"):
                healed += 1
        else:
            adopted += 1
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "adopted": adopted,
        "already_tracked": already,
        "refused": refused,
        "healed": healed,
    }


def _candidate_forward_pointer(candidate: dict[str, Any]) -> str | None:
    """The candidate's own statement of what to DO, or ``None``.

    ``None`` is a real answer, not a missing value: `task.py`'s builders emit
    ``next_action`` only where the source's evidence names one, so its absence
    is the source saying "I can describe this problem but not the work", and
    the honest response is a disclosed refusal. Reading the field here — and
    nowhere composing a fallback — is what keeps that refusal reachable.
    """
    forward = candidate.get("next_action")
    if not isinstance(forward, str) or not forward.strip():
        return None
    return forward.strip()


def active_wip_missions(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """The missions currently holding a WIP slot.

    Derived from `ACTIVE_WIP_STATES`, not from a second list: a mission holds
    a slot exactly when it holds real resources (a branch, a worker, a PR
    slot). DISCOVERED is not one of them, which is what lets `mission_ingest`
    open a night's whole candidate set without the first adoption blocking
    every promotion after it.
    """
    return [
        state
        for state in list_open_missions(base_dir=base_dir)
        if state["state"] in ACTIVE_WIP_STATES
    ]


def assert_wip_available(
    *,
    cap: int = DEFAULT_WIP_CAP,
    admitting: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Refuse to admit new work while the WIP cap is already spent.

    RAISES rather than returning a verdict, deliberately. The defect this
    closes is a computed in-flight set that no gate ever read; a function
    returning `{"available": False}` reproduces it the first time a caller
    forgets to check the field. A caller that wants to REPORT rather than
    stop — `promote_converged_plan_to_dispatch`, whose contract is a blocker
    list — translates the refusal at its own boundary.

    ``admitting`` excludes one mission from the count: re-admitting the
    mission that already holds the slot is a resumption, not a second thing
    in flight.
    """
    if not isinstance(cap, int) or cap < 1:
        raise GovernanceError("wip cap must be a positive integer")
    in_flight = [
        state
        for state in active_wip_missions(base_dir=base_dir)
        if state["mission_id"] != admitting
    ]
    if len(in_flight) >= cap:
        blocking = ", ".join(
            f"{state['mission_id']}({state['state']})" for state in in_flight
        )
        raise GovernanceError(
            f"wip cap {cap} is spent; in flight: {blocking}"
        )
    return {
        "schema_version": 1,
        "cap": cap,
        "in_flight": [state["mission_id"] for state in in_flight],
        "available": cap - len(in_flight),
    }


def assert_cycle_closure(*, base_dir: str | Path | None = None) -> dict[str, Any]:
    """"No plan silently half-done", executable.

    Every open mission must say what happens next (``next_action``) and what
    it is waiting for (``wake_condition``). A mission carrying neither is
    exactly the shape that used to rot in a worktree nothing revisits — so it
    is a violation, and the violation is RECORDED as a governance event
    because a violation nobody recorded is a violation nobody will fix.

    ORPHAN-MEDIUM-730 NARROWED WHAT THIS CAN STILL SEE, TWICE. `open_mission`
    refuses a contract-less mint, so a freshly minted mission cannot appear
    here; `transition_mission` refuses a non-terminal move that does not
    restate the contract, so a legal move can no longer empty one either. What
    remains reachable is exactly one shape: a row written BEFORE the rule
    existed — the 5 ``opened`` rows measured on the live store, plus anything
    hand-written into the ledger. Those heal the next time a producer
    re-observes them (`open_mission` installs the contract on re-open), except
    where `OPERATOR_HELD_STATES` says the sentence is a human's to write.

    THE VIOLATION IS DISCLOSED ONCE PER DISTINCT VIOLATION SET. The same
    unhealed backlog re-reported verbatim every night is the weather-reporting
    this train exists to end; a violation set that CHANGED is a new fact and
    gets its own row.

    This function observes and records. The DECISION of what a violation does
    to a cycle lives where the cycle seals — `run_enterprise_cycle`, not a
    phase: PLAN called for a `cycle_seal` phase and there is none, and a table
    row would run before the terminal decision it is meant to describe.
    """
    root = ensure_tools_dir(base_dir)
    violations = []
    for state in list_open_missions(base_dir=root):
        missing = []
        if not state.get("next_action"):
            missing.append("next_action")
        if not state.get("wake_condition"):
            missing.append("wake_condition")
        if missing:
            violations.append(
                {
                    "mission_id": state["mission_id"],
                    "state": state["state"],
                    "missing": missing,
                }
            )
    governance_recorded = False
    already_disclosed = False
    if violations:
        disclosure = append_tools_governance_once(
            root,
            "mission_closure_violation",
            {
                "schema_version": 1,
                "violation_count": len(violations),
                "violations": violations,
            },
            # The claim IS the violation set: which missions, in which state,
            # missing which field. The cycle it was noticed in is not part of
            # the claim, which is why noticing it again changes nothing.
            claim_keys=("violations",),
        )
        governance_recorded = bool(disclosure["appended"])
        already_disclosed = not governance_recorded
    return {
        "schema_version": 1,
        "open_missions": len(list_open_missions(base_dir=root)),
        "violations": violations,
        "governance_recorded": governance_recorded,
        "already_disclosed": already_disclosed,
    }


__all__ = [
    "ACTIVE_WIP_STATES",
    "ALLOWED_TRANSITIONS",
    "BINDING_KEYS",
    "COARSE_OBSERVATION",
    "DEFAULT_WIP_CAP",
    "EVENT_KINDS",
    "FORWARD_SKIP_REASONS",
    "MINT_HEAL_STEP_ID",
    "OPERATOR_HELD_STATES",
    "WAITING_STATES",
    "MAINLINE_STATES",
    "MISSION_SCHEMA",
    "MISSION_STATES",
    "RECONCILED_EXTERNAL_MERGE",
    "RETRY_LADDER",
    "TERMINAL_STATES",
    "WAKE_KINDS",
    "UNUSABLE_SOURCE_IDS",
    "active_wip_missions",
    "adopt_task_candidates",
    "assert_cycle_closure",
    "assert_wip_available",
    "bind_mission",
    "events_path",
    "fold_mission",
    "index_path",
    "list_open_missions",
    "mainline_index",
    "mission_id_for",
    "open_mission",
    "rebuild_mission_index",
    "set_closure_contract",
    "transition_mission",
    "validate_closure_contract",
]
