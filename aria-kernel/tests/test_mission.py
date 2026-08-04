"""Persistent missions: identity outlives the cycle that discovered the work.

PLAN Wave 2 PR 1.1. `task.py` derives `task_id` from `cycle_id`, so the same
defect rediscovered tonight is a NEW task every night — nothing accumulates,
nothing resumes, and "no plan silently half-done" is unenforceable because
there is no durable thing to enforce it against.

A mission's identity is derived from WHAT the work is (source_kind, source_id,
repo_hash) and never from WHEN it was seen. That is the structural fix for the
per-cycle churn, and `test_mission_id_source_never_reads_cycle` pins it at the
source level (invariant I-W1-05) so it cannot regress by someone "helpfully"
adding a freshness component.

State lives in an event-sourced ledger folded on read — the same pattern
`plan_convergence` has proven for months — because a mission's history IS its
audit trail: how it got stuck, which retry rungs were spent, what it is
waiting for.
"""

from __future__ import annotations

import ast
import inspect
import tempfile
import unittest
from pathlib import Path

from aria_kernel import mission as mission_module
from aria_kernel.ledger import load_jsonl, verify_jsonl
from aria_kernel.mission import (
    ACTIVE_WIP_STATES,
    ALLOWED_TRANSITIONS,
    BINDING_KEYS,
    WAITING_STATES,
    MAINLINE_STATES,
    MISSION_STATES,
    RETRY_LADDER,
    TERMINAL_STATES,
    WAKE_KINDS,
    assert_cycle_closure,
    bind_mission,
    events_path,
    fold_mission,
    list_open_missions,
    mission_id_for,
    open_mission,
    rebuild_mission_index,
    transition_mission,
)
from aria_kernel.tool_registry import GovernanceError

REPO_HASH = "repohash0001"


class MissionTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    def _open(self, source_id: str = "ORPHAN-HIGH-541", **kw):
        return open_mission(
            source_kind=kw.pop("source_kind", "finding"),
            source_id=source_id,
            repo_hash=kw.pop("repo_hash", REPO_HASH),
            title=kw.pop("title", f"close {source_id}"),
            base_dir=self.base,
            **kw,
        )

    def _advance(self, mission_id: str, to_state: str, *, reason: str, step: str, **kw):
        return transition_mission(
            mission_id=mission_id,
            to_state=to_state,
            reason_code=reason,
            step_id=step,
            base_dir=self.base,
            **kw,
        )


class MissionIdentityTests(MissionTestBase):
    """The identity rule the whole wave exists for."""

    def test_mission_id_is_derived_from_the_work_not_the_sighting(self) -> None:
        first = self._open()
        again = self._open()
        self.assertEqual(first["mission_id"], again["mission_id"])
        self.assertRegex(first["mission_id"], r"^m-[0-9a-f]{16}$")

    def test_mission_id_changes_with_each_identity_component(self) -> None:
        base = mission_id_for("finding", "F-1", REPO_HASH)
        self.assertNotEqual(base, mission_id_for("pressure", "F-1", REPO_HASH))
        self.assertNotEqual(base, mission_id_for("finding", "F-2", REPO_HASH))
        self.assertNotEqual(base, mission_id_for("finding", "F-1", "otherrepo000"))

    def test_mission_id_source_never_reads_cycle_or_time(self) -> None:
        """I-W1-05 — the derivation cannot regress into task.py's churn.

        AST over the module: no function participating in mission-id
        derivation may reference cycle identity OR any source of freshness
        (clock, uuid, randomness). Behavioural tests cannot pin this — a
        time component would collide within one second and pass a same-run
        equality check — so the source is the test subject.
        """
        forbidden = {
            "cycle_id",
            "utc_now",
            "time",
            "datetime",
            "uuid",
            "random",
            "uuid4",
        }
        tree = ast.parse(inspect.getsource(mission_module))
        offenders: list[str] = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and (
                "mission_id" in node.name
            ):
                for inner in ast.walk(node):
                    if isinstance(inner, ast.Name) and inner.id in forbidden:
                        offenders.append(f"{node.name}: reads {inner.id}")
                    if isinstance(inner, ast.Attribute) and inner.attr in forbidden:
                        offenders.append(f"{node.name}: reads .{inner.attr}")
                    if isinstance(inner, ast.arg) and inner.arg in forbidden:
                        offenders.append(f"{node.name}: accepts {inner.arg}")
        self.assertEqual(offenders, [])

    def test_open_mission_is_idempotent(self) -> None:
        first = self._open()
        again = self._open()
        self.assertFalse(first["idempotent"])
        self.assertTrue(again["idempotent"])
        state = fold_mission(mission_id=first["mission_id"], base_dir=self.base)
        self.assertEqual(state["opened_count"], 1)
        self.assertEqual(state["state"], "DISCOVERED")


