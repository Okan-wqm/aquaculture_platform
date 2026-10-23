"""The autonomous execution identity and session spine.

Operator design (2026-08-30, "Faz 1A"): every mutating operation in ARIA
carries a UNIFIED identity — who triggered it, which session it belongs to,
what mission it serves, what provider runs the models. The first cut of
this module (ARIA-MEDIUM-029) shipped a CLOSED service-actor registry and a
factory callers had to feed by hand, plus a session ledger whose surface
``state_manifest`` declared and nobody produced. On the live store every
governance row therefore said ``{"kind": "human", "id": "user@host"}`` —
the default a process gets when nothing sets ``ARIA_ACTOR``, which nothing
ever did (2026-09-25 full-read B11) — and the audit thread the design asked
for did not exist.

The spine is now DERIVED, not declared:

1. **Derived identity** — :func:`derive_execution_identity` reads the
   platform that is actually running the process: a GitHub Actions run is
   ``workflow``, a ``system.slice`` cgroup is ``unit``, a ``user.slice``
   cgroup is ``operator_session``, anything else is ``unattributed`` with a
   reason. ``human`` is not a kind: no ARIA process is a person, and an
   identity the environment can declare is an identity an attacker can
   declare. :func:`current_actor_record` is the same derivation against
   the real process; it never raises.

2. **Session spine** — the cycle is the ledger's producer. A cycle start
   mints ``sess-<cycle_id>`` (:func:`begin_cycle_session`), mission
   selection binds the mission (:func:`bind_session_mission`), the cycle's
   terminal row closes the session (:func:`end_cycle_session`), and
   governance rows appended inside the cycle carry the session id and the
   actor block through the ambient session this module tracks.

This module is a LEAF: it imports only ``ledger`` (and stdlib), so
``workspace`` — whose ``governance_event`` stamps the actor block — can
import it without a cycle.
"""

from __future__ import annotations

import os
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl

# ---------------------------------------------------------------------------
# 1. Derived identity
# ---------------------------------------------------------------------------

#: The closed vocabulary of actor kinds. Every kind is DERIVED from the
#: platform (see :func:`derive_execution_identity`); ``human`` is
#: deliberately absent — a mutating operation run by an ARIA process is
#: attributed to that process, never to a person, because no surface in
#: this kernel can prove a person.
ACTOR_KINDS: tuple[str, ...] = (
    "workflow",
    "unit",
    "operator_session",
    "unattributed",
)

_GITHUB_WORKFLOW_REF = "GITHUB_WORKFLOW_REF"
_GITHUB_RUN_ID = "GITHUB_RUN_ID"
_GITHUB_RUN_ATTEMPT = "GITHUB_RUN_ATTEMPT"

_CGROUP_PATH = Path("/proc/self/cgroup")
_SYSTEM_SLICE = "/system.slice/"
_USER_SLICE = "/user.slice/"


@dataclass(frozen=True)
class ExecutionIdentity:
    """Who is executing this process, derived from the platform.

    ``id`` names the actor within its kind (the workflow file stem, the
    systemd unit, the login session scope). ``run`` carries the GitHub
    run id/attempt for ``workflow`` actors. ``reason`` says why an
    ``unattributed`` derivation could not name anything better — an
    unattributable actor with no reason is a gap in the audit thread, not
    an answer.
    """

    kind: str
    id: str
    run: str | None = None
    reason: str = ""

    def __post_init__(self) -> None:
        if self.kind not in ACTOR_KINDS:
            raise ValueError(
                f"unknown_actor_kind: {self.kind!r} — must be one of {list(ACTOR_KINDS)}"
            )

    def to_audit_fields(self) -> dict[str, Any]:
        """The actor block every audit surface carries."""
        out: dict[str, Any] = {"kind": self.kind, "id": self.id}
        if self.run:
            out["run"] = self.run
        if self.reason:
            out["reason"] = self.reason
        return out


