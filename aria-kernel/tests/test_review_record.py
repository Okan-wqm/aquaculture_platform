"""Tests for Plan 017 Phase 6.1 operator review record."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.review_record import list_reviews, record_review
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed_tools() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-review-"))
    tools = repo / "aria-tools"
    ensure_tools_dir(tools)
    return tools


class RecordReviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_minimal_record_persists_with_review_id(self) -> None:
        row = record_review(
            scope="plan-017-phase-6",
            summary="Phase 6 traceability hardening landed.",
            reviewer="operator-test",
            base_dir=self.tools,
        )
        self.assertTrue(row["review_id"].startswith("REV-"))
        self.assertEqual(row["scope"], "plan-017-phase-6")
        self.assertEqual(row["reviewer"], "operator-test")
        self.assertEqual(row["findings_referenced"], [])
        self.assertEqual(row["debts_referenced"], [])

    def test_record_with_finding_and_debt_refs(self) -> None:
        row = record_review(
            scope="plan-017-phase-3",
            summary="DEBT-...-004 closure verification.",
            reviewer="operator-test",
            findings_referenced=["F-001"],
            debts_referenced=["DEBT-2026-05-07-004"],
            base_dir=self.tools,
        )
        self.assertEqual(row["findings_referenced"], ["F-001"])
        self.assertEqual(row["debts_referenced"], ["DEBT-2026-05-07-004"])

    def test_empty_scope_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "scope is required"):
            record_review(scope="", summary="x", reviewer="op", base_dir=self.tools)

    def test_empty_summary_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "summary is required"):
            record_review(scope="x", summary="", reviewer="op", base_dir=self.tools)

    def test_empty_reviewer_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "reviewer is required"):
            record_review(scope="x", summary="y", reviewer="", base_dir=self.tools)

    def test_sequential_id_allocation_per_day(self) -> None:
        first = record_review(scope="a", summary="x", reviewer="op", base_dir=self.tools)
        second = record_review(scope="b", summary="y", reviewer="op", base_dir=self.tools)
        self.assertNotEqual(first["review_id"], second["review_id"])
        n1 = int(first["review_id"].rsplit("-", 1)[1])
        n2 = int(second["review_id"].rsplit("-", 1)[1])
        self.assertEqual(n2, n1 + 1)

    def test_governance_event_emitted(self) -> None:
        record_review(scope="gov", summary="x", reviewer="op", base_dir=self.tools)
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(l).get("kind") for l in gov if l.strip()]
        self.assertIn("review_recorded", kinds)


class ListReviewsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent
        record_review(scope="plan-017-phase-1", summary="x", reviewer="alice", base_dir=self.tools)
        record_review(scope="plan-017-phase-2", summary="y", reviewer="bob", base_dir=self.tools)
        record_review(scope="plan-016-arc", summary="z", reviewer="alice", base_dir=self.tools)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_no_filter_returns_all(self) -> None:
        rows = list_reviews(base_dir=self.tools)
        self.assertEqual(len(rows), 3)

    def test_scope_substring_filter(self) -> None:
        rows = list_reviews(base_dir=self.tools, scope_substring="plan-017")
        self.assertEqual(len(rows), 2)

    def test_reviewer_filter(self) -> None:
        rows = list_reviews(base_dir=self.tools, reviewer="alice")
        self.assertEqual(len(rows), 2)

    def test_combined_filters(self) -> None:
        rows = list_reviews(
            base_dir=self.tools,
            scope_substring="plan-017",
            reviewer="alice",
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["scope"], "plan-017-phase-1")


if __name__ == "__main__":
    unittest.main()
