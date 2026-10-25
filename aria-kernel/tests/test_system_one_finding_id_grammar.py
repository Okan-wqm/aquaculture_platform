"""REG-ID (ARIA-LOW-1004) — System One reads a registry finding id as the grammar owner does.

WHY. ``system_one`` and ``system_one_points`` each typed a finding-id grammar of
their own: one pattern, with a bound of one to six digits after any run of
upper-case segments, for a finding reference, for the ledger's subject and for the
plan's finding, and another, with an unbounded run of digits, for the ``Closes:``
trailers the merge authority reads. They accept what the owner
(``aria_kernel.finding_id_grammar``, held with the TypeScript owner to
``tools/gates/fixtures/finding-id-grammar-table.json``) refuses: ``ARIA-HIGH-12``,
``ARIA-HIGH-0999``, a fifth and a sixth digit, a trailing newline, ``ARIA-1000``.
A reference the registry cannot hold went to the registry lookup instead of being
refused by name, and a subject the ledger should have refused was recorded.

WHAT this module pins, by behaviour, on the table both owners are held to:

  * a ``finding`` reference is refused as ``finding_id_malformed`` unless the owner
    reads it as an id; an id it reads (``ARIA-HIGH-1000``) is a well-formed
    reference, answered when the registry holds it;
  * the ledger's subject is an id the owner reads (or ``PR#n`` or an object id);
    any other subject is refused as ``subject_not_an_id``;
  * the merge authority reads a ``Closes:`` trailer's id only when the owner reads
    it;
  * the decision points take the same id: an R4 plan that names an id the owner
    refuses asks nothing and writes no row, and a judge fan-out item with such an id
    records no subject.

The ``F-NNN`` and ``DEBT`` families are different grammars the registry never holds;
they are left to the readers that own them and are not part of the table here.
"""
from __future__ import annotations

# ARIA-HIGH-602 — the live partition: this module reads the one table of finding ids
# from the live checkout (outside the kernel surface), so it runs in aria-kernel.yml's
# always-run `workspace` job, never in a skippable shard.
READS_LIVE_CHECKOUT = 'tools/gates/fixtures/finding-id-grammar-table.json is the one table both finding-id grammar owners are held to'

import json
import re
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import system_one_points as points
from aria_kernel.system_one import CALLS_RELPATH, Answer, StateRef, Unavailable
from aria_kernel.tool_registry import ensure_tools_dir
from tests import test_system_one as ask_tests
from tests import test_system_one_points as point_tests

_TABLE_PATH = Path(__file__).resolve().parents[2] / "tools" / "gates" / "fixtures" / "finding-id-grammar-table.json"
_TABLE = json.loads(_TABLE_PATH.read_text(encoding="utf-8"))

_ACCEPTED = [entry["id"] for entry in _TABLE["accept"]]
# F-NNN and DEBT are other grammars the registry never holds; a refused id with
# whitespace in it is the trailer line's business, not the id grammar's.
_REFUSED = [value for value in _TABLE["reject"] if not value.startswith(("F-", "DEBT-"))]
_REFUSED_IN_A_TRAILER = [value for value in _REFUSED if not re.search(r"\s", value)]
# The ids a loose ``[0-9]{1,6}`` or ``\d+`` reader takes for ids and the owner refuses.
_LOOSELY_READ = ("ARIA-HIGH-99", "ARIA-HIGH-0999", "ARIA-HIGH-10000", "ARIA-HIGH-010000", "ARIA-HIGH-1000\n")


def _refusal(result: Answer | Unavailable) -> str:
    assert isinstance(result, Unavailable), result
    assert result.outcome == "refused", result
    return result.reason.split(":")[0]


class TheTableCoversTheIdsTheLooseReadersTook(unittest.TestCase):
    def test_every_loosely_read_id_is_one_the_table_refuses(self) -> None:
        # A table that stopped listing them would make every pin below vacuous for them.
        self.assertLessEqual(set(_LOOSELY_READ), set(_TABLE["reject"]))


