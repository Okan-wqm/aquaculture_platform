"""F1.2 — the three scorecard lenses are specs in CAPABILITY_SPECS, each naming what it measures, where it reads and who computes it.

WHY THIS EXISTS. ARIA-MEDIUM-733: CAPABILITY_SPECS holds the seven proof capabilities (the roster, and the order the
lenses follow it in, is pinned once, in test_autonomy_evidence_status). None of them names a
learning mechanism or a quality number, so a dormant learner looks the same as a working one, and the G1 field
list (PLAN-v2 F1.2, §4) has no registry of the fields it lists. PLAN-v2 §2 'Mekanizma karnesi': the scorecard is
``autonomy_evidence.CAPABILITY_SPECS``; each of the three lenses of the PLAN context (finding quality,
implementation quality, learning from memory) is one spec; the numbers are computed by their EXISTING owners
(role_fitness, agent_eval.performance_kpis, the learning journal) and only named here, never restated.

THE API THIS PINS (new in F1.2; at the branch base none of it exists, so each test reports an assertion failure,
not an import error):
  autonomy_evidence.MeasuredField(name, ledger, owner)   frozen: one scorecard number
      name    snake_case, unique across every spec (one owner per number)
      ledger  a declared state surface (state_manifest.surface_by_name) the number is computed from
      owner   "<repo path>:<function>" of the module-level function that computes it
  autonomy_evidence.CapabilitySpec.measured_fields: tuple[MeasuredField, ...]   (the seven proof capabilities: ())
  autonomy_evidence.CapabilitySpec.mechanisms: tuple[str, ...]                  (the learning mechanisms the lens names)
  CAPABILITY_SPECS keys: finding_quality, implementation_quality, learning_from_memory
Also pinned: a lens carries no proof contract, counts no ledger and is declared at contract version 1 (the three
fold pins recorded in tests/invariants/capability_semantic_equivalence/pins.json are those of that shape), and the
G1 list (genesis_policy.gates_policy) names measured fields, every lens contributing at least one.
Not pinned: the lenses' authority paths, the names of the measured fields, and (beyond being a declared surface)
which ledger the finding-quality and implementation-quality numbers are read from.
"""
from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path
from typing import Any

from aria_kernel import autonomy_evidence, genesis_policy
from aria_kernel.state_manifest import surface_by_name

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL = "aria-kernel/aria_kernel/"
_LENSES = ("finding_quality", "implementation_quality", "learning_from_memory")
# The EXISTING computation each lens reads its numbers from (PLAN-v2 §2: no restated computation).
_OWNERS = {
    "finding_quality": {f"{_KERNEL}role_fitness.py:measure_role_fitness"},
    "implementation_quality": {f"{_KERNEL}agent_eval.py:performance_kpis"},
    "learning_from_memory": {
        f"{_KERNEL}autonomy_evidence.py:mechanism_contribution",
        f"{_KERNEL}autonomy_evidence.py:mechanism_scorecard",
    },
}
# What writers give memory/learning-events.jsonl today (F1.1's closed vocabulary): the learning mechanisms.
_JOURNAL_KINDS = {"belief_proposed", "belief_corrected", "belief_confirmed", "evidence_invalidated", "goldset_promoted"}
_SNAKE_CASE = re.compile(r"[a-z][a-z0-9_]*")


def _lens(key: str) -> Any:
    spec = autonomy_evidence.CAPABILITY_SPECS.get(key)
    if spec is None:
        raise AssertionError(f"F1.2: autonomy_evidence.CAPABILITY_SPECS has no {key!r} lens spec")
    return spec


def _measured(key: str) -> tuple[Any, ...]:
    spec = _lens(key)
    fields = getattr(spec, "measured_fields", None)
    if not fields:
        raise AssertionError(f"F1.2: the {key!r} lens spec names no measured_fields")
    return tuple(fields)


def _all_measured_names() -> list[str]:
    return [field.name for spec in autonomy_evidence.CAPABILITY_SPECS.values()
            for field in getattr(spec, "measured_fields", ())]


