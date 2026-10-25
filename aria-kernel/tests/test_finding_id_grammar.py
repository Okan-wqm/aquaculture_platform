"""REG-ID — the registry finding-id grammar has ONE Python owner,
``aria_kernel.finding_id_grammar``, held to the same table as the TypeScript
owner (``tools/gates/finding-id-grammar.ts``).

WHY. ``finding-registry add`` refused with "Finding ID space exhausted for
domain ARIA (maximum 999)": the sequence was three digits and the grammar was
restated by hand at every reader — here in ``plan_origin`` (the trailer and
the ORPHAN id), ``plan_convergence``, ``adapter_quarantine`` and ``twin``,
each with its own digit count (``\\d{3}``, ``[0-9]{3,}``, ``\\d+``), so no two
of them agreed on what ``ARIA-HIGH-0999`` is. Python cannot import the
TypeScript owner, so the two owners cannot be one module; they are one GRAMMAR
because both are tested against the same table
(``tools/gates/fixtures/finding-id-grammar-table.json``): a row added there is
judged by both, and either owner drifting fails its own test by name.

WHAT IS PINNED. The sequence is three digits (001..999) or four to a maximum of
9999 with no leading zero; the domain is upper-case alphanumeric starting with a
letter; ASCII digits only (Python's ``\\d`` also matches Arabic-Indic digits, and
``$`` matches before a trailing newline — the table carries both, because the
TypeScript regex does neither). ``format_finding_id`` zero-pads to three digits
and refuses a sequence outside 1..9999; ``finding_id_sort_key`` orders the
sequence as a number.

This module pins NEW API the specification introduces
(``aria_kernel.finding_id_grammar`` does not exist at the branch base), so it is
red at the base by import. ``test_registry_finding_id_four_digits.py`` pins the
EXISTING readers against the same table and is red by assertion.
"""
from __future__ import annotations

# ARIA-HIGH-602 — the live partition: this module reads the TypeScript owner's
# table from the live checkout (outside the kernel surface), so it runs in
# aria-kernel.yml's always-run `workspace` job, never in a skippable shard.
READS_LIVE_CHECKOUT = 'tools/gates/fixtures/finding-id-grammar-table.json is the one table both finding-id grammar owners are held to'

import json
import unittest
from pathlib import Path

from aria_kernel.finding_id_grammar import (
    FINDING_SEQUENCE_MAX,
    REGISTRY_FINDING_ID_RE,
    finding_id_sort_key,
    format_finding_id,
    parse_finding_id,
)

_TABLE_PATH = Path(__file__).resolve().parents[2] / "tools" / "gates" / "fixtures" / "finding-id-grammar-table.json"
_TABLE = json.loads(_TABLE_PATH.read_text(encoding="utf-8"))


class TheTableBothOwnersAreHeldTo(unittest.TestCase):
    def test_the_table_holds_the_ids_the_specification_names(self) -> None:
        accepted = {entry["id"] for entry in _TABLE["accept"]}
        self.assertLessEqual({"ARIA-HIGH-999", "ARIA-HIGH-1000"}, accepted)
        self.assertLessEqual(
            {"ARIA-HIGH-0999", "ARIA-HIGH-99", "aria-high-1000", "ARIA-HIGH-10000"}, set(_TABLE["reject"])
        )

    def test_the_allocator_limit_is_the_tables(self) -> None:
        self.assertEqual(FINDING_SEQUENCE_MAX, 9999)
        self.assertEqual(FINDING_SEQUENCE_MAX, _TABLE["limit"])


class TheRegexAndTheParser(unittest.TestCase):
    def test_every_tabled_id_matches_and_every_refused_one_does_not(self) -> None:
        for entry in _TABLE["accept"]:
            with self.subTest(accept=entry["id"]):
                self.assertIsNotNone(REGISTRY_FINDING_ID_RE.fullmatch(entry["id"]))
        for value in _TABLE["reject"]:
            with self.subTest(reject=value):
                self.assertIsNone(REGISTRY_FINDING_ID_RE.fullmatch(value))

    def test_parse_splits_a_tabled_id(self) -> None:
        for entry in _TABLE["accept"]:
            with self.subTest(accept=entry["id"]):
                parsed = parse_finding_id(entry["id"])
                self.assertIsNotNone(parsed)
                assert parsed is not None
                self.assertEqual(parsed.id, entry["id"])
                self.assertEqual(parsed.domain, entry["domain"])
                self.assertEqual(parsed.classifier, entry["classifier"])
                self.assertEqual(parsed.sequence, entry["sequence"])

    def test_parse_refuses_every_refused_id(self) -> None:
        for value in _TABLE["reject"]:
            with self.subTest(reject=value):
                self.assertIsNone(parse_finding_id(value))

    def test_a_trailing_newline_and_a_foreign_digit_are_not_part_of_an_id(self) -> None:
        # The two spellings Python's `$` and `\\d` admit and the TypeScript owner
        # never did; named here so the table's rows are not the only witness.
        self.assertIsNone(parse_finding_id("ARIA-HIGH-1000\n"))
        self.assertIsNone(parse_finding_id("ARIA-HIGH-١٠٠٠"))


class FormatAndOrder(unittest.TestCase):
    def test_format_zero_pads_to_three_digits_and_never_truncates(self) -> None:
        for entry in _TABLE["format"]:
            with self.subTest(sequence=entry["sequence"]):
                self.assertEqual(
                    format_finding_id(entry["domain"], entry["classifier"], entry["sequence"]),
                    entry["id"],
                )

    def test_format_refuses_a_sequence_the_grammar_cannot_spell(self) -> None:
        for sequence in _TABLE["formatRefused"]:
            with self.subTest(sequence=sequence):
                with self.assertRaises((ValueError, TypeError)):
                    format_finding_id("ARIA", "HIGH", sequence)

    def test_format_and_parse_are_inverses_over_the_whole_range(self) -> None:
        for sequence in (1, 9, 10, 99, 100, 998, 999, 1000, 1001, 5000, 9998, 9999):
            with self.subTest(sequence=sequence):
                value = format_finding_id("ARIA", "LOW", sequence)
                self.assertIsNotNone(REGISTRY_FINDING_ID_RE.fullmatch(value))
                parsed = parse_finding_id(value)
                self.assertIsNotNone(parsed)
                assert parsed is not None
                self.assertEqual(parsed.sequence, sequence)

    def test_the_sequence_orders_as_a_number_never_as_text(self) -> None:
        order = list(_TABLE["order"])
        self.assertNotEqual(sorted(order), order, "the table must be one text order cannot give")
        self.assertEqual(sorted(reversed(order), key=finding_id_sort_key), order)
        self.assertLess(finding_id_sort_key("ARIA-LOW-999"), finding_id_sort_key("ARIA-LOW-1000"))


if __name__ == "__main__":
    unittest.main()