class AFindingReferenceIsAnIdTheOwnerReads(ask_tests._Store):
    def _refs(self, finding_id: str) -> dict[str, StateRef]:
        return {"finding": StateRef(finding_id=finding_id), "diff": StateRef(commit=self.fix, path="src/x.ts")}

    def _reason(self, finding_id: str) -> str:
        transport = ask_tests._Transport()
        reason = _refusal(self.ask("J0", self._refs(finding_id), transport))
        self.assertEqual(transport.payloads, [])
        self.reset_rows()
        return reason

    def test_every_tabled_id_is_a_well_formed_reference(self) -> None:
        for finding_id in _ACCEPTED:
            with self.subTest(finding_id=finding_id):
                self.assertEqual(self._reason(finding_id), "finding_not_registered")

    def test_no_refused_id_is_a_reference(self) -> None:
        self.assertGreater(len(_REFUSED), 25)
        for value in _REFUSED:
            with self.subTest(value=value):
                self.assertEqual(self._reason(value), "finding_id_malformed")

    def test_the_ids_a_loose_reader_took_are_refused_by_name(self) -> None:
        for value in _LOOSELY_READ:
            with self.subTest(value=value):
                self.assertEqual(self._reason(value), "finding_id_malformed")

    def test_a_four_digit_finding_the_registry_holds_is_answered(self) -> None:
        registry = self.root / "docs" / "reviews" / "_registry" / "findings.jsonl"
        row = {**ask_tests._FINDING, "id": "ARIA-HIGH-1000"}
        self.commit_file(
            "docs/reviews/_registry/findings.jsonl",
            registry.read_text(encoding="utf-8") + json.dumps(row) + "\n",
            "register a four-digit finding",
        )
        transport = ask_tests._Transport(ask_tests._noul(0.9))
        result = self.ask("J0", self._refs("ARIA-HIGH-1000"), transport)
        self.assertIsInstance(result, Answer)
        self.assertEqual(len(transport.payloads), 1)


class ASubjectIsAnIdTheOwnerReads(ask_tests._Store):
    def test_every_tabled_id_is_a_subject_the_ledger_records(self) -> None:
        for finding_id in _ACCEPTED:
            with self.subTest(finding_id=finding_id):
                self.reset_rows()
                result = self.ask("J0", self.refs(), ask_tests._Transport(ask_tests._noul(0.9)), subject=finding_id)
                self.assertIsInstance(result, Answer)
                (row,) = self.rows()
                self.assertEqual(row["subject"], finding_id)

    def test_no_refused_id_is_a_subject(self) -> None:
        for value in _REFUSED:
            with self.subTest(value=value):
                transport = ask_tests._Transport()
                self.assertEqual(_refusal(self.ask("J0", self.refs(), transport, subject=value)), "subject_not_an_id")
                self.assertEqual(transport.payloads, [])

    def test_the_ids_a_loose_reader_took_are_not_subjects(self) -> None:
        for value in _LOOSELY_READ:
            with self.subTest(value=value):
                transport = ask_tests._Transport()
                self.assertEqual(_refusal(self.ask("J0", self.refs(), transport, subject=value)), "subject_not_an_id")

    def test_a_pull_request_and_a_commit_are_still_subjects(self) -> None:
        for subject in ("PR#1756", self.fix):
            with self.subTest(subject=subject):
                self.reset_rows()
                result = self.ask("J0", self.refs(), ask_tests._Transport(ask_tests._noul(0.9)), subject=subject)
                self.assertIsInstance(result, Answer)
                self.assertEqual(self.rows()[0]["subject"], subject)


class TheMergeAuthorityReadsTheOwnersIdsFromATrailer(unittest.TestCase):
    @staticmethod
    def _read(finding_id: str) -> list[str]:
        return points.closes_ids([f"fix(x): y\n\nCloses: docs/reviews/a.md#{finding_id}"])

    def test_every_tabled_id_is_read(self) -> None:
        for finding_id in _ACCEPTED:
            with self.subTest(finding_id=finding_id):
                self.assertEqual(self._read(finding_id), [finding_id])

    def test_no_refused_id_is_read(self) -> None:
        self.assertGreater(len(_REFUSED_IN_A_TRAILER), 15)
        for value in _REFUSED_IN_A_TRAILER:
            with self.subTest(value=value):
                self.assertEqual(self._read(value), [])

    def test_a_message_naming_two_findings_reads_both(self) -> None:
        message = "fix(x): y\n\nCloses: docs/reviews/a.md#ARIA-HIGH-1000\nCloses: docs/reviews/a.md#ARIA-HIGH-999"
        ids = points.closes_ids([message])
        self.assertEqual((len(ids), set(ids)), (2, {"ARIA-HIGH-1000", "ARIA-HIGH-999"}))


