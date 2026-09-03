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
    set_closure_contract,
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
        # ORPHAN-MEDIUM-730 — the closure contract is part of the MINT now, so
        # the shared helper carries one derived from the source it opens. A
        # test that wants a contract-less mint has to ask for it explicitly,
        # which is the point: it can only ask for a refusal.
        return open_mission(
            source_kind=kw.pop("source_kind", "finding"),
            source_id=source_id,
            repo_hash=kw.pop("repo_hash", REPO_HASH),
            title=kw.pop("title", f"close {source_id}"),
            next_action=kw.pop("next_action", f"close {source_id}"),
            wake_condition=kw.pop(
                "wake_condition", {"kind": "evidence", "key": f"finding:{source_id}"}
            ),
            base_dir=self.base,
            **kw,
        )

    def _legacy_open(self, source_id: str) -> str:
        """A pre-ORPHAN-MEDIUM-730 `opened` row, written straight to the ledger.

        `open_mission` can no longer produce one, and that is the fix — but
        the live store is full of them, so the healing path has to be proven
        against the real shape rather than against a mission the current mint
        would have refused.
        """
        from aria_kernel.ledger import append_declared_jsonl
        from aria_kernel.tool_registry import ensure_tools_dir, utc_now

        root = ensure_tools_dir(self.base)
        mission_id = mission_id_for("finding", source_id, REPO_HASH)
        # The writer's own genesis key, not a string invented here: a fixture
        # with a different key would let a later `open_mission` append a
        # SECOND opened event rather than fold into this mission, and the
        # healing path would be proven against a shape the store never holds.
        key = mission_module._idempotency_key(mission_id, "genesis", "", "opened")
        append_declared_jsonl(
            events_path(root),
            {
                "schema_version": 1,
                "schema": mission_module.MISSION_SCHEMA,
                "event_id": f"legacy-{source_id}",
                "recorded_at": utc_now(),
                "event": "opened",
                "mission_id": mission_id,
                "idempotency_key": key,
                "source_kind": "finding",
                "source_id": source_id,
                "repo_hash": REPO_HASH,
                "title": f"close {source_id}",
                "capability": None,
                "priority": None,
                "target_project": None,
            },
            expected_surface="mission_events",
        )
        return mission_id

    def _advance(self, mission_id: str, to_state: str, *, reason: str, step: str, **kw):
        # ORPHAN-MEDIUM-730 — a NON-TERMINAL move must restate the whole
        # closure contract and a TERMINAL move must carry none, so the shared
        # helper carries the same split the module enforces. A test that wants
        # a contract-less move asks for it explicitly (``next_action=None``),
        # which is the point: what it can then observe is the refusal.
        if to_state not in TERMINAL_STATES:
            kw.setdefault("next_action", f"advance to {to_state}")
            kw.setdefault("wake_condition", {"kind": "timer", "key": "next_cycle"})
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
        with self.assertRaises(GovernanceError) as caught:
            self._advance(
                opened["mission_id"],
                "PLANNING",
                reason="coarse_observation",
                step="s1",
                next_action="draft plan",
                wake_condition={"kind": "vibes", "key": "x"},
            )
        # The next_action is present, so the refusal can only be the KIND.
        self.assertIn("vibes", str(caught.exception))
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


