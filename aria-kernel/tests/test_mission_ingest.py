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

AND THIS IS THE PRODUCER THAT ACTUALLY FILLED THE LIVE STORE. Measured
2026-08-19: all 5 events in `missions/mission-events.jsonl` are contract-less
``opened`` rows from here (``pressure`` x2, ``shadow_run_summary`` x3), none
from the service seeder. ORPHAN-MEDIUM-730's refusal was first written so that
this path could not reach it — it passed ``next_action=title``, and since
`UNUSABLE_SOURCE_IDS` already guarantees a non-empty ``source_id`` the title
was never empty, so a mission whose "what happens next" was a bare identifier
or a restated defect always minted. The contract is read off the candidate's
own ``next_action`` now, which `task.py` composes from the SOURCE's evidence,
and a candidate that carries none is refused and disclosed.
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


def _candidate(
    source: str,
    source_id: str,
    title: str = "the thing is broken",
    next_action: str | None = "fix the thing at apps/x/y.ts",
) -> dict:
    """A candidate as `task.py` emits one: a title AND a forward pointer.

    They are deliberately different strings here. The defect this fixture
    would otherwise hide is the mission layer using the title as the contract
    — every assertion below would still pass while the mission's "what happens
    next" was a restatement of the problem.
    """
    candidate = {
        "schema_version": 1,
        "task_id": "task-deadbeef",
        "cycle_id": "cycle-1",
        "source": source,
        "source_id": source_id,
        "title": title,
        "problem": title,
        "score": 50,
    }
    if next_action is not None:
        candidate["next_action"] = next_action
    return candidate


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
            set(result),
            {
                "schema_version", "cycle_id", "adopted", "already_tracked",
                "refused",
                # `healed` joins the count report because a re-adoption that
                # repaired a pre-rule row did real work, and a night that
                # reports only "already_tracked: 1" hides it.
                "healed",
            },
        )
        self.assertEqual(result["cycle_id"], "cycle-1")


