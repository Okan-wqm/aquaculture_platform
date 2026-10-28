"""F0.9p — no learned memory row is an orphan: ``row_provenance`` names each kind's source and counts the rows without one.

WHY THIS EXISTS. A learned row (a convention, a procedural episode, a belief) is only as trustworthy as the thing it
came from: when a poisoned or mistaken source is found, the rows that cite it have to be found too (F4.6 walks that
graph), and every memory kind a later package adds needs a gate that says "this row cites a source". Today's three
writers already produce sourced rows by construction; the package locks that in and gives F4.x kinds the invariant.
The census is a reader: a store without a reader is dead code, so the doctor reports it every run
(tests/test_doctor_provenance.py) and the atlas lists its owner (tests/test_ownership_atlas_provenance.py).

THE API THIS PINS (new in F0.9p; at the branch base ``aria_kernel.row_provenance`` does not exist, so each test reports
an assertion failure, not an import error). The vocabularies are closed and read the manifest, not a second list:
  Ref(surface, id_field), Learned(surface, id_field, sources)             frozen dataclasses
  REF_FIELDS    the citation vocabulary: a row field -> the ledger and the id field it names
  LEARNED_KINDS the learned memory kinds -> (ledger, id field, the fields that carry the row's source, in order)
  provenance_census(tools_root) -> {kind: {"rows": int, "orphans": [{"row_id", "reason"}, ...]}}
    READ-ONLY. An orphan is a row whose FIRST source field is empty or absent (``source_missing:<field>``) or names no
    row of the cited ledger (``source_unresolved:<field>``; only ``plan_id`` is joined in this slice: the plan ids of
    the plan ledger). A belief row is the latest per belief id, a convention row is every row (a superseding
    ``-verified`` row is not exempt), an episode row is a current episode (a superseded one is dropped). An absent
    ledger is zero rows; an unreadable one raises its owner's own error and is never counted as an orphan.
  knowledge_graph.convention_rows(tools_root) -> list[dict]
    the owner's read-only reader of conventions.jsonl: unlike ``lookup_pattern`` it does not verify-and-quarantine,
    and unlike ``_observation_rows`` it does not project every row through the current schema.
Every fixture is built through the owners' writers into a tmp tools root.
"""
from __future__ import annotations

import dataclasses
import hashlib
import importlib
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from typing import Any

import aria_kernel
from aria_kernel import knowledge_graph
from aria_kernel.knowledge_graph import KnowledgeGraphTamper, Pattern, record_convention
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.plan_convergence import events_file
from aria_kernel.state_manifest import memory_surfaces, surface_by_name
from aria_kernel.tool_registry import ensure_tools_dir

_OWNER = "aria_kernel.row_provenance"
_KINDS = ("belief", "convention", "episode")
_EMPTY = {kind: {"rows": 0, "orphans": []} for kind in _KINDS}
_AT = "2026-10-27T00:00:00Z"
_GOOD_EVIDENCE = [{"surface": "plan_convergence_events", "id": "ev-1"}]


def _provenance() -> ModuleType:
    if importlib.util.find_spec(_OWNER) is None:
        raise AssertionError(f"F0.9p: {_OWNER} (the provenance owner) does not exist")
    return importlib.import_module(_OWNER)


# --- fixtures, built through the owners' writers (shared with tests/test_doctor_provenance.py) -------------------------

def seed_plans(tools: Path, *plan_ids: str) -> None:
    for plan_id in plan_ids:
        append_declared_jsonl(events_file(tools), {"plan_id": plan_id, "event": "plan_started"},
                              expected_surface="plan_convergence_events")


def seed_convention(tools: Path, pattern_id: str, *, plan_id: str | None, supersedes: str | None = None,
                    outcome_status: str = "hypothesis") -> None:
    record_convention(
        Pattern(pattern_id=pattern_id, pattern_type="convention", confidence=0.5, evidence_refs=("a.py:1",),
                discovered_by_cycle_id="c1", observed_at=_AT, plan_id=plan_id, supersedes_pattern_id=supersedes,
                outcome_status=outcome_status),
        base_dir=tools, signer_key_fp="SHA256:x",
    )