class ClosureContractAtTheMintTests(MissionTestBase):
    """ORPHAN-MEDIUM-730 — the mint is the writer that refuses.

    SUPERSEDES `test_open_mission_without_forward_pointer_is_a_violation`,
    which asserted that a contract-less mint LANDED and was then reported by
    `assert_cycle_closure`. That was the defect, not the contract. Measured on
    the store (2026-08-19): `missions/mission-events.jsonl` holds 5 events,
    ALL `opened`, all contract-less — `pressure` x2 and `shadow_run_summary`
    x3, every one from `adopt_task_candidates` — and `governance.jsonl` holds
    the single `mission_closure_violation` row naming those five. The
    successor truth is that the mint never happens, so the old assertion is
    unreachable by construction.
    """

    def test_a_mint_without_a_next_action_is_refused(self) -> None:
        with self.assertRaises(GovernanceError) as caught:
            self._open(next_action="   ")
        self.assertIn("next_action", str(caught.exception))
        self.assertEqual(list_open_missions(base_dir=self.base), [])

    def test_a_mint_without_a_wake_condition_is_refused(self) -> None:
        with self.assertRaises(GovernanceError) as caught:
            self._open(wake_condition=None)
        self.assertIn("wake_condition", str(caught.exception))
        self.assertEqual(list_open_missions(base_dir=self.base), [])

    def test_a_mint_whose_wake_kind_is_outside_the_vocabulary_is_refused(self) -> None:
        with self.assertRaises(GovernanceError):
            self._open(wake_condition={"kind": "vibes", "key": "F-1"})
        self.assertEqual(list_open_missions(base_dir=self.base), [])

    def test_the_mint_carries_the_contract_into_the_fold(self) -> None:
        """The forward pointer must survive to the FOLD, not just to the row.

        A mint that wrote the contract into the event and folded it away
        would pass a ledger assertion and still leave the mission unmovable —
        the fold is what every reader (scheduler, closure gate, index) sees.
        """
        opened = self._open()
        state = fold_mission(mission_id=opened["mission_id"], base_dir=self.base)
        self.assertEqual(state["next_action"], "close ORPHAN-HIGH-541")
        self.assertEqual(
            state["wake_condition"],
            {"kind": "evidence", "key": "finding:ORPHAN-HIGH-541"},
        )
        self.assertEqual(assert_cycle_closure(base_dir=self.base)["violations"], [])

    def test_a_pre_contract_mission_is_healed_rather_than_stranded(self) -> None:
        """The live store's 5 pre-rule rows must be able to converge.

        Mission identity deliberately ignores the cycle, so re-seeding a
        pre-730 mission is a no-op: without a way to install the contract
        afterwards, every mission opened before the refusal existed would
        stay unmovable forever. `set_closure_contract` is the first producer
        of the `wake` event kind, which `EVENT_KINDS` declared and `_fold`
        folded with nothing on the write side ever emitting one.
        """
        mission_id = self._legacy_open("ORPHAN-HIGH-999")
        self.assertIn(
            mission_id,
            {row["mission_id"] for row in assert_cycle_closure(base_dir=self.base)["violations"]},
        )

        set_closure_contract(
            mission_id=mission_id,
            next_action="close ORPHAN-HIGH-999",
            wake_condition={"kind": "evidence", "key": "finding:ORPHAN-HIGH-999"},
            step_id="heal",
            base_dir=self.base,
        )

        state = fold_mission(mission_id=mission_id, base_dir=self.base)
        self.assertEqual(state["next_action"], "close ORPHAN-HIGH-999")
        self.assertEqual(
            state["wake_condition"],
            {"kind": "evidence", "key": "finding:ORPHAN-HIGH-999"},
        )
        self.assertEqual(assert_cycle_closure(base_dir=self.base)["violations"], [])

    def test_healing_a_terminal_mission_is_refused(self) -> None:
        opened = self._open()
        self._advance(opened["mission_id"], "POLICY_REJECTED", reason="policy", step="s1")
        with self.assertRaises(GovernanceError) as caught:
            set_closure_contract(
                mission_id=opened["mission_id"],
                next_action="try again",
                wake_condition={"kind": "timer", "key": "tomorrow"},
                step_id="heal",
                base_dir=self.base,
            )
        self.assertIn("terminal", str(caught.exception))