def derive_execution_identity(
    environ: dict[str, str] | None,
    cgroup_text: str | None,
) -> ExecutionIdentity:
    """Derive the executing identity from the platform, never from ARIA_ACTOR.

    Precedence (first match wins, and no branch raises):

    * ``workflow`` — a GitHub Actions run (``GITHUB_WORKFLOW_REF`` with
      ``GITHUB_RUN_ID``): ``id`` is the workflow file stem (which workflow),
      ``run`` is ``<run id>/<attempt>`` (which execution of it).
    * ``unit`` — the process lives under a ``system.slice`` cgroup (a
      service): ``id`` is the unit name.
    * ``operator_session`` — the process lives under a ``user.slice``
      cgroup (a login session): ``id`` is the session scope. This is an
      operator's session, NOT the operator as an actor — the mutation is
      still run by an ARIA process inside that session.
    * ``unattributed`` — none of the above named the platform, and the
      ``reason`` says so.
    """
    env = os.environ if environ is None else environ
    ref = str(env.get(_GITHUB_WORKFLOW_REF) or "").strip()
    run_id = str(env.get(_GITHUB_RUN_ID) or "").strip()
    if ref and run_id:
        # "owner/repo/.github/workflows/<file>.yml@refs/heads/main" → <file>
        workflow_path = ref.split("@", 1)[0]
        attempt = str(env.get(_GITHUB_RUN_ATTEMPT) or "").strip() or "1"
        return ExecutionIdentity(
            kind="workflow",
            id=Path(workflow_path).stem or workflow_path,
            run=f"{run_id}/{attempt}",
        )
    for line in (cgroup_text or "").splitlines():
        path = line.split(":", 2)[-1] if line.count(":") >= 2 else line
        if _SYSTEM_SLICE in path:
            unit = path.rstrip("/").rsplit("/", 1)[-1]
            return ExecutionIdentity(kind="unit", id=unit or "system.slice")
        if _USER_SLICE in path:
            scope = path.rstrip("/").rsplit("/", 1)[-1]
            return ExecutionIdentity(kind="operator_session", id=scope or "user.slice")
    why = "no_github_workflow_env:no_service_or_user_slice_cgroup"
    if ref and not run_id:
        why = f"github_workflow_ref_without_run_id:{ref[:80]}"
    elif run_id and not ref:
        why = f"github_run_id_without_workflow_ref:{run_id}"
    return ExecutionIdentity(kind="unattributed", id="unknown", reason=why)


def current_execution_identity() -> ExecutionIdentity:
    """The derived identity of THIS process.

    Never raises: identity must be derivable on a host whose
    ``/proc/self/cgroup`` is unreadable or empty — the answer is then
    ``unattributed`` with the reason, which is the honest answer.
    """
    try:
        cgroup_text = _CGROUP_PATH.read_text(encoding="utf-8")
    except OSError:
        cgroup_text = ""
    return derive_execution_identity(os.environ, cgroup_text)


def current_actor_record() -> dict[str, Any]:
    """The derived actor block for THIS process, as a plain record."""
    return current_execution_identity().to_audit_fields()


# ---------------------------------------------------------------------------
# 2. Session spine — the cycle is the ledger's producer
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

#: session outcome → terminal event. ``stopped`` and ``aborted`` cycles
#: both end a session that will not resume: the session is abandoned
#: (:func:`session_outcome_for_cycle_status` owns the cycle-status side).
_SESSION_OUTCOMES: dict[str, str] = {
    "completed": "session_completed",
    "failed": "session_failed",
    "abandoned": "session_abandoned",
}


def session_outcome_for_cycle_status(status: str) -> str:
    """A cycle's terminal ``status`` → the session outcome that closes it.

    ``stopped`` and ``aborted`` cycles both leave a session that will not
    resume: the session is abandoned. One mapping, owned here beside the
    vocabulary it maps — callers never re-derive it.
    """
    if status in ("completed", "failed"):
        return status
    if status in ("stopped", "aborted"):
        return "abandoned"
    raise ValueError(
        f"unknown_cycle_terminal_status: {status!r} — cannot close a session with it"
    )

SESSION_LEDGER_SURFACE = "session_ledger"
SESSION_LEDGER_PATH = Path("sessions") / "session-ledger.jsonl"


def session_id_for_cycle(cycle_id: str) -> str:
    """The session id a cycle mints — deterministic, one session per cycle."""
    return f"sess-{cycle_id}"


@dataclass(frozen=True)
class SessionRecord:
    """The session a cycle opened; the spine's ambient unit of work."""

    session_id: str
    cycle_id: str
    actor: dict[str, Any] = field(default_factory=dict)
    started_at: str = ""


_ACTIVE_SESSION: ContextVar[SessionRecord | None] = ContextVar(
    "aria_execution_session", default=None
)