def seed_episode(tools: Path, episode_id: str, *, plan_id: str, evidence: list[dict[str, str]] | None = None,
                 supersedes: str | None = None, occurred_at: str = _AT) -> None:
    append_declared_jsonl(
        tools / "memory" / "procedural.jsonl",
        {"episode_id": episode_id, "row_id": episode_id, "row_type": "performance_observed", "role": "drafter",
         "subject": "subject-a", "plan_id": plan_id, "outcome": "converged", "success": True, "failure_mode": None,
         "attributable": True, "occurred_at": occurred_at,
         "evidence": _GOOD_EVIDENCE if evidence is None else evidence, "supersedes": supersedes},
        expected_surface="memory_procedural",
    )


def seed_belief(tools: Path, belief_id: str, evidence_refs: list[str]) -> None:
    append_declared_jsonl(
        tools / "memory" / "beliefs.jsonl",
        {"schema_version": 2, "belief_id": belief_id, "claim": f"claim of {belief_id}",
         "evidence_refs": evidence_refs, "status": "supported"},
        expected_surface="memory_beliefs",
    )


def snapshot(root: Path) -> dict[str, str]:
    """Every path under ``root``: a directory as ``dir``, a file as its digest. One equality proves that nothing was
    created, renamed, appended to or rewritten (a lock file counts: a reader takes none)."""
    return {
        path.relative_to(root).as_posix(): "dir" if path.is_dir() else hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
    }


class CensusCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.tools = self.fresh_tools("aria-tools")

    def fresh_tools(self, name: str, *plans: str) -> Path:
        tools = self.root / name
        ensure_tools_dir(tools)
        seed_plans(tools, *(plans or ("plan-1",)))
        return tools

    def census(self, tools: Path | None = None) -> dict[str, Any]:
        return _provenance().provenance_census(self.tools if tools is None else tools)

    def orphans(self, kind: str, tools: Path | None = None) -> list[dict[str, str]]:
        return self.census(tools)[kind]["orphans"]


# --- B. the registry --------------------------------------------------------------------------------------------------

class TheVocabulariesAreClosedAndNamedOnce(unittest.TestCase):
    def test_the_citation_vocabulary_is_exactly_the_six_fields(self) -> None:
        mod = _provenance()
        self.assertEqual(mod.REF_FIELDS, {
            "plan_id": mod.Ref("plan_convergence_events", "plan_id"),
            "change_id": mod.Ref("change_planned", "change_id"),
            # finding.py's mint: the `findings` and `raw_findings` surfaces are other id spaces.
            "finding_id": mod.Ref("repo_finding_events", "finding_id"),
            "commit_sha": mod.Ref("change_committed", "commit_sha"),
            "supersedes_pattern_id": mod.Ref("kg_conventions", "pattern_id"),
            "supersedes": mod.Ref("memory_procedural", "episode_id"),
        })

    def test_every_cited_ledger_is_a_declared_surface(self) -> None:
        for field, ref in _provenance().REF_FIELDS.items():
            with self.subTest(field=field):
                surface_by_name(ref.surface)  # KeyError when the surface is not declared

    def test_the_learned_kinds_are_exactly_belief_convention_episode(self) -> None:
        mod = _provenance()
        self.assertEqual(mod.LEARNED_KINDS, {
            "belief": mod.Learned("memory_beliefs", "belief_id", ("evidence_refs",)),
            "convention": mod.Learned("kg_conventions", "pattern_id", ("plan_id",)),
            "episode": mod.Learned("memory_procedural", "episode_id", ("plan_id", "evidence")),
        })

    def test_a_learned_kind_is_a_memory_surface_by_the_manifests_own_flag(self) -> None:
        # The `memory` flag is the one declaration of "what ARIA learned": no second list of memory surfaces.
        memory = {surface.name for surface in memory_surfaces()}
        for kind, learned in _provenance().LEARNED_KINDS.items():
            with self.subTest(kind=kind):
                self.assertIn(learned.surface, memory)
                surface_by_name(learned.surface)

    def test_both_records_are_frozen_dataclasses(self) -> None:
        mod = _provenance()
        for record in (mod.Ref("plan_convergence_events", "plan_id"), mod.Learned("kg_conventions", "pattern_id", ("plan_id",))):
            with self.subTest(record=type(record).__name__):
                self.assertTrue(dataclasses.is_dataclass(record))
                with self.assertRaises(dataclasses.FrozenInstanceError):
                    record.surface = "other"  # type: ignore[misc]

    def test_the_module_binds_no_ast_and_loads_no_owner_at_import(self) -> None:
        # The atlas imports this module and docs_ssot must not start loading the kernel: the owners are imported
        # inside the functions that read them, and the one parse stays source_facts's.
        mod = _provenance()
        self.assertFalse(any(value is __import__("ast") for value in vars(mod).values()),
                         "row_provenance binds the ast module: a second parser")
        probe = (
            "import sys\n"
            "import aria_kernel\n"
            "before = set(sys.modules)\n"
            f"import {_OWNER}\n"
            "print(sorted(name for name in set(sys.modules) - before if name.startswith('aria_kernel.')))\n"
        )
        # A fresh interpreter finds the package the way this test did: the kernel root the package was imported from.
        env = {**os.environ, "PYTHONPATH": str(Path(aria_kernel.__file__).resolve().parents[1])}
        result = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, env=env, check=True)
        self.assertEqual(result.stdout.strip(), f"['{_OWNER}']")