class MissionVocabularyTests(MissionTestBase):
    """The vocabularies are closed on purpose; the tests keep them closed."""

    def test_states_partition_cleanly(self) -> None:
        mainline, waiting, terminal = (
            set(MAINLINE_STATES),
            set(WAITING_STATES),
            set(TERMINAL_STATES),
        )
        self.assertFalse(mainline & waiting)
        self.assertFalse(mainline & terminal)
        self.assertFalse(waiting & terminal)
        self.assertEqual(set(MISSION_STATES), mainline | waiting | terminal)
        self.assertTrue(set(ACTIVE_WIP_STATES) <= mainline)

    def test_transition_table_speaks_only_known_states(self) -> None:
        for source, targets in ALLOWED_TRANSITIONS.items():
            self.assertIn(source, MISSION_STATES)
            for target in targets:
                self.assertIn(target, MISSION_STATES)

    def test_terminal_states_have_no_exit_edges(self) -> None:
        for state in TERMINAL_STATES:
            self.assertFalse(
                ALLOWED_TRANSITIONS.get(state),
                f"terminal state {state} must not have outgoing edges",
            )

    def test_retry_ladder_is_the_documented_progression(self) -> None:
        self.assertEqual(
            RETRY_LADDER,
            (
                "transient",
                "in_plan_repair",
                "alternative",
                "scope_shrink",
                "new_evidence",
                "new_capability",
                "justified_reject",
            ),
        )


