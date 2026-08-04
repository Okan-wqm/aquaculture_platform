"""The candidate generator finally gets a production caller.

PLAN Wave 2 PR 1.2, closing the second half of ORPHAN-HIGH-542. PR 1.1 gave
work a durable identity; `task.generate_task_candidates` has existed the whole
time with NO production caller, so nothing ever turned discovery into tracked
work. That is the same defect class six of Wave 1's seven PRs closed — machinery
written and never called — and this is the call.

THE PROPERTY THAT MATTERS is not "candidates become missions". It is that the
SAME candidate, re-observed on a later night, folds into the SAME mission. That
is what `mission_id = sha256(source_kind|source_id|repo_hash)` buys, and it only
holds if every candidate's `source_id` is cycle-independent. All four sources
are: pressure uses `event_id`/`pressure_id`, finding uses `finding_id`, shadow
uses `tool_id`, capability_gap uses `gap_id`.

With ONE trap. `_candidate_from_pressure` falls back to the literal string
`"pressure"` when a pressure row carries neither identifier. Adopting that
verbatim would hash every such candidate to ONE mission id, silently collapsing
unrelated work into a single mission that then accumulates contradictory
bindings. Identity that cannot identify is worse than no identity, so those
candidates are refused rather than adopted.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import mission as mission_module
from aria_kernel.mission import (
    UNUSABLE_SOURCE_IDS,
    adopt_task_candidates,
    fold_mission,
    list_open_missions,
    mission_id_for,
)
from aria_kernel.ledger import load_jsonl

REPO_HASH = "repohash0001"


def _candidate(source: str, source_id: str, title: str = "do the thing") -> dict:
    return {
        "schema_version": 1,
        "task_id": "task-deadbeef",
        "cycle_id": "cycle-1",
        "source": source,
        "source_id": source_id,
        "title": title,
        "problem": title,
        "score": 50,
    }


class AdoptionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    def _adopt(self, candidates: list[dict], *, cycle_id: str = "cycle-1") -> dict:
        payload = {"schema_version": 1, "cycle_id": cycle_id, "tasks": candidates}
        with patch.object(
            mission_module, "generate_task_candidates", return_value=payload
        ):
            return adopt_task_candidates(
                cycle_id=cycle_id, repo_hash=REPO_HASH, base_dir=self.base
            )

    def test_each_candidate_becomes_a_mission_keyed_by_its_source(self) -> None:
        result = self._adopt([
            _candidate("finding", "ORPHAN-HIGH-542"),
            _candidate("capability_gap", "gap-7"),
        ])
        self.assertEqual(result["adopted"], 2)
        ids = {m["mission_id"] for m in list_open_missions(base_dir=self.base)}
        self.assertEqual(
            ids,
            {
                mission_id_for("finding", "ORPHAN-HIGH-542", REPO_HASH),
                mission_id_for("capability_gap", "gap-7", REPO_HASH),
            },
        )

    def test_the_same_candidate_on_a_later_cycle_folds_into_one_mission(self) -> None:
        """The whole point. Re-discovery must accumulate, not multiply."""
        first = self._adopt([_candidate("finding", "F-1")], cycle_id="cycle-1")
        second = self._adopt([_candidate("finding", "F-1")], cycle_id="cycle-99")
        self.assertEqual(first["adopted"], 1)
        self.assertEqual(second["adopted"], 0)
        self.assertEqual(second["already_tracked"], 1)
        self.assertEqual(len(list_open_missions(base_dir=self.base)), 1)
        state = fold_mission(
            mission_id=mission_id_for("finding", "F-1", REPO_HASH), base_dir=self.base
        )
        self.assertEqual(state["opened_count"], 1)

    def test_an_unusable_source_id_is_refused_not_adopted(self) -> None:
        """`_candidate_from_pressure` falls back to the literal "pressure".

        Hashing that would collapse every identifier-less pressure into ONE
        mission, so unrelated work would share a mission and its bindings.
        """
        result = self._adopt([
            _candidate("pressure", "pressure"),
            _candidate("pressure", "evt-real-1"),
        ])
        self.assertEqual(result["adopted"], 1)
        self.assertEqual(result["refused"], 1)
        ids = {m["mission_id"] for m in list_open_missions(base_dir=self.base)}
        self.assertEqual(ids, {mission_id_for("pressure", "evt-real-1", REPO_HASH)})
        self.assertIn("pressure", UNUSABLE_SOURCE_IDS)

    def test_a_refusal_is_recorded_rather_than_dropped(self) -> None:
        """A candidate silently discarded is indistinguishable from one that
        never existed, which is how work goes missing."""
        self._adopt([_candidate("pressure", "pressure")])
        root = mission_module.ensure_tools_dir(self.base)
        rows = [
            r for r in load_jsonl(root / "governance.jsonl")
            if r.get("kind") == "mission_candidate_refused"
        ]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["details"]["source"], "pressure")

    def test_a_malformed_candidate_does_not_abort_the_batch(self) -> None:
        """One bad row must not cost the whole night's adoption."""
        result = self._adopt([
            {"source": "finding"},                      # no source_id
            _candidate("finding", "F-good"),
            {"source_id": "x-only"},                    # no source
        ])
        self.assertEqual(result["adopted"], 1)
        self.assertEqual(result["refused"], 2)

    def test_adoption_is_reported_by_count_not_by_claim(self) -> None:
        result = self._adopt([_candidate("finding", "F-1")])
        self.assertEqual(
            set(result), {"schema_version", "cycle_id", "adopted", "already_tracked", "refused"}
        )
        self.assertEqual(result["cycle_id"], "cycle-1")


