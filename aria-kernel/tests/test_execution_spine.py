"""Execution spine invariants — identity is DERIVED, the session ledger is PRODUCED.

ARIA-MEDIUM-029 (operator design 2026-08-30 Faz 1A, 2026-10-16 CONNECT
re-scope). The first cut of this module shipped a CLOSED actor registry an
operator had to keep in sync and a session ledger with a declared surface
(``state_manifest``) and no producer: on the live store every governance row
said ``{"kind": "human", "id": "user@host"}`` because nothing sets
``ARIA_ACTOR`` (2026-09-25 full-read B11), and ``sessions/session-ledger.jsonl``
never existed.

The rewritten spine derives identity from the platform that is actually
running the process and makes the cycle the session ledger's producer:

* ``derive_execution_identity(environ, cgroup_text)`` — a GitHub Actions run
  is ``workflow``; a ``system.slice`` cgroup is ``unit``; a ``user.slice``
  cgroup is ``operator_session``; anything else is ``unattributed`` WITH A
  REASON and never a raise. ``human`` is not a kind: no ARIA process is a
  person, and the actor an audit row names must be derivable, not declared
  by whoever exports the environment.
* ``current_actor_record()`` — the same derivation against the real process.
* ``begin_cycle_session`` / ``bind_session_mission`` / ``end_cycle_session``
  — the cycle mints ``sess-<cycle_id>``, records the lifecycle into the
  declared ledger, and governance rows appended inside the cycle carry the
  session id and the derived actor block.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

_PARENT = Path(__file__).resolve().parents[1]
if str(_PARENT) not in sys.path:
    sys.path.insert(0, str(_PARENT))

from aria_kernel.execution_spine import (  # noqa: E402
    ACTOR_KINDS,
    SESSION_EVENTS,
    ExecutionIdentity,
    begin_cycle_session,
    bind_session_mission,
    current_actor_record,
    derive_execution_identity,
    end_cycle_session,
    session_id_for_cycle,
)

_GHA_ENV = {
    "GITHUB_WORKFLOW_REF": (
        "Okan-wqm/aquaculture_platform/.github/workflows/aria-auto-cycle.yml"
        "@refs/heads/main"
    ),
    "GITHUB_RUN_ID": "1234567890",
    "GITHUB_RUN_ATTEMPT": "3",
}
_GHA_CGROUP = "0::/system.slice/aria-cycle.service\n"
_USER_CGROUP = "0::/user.slice/user-1000.slice/session-5.scope\n"


class DerivedActorKinds(unittest.TestCase):
    """Part A — identity comes from the platform, never from ARIA_ACTOR."""

    def test_actor_kinds_are_the_derived_four_and_human_is_not_one(self) -> None:
        self.assertEqual(ACTOR_KINDS, ("workflow", "unit", "operator_session", "unattributed"))
        self.assertNotIn("human", ACTOR_KINDS)

    def test_a_github_actions_env_gives_the_workflow_actor(self) -> None:
        identity = derive_execution_identity(_GHA_ENV, _GHA_CGROUP)
        self.assertIsInstance(identity, ExecutionIdentity)
        self.assertEqual(identity.kind, "workflow")
        # id is the workflow STEM: which workflow file, not which ref it ran on.
        self.assertEqual(identity.id, "aria-auto-cycle")
        self.assertEqual(identity.run, "1234567890/3")

    def test_aria_actor_is_ignored(self) -> None:
        declared = dict(_GHA_ENV)
        declared["ARIA_ACTOR"] = json.dumps({"kind": "human", "id": "attacker@declared"})
        identity = derive_execution_identity(declared, _GHA_CGROUP)
        self.assertEqual(identity.kind, "workflow")
        self.assertEqual(identity.id, "aria-auto-cycle")
        self.assertNotIn("human", (identity.kind, identity.id))

    def test_a_system_slice_cgroup_gives_the_unit_actor(self) -> None:
        identity = derive_execution_identity({}, _GHA_CGROUP)
        self.assertEqual(identity.kind, "unit")
        self.assertEqual(identity.id, "aria-cycle.service")

    def test_a_user_slice_cgroup_gives_operator_session_never_human(self) -> None:
        identity = derive_execution_identity({}, _USER_CGROUP)
        self.assertEqual(identity.kind, "operator_session")
        self.assertNotEqual(identity.kind, "human")

    def test_an_undecidable_environment_gives_unattributed_with_a_reason(self) -> None:
        identity = derive_execution_identity({}, "")
        self.assertEqual(identity.kind, "unattributed")
        self.assertTrue(identity.reason, "unattributed must carry a reason, not just a label")

    def test_current_actor_record_never_raises_and_names_a_derived_kind(self) -> None:
        record = current_actor_record()
        self.assertIsInstance(record, dict)
        self.assertIn(record["kind"], ACTOR_KINDS)
        self.assertTrue(str(record["id"]).strip())


class SessionIdMinting(unittest.TestCase):
    def test_session_id_is_deterministic_from_the_cycle(self) -> None:
        self.assertEqual(session_id_for_cycle("cyc-20261020T000000Z"), "sess-cyc-20261020T000000Z")


class SessionLedgerLifecycle(unittest.TestCase):
    """Part B — the session spine API writes the declared lifecycle."""

    def setUp(self) -> None:
        from aria_kernel.tool_registry import ensure_tools_dir

        self._tmp = tempfile.TemporaryDirectory()
        self.base = Path(self._tmp.name)
        # A real tools root carries the state manifest the declared-surface
        # check reads; ensure_tools_dir bootstraps it the way every
        # production root is bootstrapped.
        self.tools = ensure_tools_dir(self.base / "aria-tools")
        self.addCleanup(self._tmp.cleanup)

    def _ledger(self) -> list[dict]:
        path = self.tools / "sessions" / "session-ledger.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

    def test_a_session_records_started_bound_and_terminal_in_order(self) -> None:
        session = begin_cycle_session(cycle_id="cyc-spine-api", tools_root=self.tools)
        self.assertEqual(session.session_id, "sess-cyc-spine-api")
        bind_session_mission(mission_id="m-1", tools_root=self.tools)
        ended = end_cycle_session(outcome="completed", tools_root=self.tools)
        self.assertEqual(ended["event"], "session_completed")
        self.assertEqual([row["event"] for row in self._ledger()], [
            "session_started", "mission_bound", "session_completed",
        ])
        for row in self._ledger():
            self.assertEqual(row["session_id"], "sess-cyc-spine-api")
            self.assertEqual(row["cycle_id"], "cyc-spine-api")
            self.assertIn(row["actor"]["kind"], ACTOR_KINDS)
        self.assertEqual(self._ledger()[1]["mission_id"], "m-1")

    def test_the_ambient_session_ends_with_the_terminal_event(self) -> None:
        from aria_kernel.execution_spine import active_session

        begin_cycle_session(cycle_id="cyc-spine-ambient", tools_root=self.tools)
        self.assertIsNotNone(active_session())
        end_cycle_session(outcome="failed", tools_root=self.tools)
        self.assertIsNone(active_session(), "a terminal event must close the ambient session")

    def test_binding_outside_a_session_is_refused(self) -> None:
        with self.assertRaises(RuntimeError):
            bind_session_mission(mission_id="m-orphan", tools_root=self.tools)

    def test_a_session_still_open_when_the_next_cycle_begins_is_abandoned(self) -> None:
        # The escape window no terminal writer covers (an exception between
        # the started row and the phase loop): the next cycle's begin must
        # close the stale thread, not overwrite it silently.
        stale = begin_cycle_session(cycle_id="cyc-spine-leaked", tools_root=self.tools)
        begin_cycle_session(cycle_id="cyc-spine-next", tools_root=self.tools)
        end_cycle_session(outcome="completed", tools_root=self.tools)
        events = [(row["event"], row["session_id"]) for row in self._ledger()]
        self.assertEqual(events, [
            ("session_started", stale.session_id),
            ("session_abandoned", stale.session_id),
            ("session_started", "sess-cyc-spine-next"),
            ("session_completed", "sess-cyc-spine-next"),
        ])

    def test_an_unknown_outcome_is_refused(self) -> None:
        begin_cycle_session(cycle_id="cyc-spine-bad", tools_root=self.tools)
        with self.assertRaises(ValueError):
            end_cycle_session(outcome="exploded", tools_root=self.tools)
        end_cycle_session(outcome="abandoned", tools_root=self.tools)

    def test_every_declared_event_name_is_writable(self) -> None:
        # The declared surface's vocabulary (state_manifest names the ledger;
        # SESSION_EVENTS names what a row may say) stays closed and covered.
        self.assertEqual(
            SESSION_EVENTS,
            {
                "session_started", "mission_bound", "agent_bound", "provider_bound",
                "session_paused", "session_resumed", "session_completed",
                "session_failed", "session_abandoned",
            },
        )


if __name__ == "__main__":
    unittest.main()
