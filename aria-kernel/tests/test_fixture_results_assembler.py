"""C4-b (ORPHAN-675) — sandbox evidence assembled from the ledger.

`evaluate_genesis_sandbox` demands provenance-carrying results that its
ledger join re-verifies, but nothing ever ASSEMBLED them — the input was
an operator-authored JSON file, both toil and a home for hand-typed
drift. The assembler derives the results from the same suite row the
join verifies against: one source, no parallel authoring path.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_genesis import (
    _fixture_result_has_real_execution_provenance,
    _fixture_result_provenance_matches_ledger,
    assemble_fixture_results_from_suite,
)
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _write_suite_row(root: Path, run_id: str) -> dict:
    row = {
        "schema_version": 1,
        "at": "2026-08-14T05:00:00Z",
        "row_type": "fixture_run_suite",
        "tool_id": "tenant-scoping-adapter",
        "fixture_set_hash": "sha256:" + "a" * 64,
        "cycle_id": "cycle-c4b",
        "passed": True,
        "case_count": 3,
        "cases": [
            {"name": "tp-case", "passed": True},
            {"name": "fp-trap", "passed": True},
            {"name": "scope-guard", "passed": True},
        ],
        "execution_run_id": run_id,
        "actual_status": "pass",
        "evidence_hash": "sha256:" + "b" * 64,
    }
    return append_declared_jsonl(
        root / "fixture-runs.jsonl", row, expected_surface="agent_eval_fixture_runs"
    )


class AssemblerTests(unittest.TestCase):
    def test_assembled_results_pass_the_sandbox_ledger_join(self) -> None:
        # The deliberate point: the assembler's output must satisfy BOTH
        # gates evaluate_genesis_sandbox applies — the shape pre-filter
        # and the ledger-binding join — with zero hand-authored fields.
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            _write_suite_row(root, "exec-c4b-1")
            results = assemble_fixture_results_from_suite(
                execution_run_id="exec-c4b-1", base_dir=root
            )
            self.assertEqual(len(results), 3)
            for result in results:
                self.assertTrue(
                    _fixture_result_has_real_execution_provenance(result)
                )
                ok, reason = _fixture_result_provenance_matches_ledger(
                    result, base_dir=root
                )
                self.assertTrue(ok, reason)
            self.assertEqual({r["status"] for r in results}, {"pass"})

    def test_unknown_execution_run_id_refuses(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            _write_suite_row(root, "exec-known")
            with self.assertRaises(GovernanceError) as ctx:
                assemble_fixture_results_from_suite(
                    execution_run_id="exec-ghost", base_dir=root
                )
        self.assertIn("assemble_unknown_execution_run_id", str(ctx.exception))

    def test_failed_case_assembles_as_fail(self) -> None:
        # An honest assembler carries the failure through; the sandbox
        # decision (fail) is the sandbox's job, not the assembler's.
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            row = {
                "schema_version": 1,
                "at": "2026-08-14T05:00:00Z",
                "row_type": "fixture_run_suite",
                "tool_id": "t",
                "fixture_set_hash": "sha256:" + "c" * 64,
                "cycle_id": "cyc",
                "passed": False,
                "case_count": 1,
                "cases": [{"name": "red", "passed": False}],
                "execution_run_id": "exec-red",
                "actual_status": "fail",
                "evidence_hash": "sha256:" + "d" * 64,
            }
            append_declared_jsonl(
                root / "fixture-runs.jsonl", row,
                expected_surface="agent_eval_fixture_runs",
            )
            results = assemble_fixture_results_from_suite(
                execution_run_id="exec-red", base_dir=root
            )
        self.assertEqual([r["status"] for r in results], ["fail"])


if __name__ == "__main__":
    unittest.main()
