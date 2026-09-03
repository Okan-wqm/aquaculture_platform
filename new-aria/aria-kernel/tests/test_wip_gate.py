"""One thing in flight at a time — and a way out when it dies.

PLAN Wave 2 PR 1.4, closing ORPHAN-HIGH-487. The operator rule (2026-07-28) is
that ARIA must not start a new plan before the current one is completely
finished, and must not leave work half-done. Nothing enforced it.

TWO HALVES, AND THE FIRST WITHOUT THE SECOND IS WORSE THAN NEITHER. Admission
alone makes a single abandoned worker freeze ARIA permanently: the assignment
stays `picked_up` forever, the gate reads it as in flight forever, and no
second plan is ever promoted again. So the lease reaper lands in the same
change.

THE FINDING NAMED THE WRONG DATA SOURCE, and that had to be checked rather
than assumed. It proposed gating on `plan_convergence.list_active_plans()`.
That function filters out `TERMINAL_STATES`, and `CONVERGED` is in that set —
while `promote_converged_plan_to_dispatch` refuses any plan that is not
CONVERGED. So the candidate is never in the active list, and neither is any
previously-promoted plan: promotion writes a dispatch row and no plan event at
all, so a promoted plan stays CONVERGED, which is terminal. A gate built on
that source would have been unable to fire — the exact defect class this
programme keeps closing. The live in-flight record is the DISPATCH ASSIGNMENT.
"""