class TheLensesAreCapabilitySpecs(unittest.TestCase):
    def test_a_lens_is_a_capability_spec(self) -> None:
        for key in _LENSES:
            with self.subTest(lens=key):
                self.assertIsInstance(_lens(key), autonomy_evidence.CapabilitySpec)

    def test_a_lens_names_numbers_it_proves_nothing_so_it_carries_no_contract_and_counts_no_ledger(self) -> None:
        # The numbers are read from their owners (EachLensNames...), not folded by the evidence accumulator: no
        # proof contract, no counted surface (so no share of the evidence input budget). The fold the pins in
        # tests/invariants/capability_semantic_equivalence/pins.json record for the three lenses is that of this shape.
        for key in _LENSES:
            with self.subTest(lens=key):
                spec = _lens(key)
                self.assertEqual(spec.contracts, ())
                self.assertEqual(spec.count_surfaces, ())

    def test_the_semantic_authority_declares_each_lens_at_contract_version_one(self) -> None:
        for key in _LENSES:
            _lens(key)
        declared = autonomy_evidence._DECLARED_SEMANTICS["capability_contract_versions"]
        for key in _LENSES:
            with self.subTest(lens=key):
                self.assertEqual(declared.get(key), 1)


class EachLensNamesWhatItMeasuresWhereItReadsAndWhoComputesIt(unittest.TestCase):
    def test_every_lens_names_measured_fields_of_the_declared_type(self) -> None:
        measured_field = getattr(autonomy_evidence, "MeasuredField", None)
        if measured_field is None:
            raise AssertionError("F1.2: autonomy_evidence.MeasuredField does not exist")
        for key in _LENSES:
            for field in _measured(key):
                with self.subTest(lens=key, field=getattr(field, "name", field)):
                    self.assertIsInstance(field, measured_field)
                    self.assertRegex(field.name, _SNAKE_CASE)

    def test_the_ledger_a_number_is_read_from_is_a_declared_state_surface(self) -> None:
        for key in _LENSES:
            for field in _measured(key):
                with self.subTest(lens=key, field=field.name):
                    try:
                        surface_by_name(field.ledger)
                    except KeyError:
                        self.fail(f"{field.name}: {field.ledger!r} is not a declared state surface")

    def test_the_numbers_are_computed_by_their_existing_owners(self) -> None:
        for key in _LENSES:
            for field in _measured(key):
                with self.subTest(lens=key, field=field.name):
                    self.assertIn(field.owner, _OWNERS[key])

    def test_an_owner_is_a_module_level_function_of_an_existing_module(self) -> None:
        for key in _LENSES:
            for field in _measured(key):
                with self.subTest(lens=key, field=field.name, owner=field.owner):
                    path, _, function = field.owner.partition(":")
                    source = (_REPO_ROOT / path).read_text(encoding="utf-8")
                    defined = {node.name for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)}
                    self.assertIn(function, defined)

    def test_one_number_has_one_owner_and_one_name(self) -> None:
        for key in _LENSES:
            _measured(key)
        names = _all_measured_names()
        self.assertEqual(len(set(names)), len(names), "a measured field named by two specs")
        # A number lives in the lens specs only: the proof capabilities keep proving, they do not measure.
        for key in autonomy_evidence.CAPABILITY_SPECS:
            if key in _LENSES:
                continue
            with self.subTest(capability=key):
                spec = autonomy_evidence.CAPABILITY_SPECS[key]
                self.assertEqual(tuple(getattr(spec, "measured_fields", ())), ())
                self.assertEqual(tuple(getattr(spec, "mechanisms", ())), ())

    def test_the_learning_lens_reads_the_learning_journal(self) -> None:
        for field in _measured("learning_from_memory"):
            with self.subTest(field=field.name):
                self.assertEqual(field.ledger, "memory_learning_events")

    def test_the_learning_lens_names_the_journal_kinds_as_its_mechanisms(self) -> None:
        mechanisms = getattr(_lens("learning_from_memory"), "mechanisms", ())
        self.assertEqual(set(mechanisms), _JOURNAL_KINDS)
        self.assertEqual(len(set(mechanisms)), len(tuple(mechanisms)), "a mechanism named twice")


class TheG1ListNamesMeasuredFields(unittest.TestCase):
    def _g1_fields(self) -> list[str]:
        accessor = getattr(genesis_policy, "gates_policy", None)
        if accessor is None:
            raise AssertionError("F1.2: aria_kernel.genesis_policy.gates_policy does not exist")
        return list(accessor()["g1"]["fields"])

    def test_every_g1_field_is_a_measured_field_of_a_lens(self) -> None:
        for _key in _LENSES:
            _measured(_key)
        known = set(_all_measured_names())
        for name in self._g1_fields():
            with self.subTest(field=name):
                self.assertIn(name, known, "a G1 field no lens spec names has no owner")

    def test_every_lens_contributes_a_field_to_g1(self) -> None:
        listed = set(self._g1_fields())
        for key in _LENSES:
            with self.subTest(lens=key):
                self.assertTrue(
                    listed & {field.name for field in _measured(key)},
                    f"the {key!r} lens has no field on the G1 list",
                )


if __name__ == "__main__":
    unittest.main()