# --- C. the census ----------------------------------------------------------------------------------------------------

class AnEmptyOrAbsentStoreHasNoRowsAndIsLeftAlone(CensusCase):
    def test_an_empty_directory_and_a_nonexistent_path_are_zero_rows_and_nothing_is_created(self) -> None:
        empty = self.root / "empty"
        empty.mkdir()
        bound = self.root / "bound-without-ledgers"
        ensure_tools_dir(bound)
        nowhere = self.root / "nowhere"
        for name, path in (("empty directory", empty), ("bound store without ledgers", bound),
                           ("nonexistent path", nowhere)):
            with self.subTest(path=name):
                before = snapshot(self.root)
                self.assertEqual(self.census(path), _EMPTY)
                self.assertEqual(snapshot(self.root), before, "the census wrote to the store (red under ensure_tools_dir)")
        self.assertFalse(nowhere.exists(), "the census created the tools root it was asked about")

    def test_a_store_with_one_sourced_row_per_kind_has_no_orphan_and_is_not_written(self) -> None:
        seed_convention(self.tools, "conv_ok", plan_id="plan-1")
        seed_episode(self.tools, "e1", plan_id="plan-1")
        seed_belief(self.tools, "b1", ["x.py"])
        before = snapshot(self.tools)
        self.assertEqual(self.census(), {kind: {"rows": 1, "orphans": []} for kind in _KINDS})
        self.assertEqual(snapshot(self.tools), before, "the census is a reader: no file may change, appear or be locked")


class AConventionCitesAPlanThatExists(CensusCase):
    def test_a_plan_id_that_names_no_plan_is_unresolved_and_the_join_is_not_field_presence(self) -> None:
        seed_convention(self.tools, "conv_dangling", plan_id="plan-gone")
        self.assertEqual(self.census()["convention"],
                         {"rows": 1, "orphans": [{"row_id": "conv_dangling", "reason": "source_unresolved:plan_id"}]})
        # Near-miss: the same row once its plan is on the plan ledger. A join that only asks "is the field present"
        # would have passed the row above, and a join that is cached would still fail this one.
        seed_plans(self.tools, "plan-gone")
        self.assertEqual(self.census()["convention"], {"rows": 1, "orphans": []})

    def test_a_store_with_no_plan_ledger_resolves_no_plan_and_does_not_fail(self) -> None:
        bare = self.root / "aria-tools-no-plan-ledger"
        ensure_tools_dir(bare)
        seed_convention(bare, "conv_x", plan_id="plan-1")
        self.assertEqual(self.census(bare)["convention"],
                         {"rows": 1, "orphans": [{"row_id": "conv_x", "reason": "source_unresolved:plan_id"}]})

    def test_an_absent_or_blank_plan_id_is_a_missing_source(self) -> None:
        seed_convention(self.tools, "conv_legacy", plan_id=None)
        seed_convention(self.tools, "conv_blank", plan_id="")
        self.assertEqual(self.census()["convention"], {"rows": 2, "orphans": [
            {"row_id": "conv_blank", "reason": "source_missing:plan_id"},
            {"row_id": "conv_legacy", "reason": "source_missing:plan_id"},
        ]})

    def test_a_superseding_verified_row_is_a_row_like_any_other(self) -> None:
        seed_convention(self.tools, "conv_ok", plan_id="plan-1")
        seed_convention(self.tools, "conv_ok-verified", plan_id="plan-1", supersedes="conv_ok", outcome_status="verified")
        self.assertEqual(self.census()["convention"], {"rows": 2, "orphans": []})
        other = self.fresh_tools("aria-tools-unsourced-verified")
        seed_convention(other, "conv_ok", plan_id="plan-1")
        seed_convention(other, "conv_ok-verified", plan_id=None, supersedes="conv_ok", outcome_status="verified")
        self.assertEqual(self.census(other)["convention"], {"rows": 2, "orphans": [
            {"row_id": "conv_ok-verified", "reason": "source_missing:plan_id"},
        ]})


