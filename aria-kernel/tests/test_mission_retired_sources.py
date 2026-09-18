"""A mission whose producer is gone is superseded, not carried forever — and
only when closing it abandons nothing.

Live shape (origin/aria/state `tools/missions/mission-events.jsonl`, read
2026-09-12): six ``shadow_run_summary`` missions opened 2026-08-10/11 with
``next_action: null`` — before the C9/E8 guard existed — and never touched
again, because the only heal path is re-adoption and the guard refuses the
producer's every candidate. They are 6 of the 14 rows in the standing
``mission_closure_violation`` and 6 of the 57 missions the scheduler
considered on 2026-09-04 (``mission_schedule_decided.considered``). With the
producer retired (`task.py`), nothing would ever re-observe them.

The fixture writes such rows in the live row shape (an ``opened`` event with
no contract) and pins: a pre-WIP, contract-less retired-source mission
becomes SUPERSEDED with a disclosed reason; a live-producer mission is left
alone; the sweep is idempotent; and EVERY other retired-source shape is
declined with its reason — operator-held, work in progress (the first
revision of the sweep superseded an IMPLEMENTING mission, abandoning its
branch), waiting on a wake, observing a merged outcome, or already carrying a
contract. `sweep_verdict` is pinned exhaustive over the state vocabulary so a
new state cannot be swept by omission.
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from aria_kernel import mission as mission_module
from aria_kernel.ledger import append_declared_jsonl, load_jsonl
from aria_kernel.mission import (
    ACTIVE_WIP_STATES,
    MISSION_STATES,
    OPERATOR_HELD_STATES,
    RETIRED_SOURCE_KINDS,
    TERMINAL_STATES,
    WAITING_STATES,
    events_path,
    fold_mission,
    list_open_missions,
    mission_id_for,
    open_mission,
    transition_mission,
)
from aria_kernel.mission_retired_sources import (
    DECLINE_CONTRACTED,
    DECLINE_OPERATOR_HELD,
    DECLINE_OUTCOME_OBSERVING,
    DECLINE_WAKE_PENDING,
    DECLINE_WORK_IN_PROGRESS,
    GOVERNANCE_KIND,
    POST_WIP_STATES,
    PRE_WIP_STATES,
    RETIRED_PRODUCER_REASON,
    SWEEP_DECLINE_REASONS,
    supersede_retired_source_missions,
    sweep_verdict,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir, utc_now

REPO_HASH = "repohash0001"
CONTRACT = {
    "next_action": "triage the run's raw findings",
    "wake_condition": {"kind": "timer", "key": "next-cycle"},
}


class _RetiredFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = ensure_tools_dir(self.base)

    def _open_pre_rule(self, source_kind: str, source_id: str, title: str) -> str:
        """An ``opened`` row exactly as the live producer wrote it before the
        closure contract existed: no next_action, no wake_condition."""
        mission_id = mission_id_for(source_kind, source_id, REPO_HASH)
        append_declared_jsonl(
            events_path(self.root),
            {
                "schema_version": 1,
                "schema": mission_module.MISSION_SCHEMA,
                "event_id": f"legacy-{mission_id}",
                "recorded_at": utc_now(),
                "event": "opened",
                "mission_id": mission_id,
                "idempotency_key": mission_module._idempotency_key(
                    mission_id, "genesis", "", "opened"
                ),
                "source_kind": source_kind,
                "source_id": source_id,
                "repo_hash": REPO_HASH,
                "title": title,
                "capability": None,
                "priority": None,
                "target_project": None,
            },
            expected_surface="mission_events",
        )
        return mission_id

    def _move(self, mission_id: str, to_state: str, *, reason: str = "coarse_observation") -> None:
        transition_mission(
            mission_id=mission_id, to_state=to_state, reason_code=reason,
            step_id=f"move:{to_state}", base_dir=self.base, **CONTRACT,
        )

    def _governance(self, kind: str) -> list[dict]:
        return [
            row["details"] for row in load_jsonl(self.root / "governance.jsonl")
            if row.get("kind") == kind
        ]

    def _state(self, mission_id: str) -> str:
        return fold_mission(mission_id=mission_id, base_dir=self.base)["state"]


class RetiredSourceSweep(_RetiredFixture):
    def test_the_vocabulary_names_the_retired_producer(self) -> None:
        self.assertEqual(RETIRED_SOURCE_KINDS, frozenset({"shadow_run_summary"}))

    def test_retired_source_missions_are_superseded_and_disclosed(self) -> None:
        doc = self._open_pre_rule(
            "shadow_run_summary", "doc-staleness-adapter",
            "Triage 1146 SHADOW findings from doc-staleness-adapter",
        )
        gap = self._open_pre_rule(
            "shadow_run_summary", "test-gap-adapter",
            "Triage 418 SHADOW findings from test-gap-adapter",
        )
        pressure = self._open_pre_rule(
            "pressure", "pressure:migration-surface-repeat:repetition",
            "continue TypeORM schema drift checks",
        )
        self.assertEqual(len(list_open_missions(base_dir=self.base)), 3)

        result = supersede_retired_source_missions(base_dir=self.base)

        self.assertEqual(result["superseded"], 2)
        self.assertEqual(result["declined"], 0)
        self.assertEqual(set(result["mission_ids"]), {doc, gap})
        for mission_id in (doc, gap):
            self.assertEqual(self._state(mission_id), "SUPERSEDED")
        self.assertEqual(
            [m["mission_id"] for m in list_open_missions(base_dir=self.base)], [pressure]
        )
        [disclosure] = self._governance(GOVERNANCE_KIND)
        self.assertEqual({e["mission_id"] for e in disclosure["superseded"]}, {doc, gap})
        self.assertEqual(disclosure["declined"], [])
        self.assertEqual(disclosure["retired_source_kinds"], ["shadow_run_summary"])
        # The closure violation that listed them is gone with them.
        self.assertEqual(
            mission_module.assert_cycle_closure(base_dir=self.base)["violations"],
            [{"mission_id": pressure, "state": "DISCOVERED", "missing": ["next_action", "wake_condition"]}],
        )

    def test_the_transition_carries_the_reason(self) -> None:
        mission_id = self._open_pre_rule("shadow_run_summary", "bundle-budget-adapter", "t")

        supersede_retired_source_missions(base_dir=self.base)

        transitions = [
            row for row in load_jsonl(events_path(self.root))
            if row.get("event") == "transition" and row.get("mission_id") == mission_id
        ]
        self.assertEqual(len(transitions), 1)
        self.assertEqual(transitions[0]["reason_code"], RETIRED_PRODUCER_REASON)
        self.assertEqual(transitions[0]["to_state"], "SUPERSEDED")

    def test_the_sweep_is_idempotent(self) -> None:
        self._open_pre_rule("shadow_run_summary", "fe-dto-parity-adapter", "t")
        first = supersede_retired_source_missions(base_dir=self.base)

        second = supersede_retired_source_missions(base_dir=self.base)

        self.assertEqual(first["superseded"], 1)
        self.assertEqual(second["superseded"], 0)
        self.assertEqual(len(self._governance(GOVERNANCE_KIND)), 1)

    def test_nothing_to_do_writes_nothing(self) -> None:
        self._open_pre_rule("pressure", "pressure:x", "t")

        result = supersede_retired_source_missions(base_dir=self.base)

        self.assertEqual(
            result,
            {"schema_version": 1, "superseded": 0, "declined": 0, "declined_by_reason": {}, "mission_ids": []},
        )
        self.assertEqual(self._governance(GOVERNANCE_KIND), [])


class TheSweepDeclinesWhatClosingWouldAbandon(_RetiredFixture):
    """Each decline reason, reached through the production transition table."""

    def _assert_declined(self, mission_id: str, reason: str, state: str) -> None:
        result = supersede_retired_source_missions(base_dir=self.base)

        self.assertEqual(result["superseded"], 0)
        self.assertEqual(result["declined"], 1)
        self.assertEqual(result["declined_by_reason"], {reason: 1})
        self.assertEqual(self._state(mission_id), state)
        [disclosure] = self._governance(GOVERNANCE_KIND)
        self.assertEqual(disclosure["superseded"], [])
        self.assertEqual(
            disclosure["declined"],
            [{
                "mission_id": mission_id, "source_kind": "shadow_run_summary",
                "source_id": "security-boundary-adapter", "state": state, "reason": reason,
            }],
        )

    def test_an_operator_held_mission_is_declined_not_closed(self) -> None:
        mission_id = self._open_pre_rule("shadow_run_summary", "security-boundary-adapter", "t")
        transition_mission(
            mission_id=mission_id, to_state="HUMAN_REQUIRED", reason_code="operator_parked",
            step_id="park", next_action="the operator decides",
            wake_condition={"kind": "evidence", "key": "operator:decision"}, base_dir=self.base,
        )

        self._assert_declined(mission_id, DECLINE_OPERATOR_HELD, "HUMAN_REQUIRED")

    def test_a_mission_with_work_in_progress_is_declined_not_closed(self) -> None:
        """The defect the verifier reproduced: IMPLEMENTING -> SUPERSEDED
        abandoned a live branch. A WIP mission keeps its state."""
        mission_id = self._open_pre_rule("shadow_run_summary", "security-boundary-adapter", "t")
        self._move(mission_id, "IMPLEMENTING")

        self._assert_declined(mission_id, DECLINE_WORK_IN_PROGRESS, "IMPLEMENTING")

    def test_every_wip_state_is_declined(self) -> None:
        for state in ACTIVE_WIP_STATES:
            with self.subTest(state=state):
                mission_id = self._open_pre_rule("shadow_run_summary", f"tool-{state.lower()}", "t")
                self._move(mission_id, state)
                self.assertEqual(sweep_verdict(fold_mission(mission_id=mission_id, base_dir=self.base)), DECLINE_WORK_IN_PROGRESS)

    def test_a_mission_waiting_on_a_wake_is_declined(self) -> None:
        mission_id = self._open_pre_rule("shadow_run_summary", "security-boundary-adapter", "t")
        self._move(mission_id, "EVIDENCE_REQUIRED", reason="evidence_missing")

        self._assert_declined(mission_id, DECLINE_WAKE_PENDING, "EVIDENCE_REQUIRED")

    def test_a_mission_observing_its_merged_outcome_is_declined(self) -> None:
        mission_id = self._open_pre_rule("shadow_run_summary", "security-boundary-adapter", "t")
        self._move(mission_id, "OUTCOME_OBSERVING")

        self._assert_declined(mission_id, DECLINE_OUTCOME_OBSERVING, "OUTCOME_OBSERVING")

    def test_a_pre_wip_mission_that_carries_a_contract_is_declined(self) -> None:
        """Minted through the production door, so it has a contract: the
        scheduler can advance it, which is not "unhealable"."""
        opened = open_mission(
            source_kind="shadow_run_summary", source_id="security-boundary-adapter",
            repo_hash=REPO_HASH, title="t", base_dir=self.base, **CONTRACT,
        )

        self._assert_declined(opened["mission_id"], DECLINE_CONTRACTED, "DISCOVERED")

    def test_a_standing_decline_is_disclosed_once(self) -> None:
        mission_id = self._open_pre_rule("shadow_run_summary", "security-boundary-adapter", "t")
        self._move(mission_id, "IMPLEMENTING")

        supersede_retired_source_missions(base_dir=self.base)
        supersede_retired_source_missions(base_dir=self.base)

        self.assertEqual(len(self._governance(GOVERNANCE_KIND)), 1)


class TheVerdictIsTotalOverTheVocabulary(unittest.TestCase):
    def test_every_open_state_has_exactly_one_verdict(self) -> None:
        open_states = [s for s in MISSION_STATES if s not in TERMINAL_STATES]
        self.assertEqual(sorted(PRE_WIP_STATES), ["CONTRACTING", "DISCOVERED", "PLANNING"])
        self.assertEqual(POST_WIP_STATES, frozenset({"OUTCOME_OBSERVING"}))
        for state in open_states:
            with self.subTest(state=state):
                bare = sweep_verdict({"state": state, "next_action": None, "wake_condition": None})
                contracted = sweep_verdict({"state": state, **CONTRACT})
                if state in OPERATOR_HELD_STATES:
                    self.assertEqual((bare, contracted), (DECLINE_OPERATOR_HELD,) * 2)
                elif state in ACTIVE_WIP_STATES:
                    self.assertEqual((bare, contracted), (DECLINE_WORK_IN_PROGRESS,) * 2)
                elif state in WAITING_STATES:
                    self.assertEqual((bare, contracted), (DECLINE_WAKE_PENDING,) * 2)
                elif state in POST_WIP_STATES:
                    self.assertEqual((bare, contracted), (DECLINE_OUTCOME_OBSERVING,) * 2)
                else:
                    self.assertIn(state, PRE_WIP_STATES)
                    self.assertEqual((bare, contracted), (None, DECLINE_CONTRACTED))
                if contracted is not None:
                    self.assertIn(contracted, SWEEP_DECLINE_REASONS)

    def test_a_terminal_or_unknown_state_is_refused_not_swept(self) -> None:
        for state in (*TERMINAL_STATES, "NOT_A_STATE", ""):
            with self.subTest(state=state):
                with self.assertRaises(GovernanceError):
                    sweep_verdict({"state": state})


class TheIngestPhaseRunsTheSweep(_RetiredFixture):
    def test_mission_ingest_supersedes_the_retired_and_adopts_the_live(self) -> None:
        """The production entry: one phase call closes the retired-source
        mission AND adopts tonight's admissible candidate, and reports both."""
        import json

        from aria_kernel import cycle as cycle_module

        stale = self._open_pre_rule("shadow_run_summary", "doc-staleness-adapter", "t")
        parked = self._open_pre_rule("shadow_run_summary", "test-gap-adapter", "t")
        self._move(parked, "IMPLEMENTING")
        cycle_id = "cyc-ingest"
        pressure_dir = self.root / "pressure"
        pressure_dir.mkdir(parents=True, exist_ok=True)
        (pressure_dir / f"{cycle_id}.json").write_text(json.dumps({
            "schema_version": 1,
            "pressures": [{
                "pressure_id": "pressure:own-pr-ci:pr-1335", "score": 90,
                "reason": "own PR 1335 is red",
                "recommended_action": "read the failing check's log and fix forward",
                "blocked_by": [],
            }],
        }))
        context = cycle_module.PhaseContext(
            cycle_id=cycle_id, workspace_root=self.base, base_dir=self.base, workspace=None,
            plan_id=None, shadow_only=False, defer_reflection=False, snapshot_mode="committed",
            profile="standard", cycle_started_at=datetime.now(timezone.utc),
            started_monotonic=0.0, results={}, outcomes={},
        )

        result = cycle_module._phase_mission_ingest(context)

        self.assertEqual(result["retired_superseded"], 1)
        self.assertEqual(result["retired_declined"], 1)
        self.assertEqual(result["adopted"], 1)
        self.assertEqual(self._state(stale), "SUPERSEDED")
        self.assertEqual(self._state(parked), "IMPLEMENTING")
        self.assertEqual(
            sorted(m["source_id"] for m in list_open_missions(base_dir=self.base)),
            ["pressure:own-pr-ci:pr-1335", "test-gap-adapter"],
        )


if __name__ == "__main__":
    unittest.main()