from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from aria_kernel import cycle as cycle_module
from aria_kernel.ledger import load_jsonl
from aria_kernel.mission import (
    DEFAULT_WIP_CAP,
    active_wip_missions,
    assert_wip_available,
    bind_mission,
    mission_id_for,
    open_mission,
    transition_mission,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.worker_dispatch import (
    ACTIVE_ASSIGNMENT_STATES,
    DEFAULT_MAX_LEASE_REQUEUES,
    active_dispatch_assignments,
    reap_expired_assignment_claims,
)
from tests._helpers.declared_fixtures import append_declared_fixture

REPO_HASH = "repohash0001"


def _iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


class WipTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = ensure_tools_dir(self.base)
        self.now = datetime(2026, 8, 4, 12, 0, 0, tzinfo=timezone.utc)

    # -- dispatch fixtures ------------------------------------------------

    def _assignment(self, assignment_id: str, *, plan_id: str = "plan-1") -> str:
        append_declared_fixture(
            self.root / "dispatch" / "requests.jsonl",
            {
                "$schema": "aria/dispatch-request/v2",
                "schema_version": 2,
                "assignment_id": assignment_id,
                "pressure_event_id": f"pe-{assignment_id}",
                "target_agent": "aria-worker",
                "state": "pending",
                "created_at": _iso(self.now - timedelta(hours=2)),
                "plan_id": plan_id,
            },
            expected_surface="dispatch_requests",
        )
        return assignment_id

    def _claim(
        self,
        assignment_id: str,
        *,
        claim_id: str,
        expires_in_seconds: int,
        at: datetime | None = None,
    ) -> str:
        # `at` moves for a re-claim after a requeue, because production time
        # moves: `_latest_assignment_states` folds by timestamp, and two claims
        # sharing one instant are indistinguishable from two live claims —
        # which the fold correctly calls `multiple_active_claims_corruption`.
        claimed_at = at if at is not None else self.now - timedelta(minutes=30)
        append_declared_fixture(
            self.root / "dispatch" / "claims.jsonl",
            {
                "schema_version": 1,
                "event": "claimed",
                "claim_id": claim_id,
                "assignment_id": assignment_id,
                "pressure_event_id": f"pe-{assignment_id}",
                "agent_id": "aria-worker",
                "lease_seconds": expires_in_seconds,
                "recorded_at": _iso(claimed_at),
                "claimed_at": _iso(claimed_at),
                "lease_expires_at": _iso(
                    claimed_at + timedelta(seconds=expires_in_seconds)
                ),
            },
            expected_surface="dispatch_claims",
        )
        return claim_id

    def _walk_the_ladder(self, assignment_id: str):
        """Claim → expire → reap, once per rung, with time moving forward.

        Yields the attempt index BEFORE each reap so a caller can assert on
        the state the assignment is in while the rung is still live.
        """
        for attempt in range(DEFAULT_MAX_LEASE_REQUEUES + 1):
            claimed_at = self.now + timedelta(hours=attempt)
            self._claim(
                assignment_id,
                claim_id=f"C-{attempt}",
                expires_in_seconds=60,
                at=claimed_at,
            )
            yield attempt
            reap_expired_assignment_claims(
                base_dir=self.base, now=claimed_at + timedelta(minutes=30)
            )

    def _claim_events(self, assignment_id: str) -> list[str]:
        path = self.root / "dispatch" / "claims.jsonl"
        if not path.exists():
            return []
        return [
            str(row.get("event"))
            for row in load_jsonl(path)
            if row.get("assignment_id") == assignment_id
        ]

    def _governance(self, kind: str) -> list[dict[str, Any]]:
        path = self.root / "governance.jsonl"
        if not path.exists():
            return []
        return [row for row in load_jsonl(path) if row.get("kind") == kind]

    # -- mission fixtures -------------------------------------------------

    def _mission_at(self, state: str, *, source_id: str = "F-1") -> str:
        from aria_kernel.mission import MAINLINE_STATES

        mission_id = mission_id_for("finding", source_id, REPO_HASH)
        # ORPHAN-MEDIUM-730 — the mint refuses a mission with no forward
        # pointer, so the fixture derives one from the finding it opens.
        open_mission(
            source_kind="finding",
            source_id=source_id,
            repo_hash=REPO_HASH,
            title=f"close {source_id}",
            next_action=f"close {source_id}",
            wake_condition={"kind": "evidence", "key": f"finding:{source_id}"},
            base_dir=self.base,
        )
        if state == "DISCOVERED":
            return mission_id
        steps = (
            list(MAINLINE_STATES[1 : MAINLINE_STATES.index(state) + 1])
            if state in MAINLINE_STATES
            else [state]
        )
        for step in steps:
            transition_mission(
                mission_id=mission_id,
                to_state=step,
                reason_code="fixture",
                step_id=f"fixture-{source_id}-{step}",
                next_action="n",
                wake_condition={"kind": "timer", "key": "k"},
                base_dir=self.base,
            )
        return mission_id


# =====================================================================
# What counts as in flight.
# =====================================================================


class ActiveAssignmentTests(WipTestBase):
    def test_a_pending_assignment_is_in_flight(self) -> None:
        self._assignment("A-1")
        self.assertEqual(
            [row["assignment_id"] for row in active_dispatch_assignments(base_dir=self.base)],
            ["A-1"],
        )

    def test_a_claimed_assignment_is_in_flight(self) -> None:
        self._assignment("A-1")
        self._claim("A-1", claim_id="C-1", expires_in_seconds=1800)
        states = {row["state"] for row in active_dispatch_assignments(base_dir=self.base)}
        self.assertEqual(states, {"picked_up"})

    def test_a_reaped_assignment_stops_being_in_flight(self) -> None:
        """The property the whole gate depends on. Without it, one dead
        worker freezes every future promotion — so the ladder is walked to
        its end here and the assignment must leave the in-flight set."""
        self._assignment("A-1")
        for attempt in self._walk_the_ladder("A-1"):
            self.assertTrue(
                active_dispatch_assignments(base_dir=self.base),
                f"assignment left the in-flight set after {attempt} expiries",
            )
        self.assertEqual(active_dispatch_assignments(base_dir=self.base), [])

    def test_a_dead_assignment_is_not_reaped_again(self) -> None:
        self._assignment("A-1")
        list(self._walk_the_ladder("A-1"))
        self._claim(
            "A-1",
            claim_id="C-late",
            expires_in_seconds=60,
            at=self.now + timedelta(hours=9),
        )
        result = reap_expired_assignment_claims(
            base_dir=self.base, now=self.now + timedelta(hours=10)
        )
        self.assertEqual(result["expired"], [])

    def test_a_verified_assignment_no_longer_holds_the_slot(self) -> None:
        """Nothing in this state machine moves `verified` onward — whether
        the PR then merges is the MISSION layer's question, answered by
        mission_reconcile. Counting it here would hold the slot forever."""
        self.assertNotIn("verified", ACTIVE_ASSIGNMENT_STATES)
        self.assertNotIn("completed", ACTIVE_ASSIGNMENT_STATES)

    def test_the_active_set_is_a_closed_declared_vocabulary(self) -> None:
        self.assertEqual(
            ACTIVE_ASSIGNMENT_STATES,
            frozenset({"pending", "prepared", "picked_up", "submitted"}),
        )


# =====================================================================
# The lease reaper — the way out.
# =====================================================================


class LeaseReaperTests(WipTestBase):
    def test_a_live_lease_is_not_reaped(self) -> None:
        self._assignment("A-1")
        self._claim("A-1", claim_id="C-1", expires_in_seconds=7200)
        result = reap_expired_assignment_claims(base_dir=self.base, now=self.now)
        self.assertEqual(result["expired"], [])
        self.assertEqual(self._claim_events("A-1"), ["claimed"])

    def test_an_expired_lease_is_requeued_back_to_pending(self) -> None:
        self._assignment("A-1")
        self._claim("A-1", claim_id="C-1", expires_in_seconds=60)
        result = reap_expired_assignment_claims(base_dir=self.base, now=self.now)
        self.assertEqual(len(result["requeued"]), 1)
        self.assertEqual(self._claim_events("A-1"), ["claimed", "released"])
        states = {row["state"] for row in active_dispatch_assignments(base_dir=self.base)}
        self.assertEqual(states, {"pending"})

    def test_the_requeue_ladder_ends_at_human_required(self) -> None:
        self._assignment("A-1")
        list(self._walk_the_ladder("A-1"))
        events = self._claim_events("A-1")
        self.assertEqual(events.count("released"), DEFAULT_MAX_LEASE_REQUEUES)
        self.assertEqual(events[-1], "human_required")

    def test_reaping_twice_does_not_double_release(self) -> None:
        self._assignment("A-1")
        self._claim("A-1", claim_id="C-1", expires_in_seconds=60)
        reap_expired_assignment_claims(base_dir=self.base, now=self.now)
        second = reap_expired_assignment_claims(base_dir=self.base, now=self.now)
        self.assertEqual(second["expired"], [])
        self.assertEqual(self._claim_events("A-1"), ["claimed", "released"])

    def test_every_expiry_is_recorded_in_governance(self) -> None:
        """A lease that died in silence is indistinguishable from a worker
        that never claimed."""
        self._assignment("A-1")
        self._claim("A-1", claim_id="C-1", expires_in_seconds=60)
        reap_expired_assignment_claims(base_dir=self.base, now=self.now)
        rows = self._governance("dispatch_claim_lease_expired")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["details"]["assignment_id"], "A-1")
        self.assertEqual(rows[0]["details"]["disposition"], "requeued")

    def test_a_claim_without_a_lease_timestamp_is_left_alone(self) -> None:
        """No expiry recorded is not an expiry observed. The same rule
        reconciliation runs on: absence is not damage."""
        self._assignment("A-1")
        append_declared_fixture(
            self.root / "dispatch" / "claims.jsonl",
            {
                "schema_version": 1,
                "event": "claimed",
                "claim_id": "C-noexpiry",
                "assignment_id": "A-1",
                "agent_id": "aria-worker",
                "recorded_at": _iso(self.now - timedelta(hours=1)),
            },
            expected_surface="dispatch_claims",
        )
        result = reap_expired_assignment_claims(base_dir=self.base, now=self.now)
        self.assertEqual(result["expired"], [])
        self.assertEqual(self._claim_events("A-1"), ["claimed"])