class ABeliefIsItsLatestRow(CensusCase):
    def test_the_latest_row_per_belief_id_decides(self) -> None:
        seed_belief(self.tools, "b_repaired", [])
        seed_belief(self.tools, "b_repaired", ["x.py"])
        seed_belief(self.tools, "b_regressed", ["x.py"])
        seed_belief(self.tools, "b_regressed", [])
        # rows counts latest-per-id (two beliefs, four appended rows); first-wins or any-row would flag b_repaired.
        self.assertEqual(self.census()["belief"], {"rows": 2, "orphans": [
            {"row_id": "b_regressed", "reason": "source_missing:evidence_refs"},
        ]})

    def test_a_belief_cites_repo_evidence_not_ledger_rows(self) -> None:
        # Stored evidence is graded without a target sha, so the rule asks the row to CARRY its refs; it does not
        # resolve them against a commit (the evidence_trust owner's later slice).
        seed_belief(self.tools, "b_carries", ["no/such/file/anywhere.py"])
        self.assertEqual(self.census()["belief"], {"rows": 1, "orphans": []})


class AnEpisodeNamesItsPlanAndItsEvidence(CensusCase):
    def test_the_first_failing_source_in_order_names_the_reason(self) -> None:
        seed_episode(self.tools, "e_ok", plan_id="plan-1")
        seed_episode(self.tools, "e_noevidence", plan_id="plan-1", evidence=[])
        seed_episode(self.tools, "e_gone", plan_id="plan-gone")
        seed_episode(self.tools, "e_both", plan_id="plan-gone", evidence=[])
        self.assertEqual(self.census()["episode"], {"rows": 4, "orphans": [
            {"row_id": "e_both", "reason": "source_unresolved:plan_id"},
            {"row_id": "e_gone", "reason": "source_unresolved:plan_id"},
            {"row_id": "e_noevidence", "reason": "source_missing:evidence"},
        ]})

    def test_a_superseded_episode_is_not_a_current_episode(self) -> None:
        seed_episode(self.tools, "e5", plan_id="plan-1", evidence=[])
        seed_episode(self.tools, "e6", plan_id="plan-1", supersedes="e5")
        # e5 would be an orphan; it was superseded by a sourced row, so only e6 is counted.
        self.assertEqual(self.census()["episode"], {"rows": 1, "orphans": []})


class OrphansAreSortedByRowId(CensusCase):
    def test_every_kind_sorts_its_orphans_whatever_the_append_order(self) -> None:
        for pattern_id in ("conv_b", "conv_c", "conv_a"):
            seed_convention(self.tools, pattern_id, plan_id="plan-gone")
        # Time order is the reverse of id order, so a sort by occurred_at or append order is wrong too.
        for index, episode_id in enumerate(("e_b", "e_c", "e_a")):
            seed_episode(self.tools, episode_id, plan_id="plan-gone", occurred_at=f"2026-10-27T00:00:0{3 - index}Z")
        for belief_id in ("b_c", "b_a", "b_b"):
            seed_belief(self.tools, belief_id, [])
        census = self.census()
        for kind, expected in (("convention", ["conv_a", "conv_b", "conv_c"]), ("episode", ["e_a", "e_b", "e_c"]),
                               ("belief", ["b_a", "b_b", "b_c"])):
            with self.subTest(kind=kind):
                self.assertEqual([orphan["row_id"] for orphan in census[kind]["orphans"]], expected)