class CycleClosureTests(MissionTestBase):
    """"No plan silently half-done", as an executable check."""

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

        The violation is produced from a PRE-RULE LEDGER ROW, because that is
        the only shape still reachable: the mint refuses a contract-less
        mission and a non-terminal transition now refuses to move one without
        restating the contract, so neither producer can manufacture a
        violation any more. An earlier revision of this test used a
        contract-less transition — which was itself the defect (a legal move
        emptied what the mint required), and using it as a fixture would have
        pinned the defect as the way to get a violation.
        """
        mission_id = self._legacy_open("ORPHAN-HIGH-777")
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
        self.assertIn(mission_id, recorded_ids)


class TransitionClosureContractTests(MissionTestBase):
    """ORPHAN-MEDIUM-730 — refusing at the mint alone bought ONE event.

    Reproduced before this refusal existed: mint carries
    ``next_action='do the thing'``; one legal
    ``transition_mission(to_state="CONTRACTING")`` with no contract folds to
    ``next_action=None, wake_condition=None``; `assert_cycle_closure` then
    records ``missing: ['next_action', 'wake_condition']``. The mint was the
    only door with a lock and the mission walked out of the other one.
    """

    def test_a_legal_transition_can_no_longer_empty_the_contract(self) -> None:
        opened = self._open()
        with self.assertRaises(GovernanceError) as caught:
            transition_mission(
                mission_id=opened["mission_id"],
                to_state="CONTRACTING",
                reason_code="coarse_observation",
                step_id="s1",
                base_dir=self.base,
            )
        self.assertIn("next_action", str(caught.exception))
        # The refusal left the mission exactly as the mint made it — a
        # refusal that half-wrote the event would be worse than the defect.
        state = fold_mission(mission_id=opened["mission_id"], base_dir=self.base)
        self.assertEqual(state["state"], "DISCOVERED")
        self.assertEqual(state["next_action"], "close ORPHAN-HIGH-541")
        self.assertEqual(assert_cycle_closure(base_dir=self.base)["violations"], [])

    def test_half_a_contract_is_refused_as_hard_as_none(self) -> None:
        """A move naming only what to do leaves the mission unwakeable; one
        naming only the wake leaves it unable to say what to do once woken."""
        opened = self._open()
        for kwargs in (
            {"next_action": "draft the plan"},
            {"wake_condition": {"kind": "timer", "key": "next_cycle"}},
        ):
            with self.assertRaises(GovernanceError):
                transition_mission(
                    mission_id=opened["mission_id"],
                    to_state="CONTRACTING",
                    reason_code="coarse_observation",
                    step_id="s1",
                    base_dir=self.base,
                    **kwargs,
                )

    def test_a_transition_that_restates_the_contract_moves_the_mission(self) -> None:
        opened = self._open()
        transition_mission(
            mission_id=opened["mission_id"],
            to_state="CONTRACTING",
            reason_code="coarse_observation",
            step_id="s1",
            next_action="draft the hardening contract",
            wake_condition={"kind": "evidence", "key": "finding:ORPHAN-HIGH-541"},
            base_dir=self.base,
        )
        state = fold_mission(mission_id=opened["mission_id"], base_dir=self.base)
        self.assertEqual(state["state"], "CONTRACTING")
        self.assertEqual(state["next_action"], "draft the hardening contract")
        self.assertEqual(assert_cycle_closure(base_dir=self.base)["violations"], [])

    def test_a_terminal_move_may_not_carry_a_forward_pointer(self) -> None:
        """The other half of the rule: a finished mission owes no next action,
        and recording one would be the schema claiming work that never runs."""
        opened = self._open()
        with self.assertRaises(GovernanceError) as caught:
            transition_mission(
                mission_id=opened["mission_id"],
                to_state="SUPERSEDED",
                reason_code="superseded_by_plan",
                step_id="s1",
                next_action="carry on somehow",
                wake_condition={"kind": "timer", "key": "never"},
                base_dir=self.base,
            )
        self.assertIn("terminal", str(caught.exception))
        # And the contract-less terminal move is the legal one.
        transition_mission(
            mission_id=opened["mission_id"],
            to_state="SUPERSEDED",
            reason_code="superseded_by_plan",
            step_id="s1",
            base_dir=self.base,
        )
        state = fold_mission(mission_id=opened["mission_id"], base_dir=self.base)
        self.assertEqual(state["state"], "SUPERSEDED")
        self.assertIsNone(state["next_action"])

    def test_a_wake_row_that_names_nothing_cannot_clear_a_contract(self) -> None:
        """The same clearing defect through the OTHER event kind.

        `set_closure_contract` validates both fields, so the write side cannot
        emit such a row — a hand-edited ledger can, and `_fold` is what every
        consumer sees. A wake row carrying nothing installs nothing rather
        than deleting the contract the mission already had.
        """
        from aria_kernel.ledger import append_declared_jsonl
        from aria_kernel.tool_registry import ensure_tools_dir, utc_now

        opened = self._open()
        root = ensure_tools_dir(self.base)
        append_declared_jsonl(
            events_path(root),
            {
                "schema_version": 1,
                "schema": mission_module.MISSION_SCHEMA,
                "event_id": "hand-written-wake",
                "recorded_at": utc_now(),
                "event": "wake",
                "mission_id": opened["mission_id"],
                "idempotency_key": "hand-written",
                "next_action": None,
                "wake_condition": None,
            },
            expected_surface="mission_events",
        )
        state = fold_mission(mission_id=opened["mission_id"], base_dir=self.base)
        self.assertEqual(state["next_action"], "close ORPHAN-HIGH-541")
        self.assertEqual(assert_cycle_closure(base_dir=self.base)["violations"], [])


class ReopenHealsTests(MissionTestBase):
    """The mint is also the heal, so no producer can forget to repair.

    The pre-rule rows on the live store (5 of them) are re-opened by their
    producers every cycle and mission identity ignores the cycle, so without
    a heal at the mint they would stay unmovable forever — and a heal copied
    into each producer is how two writers come to disagree about when a stuck
    mission may be repaired.
    """

    def _park_without_a_contract(self, mission_id: str, to_state: str) -> None:
        """A pre-rule transition row: state moved, contract never stated.

        Written straight to the ledger because `transition_mission` refuses
        this shape now — which is the fix, and also why the fixture cannot go
        through the writer.
        """
        from aria_kernel.ledger import append_declared_jsonl
        from aria_kernel.tool_registry import ensure_tools_dir, utc_now

        root = ensure_tools_dir(self.base)
        append_declared_jsonl(
            events_path(root),
            {
                "schema_version": 1,
                "schema": mission_module.MISSION_SCHEMA,
                "event_id": f"legacy-park-{to_state}",
                "recorded_at": utc_now(),
                "event": "transition",
                "mission_id": mission_id,
                "idempotency_key": f"legacy-park-{to_state}",
                "from_state": "DISCOVERED",
                "to_state": to_state,
                "reason_code": "coarse_observation",
                "retry_rung": None,
                "next_action": None,
                "wake_condition": None,
                "evidence_refs": [],
            },
            expected_surface="mission_events",
        )

    def test_a_reopen_installs_the_contract_a_pre_rule_row_never_had(self) -> None:
        mission_id = self._legacy_open("ORPHAN-HIGH-998")
        self.assertTrue(assert_cycle_closure(base_dir=self.base)["violations"])

        result = self._open("ORPHAN-HIGH-998")

        self.assertTrue(result["idempotent"])
        self.assertTrue(result["healed"])
        self.assertIsNone(result["heal_declined"])
        state = fold_mission(mission_id=mission_id, base_dir=self.base)
        self.assertEqual(state["next_action"], "close ORPHAN-HIGH-998")
        self.assertEqual(assert_cycle_closure(base_dir=self.base)["violations"], [])

    def test_a_reopen_never_overwrites_a_contract_that_exists(self) -> None:
        """The first sighting owns the contract. A producer that learned a
        better one says so explicitly through `set_closure_contract`; a
        re-open silently rewriting it would make every night's phrasing win."""
        opened = self._open()
        self._open(next_action="something else entirely")

        state = fold_mission(mission_id=opened["mission_id"], base_dir=self.base)
        self.assertEqual(state["next_action"], "close ORPHAN-HIGH-541")

    def test_a_reopen_declines_to_heal_an_operator_held_mission(self) -> None:
        """AUTHORITY. The nightly re-observes a mission a human parked and
        must leave the human's sentence alone — including when there is none
        to overwrite, because writing one would still be the machine deciding
        what happens next to work a human took over.
        """
        mission_id = self._legacy_open("ORPHAN-HIGH-997")
        self._park_without_a_contract(mission_id, "HUMAN_REQUIRED")

        result = self._open("ORPHAN-HIGH-997")

        self.assertTrue(result["idempotent"])
        self.assertFalse(result["healed"])
        self.assertEqual(result["heal_declined"], "operator_held")
        state = fold_mission(mission_id=mission_id, base_dir=self.base)
        self.assertEqual(state["state"], "HUMAN_REQUIRED")
        self.assertIsNone(state["next_action"])

    def test_a_machine_owned_waiting_state_is_still_healed(self) -> None:
        """The refusal is scoped to the states a HUMAN owns. A mission waiting
        on evidence is machine-owned, and leaving it unhealed would turn one
        authority rule into a general refusal to repair anything parked."""
        mission_id = self._legacy_open("ORPHAN-HIGH-996")
        self._park_without_a_contract(mission_id, "EVIDENCE_REQUIRED")

        result = self._open("ORPHAN-HIGH-996")

        self.assertTrue(result["healed"])
        self.assertEqual(
            fold_mission(mission_id=mission_id, base_dir=self.base)["next_action"],
            "close ORPHAN-HIGH-996",
        )

    def test_a_terminal_mission_is_not_healed_by_a_reopen(self) -> None:
        opened = self._open()
        self._advance(
            opened["mission_id"], "SUPERSEDED", reason="superseded_by_plan", step="s1"
        )

        result = self._open()

        self.assertFalse(result["healed"])
        self.assertEqual(result["heal_declined"], "terminal")

    def test_set_closure_contract_refuses_an_operator_held_mission(self) -> None:
        """Reproduced before this refusal existed: a mission parked in
        HUMAN_REQUIRED carrying the operator's "hold, do not touch" accepted
        `set_closure_contract` and folded to the machine's sentence instead.
        """
        opened = self._open()
        self._advance(
            opened["mission_id"], "HUMAN_REQUIRED", reason="coarse_observation",
            step="s1", next_action="operator: hold, do not touch",
            wake_condition={"kind": "timer", "key": "operator"},
        )

        with self.assertRaises(GovernanceError) as caught:
            set_closure_contract(
                mission_id=opened["mission_id"],
                next_action="MACHINE OVERWROTE THE OPERATOR",
                wake_condition={"kind": "evidence", "key": "x:1"},
                step_id="machine",
                base_dir=self.base,
            )

        self.assertIn("operator", str(caught.exception))
        self.assertEqual(
            fold_mission(mission_id=opened["mission_id"], base_dir=self.base)["next_action"],
            "operator: hold, do not touch",
        )