class ForwardPointerTests(unittest.TestCase):
    """The refusal has to be REACHABLE from the producer that fills the store.

    ORPHAN-MEDIUM-730's first revision made `open_mission` refuse a
    contract-less mint and then handed this path ``next_action=title``, so the
    refusal was unreachable from here by construction — the one producer that
    had ever written a paralysed mission was the one exempted from the fix.
    """

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

    def _refusals(self) -> list[dict]:
        root = mission_module.ensure_tools_dir(self.base)
        return [
            row["details"] for row in load_jsonl(root / "governance.jsonl")
            if row.get("kind") == "mission_candidate_refused"
        ]

    def test_a_candidate_that_cannot_name_a_next_action_is_refused(self) -> None:
        """The exact shape the old code minted: a title, no forward pointer."""
        result = self._adopt([
            _candidate("pressure", "evt-1", title="the tenant mismatch is swallowed",
                       next_action=None),
        ])

        self.assertEqual(result["adopted"], 0)
        self.assertEqual(result["refused"], 1)
        self.assertEqual(list_open_missions(base_dir=self.base), [])
        self.assertEqual(
            [(row["source"], row["reason"]) for row in self._refusals()],
            [("pressure", "no_derivable_next_action")],
        )

    def test_the_contract_is_read_off_the_candidate_not_off_its_title(self) -> None:
        """A finding's title IS its message — an agent told to "do" the defect.

        The pin bites on the VALUE, not on the presence: revert the mint to
        ``next_action=title`` and the folded mission's forward pointer becomes
        the restated defect, which this assertion names.
        """
        self._adopt([
            _candidate(
                "finding", "F-1",
                title="refresh token rotation is not atomic",
                next_action="Resolve open finding F-1 (high) at apps/auth-service/src/token.service.ts",
            ),
        ])

        state = fold_mission(
            mission_id=mission_id_for("finding", "F-1", REPO_HASH), base_dir=self.base
        )
        self.assertEqual(state["title"], "refresh token rotation is not atomic")
        self.assertEqual(
            state["next_action"],
            "Resolve open finding F-1 (high) at apps/auth-service/src/token.service.ts",
        )
        self.assertNotEqual(state["next_action"], state["title"])

    def test_every_builder_derives_its_action_from_its_own_evidence(self) -> None:
        """One assertion per candidate source, over rows shaped like the real
        producers': the action must NAME the source's own identifier, so a
        builder that quietly starts composing a stand-in is visible here.
        """
        from aria_kernel.task import (
            _candidate_from_capability_gap,
            _candidate_from_finding,
            _candidate_from_pressure,
            _candidate_from_proactive,
            _candidate_from_shadow_summary,
        )

        cases = [
            (_candidate_from_pressure("c", {
                "pressure_id": "pressure:tool-quarantine:x",
                "recommended_action": "inspect quarantine reason before next run",
                "reason": "tool x was quarantined",
            }), "inspect quarantine reason"),
            (_candidate_from_finding("c", {
                "finding_id": "F-9",
                "finding": {"severity": "high", "message": "m",
                            "path": "apps/auth-service/src/token.service.ts"},
            }), "F-9"),
            (_candidate_from_capability_gap("c", {
                "gap_id": "gap-1", "capability_gap_key": "coverage:auth-service",
                "recommended_action": "draft_new_aria_agent", "title": "t", "score": 1,
            }), "coverage:auth-service"),
            # H-3 — a blind-surface gap recommends an ADAPTER, not an agent.
            # Before the builder learned that word the candidate carried no
            # next_action at all and the mission path refused it.
            (_candidate_from_capability_gap("c", {
                "gap_id": "gap-2", "capability_gap_key": "observation:sens-api-gateway",
                "recommended_action": "author_new_aria_adapter", "title": "t", "score": 73,
                "details": {"root": "sens-api-gateway", "unparsed_file_types": [".rs"]},
            }), "observation:sens-api-gateway"),
            (_candidate_from_proactive("c", {
                "tool_id": "typeorm-entity-schema-adapter", "priority": 70,
                "reasons": ["no goldset"],
            }), "typeorm-entity-schema-adapter"),
            (_candidate_from_shadow_summary("c", {"tool_id": "test-gap-adapter"}, 12),
             "test-gap-adapter"),
        ]
        for candidate, identifier in cases:
            with self.subTest(source=candidate["source"]):
                self.assertIn(identifier, candidate["next_action"])
                self.assertNotEqual(candidate["next_action"], candidate["source_id"])

    def test_a_source_that_names_no_action_omits_the_key_entirely(self) -> None:
        """``None`` under the key would read as a builder that forgot; the
        absence is the source saying it cannot name the work."""
        from aria_kernel.task import _candidate_from_pressure

        candidate = _candidate_from_pressure(
            "c", {"pressure_id": "p-1", "reason": "something is wrong"}
        )
        self.assertNotIn("next_action", candidate)

    def test_the_ingest_path_heals_the_rows_it_wrote(self) -> None:
        """The 5 live rows came from HERE, so this is where they converge.

        Re-adoption is idempotent by mission identity, so without a heal the
        rows this producer wrote before the rule existed would stay unmovable
        forever — the refusal would have fixed only the future of the one path
        that has a past.
        """
        from aria_kernel.ledger import append_declared_jsonl
        from aria_kernel.mission import events_path
        from aria_kernel.tool_registry import ensure_tools_dir, utc_now

        root = ensure_tools_dir(self.base)
        source_id = "pressure:tool-quarantine:agent-harness-security-adapter"
        mission_id = mission_id_for("pressure", source_id, REPO_HASH)
        append_declared_jsonl(
            events_path(root),
            {
                "schema_version": 1,
                "schema": mission_module.MISSION_SCHEMA,
                "event_id": "legacy-live-row",
                "recorded_at": utc_now(),
                "event": "opened",
                "mission_id": mission_id,
                "idempotency_key": mission_module._idempotency_key(
                    mission_id, "genesis", "", "opened"
                ),
                "source_kind": "pressure",
                "source_id": source_id,
                "repo_hash": REPO_HASH,
                "title": "inspect quarantine reason before next run",
                "capability": None,
                "priority": None,
                "target_project": None,
            },
            expected_surface="mission_events",
        )
        self.assertTrue(
            mission_module.assert_cycle_closure(base_dir=self.base)["violations"]
        )

        result = self._adopt([
            _candidate("pressure", source_id,
                       title="agent-harness-security-adapter is quarantined",
                       next_action="inspect quarantine reason before next run"),
        ])

        self.assertEqual(result["already_tracked"], 1)
        self.assertEqual(result["healed"], 1)
        self.assertEqual(
            mission_module.assert_cycle_closure(base_dir=self.base)["violations"], []
        )