class MissionTransitionTests(MissionTestBase):
    def test_adjacent_mainline_step_is_allowed(self) -> None:
        opened = self._open()
        result = self._advance(
            opened["mission_id"], "PLANNING", reason="coarse_observation", step="s1"
        )
        self.assertFalse(result["idempotent"])
        state = fold_mission(mission_id=opened["mission_id"], base_dir=self.base)
        self.assertEqual(state["state"], "PLANNING")

    def test_backward_moves_need_an_explicit_edge(self) -> None:
        opened = self._open()
        self._advance(opened["mission_id"], "PLANNING", reason="coarse_observation", step="s1")
        with self.assertRaises(GovernanceError):
            self._advance(
                opened["mission_id"], "DISCOVERED", reason="whoops", step="s2"
            )

    def test_lost_branch_replans_through_the_explicit_edge(self) -> None:
        """Reconciliation's `reconciled_lost_branch` path is a table edge,
        not a special case in code."""
        opened = self._open()
        self._advance(opened["mission_id"], "PLANNING", reason="coarse_observation", step="s1")
        self._advance(opened["mission_id"], "IMPLEMENTING", reason="plan_converged", step="s2")
        result = self._advance(
            opened["mission_id"], "PLANNING", reason="reconciled_lost_branch", step="s3"
        )
        self.assertEqual(
            fold_mission(mission_id=opened["mission_id"], base_dir=self.base)["state"],
            "PLANNING",
        )
        self.assertFalse(result["idempotent"])

    def test_forward_skip_requires_coarse_observation(self) -> None:
        """Today's pipeline cannot distinguish every state; a skip-forward is
        legal only when it says so. A skip wearing a precise reason would be
        the schema lying about its own resolution."""
        opened = self._open()
        self._advance(opened["mission_id"], "PLANNING", reason="coarse_observation", step="s1")
        with self.assertRaises(GovernanceError):
            self._advance(
                opened["mission_id"], "MERGING", reason="plan_converged", step="s2"
            )
        self._advance(
            opened["mission_id"], "MERGING", reason="coarse_observation", step="s3"
        )
        self.assertEqual(
            fold_mission(mission_id=opened["mission_id"], base_dir=self.base)["state"],
            "MERGING",
        )

    def test_unknown_mission_is_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            self._advance("m-0000000000000000", "PLANNING", reason="x", step="s1")

    def test_transition_replay_is_idempotent(self) -> None:
        opened = self._open()
        kwargs = dict(reason="coarse_observation", step="s1")
        first = self._advance(opened["mission_id"], "PLANNING", **kwargs)
        again = self._advance(opened["mission_id"], "PLANNING", **kwargs)
        self.assertFalse(first["idempotent"])
        self.assertTrue(again["idempotent"])
        state = fold_mission(mission_id=opened["mission_id"], base_dir=self.base)
        self.assertEqual(state["transition_count"], 1)

    def test_terminal_mission_accepts_nothing(self) -> None:
        opened = self._open()
        self._advance(opened["mission_id"], "SUPERSEDED", reason="superseded_by_plan", step="s1")
        with self.assertRaises(GovernanceError):
            self._advance(
                opened["mission_id"], "PLANNING", reason="coarse_observation", step="s2"
            )

    def test_retry_rung_cannot_move_backward(self) -> None:
        """Spending a rung is spending it. A ladder that can be walked back
        down is an unbounded retry loop with extra bookkeeping."""
        opened = self._open()
        self._advance(opened["mission_id"], "PLANNING", reason="coarse_observation", step="s1")
        self._advance(
            opened["mission_id"],
            "REVALIDATION_REQUIRED",
            reason="validation_failed",
            step="s2",
            retry_rung="alternative",
        )
        with self.assertRaises(GovernanceError):
            self._advance(
                opened["mission_id"],
                "PLANNING",
                reason="revalidation_scheduled",
                step="s3",
                retry_rung="transient",
            )

    def test_unknown_retry_rung_is_refused(self) -> None:
        opened = self._open()
        with self.assertRaises(GovernanceError):
            self._advance(
                opened["mission_id"],
                "PLANNING",
                reason="coarse_observation",
                step="s1",
                retry_rung="try_harder",
            )

    def test_wake_condition_vocabulary_is_closed(self) -> None:
        opened = self._open()
        with self.assertRaises(GovernanceError):
            self._advance(
                opened["mission_id"],
                "PLANNING",
                reason="coarse_observation",
                step="s1",
                wake_condition={"kind": "vibes", "key": "x"},
            )
        result = self._advance(
            opened["mission_id"],
            "PLANNING",
            reason="coarse_observation",
            step="s2",
            next_action="draft plan",
            wake_condition={"kind": "timer", "key": "next_cycle"},
        )
        self.assertFalse(result["idempotent"])
        self.assertIn("timer", str(WAKE_KINDS))


class MissionBindingTests(MissionTestBase):
    def test_bindings_accumulate_and_dedupe(self) -> None:
        opened = self._open()
        bind_mission(
            mission_id=opened["mission_id"],
            bindings={"plan_ids": ["plan-a"], "pr_numbers": [1061]},
            step_id="b1",
            base_dir=self.base,
        )
        bind_mission(
            mission_id=opened["mission_id"],
            bindings={"plan_ids": ["plan-a", "plan-b"]},
            step_id="b2",
            base_dir=self.base,
        )
        state = fold_mission(mission_id=opened["mission_id"], base_dir=self.base)
        self.assertEqual(state["bindings"]["plan_ids"], ["plan-a", "plan-b"])
        self.assertEqual(state["bindings"]["pr_numbers"], [1061])

    def test_binding_vocabulary_is_closed(self) -> None:
        opened = self._open()
        with self.assertRaises(GovernanceError):
            bind_mission(
                mission_id=opened["mission_id"],
                bindings={"favourite_color": ["blue"]},
                step_id="b1",
                base_dir=self.base,
            )
        self.assertIn("plan_ids", BINDING_KEYS)