class ClosureDisclosureTests(MissionTestBase):
    """A disclosure that repeats identically every night is noise.

    The gate's own thesis is that reporting the same class every night while
    nothing changes is weather, not evidence — so the gate must not do it
    either. The backlog it can still see is pre-rule rows that nothing has
    re-observed yet, and re-stating them nightly buries the row that IS new.
    """

    def test_an_unchanged_violation_set_is_disclosed_once(self) -> None:
        self._legacy_open("ORPHAN-HIGH-995")

        first = assert_cycle_closure(base_dir=self.base)
        second = assert_cycle_closure(base_dir=self.base)

        self.assertTrue(first["governance_recorded"])
        self.assertFalse(second["governance_recorded"])
        self.assertTrue(second["already_disclosed"])
        # The verdict itself is unchanged — silence on the ledger is not
        # silence to the caller.
        self.assertEqual(len(second["violations"]), 1)
        root = mission_module.ensure_tools_dir(self.base)
        rows = [
            row for row in load_jsonl(root / "governance.jsonl")
            if row.get("kind") == "mission_closure_violation"
        ]
        self.assertEqual(len(rows), 1)

    def test_a_changed_violation_set_is_a_new_fact_and_a_new_row(self) -> None:
        self._legacy_open("ORPHAN-HIGH-994")
        assert_cycle_closure(base_dir=self.base)

        self._legacy_open("ORPHAN-HIGH-993")
        result = assert_cycle_closure(base_dir=self.base)

        self.assertTrue(result["governance_recorded"])
        root = mission_module.ensure_tools_dir(self.base)
        rows = [
            row for row in load_jsonl(root / "governance.jsonl")
            if row.get("kind") == "mission_closure_violation"
        ]
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[-1]["details"]["violation_count"], 2)


