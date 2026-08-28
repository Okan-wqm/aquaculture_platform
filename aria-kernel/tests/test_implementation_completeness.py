"""ORPHAN-721 (2026-08-18 operator directive) — under-implementation is a
declared state, never a silent one.

§D.2 made over-implementation impossible (actual ⊆ intended). Nothing made
the OTHER direction visible: an implementer landing 3 of 7 key_changes
recorded a normal commit and the chain read complete. Deliberate-breakage
pins: an undeclared shortfall refuses the committed row; a declared one is
recorded verbatim; the triple gate re-checks rows the writer never saw.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import auto_merge
from aria_kernel.change_ledger import (
    emit_change_committed,
    emit_change_planned,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_SHA = "ab" * 20


class _LedgerCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-721-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.change_id = emit_change_planned(
            plan_id="plan-721",
            finding_id="F-721",
            intended_affected_files=["apps/a.ts", "apps/b.ts", "apps/c.ts"],
            intended_validation_refs=["nx affected --target=test"],
            architectural_tier=1,
            base_dir=self.tools,
        )["change_id"]

    def tearDown(self) -> None:
        self._tmp.cleanup()


class CommitCompletenessTests(_LedgerCase):
    def test_undeclared_shortfall_refuses_the_row(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            emit_change_committed(
                change_id=self.change_id,
                commit_sha=_SHA,
                actual_affected_files=["apps/a.ts"],
                base_dir=self.tools,
            )
        self.assertIn("implementation_incomplete_undeclared", str(ctx.exception))
        self.assertIn("apps/b.ts", str(ctx.exception))

    def test_declared_shortfall_is_recorded_verbatim(self) -> None:
        row = emit_change_committed(
            change_id=self.change_id,
            commit_sha=_SHA,
            actual_affected_files=["apps/a.ts"],
            uncovered_intended_dispositions={
                "apps/b.ts": "reviewed; guard already present upstream",
                "apps/c.ts": "reviewed; dead path removed by apps/a.ts change",
            },
            base_dir=self.tools,
        )
        self.assertEqual(row["uncovered_intended"], ["apps/b.ts", "apps/c.ts"])
        self.assertFalse(row["implementation_complete"])
        self.assertIn("guard already present", row["uncovered_intended_dispositions"]["apps/b.ts"])

    def test_full_coverage_is_complete_with_no_dispositions(self) -> None:
        row = emit_change_committed(
            change_id=self.change_id,
            commit_sha=_SHA,
            actual_affected_files=["apps/a.ts", "apps/b.ts", "apps/c.ts"],
            base_dir=self.tools,
        )
        self.assertTrue(row["implementation_complete"])
        self.assertEqual(row["uncovered_intended"], [])

    def test_disposition_for_a_touched_file_is_rejected(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            emit_change_committed(
                change_id=self.change_id,
                commit_sha=_SHA,
                actual_affected_files=["apps/a.ts", "apps/b.ts", "apps/c.ts"],
                uncovered_intended_dispositions={"apps/a.ts": "prose over diff"},
                base_dir=self.tools,
            )
        self.assertIn("implementation_disposition_for_covered_file", str(ctx.exception))

    def test_blank_disposition_counts_as_undeclared(self) -> None:
        with self.assertRaises(GovernanceError):
            emit_change_committed(
                change_id=self.change_id,
                commit_sha=_SHA,
                actual_affected_files=["apps/a.ts"],
                uncovered_intended_dispositions={"apps/b.ts": "  ", "apps/c.ts": "ok"},
                base_dir=self.tools,
            )


class TripleGateLegacyRowTests(_LedgerCase):
    def test_legacy_row_with_shortfall_blocks_merge(self) -> None:
        # A row written BEFORE the contract: no completeness fields, actual
        # a strict subset of intended. The gate must not certify it.
        legacy = {
            "change_id": self.change_id,
            "commit_sha": _SHA,
            "actual_affected_files": ["apps/a.ts"],
        }
        with patch.object(auto_merge, "change_for_pr", return_value=self.change_id), \
             patch("aria_kernel.change_ledger._find_committed", return_value=legacy):
            result = auto_merge._evaluate_triple_gate(
                pr_number=721, head_sha=_SHA, base_dir=self.tools,
            )
        self.assertFalse(result["passed"])
        self.assertTrue(
            any("triple_gate_implementation_incomplete" in r for r in result["reasons"]),
            result["reasons"],
        )

    def test_declared_row_does_not_trip_the_gate_reason(self) -> None:
        emit_change_committed(
            change_id=self.change_id,
            commit_sha=_SHA,
            actual_affected_files=["apps/a.ts"],
            uncovered_intended_dispositions={
                "apps/b.ts": "reviewed; no change needed",
                "apps/c.ts": "reviewed; no change needed",
            },
            base_dir=self.tools,
        )
        with patch.object(auto_merge, "change_for_pr", return_value=self.change_id):
            result = auto_merge._evaluate_triple_gate(
                pr_number=722, head_sha=_SHA, base_dir=self.tools,
            )
        self.assertFalse(
            any("triple_gate_implementation_incomplete" in r for r in result["reasons"]),
            result["reasons"],
        )


if __name__ == "__main__":
    unittest.main()
