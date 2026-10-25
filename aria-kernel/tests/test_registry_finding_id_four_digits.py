"""REG-ID — the kernel's EXISTING readers of a registry finding id agree with the
grammar: three digits up to 999, four to 9999 with no leading zero.

WHY. ``finding-registry add`` ran out of ARIA ids at 999 and the kernel held
four different spellings of the same grammar: ``plan_origin`` (the Closes
trailer and the ORPHAN id, ``\\d{3}``) and ``adapter_quarantine`` (``\\d+``,
which also accepts ``0999``, a fifth digit, a trailing newline and
Arabic-Indic digits). A plan minted from ``ORPHAN-HIGH-1000`` was refused at
submission (``plan_origin_finding_id_unrecognised``), the commit contract it
would have been given names a trailer the gate refused, and a manifest could
quarantine on an id that is not one.

The TypeScript gate and the kernel are held to ONE table
(``tools/gates/fixtures/finding-id-grammar-table.json``): the same ids the gate's
CLOSES_TRAILER_REGEX and the registry row schema are held to here decide what
``CLOSES_TRAILER_RE``, ``plan_origin`` and ``validate_manifest_quarantine``
accept. The byte-for-byte mirror of the gate's regex source in
``test_plan_origin_commit_contract.py`` cannot survive every restatement moving
to the owner (the gate's trailer regex is then built from the owner, not typed);
this is its behavioural replacement for the one rule that changed.

``test_finding_id_grammar.py`` pins the new owner module and is red by import;
this module pins the existing API and is red by assertion.
"""
from __future__ import annotations

# ARIA-HIGH-602 — the live partition: this module reads the TypeScript owner's
# table from the live checkout (outside the kernel surface), so it runs in
# aria-kernel.yml's always-run `workspace` job, never in a skippable shard.
READS_LIVE_CHECKOUT = 'tools/gates/fixtures/finding-id-grammar-table.json is the one table both finding-id grammar owners are held to'

import json
import re
import unittest
from pathlib import Path

from aria_kernel.adapter_quarantine import validate_manifest_quarantine
from aria_kernel.plan_origin import (
    CLOSES_TRAILER_RE,
    ORIGIN_ORPHAN_FINDING,
    commit_contract_for_plan,
    plan_origin,
)
from aria_kernel.tool_registry import GovernanceError

_TABLE_PATH = Path(__file__).resolve().parents[2] / "tools" / "gates" / "fixtures" / "finding-id-grammar-table.json"
_TABLE = json.loads(_TABLE_PATH.read_text(encoding="utf-8"))

_ACCEPTED = [entry["id"] for entry in _TABLE["accept"]]
_REJECTED = list(_TABLE["reject"])
# The F-NNN and DEBT families are different grammars the trailer also admits, and
# whitespace in an id is the trailer line's own business, not the id grammar's.
_REJECTED_AS_TRAILER_TARGET = [
    value
    for value in _REJECTED
    if not re.search(r"\s", value) and not value.startswith(("F-", "DEBT-"))
]
_ORPHAN_REVIEW_FILE = "docs/reviews/orphan-findings.md"


class TheCloseTrailerAgreesWithTheGate(unittest.TestCase):
    def test_every_tabled_id_is_a_trailer_target(self) -> None:
        for finding_id in _ACCEPTED:
            with self.subTest(finding_id=finding_id):
                match = CLOSES_TRAILER_RE.match(f"Closes: {_ORPHAN_REVIEW_FILE}#{finding_id}")
                self.assertIsNotNone(match)
                assert match is not None
                self.assertEqual(match.group(2), finding_id)

    def test_no_refused_id_is_a_trailer_target(self) -> None:
        self.assertGreater(len(_REJECTED_AS_TRAILER_TARGET), 15)
        for value in _REJECTED_AS_TRAILER_TARGET:
            with self.subTest(value=value):
                self.assertIsNone(CLOSES_TRAILER_RE.match(f"Closes: {_ORPHAN_REVIEW_FILE}#{value}"))


class AnOrphanFindingOfFourDigitsIsAPlanOrigin(unittest.TestCase):
    def test_a_four_digit_orphan_id_is_recognised_and_gets_the_trailer_the_gate_resolves(self) -> None:
        finding_id = "ORPHAN-HIGH-1000"
        origin = plan_origin({"finding_id": finding_id})
        self.assertEqual(origin.kind, ORIGIN_ORPHAN_FINDING)
        self.assertEqual(origin.finding_id, finding_id)
        contract = commit_contract_for_plan({"finding_id": finding_id}, plan_id="plan-reg-id")
        self.assertEqual(contract["trailer"], f"Closes: {_ORPHAN_REVIEW_FILE}#{finding_id}")
        self.assertIsNotNone(CLOSES_TRAILER_RE.match(contract["trailer"]))

    def test_an_orphan_id_the_grammar_does_not_spell_is_not_an_origin(self) -> None:
        for finding_id in ("ORPHAN-HIGH-0999", "ORPHAN-HIGH-10000", "ORPHAN-HIGH-99"):
            with self.subTest(finding_id=finding_id):
                with self.assertRaises(GovernanceError):
                    plan_origin({"finding_id": finding_id})


class AManifestQuarantinesOnARealRegistryId(unittest.TestCase):
    @staticmethod
    def _quarantine(finding: str) -> dict[str, str]:
        return validate_manifest_quarantine({"finding": finding, "reason": "the finding's own reason"}, tool_id="tool-x")

    def test_every_tabled_id_is_a_registry_finding_id(self) -> None:
        for finding_id in _ACCEPTED:
            with self.subTest(finding_id=finding_id):
                self.assertEqual(self._quarantine(finding_id)["finding"], finding_id)

    def test_no_refused_id_is_one(self) -> None:
        for value in _REJECTED:
            with self.subTest(value=value):
                with self.assertRaises(GovernanceError):
                    self._quarantine(value)


if __name__ == "__main__":
    unittest.main()