class AnUnreadableLedgerIsRaisedNotCounted(CensusCase):
    def test_a_non_json_line_raises_the_owners_error_and_the_file_is_left_exactly_as_it_was(self) -> None:
        seed_convention(self.tools, "conv_one", plan_id="plan-1")
        seed_convention(self.tools, "conv_two", plan_id="plan-1")
        path = self.tools / "knowledge-graph" / "conventions.jsonl"
        first, *rest = path.read_text(encoding="utf-8").splitlines(keepends=True)
        path.write_text(first + "this line is not json\n" + "".join(rest), encoding="utf-8")
        before = snapshot(self.tools)
        with self.assertRaises(KnowledgeGraphTamper):
            self.census()
        self.assertEqual(snapshot(self.tools), before)
        self.assertEqual([p.name for p in self.tools.rglob("*") if ".quarantined." in p.name], [],
                         "the census renamed a ledger (verify_chain_or_quarantine under lookup_pattern)")


class TheCensusDoesNotVerifyTheChain(CensusCase):
    def test_a_row_whose_hash_no_longer_matches_is_still_read_and_nothing_is_renamed(self) -> None:
        # Tamper evidence stays with `integrity verify` (doctor organ `integrity`): the census counts rows, and a reader
        # that verified the chain first would quarantine (rename) the ledger it was only asked to read.
        seed_convention(self.tools, "conv_one", plan_id="plan-1")
        seed_convention(self.tools, "conv_two", plan_id="plan-gone")
        path = self.tools / "knowledge-graph" / "conventions.jsonl"
        text = path.read_text(encoding="utf-8")
        self.assertIn('"confidence":0.5', text)
        path.write_text(text.replace('"confidence":0.5', '"confidence":0.6', 1), encoding="utf-8")
        before = snapshot(self.tools)
        self.assertEqual(self.census()["convention"],
                         {"rows": 2, "orphans": [{"row_id": "conv_two", "reason": "source_unresolved:plan_id"}]})
        self.assertEqual(snapshot(self.tools), before)
        self.assertEqual([p.name for p in self.tools.rglob("*") if ".quarantined." in p.name], [])


# --- 3. the owner's read-only reader of the conventions ledger ---------------------------------------------------------

def _convention_rows() -> Any:
    reader = getattr(knowledge_graph, "convention_rows", None)
    if reader is None:
        raise AssertionError("F0.9p: aria_kernel.knowledge_graph.convention_rows (the read-only reader) does not exist")
    return reader


class TheConventionsReaderReadsAndNothingElse(CensusCase):
    def test_it_returns_every_row_in_file_order(self) -> None:
        seed_convention(self.tools, "conv_a", plan_id="plan-1")
        seed_convention(self.tools, "conv_b", plan_id=None)
        rows = _convention_rows()(self.tools)
        self.assertEqual([(row["pattern_id"], row["plan_id"]) for row in rows], [("conv_a", "plan-1"), ("conv_b", None)])

    def test_an_absent_ledger_is_no_rows_and_creates_nothing(self) -> None:
        before = snapshot(self.tools)
        self.assertEqual(_convention_rows()(self.tools), [])
        self.assertEqual(snapshot(self.tools), before)

    def test_a_non_json_line_raises_and_quarantines_nothing(self) -> None:
        seed_convention(self.tools, "conv_a", plan_id="plan-1")
        path = self.tools / "knowledge-graph" / "conventions.jsonl"
        path.write_text(path.read_text(encoding="utf-8") + "not json\n", encoding="utf-8")
        before = snapshot(self.tools)
        with self.assertRaises(KnowledgeGraphTamper):
            _convention_rows()(self.tools)
        self.assertEqual(snapshot(self.tools), before)


if __name__ == "__main__":
    unittest.main()