def active_session() -> SessionRecord | None:
    """The session of the cycle currently running in this process, if any."""
    return _ACTIVE_SESSION.get()


def record_session_event(
    *,
    event: str,
    session: SessionRecord,
    tools_root: Path,
    **details: Any,
) -> dict[str, Any]:
    """Append one lifecycle row to the declared session ledger.

    Every row carries the thread an auditor needs to walk: which session,
    which cycle, which derived actor — plus the event's own details.
    """
    if event not in SESSION_EVENTS:
        raise ValueError(
            f"unknown_session_event: {event!r} — must be one of {sorted(SESSION_EVENTS)}"
        )
    row: dict[str, Any] = {
        "schema_version": 2,
        "event": event,
        "at": datetime.now(timezone.utc).isoformat(),
        "session_id": session.session_id,
        "cycle_id": session.cycle_id,
        "actor": session.actor,
    }
    row.update(details)
    append_declared_jsonl(
        Path(tools_root) / SESSION_LEDGER_PATH,
        row,
        expected_surface=SESSION_LEDGER_SURFACE,
    )
    return row


def begin_cycle_session(*, cycle_id: str, tools_root: Path) -> SessionRecord:
    """Mint the cycle's session and record ``session_started``.

    The session id is derived from the cycle id, so replaying a cycle's
    ledger identifies its session without a second source of truth. The
    actor is DERIVED at mint time — the record of who opened the session
    is what the platform said when it happened.

    A session still open from a previous cycle in this process is
    recorded ``session_abandoned`` before the new one opens: a new cycle
    starting means the old session will never resume (its cycle escaped
    between its started row and any terminal writer — exactly the window
    the escape sealer cannot cover), and an auditor must see that close,
    not a silently overwritten thread.
    """
    stale = _ACTIVE_SESSION.get()
    if stale is not None:
        try:
            record_session_event(
                event="session_abandoned", session=stale, tools_root=tools_root,
                reason="superseded_by_next_cycle",
            )
        except OSError:
            # The new session still opens: a ledger that cannot record the
            # abandon must not also prevent the honest start of the next.
            pass
    session = SessionRecord(
        session_id=session_id_for_cycle(cycle_id),
        cycle_id=cycle_id,
        actor=current_actor_record(),
        started_at=datetime.now(timezone.utc).isoformat(),
    )
    record_session_event(
        event="session_started", session=session, tools_root=tools_root
    )
    _ACTIVE_SESSION.set(session)
    return session


def bind_session_mission(*, mission_id: str, tools_root: Path) -> dict[str, Any]:
    """Record ``mission_bound`` against the ambient session."""
    session = _ACTIVE_SESSION.get()
    if session is None:
        raise RuntimeError(
            "bind_session_mission requires a running session: call "
            "begin_cycle_session first (mission binding outside a cycle "
            "has no audit thread to attach to)"
        )
    return record_session_event(
        event="mission_bound",
        session=session,
        tools_root=tools_root,
        mission_id=mission_id,
    )


def record_provider_bound(*, provider: str, model: str, tools_root: Path) -> dict[str, Any]:
    """Record ``provider_bound`` against the ambient session.

    The rung that answered: the provider/model combination that actually
    served the session's work. Producers call this when a result carries
    that fact; the spine never invents it.
    """
    session = _ACTIVE_SESSION.get()
    if session is None:
        raise RuntimeError(
            "record_provider_bound requires a running session: call "
            "begin_cycle_session first"
        )
    return record_session_event(
        event="provider_bound",
        session=session,
        tools_root=tools_root,
        provider=provider,
        model=model,
    )


def end_cycle_session(
    *,
    outcome: str,
    tools_root: Path,
    **details: Any,
) -> dict[str, Any]:
    """Record the session's terminal event and close the ambient session."""
    event = _SESSION_OUTCOMES.get(outcome)
    if event is None:
        raise ValueError(
            f"invalid_session_outcome: {outcome!r} — must be one of {sorted(_SESSION_OUTCOMES)}"
        )
    session = _ACTIVE_SESSION.get()
    if session is None:
        raise RuntimeError(
            "end_cycle_session requires a running session: call "
            "begin_cycle_session first"
        )
    row = record_session_event(
        event=event, session=session, tools_root=tools_root, **details
    )
    _ACTIVE_SESSION.set(None)
    return row