class TheDecisionPointsTakeTheOwnersId(unittest.TestCase):
    _PLAN_FINDING = "FARM-HIGH-1000"
    _ITEM_FINDING = "FARM-HIGH-1001"

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        (self.repo / "apps").mkdir(parents=True)
        (self.repo / "src").mkdir(parents=True)
        for name in ("tenant_tenant", "tenant", "farm"):
            (self.repo / "apps" / f"{name}.ts").write_text(
                "export function scopeQuery() {}\nconst getScopedRepository = 1\n", encoding="utf-8")
        (self.repo / "src" / "farm.ts").write_text(
            "".join(f"line {number}\n" for number in range(1, 31)), encoding="utf-8")
        registry = self.repo / point_tests.REGISTRY_FINDINGS
        registry.parent.mkdir(parents=True)
        # Every id the fixture may name is registered, so a refusal is the grammar's and not the registry's.
        ids = ("FARM-HIGH-001", self._PLAN_FINDING, self._ITEM_FINDING)
        registry.write_text("".join(point_tests.registry_row(finding_id) + "\n" for finding_id in ids), encoding="utf-8")
        point_tests.git(self.repo, "init", "-q")
        point_tests.commit_all(self.repo, "init")
        origin = point_tests.bind_public(self)
        point_tests.git(self.repo, "push", "-q", str(origin), "HEAD:main")
        self.tools = ensure_tools_dir(self.repo / "aria-tools")
        point_tests.write_registry(self.repo, r4_mode="order", top_k=3)

    def _reset_rows(self) -> None:
        self.tools.joinpath(*CALLS_RELPATH).unlink(missing_ok=True)

    def _rank(self, finding_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
        self._reset_rows()
        vendor = point_tests.Vendor()

        def plan() -> dict[str, str]:
            return {"title": "Use `getScopedRepository`", "summary": "in scopeQuery", "finding_id": finding_id}

        with patch("aria_kernel.system_one._transport", vendor):
            ranked = points.rank_candidate_files(plan=plan, workspace_root=self.repo, base_dir=self.tools)
        return ranked, vendor.payloads, point_tests.rows(self.tools)

    def _fan_out(self, finding_id: str) -> list[dict[str, Any]]:
        self._reset_rows()
        item = {"tool_id": "tenant-scoping-adapter", "run_id": "r", "cycle_id": "c1", "finding_id": finding_id,
                "rule": "missing-tenant-guard", "severity": "high", "path": "src/farm.ts:12",
                "message": "query without tenant scope", "evidence": ["src/farm.ts:12"],
                "finding_fingerprint": "fp1"}
        with patch("aria_kernel.system_one._transport", point_tests.Vendor()):
            points.shadow_judge_fanout(base_dir=self.tools, repo_root=self.repo, items=[item])
        return point_tests.rows(self.tools)

    def test_an_r4_plan_naming_a_four_digit_finding_the_registry_holds_ranks_files(self) -> None:
        ranked, payloads, recorded = self._rank(self._PLAN_FINDING)
        self.assertTrue(ranked)
        self.assertTrue(payloads)
        self.assertEqual({row["subject"] for row in recorded}, {self._PLAN_FINDING})

    def test_an_r4_plan_naming_an_id_the_owner_refuses_asks_nothing_and_writes_nothing(self) -> None:
        for value in sorted(set(_REFUSED) | set(_LOOSELY_READ)):
            with self.subTest(value=value):
                self.assertEqual(self._rank(value), ([], [], []))

    def test_a_judge_fan_out_item_with_a_four_digit_finding_records_its_subject(self) -> None:
        recorded = self._fan_out(self._ITEM_FINDING)
        self.assertEqual([(row["question_id"], row["subject"]) for row in recorded],
                         [("J1-tenant-scoping", self._ITEM_FINDING)])

    def test_a_judge_fan_out_item_with_an_id_the_owner_refuses_records_no_subject(self) -> None:
        for value in _LOOSELY_READ:
            with self.subTest(value=value):
                self.assertEqual([row["subject"] for row in self._fan_out(value)], [None])


if __name__ == "__main__":
    unittest.main()