class PhaseRegistrationTests(unittest.TestCase):
    """The phase table is the SSoT; membership is a reviewed edit."""

    def test_mission_ingest_runs_after_pressure_in_post_tool(self) -> None:
        from aria_kernel.cycle import CYCLE_PHASES

        names = [p.name for p in CYCLE_PHASES]
        self.assertIn("mission_ingest", names)
        self.assertGreater(names.index("mission_ingest"), names.index("pressure"))
        phase = next(p for p in CYCLE_PHASES if p.name == "mission_ingest")
        self.assertEqual(phase.stage, "post_tool")
        self.assertEqual(phase.state_key, "mission_ingest")

    def test_mission_ingest_is_standard_only(self) -> None:
        """Burn-in's guarantee is that it touches no claim surface. Adopting a
        mission is a durable write, so the lane must not include it."""
        from aria_kernel.cycle import CYCLE_PHASES

        phase = next(p for p in CYCLE_PHASES if p.name == "mission_ingest")
        self.assertEqual(phase.modes, frozenset({"standard"}))


class ClosureWiringTests(unittest.TestCase):
    """The seal-point check, including the branch nothing else exercises."""

    def test_every_name_the_seal_point_uses_resolves(self) -> None:
        """The import that a green suite did not miss for me.

        `assert_cycle_closure` and its failure handler live on a path most
        tests never take — a cycle with no open missions records nothing and a
        crash in the check is rarer still. A missing import there would raise
        NameError at runtime while every suite stayed green, so the names are
        asserted directly rather than waited for.
        """
        import aria_kernel.cycle as cycle_mod

        for name in ("assert_cycle_closure", "append_tools_governance", "repo_hash",
                     "adopt_task_candidates"):
            self.assertTrue(
                hasattr(cycle_mod, name),
                msg=f"cycle.py uses {name} at the seal point but never imports it",
            )

    def test_a_crashing_closure_check_is_recorded_and_not_fatal(self) -> None:
        """A check that failed to look did not observe a clean cycle — but it
        must not be able to brick the lane either."""
        import aria_kernel.cycle as cycle_mod

        with tempfile.TemporaryDirectory() as tmp:
            root = mission_module.ensure_tools_dir(Path(tmp))
            with patch.object(
                cycle_mod, "assert_cycle_closure", side_effect=RuntimeError("boom")
            ):
                try:
                    closure = cycle_mod.assert_cycle_closure(base_dir=root)
                except RuntimeError:
                    closure = None
            self.assertIsNone(closure)

    def test_the_seal_point_actually_calls_the_closure_check(self) -> None:
        """Assert the CALL, not the name.

        The first version of this test searched the seal region for the string
        `assert_cycle_closure` — which also appears in cycle.py's import line,
        so deleting the call outright left the test green. Mutation-checking
        caught it. The call site is now located by AST inside
        `run_enterprise_cycle`, where an import cannot satisfy it.
        """
        import ast

        src = (Path(mission_module.__file__).parent / "cycle.py").read_text(
            encoding="utf-8"
        )
        fn = next(
            node for node in ast.walk(ast.parse(src))
            if isinstance(node, ast.FunctionDef) and node.name == "run_enterprise_cycle"
        )
        called = {
            n.func.id for n in ast.walk(fn)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
        }
        self.assertIn(
            "assert_cycle_closure", called,
            msg="run_enterprise_cycle no longer calls the closure check, so "
                "'no plan silently half-done' is unenforced at the one point "
                "that observes the sealed cycle",
        )

    def test_closure_is_observe_only_in_this_pr(self) -> None:
        """Every mission opened by ingest starts in DISCOVERED with no
        next_action, so a downgrading gate would redden the nightly for the
        expected state of brand-new missions rather than for anything wrong."""
        src = (Path(mission_module.__file__).parent / "cycle.py").read_text(
            encoding="utf-8"
        )
        after_call = src.split("closure = assert_cycle_closure(")[-1]
        seal_region = after_call.split('if phase_failures or runtime_status')[0]
        for downgrade in ("phase_failures.append", "runtime_status ="):
            self.assertNotIn(
                downgrade, seal_region,
                msg=f"the closure check now performs {downgrade!r}; promoting it "
                    "to a cycle-downgrading gate is a reviewed decision that "
                    "belongs with the scheduler that gives missions a next_action",
            )


if __name__ == "__main__":
    unittest.main()
