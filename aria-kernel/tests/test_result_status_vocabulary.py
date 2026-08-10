"""One result vocabulary at read time; the ledger keeps its history.

Two generations coexist in the append-only results ledger: legacy
completed/rejected/partial and Plan-016 accepted/rejected. Every reader that
learned this the hard way was a re-armed trap — `derive_request_state`
carried the union inline, and the next consumer would not. Rows now arrive
canonical from `_result_rows_for`; the original spelling survives in
`legacy_status` for audit; the write path for legacy spellings stays gated
behind the operator-migration approval it already had.
"""
from __future__ import annotations

import unittest

from aria_kernel.agent_invocations import (
    CANONICAL_RESULT_STATUSES,
    _normalize_result_row,
    _result_rows_for,
)


class ReadTimeNormalizationTest(unittest.TestCase):
    def test_completed_reads_as_accepted_with_audit_trail(self) -> None:
        row = _normalize_result_row({"request_id": "R", "status": "completed"})

        self.assertEqual(row["status"], "accepted")
        self.assertEqual(row["legacy_status"], "completed")

    def test_partial_reads_as_rejected(self) -> None:
        # Partial delivered SOMETHING but not the contract; an incomplete
        # delivery must not derive a COMPLETED request.
        row = _normalize_result_row({"request_id": "R", "status": "partial"})

        self.assertEqual(row["status"], "rejected")
        self.assertEqual(row["legacy_status"], "partial")

    def test_canonical_rows_pass_through_untouched(self) -> None:
        original = {"request_id": "R", "status": "accepted", "output_hash": "x"}

        row = _normalize_result_row(original)

        self.assertIs(row, original)
        self.assertNotIn("legacy_status", row)

    def test_the_row_filter_returns_only_canonical_statuses(self) -> None:
        rows = [
            {"request_id": "R", "status": "completed"},
            {"request_id": "R", "status": "accepted"},
            {"request_id": "OTHER", "status": "partial"},
            {"request_id": "R", "status": "partial"},
        ]

        out = _result_rows_for(rows, "R")

        self.assertEqual([r["status"] for r in out], ["accepted", "accepted", "rejected"])
        for r in out:
            self.assertIn(r["status"], CANONICAL_RESULT_STATUSES)

    def test_derive_no_longer_carries_the_dual_vocabulary(self) -> None:
        # The inline union is the trap this closes; its return is a red test.
        import ast
        import inspect
        import textwrap

        from aria_kernel import agent_invocations as ai

        tree = ast.parse(textwrap.dedent(inspect.getsource(ai.derive_request_state)))
        literals = {
            node.value
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        }
        self.assertNotIn("completed", literals)


if __name__ == "__main__":
    unittest.main()