class MissionCliDoorTests(MissionTestBase):
    """The operator's door obeys the same rule, without owning a copy of it.

    `--next-action` / `--wake-file` stay argparse-OPTIONAL on `mission
    transition` because their requirement depends on the destination: a
    non-terminal move must carry both, a terminal move must carry neither.
    argparse cannot express that, and re-deriving `TERMINAL_STATES` in the CLI
    would put a second copy of the rule where the two doors could disagree —
    so the kernel refuses and the CLI surfaces it. This pin is what proves the
    CLI cannot open a door the kernel closed.
    """

    def _cli(self, *args: str) -> int:
        from aria_kernel.cli import main as cli_main

        return cli_main([*args, "--tools-dir", str(self.base)])

    def test_the_cli_cannot_transition_a_mission_without_a_contract(self) -> None:
        opened = self._open()
        with self.assertRaises(GovernanceError) as caught:
            self._cli(
                "mission", "transition",
                "--mission-id", opened["mission_id"],
                "--to-state", "CONTRACTING",
                "--reason-code", "coarse_observation",
                "--step-id", "cli-1",
            )
        self.assertIn("next_action", str(caught.exception))
        self.assertEqual(
            fold_mission(mission_id=opened["mission_id"], base_dir=self.base)["state"],
            "DISCOVERED",
        )

    def test_the_cli_moves_a_mission_that_states_its_contract(self) -> None:
        import json

        opened = self._open()
        wake_file = Path(self.base) / "wake.json"
        wake_file.write_text(
            json.dumps({"kind": "timer", "key": "next_cycle"}), encoding="utf-8"
        )
        self._cli(
            "mission", "transition",
            "--mission-id", opened["mission_id"],
            "--to-state", "CONTRACTING",
            "--reason-code", "coarse_observation",
            "--step-id", "cli-2",
            "--next-action", "draft the contract",
            "--wake-file", str(wake_file),
        )
        state = fold_mission(mission_id=opened["mission_id"], base_dir=self.base)
        self.assertEqual(state["state"], "CONTRACTING")
        self.assertEqual(state["next_action"], "draft the contract")


if __name__ == "__main__":
    unittest.main()
