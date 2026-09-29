"""Wave 2 PR 1.6 — the scheduler chooses, and accounts for what it did not choose.

The mission layer could count slots, name their holders and refuse when they
were full. It could not CHOOSE. These tests pin the two properties that make a
choice reviewable: every outcome is named, and the order is total.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.ledger import load_jsonl
from aria_kernel.mission import TERMINAL_STATES, fold_mission, open_mission, transition_mission
from aria_kernel.mission_scheduler import (
    _rank,
    ALL_MISSIONS_WAITING,
    NO_OPEN_MISSIONS,
    SELECTED,
    WIP_SLOT_HELD,
    select_next_mission,
)
from aria_kernel.tool_registry import ensure_tools_dir

REPO_HASH = "repohash0001"


class MissionSchedulerTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.tools = Path(self._tmpdir.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def _open(self, source_kind: str, source_id: str, **kwargs: object) -> str:
        # ORPHAN-MEDIUM-730 — the mint refuses a mission with no forward
        # pointer, so the fixture derives one from the source it opens.
        result = open_mission(
            source_kind=source_kind,
            source_id=source_id,
            repo_hash=REPO_HASH,
            title=f"{source_kind}:{source_id}",
            next_action=f"work {source_kind} {source_id}",
            wake_condition={"kind": "evidence", "key": f"{source_kind}:{source_id}"},
            base_dir=self.tools,
            **kwargs,  # type: ignore[arg-type]
        )
        return str(result["mission_id"])

    def _move(self, mission_id: str, to_state: str, **kwargs: object) -> None:
        # ORPHAN-MEDIUM-730 — a non-terminal move restates the whole contract;
        # a terminal one carries none, because a finished mission owes no next
        # action. The helper follows the same split the module enforces so a
        # fixture cannot drift into a shape the kernel refuses.
        contract: dict[str, object] = (
            {}
            if to_state in TERMINAL_STATES
            else {
                "next_action": "continue",
                "wake_condition": {"kind": "timer", "key": "next_cycle"},
            }
        )
        # A callsite that names its own wake (a deadline test) overrides the
        # default rather than colliding with it.
        contract.update(kwargs)
        transition_mission(
            mission_id=mission_id,
            to_state=to_state,
            reason_code="test",
            step_id=f"step-{to_state}",
            base_dir=self.tools,
            **contract,  # type: ignore[arg-type]
        )

    def test_an_empty_queue_says_so_rather_than_returning_nothing(self) -> None:
        decision = select_next_mission(base_dir=self.tools)
        self.assertEqual(decision.outcome, NO_OPEN_MISSIONS)
        self.assertIsNone(decision.selected)
        self.assertEqual(decision.considered, 0)

    def test_the_held_slot_names_its_holder(self) -> None:
        holder = self._open("finding", "f-holder")
        self._move(holder, "CONTRACTING")
        self._move(holder, "PLANNING")
        self._move(holder, "IMPLEMENTING")
        self._open("pressure", "p-waiting")

        decision = select_next_mission(base_dir=self.tools)
        self.assertEqual(decision.outcome, WIP_SLOT_HELD)
        self.assertIsNone(decision.selected)
        # "Busy" without saying who sends an operator hunting for what is
        # already on their screen.
        holders = [row for row in decision.skipped if row.reason == WIP_SLOT_HELD]
        self.assertEqual([row.mission_id for row in holders], [holder])
        self.assertIn("IMPLEMENTING", holders[0].detail)

    def test_a_fully_parked_queue_is_not_an_empty_one(self) -> None:
        parked = self._open("pressure", "p-parked")
        self._move(
            parked,
            "CONTRACTING",
            wake_condition={"kind": "timer", "key": "later", "not_before": "2099-01-01T00:00:00Z"},
        )
        decision = select_next_mission(base_dir=self.tools)
        self.assertEqual(decision.outcome, ALL_MISSIONS_WAITING)
        self.assertEqual(decision.considered, 1)
        self.assertEqual([row.reason for row in decision.skipped], ["waiting_until"])
        self.assertEqual(decision.skipped[0].detail, "2099-01-01T00:00:00Z")

    def test_a_wake_deadline_in_the_past_does_not_park_a_mission(self) -> None:
        ready = self._open("finding", "f-due")
        self._move(
            ready,
            "CONTRACTING",
            wake_condition={"kind": "timer", "key": "due", "not_before": "2000-01-01T00:00:00Z"},
        )
        decision = select_next_mission(base_dir=self.tools)
        self.assertEqual(decision.outcome, SELECTED)
        self.assertEqual(decision.selected["mission_id"], ready)

    def test_an_unreadable_wake_deadline_reads_as_free_not_as_blocked(self) -> None:
        # A timestamp nobody can parse must not park a mission forever: that is
        # how one typo becomes a permanent silent hold.
        mission = self._open("finding", "f-garbled")
        self._move(
            mission,
            "CONTRACTING",
            wake_condition={"kind": "timer", "key": "garbled", "not_before": "not-a-date"},
        )
        decision = select_next_mission(base_dir=self.tools)
        self.assertEqual(decision.outcome, SELECTED)
        self.assertEqual(decision.selected["mission_id"], mission)

    def test_waiting_states_do_not_compete_for_the_slot(self) -> None:
        blocked = self._open("finding", "f-blocked")
        self._move(blocked, "CONTRACTING")
        self._move(blocked, "HUMAN_REQUIRED")
        free = self._open("pressure", "p-free")

        decision = select_next_mission(base_dir=self.tools)
        self.assertEqual(decision.outcome, SELECTED)
        self.assertEqual(decision.selected["mission_id"], free)
        reasons = {row.mission_id: row.reason for row in decision.skipped}
        self.assertEqual(reasons[blocked], "waiting_on_something_outside_aria")

    def test_capability_gaps_outrank_findings_which_outrank_pressure(self) -> None:
        pressure = self._open("pressure", "p-1")
        finding = self._open("finding", "f-1")
        capability = self._open("capability_gap", "c-1")

        decision = select_next_mission(base_dir=self.tools)
        self.assertEqual(decision.selected["mission_id"], capability)
        outranked = [row.mission_id for row in decision.skipped if row.reason == "outranked"]
        self.assertEqual(outranked, [finding, pressure])

    def test_an_explicit_priority_beats_the_source_rank(self) -> None:
        self._open("capability_gap", "c-1")
        urgent = self._open("pressure", "p-urgent", priority=0)
        decision = select_next_mission(base_dir=self.tools)
        self.assertEqual(decision.selected["mission_id"], urgent)

    def test_a_genuinely_older_mission_outranks_a_newer_equal_one(self) -> None:
        # `_rank` is exercised directly because `utc_now()` has SECOND
        # resolution: two missions opened in one test tick carry the same
        # `opened_at`, so an integration test could not tell an age rule from
        # an id rule. Here the ages genuinely differ.
        elder = {
            "mission_id": "m-zzzz",
            "source_kind": "pressure",
            "priority": None,
            "opened_at": "2026-08-01T00:00:00+00:00",
        }
        younger = {
            "mission_id": "m-aaaa",
            "source_kind": "pressure",
            "priority": None,
            "opened_at": "2026-08-02T00:00:00+00:00",
        }
        # The elder wins DESPITE sorting last by id — which is what makes this
        # a test of the age key rather than of the tiebreak below it.
        self.assertLess(_rank(elder), _rank(younger))

    def test_same_second_missions_get_a_stable_total_order(self) -> None:
        # The honest guarantee at this clock resolution: not fairness, but a
        # total order two runners reading one ledger cannot disagree about.
        ids = [self._open("pressure", f"p-{index}") for index in range(5)]
        first = select_next_mission(base_dir=self.tools, record=False)
        order = [first.selected["mission_id"]] + [
            row.mission_id for row in first.skipped if row.reason == "outranked"
        ]
        self.assertEqual(sorted(order), sorted(ids))
        for _ in range(3):
            again = select_next_mission(base_dir=self.tools, record=False)
            replay = [again.selected["mission_id"]] + [
                row.mission_id for row in again.skipped if row.reason == "outranked"
            ]
            self.assertEqual(replay, order)

    def test_the_decision_is_deterministic_across_repeated_reads(self) -> None:
        for index in range(6):
            self._open("pressure", f"p-{index}")
        first = select_next_mission(base_dir=self.tools, record=False)
        for _ in range(4):
            again = select_next_mission(base_dir=self.tools, record=False)
            self.assertEqual(again.selected["mission_id"], first.selected["mission_id"])
            self.assertEqual(
                [row.mission_id for row in again.skipped],
                [row.mission_id for row in first.skipped],
            )

    def test_every_open_mission_is_accounted_for_in_the_decision(self) -> None:
        # The property that makes the decision reviewable: a mission is either
        # the pick or carries a named reason it was passed over. Nothing may
        # simply vanish from the accounting.
        ids = {self._open("pressure", f"p-{index}") for index in range(4)}
        blocked = self._open("finding", "f-blocked")
        self._move(blocked, "CONTRACTING")
        self._move(blocked, "BLOCKED_EXTERNAL")
        ids.add(blocked)

        decision = select_next_mission(base_dir=self.tools)
        accounted = {row.mission_id for row in decision.skipped}
        accounted.add(decision.selected["mission_id"])
        self.assertEqual(accounted, ids)
        self.assertTrue(all(row.reason for row in decision.skipped))

    def test_the_decision_is_recorded_where_an_operator_can_read_it(self) -> None:
        self._open("finding", "f-recorded")
        decision = select_next_mission(base_dir=self.tools)
        rows = [
            row
            for row in load_jsonl(self.tools / "governance.jsonl")
            if row.get("kind") == "mission_schedule_decided"
        ]
        self.assertEqual(len(rows), 1)
        details = rows[0]["details"]
        self.assertEqual(details["outcome"], SELECTED)
        self.assertEqual(details["selected_mission_id"], decision.selected["mission_id"])
        # The half an operator debugs travels with it.
        self.assertIn("skipped", details)

    def test_record_false_leaves_no_trace(self) -> None:
        self._open("finding", "f-quiet")
        select_next_mission(base_dir=self.tools, record=False)
        rows = [
            row
            for row in load_jsonl(self.tools / "governance.jsonl")
            if row.get("kind") == "mission_schedule_decided"
        ]
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
