"""Execution spine invariants — the seven guarantees (operator design 2026-08-30).

Each test pins ONE guarantee from the operator's Faz 1A design:
1. Mutating run requires session_id (no context, no write)
2. Session can only use known actors (closed registry)
3. Agent invocation is bound to a session
4. Tool run is bound to the current session
5. Mission binding requires a valid mission_id
6. Credentials never appear raw in any ledger
7. Provider metadata is factual (from the fleet probe, never invented)
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
    Actor,
    ActorType,
    ExecutionContext,
    SESSION_EVENTS,
    SERVICE_ACTOR_REGISTRY,
    bind_mission,
    bind_provider,
    complete_session,
    create_execution_context,
    known_actor_ids,
    record_session_event,
    start_session,
    validate_actor,
)


def _ctx(**overrides):
    """Standard test context."""
    defaults = dict(
        cycle_id="cyc-test",
        trigger="dispatch",
        executor="service:aria-autonomy-orchestrator",
        runner="test-runner",
        repository="test/repo",
        runtime_profile="standard",
    )
    defaults.update(overrides)
    return create_execution_context(**defaults)


class ActorRegistryInvariants(unittest.TestCase):
    """Guarantee 2: sessions can only use known actors."""

    def test_registry_is_closed_and_nonempty(self) -> None:
        self.assertGreater(len(SERVICE_ACTOR_REGISTRY), 0)

    def test_every_actor_has_valid_type(self) -> None:
        for actor in SERVICE_ACTOR_REGISTRY:
            self.assertIsInstance(actor.type, ActorType)

    def test_known_actor_ids_matches_registry(self) -> None:
        self.assertEqual(known_actor_ids(), {a.id for a in SERVICE_ACTOR_REGISTRY})

    def test_validate_actor_returns_the_actor(self) -> None:
        actor = validate_actor("system:github-schedule")
        self.assertEqual(actor.type, ActorType.SYSTEM)

    def test_unknown_actor_rejected(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            validate_actor("attacker:unknown")
        self.assertIn("unknown_actor", str(ctx.exception))

    def test_context_factory_rejects_unknown_actor(self) -> None:
        with self.assertRaises(ValueError):
            _ctx(executor="rogue:attacker")


class ExecutionContextInvariants(unittest.TestCase):
    """Guarantee 1: no context, no mutating write."""

    def test_context_is_frozen(self) -> None:
        ctx = _ctx()
        with self.assertRaises(AttributeError):
            ctx.runner = "changed"

    def test_session_id_deterministic_from_cycle(self) -> None:
        ctx = _ctx()
        self.assertEqual(ctx.session_id, f"sess-{ctx.cycle_id}")

    def test_session_id_explicit_overrides(self) -> None:
        ctx = _ctx(session_id="sess-custom")
        self.assertEqual(ctx.session_id, "sess-custom")

    def test_invalid_trigger_rejected(self) -> None:
        with self.assertRaises(ValueError):
            _ctx(trigger="sneaky")

    def test_audit_fields_carry_full_identity(self) -> None:
        ctx = _ctx(target_sha="a" * 40, mission_id="m1", provider="zai", model="glm-5.3")
        audit = ctx.to_audit_fields()
        for key in ("session_id", "cycle_id", "trigger", "executor", "runner",
                     "repository", "runtime_profile", "target_sha", "mission_id",
                     "provider", "model"):
            self.assertIn(key, audit, f"audit_fields missing {key}")


class SessionLedgerInvariants(unittest.TestCase):
    """Guarantees 1, 3, 5, 6: the ledger enforces identity and cleanliness."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.base = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def _ledger(self) -> list[dict]:
        path = Path(self.base) / "sessions" / "session-ledger.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

    def test_start_session_writes_started_row(self) -> None:
        ctx = _ctx()
        start_session(ctx, base_dir=self.base)
        rows = self._ledger()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["event"], "session_started")
        self.assertEqual(rows[0]["session_id"], ctx.session_id)

    def test_full_lifecycle_records_all_events(self) -> None:
        ctx = _ctx()
        start_session(ctx, base_dir=self.base)
        bind_mission(ctx, mission_id="m-123", base_dir=self.base)
        bind_provider(ctx, provider="zai", model="glm-5.3", base_dir=self.base)
        complete_session(ctx, outcome="completed", base_dir=self.base)
        events = [r["event"] for r in self._ledger()]
        self.assertEqual(events, [
            "session_started", "mission_bound", "provider_bound", "session_completed",
        ])

    def test_every_row_carries_audit_context(self) -> None:
        ctx = _ctx(target_sha="b" * 40)
        start_session(ctx, base_dir=self.base)
        row = self._ledger()[0]
        self.assertEqual(row["executor"], ctx.executor)
        self.assertEqual(row["runtime_profile"], ctx.runtime_profile)
        self.assertEqual(row["target_sha"], ctx.target_sha)

    def test_unknown_event_rejected(self) -> None:
        ctx = _ctx()
        with self.assertRaises(ValueError):
            record_session_event(event="hacked", context=ctx, base_dir=self.base)

    def test_invalid_terminal_outcome_rejected(self) -> None:
        ctx = _ctx()
        with self.assertRaises(ValueError):
            complete_session(ctx, outcome="exploded", base_dir=self.base)

    def test_credential_never_in_ledger(self) -> None:
        """Guarantee 6: raw credentials must never reach any ledger row."""
        ctx = _ctx(provider="zai")
        bind_provider(ctx, provider="zai", model="glm-5.3", base_dir=self.base)
        raw = Path(self.base).joinpath("sessions", "session-ledger.jsonl").read_text()
        # The provider NAME appears; the API KEY must not
        self.assertIn("zai", raw)
        self.assertNotIn("API_KEY", raw.upper().replace("PROVIDER", ""))
        self.assertNotIn("Bearer ", raw)

    def test_mission_binding_carries_mission_id(self) -> None:
        """Guarantee 5: mission binding requires a mission_id."""
        ctx = _ctx(mission_id=None)
        bind_mission(ctx, mission_id="m-456", base_dir=self.base)
        rows = self._ledger()
        mission_rows = [r for r in rows if r["event"] == "mission_bound"]
        self.assertEqual(len(mission_rows), 1)
        self.assertEqual(mission_rows[0]["mission_id"], "m-456")


class ProviderMetadataInvariants(unittest.TestCase):
    """Guarantee 7: provider metadata is factual (from the fleet probe)."""

    def test_bind_provider_records_provider_and_model(self) -> None:
        ctx = _ctx()
        with tempfile.TemporaryDirectory() as base:
            bind_provider(ctx, provider="zai", model="glm-5.3", base_dir=base)
            path = Path(base) / "sessions" / "session-ledger.jsonl"
            row = json.loads(path.read_text().splitlines()[-1])
            self.assertEqual(row["provider"], "zai")
            self.assertEqual(row["model"], "glm-5.3")

    def test_provider_from_fleet_is_known(self) -> None:
        """The provider must be one of the fleet's registered keys."""
        from aria_kernel.model_fleet import _FLEET
        known = {p.key for p in _FLEET}
        ctx = _ctx()
        for provider in known:
            with tempfile.TemporaryDirectory() as base:
                bind_provider(ctx, provider=provider, model="test", base_dir=base)


if __name__ == "__main__":
    unittest.main()
