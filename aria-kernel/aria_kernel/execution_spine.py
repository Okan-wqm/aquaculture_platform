"""The autonomous execution identity and session spine.

Operator design (2026-08-30, "Faz 1A"): every mutating operation in ARIA
should carry a UNIFIED identity — who triggered it, which service is
executing, what session it belongs to, what mission it serves, what
provider is running the models. Today these fields are scattered: the
cycle carries cycle_id, governance carries actor, invocations carry
agent_id, tool_health carries runner — nothing ties them into one
auditable thread.

This module is that thread. It provides:

1. **Service Actor Registry** — a closed, validated set of known actors.
   No event can claim an actor that isn't registered; the registry is
   the single source of truth for "who can act in this system."

2. **ExecutionContext** — generated ONCE at cycle start, threaded
   everywhere. Every field an auditor needs to answer "who did this,
   under what authority, in which session, for which mission" lives
   here. Subsystems consume the context rather than minting their own
   partial identities.

3. **Autonomous Session Ledger** — the lifecycle of an execution
   session (started → bound → running → completed/failed/abandoned).
   A session spans one cycle; a mission spans many sessions. The ledger
   is append-only and hash-chained like every other ARIA surface.

4. **Audit Trail Threading** — `to_audit_fields()` produces the common
   identity block that governance, invocations, tool_health, and state
   surfaces SHOULD carry. Backward-compatible: surfaces that don't yet
   thread the context continue to work; new surfaces are required to.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl
from .tool_registry import ensure_tools_dir


# ---------------------------------------------------------------------------
# 1. Service Actor Registry
# ---------------------------------------------------------------------------


class ActorType(str, Enum):
    """The kind of entity that can act in the ARIA system."""

    SYSTEM = "system"  # platform triggers (GitHub schedule, PR event)
    SERVICE = "service"  # ARIA's own services (orchestrator, executor, etc.)
    HUMAN = "human"  # reserved for future operator-session binding


@dataclass(frozen=True)
class Actor:
    """One registered actor — the atom of identity in the spine."""

    id: str
    type: ActorType
    description: str = ""


# The closed registry. Adding an actor is a code change (and a PR), never
# a runtime mutation — the same discipline as MODEL_TIER_ORDER.
SERVICE_ACTOR_REGISTRY: frozenset[Actor] = frozenset({
    Actor(
        id="system:github-schedule",
        type=ActorType.SYSTEM,
        description="GitHub Actions scheduled trigger (cron)",
    ),
    Actor(
        id="system:github-pr",
        type=ActorType.SYSTEM,
        description="GitHub Actions pull_request trigger",
    ),
    Actor(
        id="system:github-dispatch",
        type=ActorType.SYSTEM,
        description="GitHub Actions workflow_dispatch trigger",
    ),
    Actor(
        id="service:aria-autonomy-orchestrator",
        type=ActorType.SERVICE,
        description="The autonomy cycle orchestrator (nightly producer)",
    ),
    Actor(
        id="service:aria-agent-executor",
        type=ActorType.SERVICE,
        description="The CI agent executor (consumer lane)",
    ),
    Actor(
        id="service:aria-merge-authority",
        type=ActorType.SERVICE,
        description="The merge authority lane (readiness claims)",
    ),
    Actor(
        id="service:aria-worker",
        type=ActorType.SERVICE,
        description="The worker dispatch lane",
    ),
    Actor(
        id="service:aria-readiness-claim",
        type=ActorType.SERVICE,
        description="The readiness claim producer",
    ),
})

_ACTOR_INDEX: dict[str, Actor] = {a.id: a for a in SERVICE_ACTOR_REGISTRY}


def validate_actor(actor_id: str) -> Actor:
    """Look up an actor; raise if not in the registry.

    Fail-closed: an unknown actor is a configuration error or an
    injection attempt, never a pass-through.
    """
    actor = _ACTOR_INDEX.get(actor_id)
    if actor is None:
        raise ValueError(
            f"unknown_actor: {actor_id!r} not in the service actor registry "
            f"({sorted(_ACTOR_INDEX)})"
        )
    return actor


def known_actor_ids() -> frozenset[str]:
    """The ids of every registered actor."""
    return frozenset(_ACTOR_INDEX)


# ---------------------------------------------------------------------------
# 2. ExecutionContext Factory
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExecutionContext:
    """All identity fields for one execution — generated once, read everywhere.

    A context is IMMUTABLE after creation. Fields that change during a
    run (e.g., the mission being selected mid-cycle) are recorded as
    session events, not by mutating the context.
    """

    session_id: str
    cycle_id: str
    trigger: str  # "schedule" | "dispatch" | "pr" | "manual"
    executor: str  # actor id from the registry
    runner: str  # runner identity (hostname, runner name)
    repository: str  # "owner/repo"
    runtime_profile: str  # "observe" | "standard" | "strict" | "frozen" | "autonomous"
    target_sha: str | None = None
    mission_id: str | None = None
    provider: str | None = None
    model: str | None = None
    created_at: str = ""

    def __post_init__(self) -> None:
        if not self.created_at:
            object.__setattr__(
                self, "created_at",
                datetime.now(timezone.utc).isoformat(),
            )

    def to_audit_fields(self) -> dict[str, Any]:
        """The common identity block every audit surface should carry.

        Surfaces that already have their own identity fields (cycle_id in
        cycles.jsonl, agent_id in invocations) continue to work — these
        fields are ADDITIVE, forming the unified thread that ties them
        together.
        """
        return {
            "session_id": self.session_id,
            "cycle_id": self.cycle_id,
            "trigger": self.trigger,
            "executor": self.executor,
            "runner": self.runner,
            "repository": self.repository,
            "runtime_profile": self.runtime_profile,
            "target_sha": self.target_sha,
            "mission_id": self.mission_id,
            "provider": self.provider,
            "model": self.model,
        }


def create_execution_context(
    *,
    cycle_id: str,
    trigger: str,
    executor: str,
    runner: str = "",
    repository: str = "",
    runtime_profile: str = "standard",
    target_sha: str | None = None,
    mission_id: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    session_id: str | None = None,
) -> ExecutionContext:
    """Factory: validate the actor, mint the session, build the context.

    This is THE entry point for creating an execution identity. Callers
    do not construct ExecutionContext directly — the factory validates
    the actor, generates the session_id (deterministic from cycle_id
    for idempotency), and returns the frozen context.
    """
    actor = validate_actor(executor)
    if trigger not in ("schedule", "dispatch", "pr", "manual"):
        raise ValueError(f"invalid_trigger: {trigger!r} — must be schedule|dispatch|pr|manual")
    sid = session_id or f"sess-{cycle_id}"
    return ExecutionContext(
        session_id=sid,
        cycle_id=cycle_id,
        trigger=trigger,
        executor=actor.id,
        runner=runner,
        repository=repository,
        runtime_profile=runtime_profile,
        target_sha=target_sha,
        mission_id=mission_id,
        provider=provider,
        model=model,
    )


# ---------------------------------------------------------------------------
# 3. Autonomous Session Ledger
# ---------------------------------------------------------------------------

SESSION_EVENTS: frozenset[str] = frozenset({
    "session_started",
    "mission_bound",
    "agent_bound",
    "provider_bound",
    "session_paused",
    "session_resumed",
    "session_completed",
    "session_failed",
    "session_abandoned",
})

SESSION_LEDGER_SURFACE = "session_ledger"
SESSION_LEDGER_PATH = Path("sessions") / "session-ledger.jsonl"


def record_session_event(
    *,
    event: str,
    context: ExecutionContext,
    base_dir: str | Path | None = None,
    **details: Any,
) -> dict[str, Any]:
    """Write a session lifecycle event to the session ledger.

    The event carries the FULL audit context — every field from the
    ExecutionContext plus any event-specific details. This is the
    immutable record of what happened, who did it, and under what
    authority.
    """
    if event not in SESSION_EVENTS:
        raise ValueError(
            f"unknown_session_event: {event!r} — must be one of {sorted(SESSION_EVENTS)}"
        )
    root = ensure_tools_dir(base_dir)
    row: dict[str, Any] = {
        "schema_version": 1,
        "event": event,
        "at": datetime.now(timezone.utc).isoformat(),
        **context.to_audit_fields(),
        **details,
    }
    append_declared_jsonl(
        root / SESSION_LEDGER_PATH,
        row,
        expected_surface=SESSION_LEDGER_SURFACE,
    )
    return row


def start_session(
    context: ExecutionContext,
    *,
    base_dir: str | None = None,
) -> dict[str, Any]:
    """Record the session_started event — the lifecycle's opening row."""
    return record_session_event(
        event="session_started",
        context=context,
        base_dir=base_dir,
    )


def bind_mission(
    context: ExecutionContext,
    *,
    mission_id: str,
    base_dir: str | None = None,
) -> dict[str, Any]:
    """Bind the session to a mission — one session, one active mission."""
    return record_session_event(
        event="mission_bound",
        context=context,
        base_dir=base_dir,
        mission_id=mission_id,
    )


def bind_provider(
    context: ExecutionContext,
    *,
    provider: str,
    model: str,
    base_dir: str | None = None,
) -> dict[str, Any]:
    """Record which provider/model combination is serving this session."""
    return record_session_event(
        event="provider_bound",
        context=context,
        base_dir=base_dir,
        provider=provider,
        model=model,
    )


def complete_session(
    context: ExecutionContext,
    *,
    outcome: str = "completed",
    base_dir: str | None = None,
    **details: Any,
) -> dict[str, Any]:
    """Record the terminal session event (completed, failed, abandoned)."""
    terminal = {"completed": "session_completed", "failed": "session_failed", "abandoned": "session_abandoned"}
    event = terminal.get(outcome)
    if event is None:
        raise ValueError(f"invalid_session_outcome: {outcome!r}")
    return record_session_event(
        event=event,
        context=context,
        base_dir=base_dir,
        **details,
    )
