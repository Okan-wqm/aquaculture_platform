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

    def test_partial_is_its_own_state_not_a_legacy_spelling(self) -> None:
        # An earlier draft mapped partial→rejected, which silently flipped a
        # partial row's derived state SUBMITTED→REJECTED and left the
        # SUBMITTED branch dead — a behaviour change smuggled in as a
        # spelling fix. partial passes through untouched.
        original = {"request_id": "R", "status": "partial"}

        row = _normalize_result_row(original)

        self.assertIs(row, original)
        self.assertNotIn("legacy_status", row)

    def test_a_partial_result_still_derives_submitted(self) -> None:
        # The behaviour pin behind the mapping decision above: a partial
        # delivery awaits adjudication (SUBMITTED), it is not terminal.
        import ast
        import inspect
        import textwrap

        from aria_kernel import agent_invocations as ai

        tree = ast.parse(textwrap.dedent(inspect.getsource(ai.derive_request_state)))
        pairs = [
            (test.comparators[0].value, node)
            for node in ast.walk(tree)
            if isinstance(node, ast.If)
            for test in [node.test]
            if isinstance(test, ast.Compare)
            and isinstance(test.comparators[0], ast.Constant)
        ]
        partial_branch = next(body for value, body in pairs if value == "partial")
        returns = [
            n.value.value
            for n in ast.walk(partial_branch)
            if isinstance(n, ast.Return) and isinstance(n.value, ast.Constant)
        ]
        self.assertEqual(returns, ["SUBMITTED"])

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

        self.assertEqual([r["status"] for r in out], ["accepted", "accepted", "partial"])
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