# =====================================================================
# Mission-side WIP.
# =====================================================================


class MissionWipTests(WipTestBase):
    def test_the_cap_is_one_because_that_is_the_operator_rule(self) -> None:
        self.assertEqual(DEFAULT_WIP_CAP, 1)

    def test_a_freshly_discovered_mission_holds_no_slot(self) -> None:
        """`mission_ingest` opens every candidate in DISCOVERED. If discovery
        consumed WIP, the first night's adoption would block everything."""
        self._mission_at("DISCOVERED", source_id="F-new")
        self.assertEqual(active_wip_missions(base_dir=self.base), [])
        assert_wip_available(base_dir=self.base)

    def test_an_implementing_mission_holds_the_slot(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING", source_id="F-wip")
        held = active_wip_missions(base_dir=self.base)
        self.assertEqual([m["mission_id"] for m in held], [mission_id])
        with self.assertRaises(GovernanceError) as ctx:
            assert_wip_available(base_dir=self.base)
        self.assertIn(mission_id, str(ctx.exception))

    def test_a_waiting_mission_releases_the_slot(self) -> None:
        """A mission blocked on a human must not starve the pipeline — the
        reason WAITING_STATES sit outside ACTIVE_WIP_STATES."""
        self._mission_at("HUMAN_REQUIRED", source_id="F-stuck")
        self.assertEqual(active_wip_missions(base_dir=self.base), [])
        assert_wip_available(base_dir=self.base)

    def test_the_mission_being_admitted_does_not_block_itself(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING", source_id="F-self")
        assert_wip_available(base_dir=self.base, admitting=mission_id)

    def test_a_wider_cap_admits_up_to_it(self) -> None:
        self._mission_at("IMPLEMENTING", source_id="F-a")
        assert_wip_available(base_dir=self.base, cap=2)
        self._mission_at("IMPLEMENTING", source_id="F-b")
        with self.assertRaises(GovernanceError):
            assert_wip_available(base_dir=self.base, cap=2)

    def test_a_terminal_mission_holds_nothing(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING", source_id="F-done")
        bind_mission(
            mission_id=mission_id,
            bindings={"pr_numbers": [1]},
            step_id="fixture",
            base_dir=self.base,
        )
        transition_mission(
            mission_id=mission_id,
            to_state="SUPERSEDED",
            reason_code="fixture",
            step_id="terminate",
            next_action=None,
            wake_condition=None,
            base_dir=self.base,
        )
        self.assertEqual(active_wip_missions(base_dir=self.base), [])


# =====================================================================
# Admission at the mutation throat.
# =====================================================================


class PromotionAdmissionTests(WipTestBase):
    def _promote(self, plan_id: str = "plan-2") -> dict[str, Any]:
        from aria_kernel.promotion_controller import promote_converged_plan_to_dispatch
        from aria_kernel.workspace import workspace_paths

        paths = workspace_paths(self.base, None)
        return promote_converged_plan_to_dispatch(
            paths,
            plan_id=plan_id,
            cycle_id="cycle-1",
            tools_root=self.root,
            impact_ref="impact.json",
            validation_ref="validation.json",
            base_sha="a" * 40,
            acknowledge=True,
        )

    def test_a_live_assignment_blocks_a_second_promotion(self) -> None:
        self._assignment("A-1", plan_id="plan-1")
        result = self._promote()
        self.assertEqual(result["status"], "blocked")
        self.assertIn("dispatch_wip_unavailable", result["blockers"])

    def test_a_mission_in_flight_blocks_a_promotion(self) -> None:
        self._mission_at("IMPLEMENTING", source_id="F-wip")
        result = self._promote()
        self.assertEqual(result["status"], "blocked")
        self.assertIn("mission_wip_unavailable", result["blockers"])

    def test_the_block_names_what_is_holding_the_slot(self) -> None:
        """A refusal that does not say which work is blocking is a refusal an
        operator cannot act on."""
        self._assignment("A-1", plan_id="plan-1")
        self._promote()
        rows = self._governance("plan_promotion_blocked")
        self.assertTrue(rows)
        details = rows[-1]["details"]
        self.assertEqual(details["in_flight_assignment_ids"], ["A-1"])

    def test_the_wip_check_runs_before_the_plan_state_check(self) -> None:
        """The candidate plan does not exist in this fixture, so without the
        WIP check first the refusal would read `plan_not_converged` and hide
        the real reason."""
        self._assignment("A-1", plan_id="plan-1")
        result = self._promote()
        self.assertEqual(result["blockers"][0], "dispatch_wip_unavailable")

    def test_an_empty_queue_does_not_block_on_wip(self) -> None:
        result = self._promote()
        self.assertEqual(result["status"], "blocked")
        self.assertNotIn("dispatch_wip_unavailable", result["blockers"])
        self.assertNotIn("mission_wip_unavailable", result["blockers"])


# =====================================================================
# Wiring.
# =====================================================================


class PipelineWiringTests(unittest.TestCase):
    def _phase(self) -> Any:
        for phase in cycle_module.CYCLE_PHASES:
            if phase.name == "dispatch_lease_reap":
                return phase
        self.fail("dispatch_lease_reap is not in CYCLE_PHASES")

    def test_the_reaper_is_on_the_lane(self) -> None:
        phase = self._phase()
        self.assertEqual(phase.stage, "post_tool")
        self.assertIs(phase.precondition, cycle_module.WRITES_PERMITTED)
        self.assertEqual(phase.on_error, "record_and_continue")
        self.assertEqual(phase.state_key, "dispatch_lease_reap")

    def test_the_reaper_is_not_in_the_burn_in_lane(self) -> None:
        self.assertNotIn("burn_in", self._phase().modes)


class PhaseRunnerTests(WipTestBase):
    def test_the_phase_runner_runs_end_to_end(self) -> None:
        """Every name the runner uses resolves and the reaper it calls acts —
        a phase whose first live run raises NameError is a phase no test
        executed."""
        self._assignment("A-1")
        self._claim("A-1", claim_id="C-1", expires_in_seconds=60)
        context = cycle_module.build_phase_context(
            cycle_id="cycle-1", workspace_root=self.base, base_dir=self.root
        )
        payload = cycle_module._phase_dispatch_lease_reap(context)
        self.assertEqual(len(payload["requeued"]), 1)


if __name__ == "__main__":
    unittest.main()