class CandidateIdentityStabilityTests(unittest.TestCase):
    """Every source_id fed to mission identity must survive a cycle boundary.

    This is the claim the whole adoption rests on, and checking the FIELD NAME
    is not checking it. `gap_id` looks stable and is not: `capability_gap._gap`
    computes it as `sha256(f"{cycle_id}:{gap_type}:{source_id}")`, so the same
    gap re-detected tomorrow yields a different id and therefore a different
    mission — a fresh mission every night, which is precisely the churn PR 1.1
    exists to make impossible.

    The stable key already exists: `capability_gap_key` is content-derived
    (`registry:ghost:<tool_id>`, `coverage:<service>`, …) and is exactly what
    `detect_capability_gaps` dedups on. It simply never reached the candidate.
    """

    def test_no_candidate_source_id_is_derived_from_the_cycle(self) -> None:
        """AST guard over task.py's five candidate builders.

        Behavioural tests cannot see this: within one cycle every id is
        perfectly stable, so a cycle-derived id passes any same-run assertion.
        (Count bumped 4 → 5 by E8/M12: `_candidate_from_proactive` joined —
        its source_id is the tool_id, content-derived like the others.)
        """
        import ast
        import inspect

        from aria_kernel import task as task_mod

        tree = ast.parse(inspect.getsource(task_mod))
        builders = {
            node.name: node for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name.startswith("_candidate_from_")
        }
        self.assertEqual(len(builders), 5, sorted(builders))
        for name, node in builders.items():
            assigns = [
                n for n in ast.walk(node)
                if isinstance(n, ast.Assign)
                and any(getattr(t, "id", None) == "source_id" for t in n.targets)
            ]
            for assign in assigns:
                read = {
                    n.id for n in ast.walk(assign.value) if isinstance(n, ast.Name)
                }
                self.assertNotIn(
                    "cycle_id", read,
                    msg=f"{name} derives source_id from cycle_id; mission identity "
                        "would churn every cycle",
                )

    def test_a_capability_gap_folds_across_cycles(self) -> None:
        """Two cycles, two gap_ids, one stable key — one mission."""
        from aria_kernel.task import _candidate_from_capability_gap

        gap_night_one = {
            "gap_id": "gap-aaaaaaaaaaaa",
            "capability_gap_key": "registry:ghost:tool-x",
            "title": "tool-x is a ghost",
            "score": 40,
        }
        gap_night_two = dict(gap_night_one, gap_id="gap-bbbbbbbbbbbb")
        first = _candidate_from_capability_gap("cycle-1", gap_night_one)
        second = _candidate_from_capability_gap("cycle-2", gap_night_two)
        self.assertEqual(first["source_id"], second["source_id"])
        self.assertEqual(first["source_id"], "registry:ghost:tool-x")
        self.assertEqual(
            mission_id_for("capability_gap", first["source_id"], REPO_HASH),
            mission_id_for("capability_gap", second["source_id"], REPO_HASH),
        )

    def test_a_gap_without_the_stable_key_still_yields_something(self) -> None:
        """Fall back to gap_id rather than refusing: a gap with no key is a
        capability_gap.py bug, and dropping the work would hide it."""
        from aria_kernel.task import _candidate_from_capability_gap

        candidate = _candidate_from_capability_gap(
            "cycle-1", {"gap_id": "gap-cccccccccccc", "title": "t", "score": 1}
        )
        self.assertEqual(candidate["source_id"], "gap-cccccccccccc")


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
        """The premise this test was written on is dead; the verdict is not.

        It used to read "every mission opened by ingest starts in DISCOVERED
        with no next_action" — false since ORPHAN-MEDIUM-730, because ingest
        mints under a contract read off the candidate. What keeps the gate
        observe-only is the OTHER half: the only violations still reachable
        are rows written before the rule existed, and one class of them (a
        mission a human parked, `mission.OPERATOR_HELD_STATES`) can never be
        healed by any unattended writer. Downgrading the cycle for those would
        redden the nightly for archaeology it is forbidden to touch.
        """
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