class MissionProjectionTests(MissionTestBase):
    def test_list_open_missions_excludes_terminals(self) -> None:
        first = self._open("F-1")
        second = self._open("F-2")
        self._advance(second["mission_id"], "SUPERSEDED", reason="superseded_by_plan", step="s1")
        open_ids = {row["mission_id"] for row in list_open_missions(base_dir=self.base)}
        self.assertIn(first["mission_id"], open_ids)
        self.assertNotIn(second["mission_id"], open_ids)

    def test_events_ledger_is_hash_chained(self) -> None:
        self._open()
        report = verify_jsonl(events_path(mission_module.ensure_tools_dir(self.base)))
        self.assertTrue(report["valid"], report)

    def test_index_is_a_derived_projection(self) -> None:
        """Delete the index, rebuild, byte-identical content — nothing in it
        is authoritative, so losing it must cost nothing."""
        opened = self._open()
        self._advance(opened["mission_id"], "PLANNING", reason="coarse_observation", step="s1")
        first = rebuild_mission_index(base_dir=self.base)
        index_file = Path(first["path"])
        original = index_file.read_text(encoding="utf-8")
        index_file.unlink()
        rebuild_mission_index(base_dir=self.base)
        self.assertEqual(index_file.read_text(encoding="utf-8"), original)


class CycleClosureTests(MissionTestBase):
    """"No plan silently half-done", as an executable check."""

    def test_open_mission_without_forward_pointer_is_a_violation(self) -> None:
        opened = self._open()
        result = assert_cycle_closure(base_dir=self.base)
        violating = {row["mission_id"] for row in result["violations"]}
        self.assertIn(opened["mission_id"], violating)

    def test_mission_with_next_action_and_wake_is_clean(self) -> None:
        opened = self._open()
        self._advance(
            opened["mission_id"],
            "PLANNING",
            reason="coarse_observation",
            step="s1",
            next_action="draft the plan",
            wake_condition={"kind": "timer", "key": "next_cycle"},
        )
        result = assert_cycle_closure(base_dir=self.base)
        violating = {row["mission_id"] for row in result["violations"]}
        self.assertNotIn(opened["mission_id"], violating)

    def test_terminal_missions_owe_nothing(self) -> None:
        opened = self._open()
        self._advance(opened["mission_id"], "POLICY_REJECTED", reason="policy", step="s1")
        result = assert_cycle_closure(base_dir=self.base)
        self.assertEqual(result["violations"], [])

    def test_violations_are_recorded_as_governance_events(self) -> None:
        """A violation nobody recorded is a violation nobody will fix.

        The assertion reads the governance LEDGER, not the return flag — a
        result field claiming "recorded" proves the function said so, not
        that it did so.
        """
        opened = self._open()
        result = assert_cycle_closure(base_dir=self.base)
        self.assertTrue(result["violations"])
        self.assertTrue(result["governance_recorded"])
        root = mission_module.ensure_tools_dir(self.base)
        rows = [
            row
            for row in load_jsonl(root / "governance.jsonl")
            if row.get("kind") == "mission_closure_violation"
        ]
        self.assertEqual(len(rows), 1)
        recorded_ids = {
            violation["mission_id"]
            for violation in rows[0]["details"]["violations"]
        }
        self.assertIn(opened["mission_id"], recorded_ids)


if __name__ == "__main__":
    unittest.main()
