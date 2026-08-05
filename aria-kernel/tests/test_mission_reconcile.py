"""Reconciliation: what the world did while the cycle was not looking.

PLAN Wave 2 PR 1.3. A mission's state is what ARIA last WROTE. Reality is
what GitHub currently IS. Between two nightlies a PR can be merged by a
human, closed unmerged, or have its branch deleted, and nothing in the
pipeline notices — the mission sits in IMPLEMENTING forever, holding a WIP
slot for work that already landed.

THE RULE THIS FILE EXISTS TO PIN: only a POSITIVE, RECOGNISED observation
moves a mission. Everything else — an unknown state, a `None`, an adapter
that raised — records and touches nothing.

That is not caution for its own sake. `RecordingGitHubAdapter` is what the
`observe`/`standard`/`frozen` profiles get, and it never fetches: its
lifecycle answer is `None`. Treating "not merged" as "closed unmerged" would
advance the retry rung of EVERY mission on every dry-run night and on every
GitHub outage, burning the ladder to `justified_reject` without a single real
observation. Absence and damage are not the same observation.
"""

from __future__ import annotations

import ast
import inspect
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import cycle as cycle_module
from aria_kernel import mission_reconcile as reconcile_module
from aria_kernel.github_adapters import RecordingGitHubAdapter
from aria_kernel.ledger import load_jsonl
from aria_kernel.mission import (
    MAINLINE_STATES,
    RETRY_LADDER,
    assert_cycle_closure,
    bind_mission,
    fold_mission,
    mission_id_for,
    open_mission,
    transition_mission,
)
from aria_kernel.mission_reconcile import (
    MissionObserver,
    RECONCILE_OBSERVATIONS,
    classify_pr_lifecycle,
    reconcile_missions,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

REPO_HASH = "repohash0001"


class FakeObserver:
    """A GitHub whose answers the test chooses, including "no answer"."""

    def __init__(
        self,
        *,
        prs: dict[int, dict[str, Any] | None] | None = None,
        branches: dict[str, bool | None] | None = None,
        open_prs: list[dict[str, Any]] | None = None,
        raises: BaseException | None = None,
    ) -> None:
        self.prs = prs or {}
        self.branches = branches or {}
        self.open_prs = open_prs
        self.raises = raises
        self.calls: list[str] = []

    def get_pr_lifecycle(self, number: int) -> dict[str, Any] | None:
        self.calls.append(f"get_pr_lifecycle:{number}")
        if self.raises is not None:
            raise self.raises
        return self.prs.get(number)

    def observe_branch(self, name: str) -> bool | None:
        self.calls.append(f"observe_branch:{name}")
        if self.raises is not None:
            raise self.raises
        return self.branches.get(name)

    def list_open_pull_requests(self) -> list[dict[str, Any]] | None:
        self.calls.append("list_open_pull_requests")
        if self.raises is not None:
            raise self.raises
        return self.open_prs


class ReconcileTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    # -- fixtures ---------------------------------------------------------

    def _mission_at(
        self,
        state: str,
        *,
        source_id: str = "F-1",
        pr: int | None = None,
        branch: str | None = None,
    ) -> str:
        mission_id = mission_id_for("finding", source_id, REPO_HASH)
        open_mission(
            source_kind="finding",
            source_id=source_id,
            repo_hash=REPO_HASH,
            title=f"close {source_id}",
            base_dir=self.base,
        )
        self._walk_to(mission_id, state)
        bindings: dict[str, Any] = {}
        if pr is not None:
            bindings["pr_numbers"] = [pr]
        if branch is not None:
            bindings["branch"] = [branch]
        if bindings:
            bind_mission(
                mission_id=mission_id,
                bindings=bindings,
                step_id=f"fixture-bind-{source_id}",
                base_dir=self.base,
            )
        return mission_id

    def _walk_to(self, mission_id: str, state: str, *, prefix: str = "fixture") -> None:
        """Walk the mainline one adjacent edge at a time, or jump to a
        waiting state (which every non-terminal state may enter)."""
        if state == "DISCOVERED":
            return
        if state not in MAINLINE_STATES:
            self._advance(mission_id, state, f"{prefix}-{state}")
            return
        current = fold_mission(mission_id=mission_id, base_dir=self.base)["state"]
        start = MAINLINE_STATES.index(current) if current in MAINLINE_STATES else 0
        for step in MAINLINE_STATES[start + 1 : MAINLINE_STATES.index(state) + 1]:
            self._advance(mission_id, step, f"{prefix}-{step}")

    def _advance(self, mission_id: str, to_state: str, step_id: str) -> None:
        transition_mission(
            mission_id=mission_id,
            to_state=to_state,
            reason_code="fixture",
            step_id=step_id,
            next_action="fixture next action",
            wake_condition={"kind": "timer", "key": "fixture"},
            base_dir=self.base,
        )

    # -- helpers ----------------------------------------------------------

    def _state(self, mission_id: str) -> str:
        return fold_mission(mission_id=mission_id, base_dir=self.base)["state"]

    def _governance(self, kind: str) -> list[dict[str, Any]]:
        root = ensure_tools_dir(self.base)
        path = root / "governance.jsonl"
        if not path.exists():
            return []
        return [row for row in load_jsonl(path) if row.get("kind") == kind]

    def _reconcile(self, observer: Any, *, cycle_id: str = "cycle-1") -> dict[str, Any]:
        return reconcile_missions(
            cycle_id=cycle_id, observer=observer, base_dir=self.base
        )


# =====================================================================
# Classification — the whole safety property lives in this function.
# =====================================================================


class ClassificationTests(unittest.TestCase):
    def test_a_merged_pr_classifies_as_merged(self) -> None:
        self.assertEqual(
            classify_pr_lifecycle({"state": "MERGED", "merged": True}), "merged"
        )

    def test_merged_wins_over_a_closed_state(self) -> None:
        """GitHub's REST API reports a merged PR with state CLOSED. Reading
        the state alone would call every merge a failed attempt and send the
        mission back to PLANNING with a rung burnt."""
        self.assertEqual(
            classify_pr_lifecycle({"state": "CLOSED", "merged": True}), "merged"
        )

    def test_a_closed_unmerged_pr_classifies_as_closed_unmerged(self) -> None:
        self.assertEqual(
            classify_pr_lifecycle({"state": "CLOSED", "merged": False}),
            "closed_unmerged",
        )

    def test_an_open_pr_classifies_as_open(self) -> None:
        self.assertEqual(
            classify_pr_lifecycle({"state": "OPEN", "merged": False}), "open"
        )

    def test_no_answer_classifies_as_unobserved(self) -> None:
        self.assertEqual(classify_pr_lifecycle(None), "unobserved")

    def test_an_unrecognised_state_classifies_as_unobserved(self) -> None:
        """`RecordingGitHubAdapter.get_pr` returns exactly this string. A
        classifier with an `else: closed` arm would read it as a failed PR."""
        self.assertEqual(
            classify_pr_lifecycle({"state": "recording_adapter_no_fetch"}),
            "unobserved",
        )

    def test_a_truthy_non_true_merged_flag_is_not_a_merge(self) -> None:
        """`merged: "false"` is truthy. Only the boolean True is a merge."""
        self.assertEqual(
            classify_pr_lifecycle({"state": "CLOSED", "merged": "false"}),
            "closed_unmerged",
        )

    def test_every_classification_is_in_the_closed_vocabulary(self) -> None:
        for payload in (
            None,
            {},
            {"state": "OPEN"},
            {"state": "CLOSED"},
            {"merged": True},
            {"state": "nonsense"},
        ):
            self.assertIn(classify_pr_lifecycle(payload), RECONCILE_OBSERVATIONS)


# =====================================================================
# Absence is not damage.
# =====================================================================


class NoPositiveObservationTests(ReconcileTestBase):
    def test_an_adapter_error_transitions_nothing(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING", pr=7)
        result = self._reconcile(FakeObserver(raises=RuntimeError("gh exploded")))
        self.assertEqual(self._state(mission_id), "IMPLEMENTING")
        self.assertEqual(result["transitions"], [])
        rows = self._governance("mission_reconcile_adapter_error")
        # Both failing calls are recorded, not just the first: a lane whose
        # GitHub calls are all failing must not look like a lane with nothing
        # to reconcile.
        self.assertEqual(
            [(row["details"]["mission_id"], row["details"]["call"]) for row in rows],
            [(mission_id, "get_pr_lifecycle:7"), (None, "list_open_pull_requests")],
        )
        self.assertEqual(result["adapter_errors"], 2)

    def test_the_recording_adapter_transitions_nothing(self) -> None:
        """The production dry-run lane, end to end. `standard`/`observe`/
        `frozen` all get this adapter, so reconciliation on those lanes is
        structurally an observation and cannot be anything else."""
        mission_id = self._mission_at("IMPLEMENTING", pr=7)
        observer = RecordingGitHubAdapter(base_dir=self.base, profile="standard")
        result = self._reconcile(observer)
        self.assertEqual(self._state(mission_id), "IMPLEMENTING")
        self.assertEqual(result["transitions"], [])
        self.assertEqual(result["unobserved"], 1)

    def test_an_unknown_pr_state_transitions_nothing(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING", pr=7)
        result = self._reconcile(FakeObserver(prs={7: {"state": "DRAFTED"}}))
        self.assertEqual(self._state(mission_id), "IMPLEMENTING")
        self.assertEqual(result["unobserved"], 1)
        self.assertEqual(result["transitions"], [])

    def test_an_open_pr_is_observed_and_left_alone(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING", pr=7)
        result = self._reconcile(
            FakeObserver(prs={7: {"state": "OPEN", "merged": False}})
        )
        self.assertEqual(self._state(mission_id), "IMPLEMENTING")
        self.assertEqual(result["transitions"], [])
        self.assertEqual(result["unobserved"], 0)

    def test_one_unreadable_mission_does_not_abort_the_sweep(self) -> None:
        """A bad row costs only itself — the same rule adoption follows."""
        broken = self._mission_at("IMPLEMENTING", source_id="F-broken", pr=7)
        healthy = self._mission_at("IMPLEMENTING", source_id="F-ok", pr=8)
        observer = FakeObserver(
            prs={8: {"state": "MERGED", "merged": True}},
        )

        real = observer.get_pr_lifecycle

        def selective(number: int) -> dict[str, Any] | None:
            if number == 7:
                raise RuntimeError("this one explodes")
            return real(number)

        observer.get_pr_lifecycle = selective  # type: ignore[method-assign]
        self._reconcile(observer)
        self.assertEqual(self._state(broken), "IMPLEMENTING")
        self.assertEqual(self._state(healthy), "MAIN_VERIFYING")

    def test_a_refused_transition_does_not_abort_the_sweep(self) -> None:
        """`transition_mission` is the one call in the sweep that can raise
        past the per-observation handlers: it refuses any edge outside the
        closed table. If this module's divergence table ever drifts from the
        state machine's, that costs the mission its turn — not the night."""
        refused = self._mission_at("IMPLEMENTING", source_id="F-refused", pr=7)
        healthy = self._mission_at("IMPLEMENTING", source_id="F-ok", pr=8)
        real = reconcile_module.transition_mission

        def selective(**kwargs: Any) -> dict[str, Any]:
            if kwargs["mission_id"] == refused:
                raise GovernanceError("the closed table refuses this edge")
            return real(**kwargs)

        with patch.object(reconcile_module, "transition_mission", selective):
            self._reconcile(
                FakeObserver(
                    prs={
                        7: {"state": "MERGED", "merged": True},
                        8: {"state": "MERGED", "merged": True},
                    }
                )
            )
        self.assertEqual(self._state(refused), "IMPLEMENTING")
        self.assertEqual(self._state(healthy), "MAIN_VERIFYING")
        rows = self._governance("mission_reconcile_failed")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["details"]["mission_id"], refused)


# =====================================================================
# A merge that happened outside the cycle.
# =====================================================================


class ExternalMergeTests(ReconcileTestBase):
    def test_a_merged_pr_fast_forwards_a_mission_that_never_saw_it(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING", pr=7)
        result = self._reconcile(
            FakeObserver(
                prs={7: {"state": "MERGED", "merged": True, "merge_commit_sha": "abc123"}}
            )
        )
        self.assertEqual(self._state(mission_id), "MAIN_VERIFYING")
        self.assertEqual(len(result["transitions"]), 1)
        self.assertEqual(
            result["transitions"][0]["reason_code"], "reconciled_external_merge"
        )

    def test_the_fast_forward_leaves_the_closure_gate_clean(self) -> None:
        """Every transition reconciliation makes must say what happens next
        and what wakes it — otherwise reconciliation itself manufactures the
        half-done plans `assert_cycle_closure` exists to catch."""
        mission_id = self._mission_at("IMPLEMENTING", pr=7)
        self._reconcile(
            FakeObserver(
                prs={7: {"state": "MERGED", "merged": True, "merge_commit_sha": "abc123"}}
            )
        )
        state = fold_mission(mission_id=mission_id, base_dir=self.base)
        self.assertTrue(state["next_action"])
        self.assertTrue(state["wake_condition"])
        closure = assert_cycle_closure(base_dir=self.base)
        self.assertEqual(closure["violations"], [])

    def test_re_observing_the_same_merge_does_not_transition_twice(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING", pr=7)
        observer = FakeObserver(prs={7: {"state": "MERGED", "merged": True}})
        first = self._reconcile(observer, cycle_id="cycle-1")
        second = self._reconcile(observer, cycle_id="cycle-2")
        self.assertEqual(len(first["transitions"]), 1)
        self.assertEqual(second["transitions"], [])
        self.assertEqual(self._state(mission_id), "MAIN_VERIFYING")

    def test_a_mission_already_past_the_merge_is_left_alone(self) -> None:
        mission_id = self._mission_at("MAIN_VERIFYING", pr=7)
        result = self._reconcile(FakeObserver(prs={7: {"state": "MERGED", "merged": True}}))
        self.assertEqual(self._state(mission_id), "MAIN_VERIFYING")
        self.assertEqual(result["transitions"], [])
        self.assertEqual(self._governance("mission_reconcile_contradiction"), [])

    def test_a_merge_observed_on_a_waiting_mission_is_a_recorded_contradiction(
        self,
    ) -> None:
        """BLOCKED_EXTERNAL cannot reach MAIN_VERIFYING by any edge. Forcing
        one would be reconciliation inventing a path it did not observe."""
        mission_id = self._mission_at("BLOCKED_EXTERNAL", pr=7)
        result = self._reconcile(FakeObserver(prs={7: {"state": "MERGED", "merged": True}}))
        self.assertEqual(self._state(mission_id), "BLOCKED_EXTERNAL")
        self.assertEqual(result["transitions"], [])
        rows = self._governance("mission_reconcile_contradiction")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["details"]["observation"], "merged")

    def test_a_merge_outranks_a_closed_sibling_pr(self) -> None:
        """Two attempts, the second merged. Acting on the closed one would
        replan work that is already on main."""
        mission_id = self._mission_at("IMPLEMENTING", pr=7)
        bind_mission(
            mission_id=mission_id,
            bindings={"pr_numbers": [8]},
            step_id="second-attempt",
            base_dir=self.base,
        )
        self._reconcile(
            FakeObserver(
                prs={
                    7: {"state": "CLOSED", "merged": False},
                    8: {"state": "MERGED", "merged": True},
                }
            )
        )
        self.assertEqual(self._state(mission_id), "MAIN_VERIFYING")


# =====================================================================
# A PR that was closed without merging.
# =====================================================================


class ClosedUnmergedTests(ReconcileTestBase):
    def test_a_closed_unmerged_pr_replans_one_rung_up(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING", pr=7)
        result = self._reconcile(FakeObserver(prs={7: {"state": "CLOSED", "merged": False}}))
        state = fold_mission(mission_id=mission_id, base_dir=self.base)
        self.assertEqual(state["state"], "PLANNING")
        self.assertEqual(state["retry_rung"], RETRY_LADDER[0])
        self.assertEqual(
            result["transitions"][0]["reason_code"], "reconciled_closed_unmerged"
        )

    def test_the_rung_advances_by_exactly_one_per_closed_attempt(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING", pr=7)
        self._reconcile(FakeObserver(prs={7: {"state": "CLOSED", "merged": False}}))
        self._advance(mission_id, "IMPLEMENTING", "retry-1")
        bind_mission(
            mission_id=mission_id,
            bindings={"pr_numbers": [8]},
            step_id="second-attempt",
            base_dir=self.base,
        )
        self._reconcile(
            FakeObserver(
                prs={
                    7: {"state": "CLOSED", "merged": False},
                    8: {"state": "CLOSED", "merged": False},
                }
            ),
            cycle_id="cycle-2",
        )
        state = fold_mission(mission_id=mission_id, base_dir=self.base)
        self.assertEqual(state["state"], "PLANNING")
        self.assertEqual(state["retry_rung"], RETRY_LADDER[1])

    def test_an_exhausted_ladder_escalates_to_a_human_instead_of_looping(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING", pr=7)
        transition_mission(
            mission_id=mission_id,
            to_state="VALIDATING",
            reason_code="fixture",
            step_id="exhaust",
            retry_rung=RETRY_LADDER[-1],
            next_action="n",
            wake_condition={"kind": "timer", "key": "k"},
            base_dir=self.base,
        )
        result = self._reconcile(FakeObserver(prs={7: {"state": "CLOSED", "merged": False}}))
        self.assertEqual(self._state(mission_id), "HUMAN_REQUIRED")
        self.assertEqual(
            result["transitions"][0]["reason_code"], "retry_ladder_exhausted"
        )

    def test_a_closed_unmerged_pr_after_main_verification_is_a_contradiction(
        self,
    ) -> None:
        mission_id = self._mission_at("MAIN_VERIFYING", pr=7)
        result = self._reconcile(FakeObserver(prs={7: {"state": "CLOSED", "merged": False}}))
        self.assertEqual(self._state(mission_id), "MAIN_VERIFYING")
        self.assertEqual(result["transitions"], [])
        rows = self._governance("mission_reconcile_contradiction")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["details"]["observation"], "closed_unmerged")

    def test_a_still_open_sibling_pr_holds_the_replan_back(self) -> None:
        """One attempt closed, another still open: the work is live, and
        replanning would abandon a PR that is in flight."""
        mission_id = self._mission_at("IMPLEMENTING", pr=7)
        bind_mission(
            mission_id=mission_id,
            bindings={"pr_numbers": [8]},
            step_id="second-attempt",
            base_dir=self.base,
        )
        self._reconcile(
            FakeObserver(
                prs={
                    7: {"state": "CLOSED", "merged": False},
                    8: {"state": "OPEN", "merged": False},
                }
            )
        )
        self.assertEqual(self._state(mission_id), "IMPLEMENTING")


# =====================================================================
# A branch that is no longer there.
# =====================================================================


class LostBranchTests(ReconcileTestBase):
    def test_a_positively_absent_branch_returns_the_mission_to_planning(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING", branch="aria/work-1")
        result = self._reconcile(FakeObserver(branches={"aria/work-1": False}))
        self.assertEqual(self._state(mission_id), "PLANNING")
        self.assertEqual(
            result["transitions"][0]["reason_code"], "reconciled_lost_branch"
        )

    def test_an_unobservable_branch_does_not_return_the_mission_to_planning(
        self,
    ) -> None:
        """`None` is "I could not look". A branch check that cannot reach the
        remote must not read as a deleted branch — that is the same mistake as
        reading "not merged" off an adapter that never fetched."""
        mission_id = self._mission_at("IMPLEMENTING", branch="aria/work-1")
        result = self._reconcile(FakeObserver(branches={"aria/work-1": None}))
        self.assertEqual(self._state(mission_id), "IMPLEMENTING")
        self.assertEqual(result["transitions"], [])
        self.assertEqual(result["unobserved"], 1)

    def test_a_present_branch_changes_nothing(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING", branch="aria/work-1")
        result = self._reconcile(FakeObserver(branches={"aria/work-1": True}))
        self.assertEqual(self._state(mission_id), "IMPLEMENTING")
        self.assertEqual(result["transitions"], [])

    def test_a_branch_is_not_checked_while_the_mission_has_a_pr(self) -> None:
        """GitHub deletes the head branch when a PR merges. Checking the
        branch of a mission that has a PR would report every clean merge as a
        lost branch."""
        self._mission_at("IMPLEMENTING", pr=7, branch="aria/work-1")
        observer = FakeObserver(
            prs={7: {"state": "OPEN", "merged": False}},
            branches={"aria/work-1": False},
        )
        self._reconcile(observer)
        self.assertNotIn("observe_branch:aria/work-1", observer.calls)

    def test_a_lost_branch_after_the_merge_tail_is_a_contradiction(self) -> None:
        mission_id = self._mission_at("MAIN_VERIFYING", branch="aria/work-1")
        result = self._reconcile(FakeObserver(branches={"aria/work-1": False}))
        self.assertEqual(self._state(mission_id), "MAIN_VERIFYING")
        self.assertEqual(result["transitions"], [])
        self.assertEqual(len(self._governance("mission_reconcile_contradiction")), 1)


# =====================================================================
# Adopting a PR that names its mission.
# =====================================================================


class TrailerAdoptionTests(ReconcileTestBase):
    def test_a_pr_carrying_a_mission_trailer_is_bound(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING")
        result = self._reconcile(
            FakeObserver(
                open_prs=[{"number": 42, "body": f"work\n\nARIA-Mission: {mission_id}\n"}]
            )
        )
        state = fold_mission(mission_id=mission_id, base_dir=self.base)
        self.assertEqual(state["bindings"]["pr_numbers"], [42])
        self.assertEqual(result["adoptions"], [{"mission_id": mission_id, "pr_number": 42}])

    def test_adoption_is_idempotent_across_cycles(self) -> None:
        mission_id = self._mission_at("IMPLEMENTING")
        observer = FakeObserver(
            open_prs=[{"number": 42, "body": f"ARIA-Mission: {mission_id}"}]
        )
        self._reconcile(observer, cycle_id="cycle-1")
        second = self._reconcile(observer, cycle_id="cycle-2")
        self.assertEqual(second["adoptions"], [])
        state = fold_mission(mission_id=mission_id, base_dir=self.base)
        self.assertEqual(state["bindings"]["pr_numbers"], [42])

    def test_a_trailer_naming_an_unknown_mission_creates_nothing(self) -> None:
        """A PR body is content ARIA did not write. Mission identity is
        derived from the source of the work, never asserted by a PR — so an
        unknown id is recorded and refused, not opened."""
        result = self._reconcile(
            FakeObserver(
                open_prs=[{"number": 42, "body": "ARIA-Mission: m-0000000000000000"}]
            )
        )
        self.assertEqual(result["adoptions"], [])
        rows = self._governance("mission_reconcile_unknown_trailer")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["details"]["mission_id"], "m-0000000000000000")

    def test_a_malformed_trailer_is_ignored(self) -> None:
        self._mission_at("IMPLEMENTING")
        result = self._reconcile(
            FakeObserver(
                open_prs=[
                    {"number": 42, "body": "ARIA-Mission: not-a-mission-id"},
                    {"number": 43, "body": "ARIA-Mission: m-XYZ"},
                    {"number": 44, "body": "no trailer at all"},
                ]
            )
        )
        self.assertEqual(result["adoptions"], [])
        self.assertEqual(self._governance("mission_reconcile_unknown_trailer"), [])

    def test_an_unlistable_pr_set_adopts_nothing_and_raises_nothing(self) -> None:
        result = self._reconcile(FakeObserver(open_prs=None))
        self.assertEqual(result["adoptions"], [])

    def test_reconciliation_never_opens_a_mission(self) -> None:
        """Pinned at the source, because a behavioural test cannot prove a
        negative about code paths it did not take. A PR body must never be
        able to mint work."""
        tree = ast.parse(inspect.getsource(reconcile_module))
        called: set[str] = set()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if isinstance(node.func, ast.Name):
                called.add(node.func.id)
            elif isinstance(node.func, ast.Attribute):
                # `mission.open_mission(...)` must be caught too — a
                # source-text search would not distinguish it from the
                # `list_open_missions` this module legitimately imports.
                called.add(node.func.attr)
        self.assertNotIn("open_mission", called)

        imported = {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom)
            for alias in node.names
        }
        self.assertNotIn("open_mission", imported)


# =====================================================================
# Wiring: the phase is on the lane, and the lane's adapters can answer it.
# =====================================================================


class PipelineWiringTests(unittest.TestCase):
    def _phase(self) -> Any:
        for phase in cycle_module.CYCLE_PHASES:
            if phase.name == "mission_reconcile":
                return phase
        self.fail("mission_reconcile is not in CYCLE_PHASES")

    def test_the_phase_runs_in_preflight_before_anything_reads_mission_state(
        self,
    ) -> None:
        phase = self._phase()
        self.assertEqual(phase.stage, "preflight")
        names = [p.name for p in cycle_module.CYCLE_PHASES]
        self.assertLess(names.index("mission_reconcile"), names.index("mission_ingest"))

    def test_the_phase_needs_writes_and_survives_its_own_failure(self) -> None:
        phase = self._phase()
        self.assertIs(phase.precondition, cycle_module.WRITES_PERMITTED)
        self.assertEqual(phase.on_error, "record_and_continue")
        self.assertEqual(phase.state_key, "mission_reconcile")

    def test_the_phase_is_not_in_the_burn_in_lane(self) -> None:
        """Burn-in proves no action surface was touched. Moving a mission is
        an action."""
        self.assertNotIn("burn_in", self._phase().modes)

    def test_both_selectable_adapters_answer_the_observer_protocol(self) -> None:
        """`select_github_adapter` returns one of two classes and the phase
        calls all three observer methods on whichever it gets. A missing
        method would be an AttributeError on the live lane only."""
        from aria_kernel.auto_merge import GhCliGitHubAdapter

        for adapter_class in (RecordingGitHubAdapter, GhCliGitHubAdapter):
            for method in ("get_pr_lifecycle", "observe_branch", "list_open_pull_requests"):
                self.assertTrue(
                    callable(getattr(adapter_class, method, None)),
                    f"{adapter_class.__name__} cannot answer {method}",
                )
        self.assertTrue(issubclass(RecordingGitHubAdapter, MissionObserver))

    def test_the_recording_adapter_records_every_observation_it_declines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            adapter = RecordingGitHubAdapter(base_dir=tmp, profile="standard")
            self.assertIsNone(adapter.get_pr_lifecycle(7))
            self.assertIsNone(adapter.observe_branch("aria/work-1"))
            self.assertIsNone(adapter.list_open_pull_requests())
            rows = load_jsonl(Path(tmp) / "audit" / "intended-gh-calls.jsonl")
            self.assertEqual(
                [row["method"] for row in rows],
                ["get_pr_lifecycle", "observe_branch", "list_open_pull_requests"],
            )


class PhaseRunnerTests(ReconcileTestBase):
    def test_the_phase_runner_runs_end_to_end_on_the_dry_run_lane(self) -> None:
        """Every name the runner uses resolves, the adapter it selects for
        the default profile answers, and the mission it observes does not
        move. A phase that raises NameError on its first live night is a
        phase no test ever executed."""
        mission_id = self._mission_at("IMPLEMENTING", pr=7)
        context = cycle_module.build_phase_context(
            cycle_id="cycle-1",
            workspace_root=self.base,
            base_dir=ensure_tools_dir(self.base),
        )
        payload = cycle_module._phase_mission_reconcile(context)
        self.assertEqual(payload["transitions"], [])
        self.assertEqual(self._state(mission_id), "IMPLEMENTING")


if __name__ == "__main__":
    unittest.main()
